import { execFile } from "node:child_process";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import type { Cid } from "@atproto/lex-data";
import {
  BlockMap,
  blocksToCarFile,
  cborToLex,
  formatDataKey,
  readCarWithRoot,
} from "@atproto/repo";
import {
  MessageFrame,
  Subscription,
  XrpcStreamServer,
} from "@atproto/xrpc-server";
import { expect, test } from "@playwright/test";
import {
  allowlistFromEnv,
  ConsumerStore,
  type RunningFirehose,
  startFirehose,
} from "@trustlab/consumer";
import {
  EVENT_NSID,
  eventRkey,
  headRkey,
  loadLocalEnv,
  type LocalEnv,
} from "@trustlab/contracts";

// Story #20: as a consumer, I reject tampered commits.
//
// The first test captures a real commit from the PDS's firehose, then feeds
// a fresh consumer the four tampered copies from the #51 fixtures (bad
// signature, changed record bytes, wrong op CID, wrong DID) through a relay
// that stands in for the PDS. Each copy is followed by the untouched commit,
// so every case shows both halves of the story: the tampered commit never
// reaches the view and the original does. Keys still come from the real PLC.
//
// The second test uses the tamper tools (#65). Those are validly signed
// writes by the account owner, so the firehose verifies them, but the
// consumer's view keeps the event it already verified.
//
// No browser: this drives the command line. Needs the local AT network:
// `npm run stack:up`.

const run = promisify(execFile);
const METHOD = "com.atproto.sync.subscribeRepos";
const CONNECT_WAIT_MS = 1000;
const WAIT = { timeout: 15_000 };

/** A decoded `#commit` message, as the firehose sends it. */
interface CommitFrame {
  seq: number;
  repo: string;
  commit: Cid;
  blocks: Uint8Array;
  ops: { action: string; path: string; cid: Cid | null }[];
  [key: string]: unknown;
}

/**
 * Load `.env.local` and check the PDS answers.
 *
 * @returns The environment, or the reason the stack can't be used.
 */
async function findStack(): Promise<LocalEnv | string> {
  let env: LocalEnv;
  try {
    env = loadLocalEnv();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  const health = await fetch(`${env.PDS_URL}/xrpc/_health`).catch(() => null);
  return health?.ok
    ? env
    : `No PDS at ${env.PDS_URL}. Start the local network with \`npm run stack:up\`.`;
}

/**
 * Skip the test when the stack is down locally, and fail it in CI.
 *
 * @returns The environment.
 */
async function requireStack(): Promise<LocalEnv> {
  const stack = await findStack();
  if (typeof stack === "string") {
    // Locally the stack is optional, so say why and skip. In CI a missing
    // stack is a failure, never a silent pass.
    expect(process.env.CI, stack).toBeFalsy();
    test.skip(true, stack);
  }
  return stack as LocalEnv;
}

/**
 * Run the publisher's command line the way a publisher would.
 *
 * @param args - Arguments after `publish-events --`.
 * @returns The `msg` of each line it printed.
 */
async function publisher(...args: string[]): Promise<string[]> {
  const { stdout } = await run("npx", [
    "tsx",
    "services/publisher/src/cli.ts",
    ...args,
  ]);
  return stdout
    .trim()
    .split("\n")
    .map((line) => (JSON.parse(line) as { msg: string }).msg);
}

/**
 * Run `tamper edit`, again if another spec's commit landed while it was
 * reading: the tool then writes nothing and says to run it again.
 *
 * @param stream - Stream to tamper with.
 * @param seq - The seq of the event to edit.
 * @returns The lines the tool printed.
 */
async function tamperEdit(stream: string, seq: number): Promise<string[]> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await publisher(
        "tamper",
        "edit",
        "--stream",
        stream,
        "--seq",
        String(seq),
      );
    } catch (error) {
      const stderr = String((error as { stderr?: unknown }).stderr);
      if (attempt === 5 || !stderr.includes("nothing was written")) throw error;
    }
  }
}

/**
 * Publish seeded events and read back the CID of each.
 *
 * @param stream - Stream to publish to.
 * @param count - How many events to publish.
 * @returns The CIDs, lowest seq first.
 */
async function publish(stream: string, count: number): Promise<string[]> {
  const lines = await publisher(
    "--stream",
    stream,
    "--count",
    String(count),
    "--seed",
    "20",
  );
  return lines.map((line) => {
    const match = /^published \S+ seq=\d+ cid=(\S+)$/.exec(line);
    if (match === null) throw new Error(`unexpected publish output: ${line}`);
    return match[1] as string;
  });
}

/**
 * Publish the first event of a stream and capture the commit the PDS sent
 * for it on the firehose.
 *
 * @param env - The local environment.
 * @param stream - A stream with no events yet.
 * @returns The decoded commit and the event's CID.
 */
async function captureCommit(
  env: LocalEnv,
  stream: string,
): Promise<{ commit: CommitFrame; eventCid: string }> {
  const path = formatDataKey(EVENT_NSID, eventRkey(stream, 1));
  const abort = new AbortController();
  const sub = new Subscription<unknown>({
    service: env.PDS_URL.replace(/^http/, "ws"),
    method: METHOD,
    signal: abort.signal,
    validate: (value) => value,
  });
  let commit: CommitFrame | undefined;
  const reading = (async () => {
    try {
      for await (const message of sub) {
        const frame = message as CommitFrame;
        if (
          frame.$type === `${METHOD}#commit` &&
          frame.repo === env.PUBLISHER_DID &&
          frame.ops.some((op) => op.path === path)
        ) {
          commit = frame;
          abort.abort();
        }
      }
    } catch (error) {
      if (!abort.signal.aborted) throw error;
    }
  })();
  // The feed starts at the live tail, so connect before publishing.
  await new Promise((resolve) => setTimeout(resolve, CONNECT_WAIT_MS));
  const [eventCid] = await publish(stream, 1);
  const timer = setTimeout(() => abort.abort(), WAIT.timeout);
  await reading;
  clearTimeout(timer);
  if (commit === undefined || eventCid === undefined) {
    throw new Error("the commit never arrived on the firehose");
  }
  // `$type` is added by Subscription; the message body has no such field.
  const body = { ...commit };
  delete body.$type;
  return { commit: body, eventCid };
}

/**
 * Copy a commit so a variant can change it.
 *
 * @param commit - The captured commit.
 * @returns A copy with its own `ops` array.
 */
function copyOf(commit: CommitFrame): CommitFrame {
  return { ...commit, ops: commit.ops.map((op) => ({ ...op })) };
}

/** The four tampered copies from the #51 fixtures, made from a live commit. */
const VARIANTS: {
  name: string;
  /** What the consumer logs when it refuses the commit, if anything. */
  error: RegExp | null;
  tamper: (commit: CommitFrame, env: LocalEnv) => Promise<CommitFrame>;
}[] = [
  {
    name: "a bad signature",
    error: /Invalid signature/,
    tamper: async (commit) => {
      const car = await readCarWithRoot(commit.blocks);
      const signed = cborToLex(car.blocks.get(car.root) as Uint8Array) as {
        sig: Uint8Array;
      };
      const sig = Uint8Array.from(signed.sig);
      sig[0] = (sig[0] ?? 0) ^ 1;
      const blocks = new BlockMap(car.blocks);
      blocks.delete(car.root);
      // Re-root so every CID still matches its bytes; only the signature
      // is wrong.
      const root = await blocks.add({ ...signed, sig });
      return {
        ...commit,
        commit: root,
        blocks: await blocksToCarFile(root, blocks),
      };
    },
  },
  {
    name: "changed record bytes under the same CID",
    error: /Not a valid CID for bytes/,
    tamper: async (commit) => {
      const cid = eventOp(commit).cid as Cid;
      const car = await readCarWithRoot(commit.blocks);
      const bytes = Uint8Array.from(car.blocks.get(cid) as Uint8Array);
      bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
      return {
        ...commit,
        blocks: await blocksToCarFile(
          car.root,
          new BlockMap(car.blocks).set(cid, bytes),
        ),
      };
    },
  },
  {
    name: "an event op that claims another CID",
    // The library drops the op without an error (ADR-002).
    error: null,
    tamper: async (commit) => {
      const copy = copyOf(commit);
      const other = copy.ops.find((op) => !op.path.startsWith(EVENT_NSID));
      if (!other?.cid) throw new Error("the commit has no head op");
      eventOp(copy).cid = other.cid;
      return copy;
    },
  },
  {
    name: "a commit claimed for another DID",
    error: /Invalid repo did|Invalid signature/,
    // The witness account is a real DID on the local PLC, so its key
    // resolves and the commit itself is what gets checked.
    tamper: async (commit, env) => ({ ...commit, repo: env.WITNESS_DID }),
  },
];

/**
 * The op that creates the event record.
 *
 * @param commit - A commit with one event create.
 * @returns That op.
 */
function eventOp(commit: CommitFrame): CommitFrame["ops"][number] {
  const op = commit.ops.find((o) => o.path.startsWith(`${EVENT_NSID}/`));
  if (!op?.cid) throw new Error("the commit has no event create");
  return op;
}

/**
 * Serve a fixed list of commits as a firehose, in place of the PDS.
 *
 * @param commits - The commits to send to each client, in order.
 * @returns The relay's URL and a function that stops it.
 */
async function relay(
  commits: CommitFrame[],
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = new XrpcStreamServer({
    port: 0,
    host: "127.0.0.1",
    handler: async function* (_req: unknown, signal: AbortSignal) {
      for (const commit of commits) {
        yield new MessageFrame(commit as never, { type: "#commit" });
      }
      // Stay connected, as a live feed does, until the test is done.
      await new Promise((resolve) => {
        signal.addEventListener("abort", resolve, { once: true });
      });
    },
  });
  await new Promise((resolve) => server.wss.once("listening", resolve));
  const { port } = server.wss.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        for (const client of server.wss.clients) client.terminate();
        server.wss.close(() => resolve());
      }),
  };
}

/**
 * Collect what the consumer logs while a test runs.
 *
 * @returns The lines so far and a function that puts the console back.
 */
function captureLogs(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const real = { log: console.log, warn: console.warn, error: console.error };
  const keep = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  console.log = keep;
  console.warn = keep;
  console.error = keep;
  return { lines, restore: () => Object.assign(console, real) };
}

test("a fresh consumer rejects every tampered commit and accepts the original", async () => {
  test.setTimeout(120_000);
  const env = await requireStack();
  const stream = `e2e${Date.now().toString(36)}`;
  const { commit: original, eventCid } = await captureCommit(env, stream);
  const eventKey = eventRkey(stream, 1);
  const verifiedEvent = `verified create did=${env.PUBLISHER_DID} rkey=${eventKey} cid=${eventCid} `;
  const verifiedHead = `verified create did=${env.PUBLISHER_DID} rkey=${headRkey(stream)} `;

  for (const [index, variant] of VARIANTS.entries()) {
    await test.step(`rejects ${variant.name}`, async () => {
      const tampered = await variant.tamper(original, env);
      // The tampered commit goes first, then the original one seq later:
      // once the original is in the view, the tampered one has been handled.
      const feed = await relay([
        { ...tampered, seq: original.seq },
        { ...original, seq: original.seq + 1 },
      ]);
      const logs = captureLogs();
      const store = new ConsumerStore(":memory:");
      let firehose: RunningFirehose | undefined;
      try {
        firehose = startFirehose({
          env: { ...env, PDS_URL: feed.url },
          store,
          allow: allowlistFromEnv(env).allow,
        });

        await expect
          .poll(() => store.getEvents(env.PUBLISHER_DID, stream).length, WAIT)
          .toBe(1);
        if (variant.error !== null) {
          const refused = variant.error;
          await expect
            .poll(() => logs.lines.some((line) => refused.test(line)), WAIT)
            .toBe(true);
        } else {
          // The dropped op leaves a commit with only the head in it, so the
          // head is verified twice and the event once.
          await expect
            .poll(
              () =>
                logs.lines.filter((line) => line.includes(verifiedHead)).length,
              WAIT,
            )
            .toBe(2);
        }

        // Only the original's event was ever verified, and it is the only
        // thing in the view.
        expect(
          logs.lines.filter((line) => line.includes(`rkey=${eventKey} `)),
          `case ${index + 1}`,
        ).toEqual([expect.stringContaining(verifiedEvent)]);
        expect(
          store.getEvents(env.PUBLISHER_DID, stream).map((event) => event.cid),
        ).toEqual([eventCid]);
        expect(store.getCheckpoint().cursor).toBe(original.seq + 1);
      } finally {
        logs.restore();
        await firehose?.stop();
        store.close();
        await feed.close();
      }
    });
  }
});

test("a consumer keeps the event it verified when the publisher edits it", async () => {
  test.setTimeout(60_000);
  const env = await requireStack();
  const stream = `e2t${Date.now().toString(36)}`;
  const logs = captureLogs();
  const store = new ConsumerStore(":memory:");
  let firehose: RunningFirehose | undefined;
  try {
    firehose = startFirehose({
      env,
      store,
      allow: allowlistFromEnv(env).allow,
    });
    // A consumer with no cursor only sees commits made after it connects.
    await new Promise((resolve) => setTimeout(resolve, CONNECT_WAIT_MS));

    const published = await publish(stream, 3);
    await expect
      .poll(() => store.getEvents(env.PUBLISHER_DID, stream).length, WAIT)
      .toBe(3);

    // The tamper tool overwrites event 2 with a validly signed commit.
    const [line] = await tamperEdit(stream, 2);
    const tamperedCid = /^tampered \S+ edit seq=2 cid=(\S+)$/.exec(
      line ?? "",
    )?.[1];
    expect(tamperedCid).toBeDefined();
    expect(tamperedCid).not.toBe(published[1]);

    // The consumer sees the overwrite on the firehose...
    await expect
      .poll(
        () =>
          logs.lines.some((entry) =>
            entry.includes(
              `verified update did=${env.PUBLISHER_DID} rkey=${eventRkey(stream, 2)} cid=${tamperedCid} `,
            ),
          ),
        WAIT,
      )
      .toBe(true);
    // ...and its view still holds the three events it verified first.
    expect(
      store.getEvents(env.PUBLISHER_DID, stream).map((event) => event.cid),
    ).toEqual(published);
  } finally {
    logs.restore();
    await firehose?.stop();
    store.close();
  }
});

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import {
  allowlistFromEnv,
  ConsumerStore,
  type RunningFirehose,
  startFirehose,
} from "@trustlab/consumer";
import {
  eventRkey,
  loadLocalEnv,
  type LocalEnv,
  parseEventRecord,
} from "@trustlab/contracts";

// Story #18: as a release publisher, I can publish an event other apps can
// verify. A fresh consumer follows the PDS's firehose, where `@atproto/sync`
// checks each commit's signature and record proof, while the real `publish`
// command writes events. No browser: this drives the command line.
//
// Needs the local AT network: `npm run stack:up`.

const run = promisify(execFile);
const CONNECT_WAIT_MS = 1000;

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
 * Run the `publish` command the way a publisher would, and read back what
 * it printed.
 *
 * @param stream - Stream to publish to.
 * @param count - How many events to publish.
 * @returns The seq and CID from each `published` line, in order.
 */
async function publish(
  stream: string,
  count: number,
): Promise<{ seq: number; cid: string }[]> {
  const { stdout } = await run("npx", [
    "tsx",
    "services/publisher/src/cli.ts",
    "--stream",
    stream,
    "--count",
    String(count),
    "--seed",
    "18",
  ]);
  return stdout
    .trim()
    .split("\n")
    .map((line) => {
      const match = /^published (\S+) seq=(\d+) cid=(\S+)$/.exec(line);
      if (match === null || match[1] !== stream) {
        throw new Error(`unexpected publish output: ${line}`);
      }
      return { seq: Number(match[2]), cid: match[3] as string };
    });
}

test("a fresh consumer verifies events the publisher just published", async () => {
  test.setTimeout(60_000);
  const stack = await findStack();
  if (typeof stack === "string") {
    // Locally the stack is optional, so say why and skip. In CI a missing
    // stack is a failure, never a silent pass.
    expect(process.env.CI, stack).toBeFalsy();
    test.skip(true, stack);
    return;
  }
  const env = stack;
  const stream = `e2e${Date.now().toString(36)}`;

  // The firehose logs one `verified ...` line per write it accepted.
  const verified: string[] = [];
  const realLog = console.log;
  console.log = (...args: unknown[]) => {
    verified.push(args.map(String).join(" "));
  };

  // A fresh consumer: empty view, no checkpoint, publisher allowlisted.
  const store = new ConsumerStore(":memory:");
  let firehose: RunningFirehose | undefined;
  try {
    expect(store.getCheckpoint().cursor).toBeNull();
    firehose = startFirehose({
      env,
      store,
      allow: allowlistFromEnv(env).allow,
    });
    // A consumer with no cursor only sees commits made after it connects.
    await new Promise((resolve) => setTimeout(resolve, CONNECT_WAIT_MS));

    const published = await publish(stream, 2);
    expect(published.map((event) => event.seq)).toEqual([1, 2]);

    // The consumer ends up with both events, under the CIDs the PDS gave.
    await expect
      .poll(() => store.getEvents(env.PUBLISHER_DID, stream).length, {
        timeout: 15_000,
      })
      .toBe(2);
    const stored = store.getEvents(env.PUBLISHER_DID, stream);
    expect(stored.map((event) => event.cid)).toEqual(
      published.map((event) => event.cid),
    );

    // Each one arrived as a commit whose signature and proof checked out.
    for (const event of published) {
      expect(verified).toContainEqual(
        expect.stringContaining(
          `verified create did=${env.PUBLISHER_DID} rkey=${eventRkey(stream, event.seq)} cid=${event.cid} `,
        ),
      );
    }

    // And what it stored is a valid chain: event 2 links to event 1.
    const [first, second] = stored.map((event) =>
      parseEventRecord(event.record, event.rkey),
    );
    expect(first?.prevEventCid).toBeUndefined();
    expect(second?.prevEventCid).toBe(published[0]?.cid);
    expect(store.getCheckpoint().cursor).not.toBeNull();
  } finally {
    console.log = realLog;
    await firehose?.stop();
    store.close();
  }
});

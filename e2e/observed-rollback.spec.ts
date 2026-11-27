import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { IdResolver } from "@atproto/identity";
import { expect, test } from "@playwright/test";
import { compareWithWitness, verifyCheckpoint } from "@trustlab/auditor";
import { ConsumerStore } from "@trustlab/consumer";
import {
  loadLocalEnv,
  type LocalEnv,
  type Verdict,
  type WitnessCheckpoint,
} from "@trustlab/contracts";
import { fetchSnapshot, planRebuild } from "@trustlab/recovery";
import {
  CheckpointStore,
  type RunningWitness,
  startWitness,
} from "@trustlab/witness";

// Story #21: as an auditor, I can detect a witnessed publisher rewrite.
//
// A witness watches the real PDS while the publisher writes five events, so
// it holds a checkpoint of every head. Then the publisher rewrites or
// truncates the stream with the tamper tools (#65): validly signed writes
// that leave a valid chain. A fresh consumer rebuilds from a `getRepo`
// snapshot and audits twice, as ADR-007's A0 and A1: with no witness, the
// chain alone accepts; with the witness's checkpoints, it is a conflict.
//
// Checkpoints are checked against the key in the publisher's DID document on
// the PLC, not the key the witness stored (ADR-003 rule 3).
//
// No browser: this drives the command line. Needs the local AT network:
// `npm run stack:up`.

const run = promisify(execFile);
const CONNECT_WAIT_MS = 1000;
const WAIT = { timeout: 15_000 };
const EVENTS = 5;

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
    "21",
  );
  return lines.map((line) => {
    const match = /^published \S+ seq=\d+ cid=(\S+)$/.exec(line);
    if (match === null) throw new Error(`unexpected publish output: ${line}`);
    return match[1] as string;
  });
}

/**
 * Run a tamper tool, again if another spec's commit landed while it was
 * reading: the tool then writes nothing and says to run it again.
 *
 * @param args - Arguments after `tamper`, such as `rewrite --from 3`.
 * @returns The lines the tool printed.
 */
async function tamper(...args: string[]): Promise<string[]> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await publisher("tamper", ...args);
    } catch (error) {
      const stderr = String((error as { stderr?: unknown }).stderr);
      if (attempt === 5 || !stderr.includes("nothing was written")) throw error;
    }
  }
}

/** A witness on the real PDS, keeping checkpoints in memory. */
interface Witness {
  checkpoints: (stream: string) => WitnessCheckpoint[];
  stop: () => Promise<void>;
}

/**
 * Start a witness for the seeded publisher and wait for it to connect.
 *
 * @param env - The local environment.
 * @returns The witness.
 */
async function startTestWitness(env: LocalEnv): Promise<Witness> {
  const store = new CheckpointStore(":memory:");
  const running: RunningWitness = startWitness({
    env,
    store,
    allow: (did) => did === env.PUBLISHER_DID,
  });
  // The feed starts at the live tail, so connect before publishing.
  await new Promise((resolve) => setTimeout(resolve, CONNECT_WAIT_MS));
  return {
    checkpoints: (stream) => store.list(env.PUBLISHER_DID, stream),
    stop: async () => {
      await running.stop();
      store.close();
    },
  };
}

/**
 * Audit one stream as a fresh consumer: rebuild from a verified snapshot
 * into an empty view, then compare the chain with the checkpoints.
 *
 * @param env - The local environment.
 * @param stream - The stream to audit.
 * @param checkpoints - The witness's checkpoints; none for A0.
 * @returns The verdict.
 */
async function audit(
  env: LocalEnv,
  stream: string,
  checkpoints: readonly WitnessCheckpoint[],
): Promise<Verdict> {
  const snapshot = await fetchSnapshot({
    pdsUrl: env.PDS_URL,
    plcUrl: env.PLC_URL,
    did: env.PUBLISHER_DID,
  });
  const view = new ConsumerStore(":memory:");
  try {
    view.replaceRepo(snapshot.did, snapshot.rev, planRebuild(snapshot).events);
    return await compareWithWitness(
      view.getEvents(env.PUBLISHER_DID, stream),
      checkpoints,
      await verifierFor(env),
      snapshot.head[stream],
    );
  } finally {
    view.close();
  }
}

/**
 * Check checkpoints against the publisher's key from its DID document.
 *
 * @param env - The local environment.
 * @returns A verifier for `compareWithWitness`.
 */
async function verifierFor(
  env: LocalEnv,
): Promise<(cp: WitnessCheckpoint) => Promise<boolean>> {
  // Plain fetch: the library's default refuses the local PLC.
  const resolver = new IdResolver({
    plcUrl: env.PLC_URL,
    fetch: globalThis.fetch,
  });
  const signingKey = await resolver.did.resolveAtprotoKey(env.PUBLISHER_DID);
  return (cp) => verifyCheckpoint({ ...cp, signingKey });
}

/**
 * Publish the stream and wait until the witness holds its head.
 *
 * @param witness - The running witness.
 * @param stream - A new stream.
 * @returns The published CIDs, lowest seq first.
 */
async function publishWitnessed(
  witness: Witness,
  stream: string,
): Promise<string[]> {
  const published = await publish(stream, EVENTS);
  const head = published[EVENTS - 1];
  await expect
    .poll(
      () =>
        witness
          .checkpoints(stream)
          .some((cp) => cp.seq === EVENTS && cp.eventCid === head),
      WAIT,
    )
    .toBe(true);
  return published;
}

test("a witnessed suffix rewrite is accepted without the witness and a conflict with it", async () => {
  test.setTimeout(90_000);
  const env = await requireStack();
  const stream = `e2w${Date.now().toString(36)}`;
  const witness = await startTestWitness(env);
  try {
    const published = await publishWitnessed(witness, stream);

    // Rewrite seqs 3 to 5 with valid links, so the chain alone looks fine.
    const lines = await tamper("rewrite", "--stream", stream, "--from", "3");
    const rewrittenCid = /^tampered \S+ rewrite seq=3 cid=(\S+)$/.exec(
      lines[0] ?? "",
    )?.[1];
    expect(rewrittenCid).toBeDefined();
    expect(rewrittenCid).not.toBe(published[2]);

    await test.step("A0: no witness, the chain alone accepts", async () => {
      expect(await audit(env, stream, [])).toEqual({
        verdict: "accept",
        reason: "no-witness",
      });
    });

    await test.step("A1: the witness's checkpoints show the rewrite", async () => {
      const checkpoints = witness.checkpoints(stream);
      // Every checkpoint from an honest witness verifies against the DID
      // document's key, so the conflict is not from bad evidence.
      const verify = await verifierFor(env);
      expect(await Promise.all(checkpoints.map(verify))).not.toContain(false);
      expect(await audit(env, stream, checkpoints)).toEqual({
        verdict: "conflict",
        reason: "rewritten",
        evidence: {
          seq: 3,
          witnessedCid: published[2],
          currentCid: rewrittenCid,
        },
      });
    });
  } finally {
    await witness.stop();
  }
});

test("a witnessed truncation is accepted without the witness and a conflict with it", async () => {
  test.setTimeout(90_000);
  const env = await requireStack();
  const stream = `e2x${Date.now().toString(36)}`;
  const witness = await startTestWitness(env);
  try {
    const published = await publishWitnessed(witness, stream);

    // Delete seqs 4 and 5 and move the head back to 3.
    const [line] = await tamper("truncate", "--stream", stream, "--to", "3");
    expect(line).toBe(`tampered ${stream} truncate to=3 cid=${published[2]}`);

    await test.step("A0: no witness, the chain alone accepts", async () => {
      expect(await audit(env, stream, [])).toEqual({
        verdict: "accept",
        reason: "no-witness",
      });
    });

    await test.step("A1: the witness saw a head above the current one", async () => {
      expect(await audit(env, stream, witness.checkpoints(stream))).toEqual({
        verdict: "conflict",
        reason: "truncated",
        evidence: { seq: 4, witnessedCid: published[3] },
      });
    });
  } finally {
    await witness.stop();
  }
});

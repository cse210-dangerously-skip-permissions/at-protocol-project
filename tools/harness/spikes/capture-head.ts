/**
 * Spike for #46 (WIT-1): capture a provable stream head from the live stack,
 * then verify it offline and check that tampered copies fail.
 *
 * Run from the repo root:
 *
 *     npm run stack:up
 *     npx tsx tools/harness/spikes/capture-head.ts capture [file]
 *     npm run stack:down
 *     npx tsx tools/harness/spikes/capture-head.ts verify [file]
 *     npx tsx tools/harness/spikes/capture-head.ts sizes
 *
 * - `capture` reads raw `subscribeRepos` frames, publishes three seeded events
 *   on a fresh stream, and turns each head commit into a `WitnessCheckpoint`.
 *   It writes them to `file` (default: `wit1-capture.json` in the OS temp dir).
 * - `verify` needs no network: it replaces `fetch` with one that throws. It
 *   runs `checkCheckpoint` on the capture and on tampered copies of it.
 * - `sizes` builds signed in-memory repos of 10 to 10,000 records with the
 *   publisher's record layout and prints proof bytes for each. The repos are
 *   built from a fixed key and rev, so the bytes are the same on every run.
 *
 * Each command exits non-zero when a check comes out wrong. A spike, not
 * production code: nothing imports it and it has no unit tests.
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Secp256k1Keypair } from "@atproto/crypto";
import { IdResolver } from "@atproto/identity";
import { type Cid, parseCid } from "@atproto/lex-data";
import {
  BlockMap,
  blocksToCarFile,
  cborToLexRecord,
  cidForRecord,
  concatBytesAsync,
  def,
  formatDataKey,
  getRecords,
  MemoryBlockstore,
  MST,
  readCarWithRoot,
  Repo,
  type RecordCreateOp,
  type RecordWriteOp,
  WriteOpAction,
} from "@atproto/repo";
import { Subscription } from "@atproto/xrpc-server";
import { checkCheckpoint } from "@trustlab/auditor";
import {
  EVENT_NSID,
  eventRkey,
  HEAD_NSID,
  type HeadRecord,
  headRkey,
  loadLocalEnv,
  parseHeadRecord,
  parseWitnessCheckpoint,
  type WitnessCheckpoint,
} from "@trustlab/contracts";
import { login, makeWorkload, runPublish } from "@trustlab/publisher";

const METHOD = "com.atproto.sync.subscribeRepos";
const DEFAULT_FILE = join(tmpdir(), "wit1-capture.json");
const EVENTS = 3;
const SEED = 46;
const WAIT_MS = 10_000;

/** What `capture` writes and `verify` reads. */
interface Capture {
  /** One checkpoint per head commit seen, oldest first. Proofs are trimmed. */
  checkpoints: WitnessCheckpoint[];
  /** The newest head commit's whole frame `blocks`, base64, untrimmed. */
  frameCar: string;
  /** The witness account's signing key: real, but not the publisher's. */
  otherKey: string;
  /** Records in the publisher's repo at capture time, for the sizes table. */
  repoRecords: number;
}

/** The fields of a raw `#commit` frame that the spike uses. */
interface RawCommit {
  repo: string;
  commit: Cid;
  rev: string;
  blocks: Uint8Array;
  ops: { action: string; path: string; cid: Cid | null }[];
}

/**
 * Narrow a raw frame to a commit from one repo that writes the stream's head.
 * Frames come off the network, so the fields are checked, not assumed.
 *
 * @param msg - The frame, with `$type` set by `Subscription`.
 * @param did - The publisher's DID.
 * @param stream - The spike stream.
 * @returns The commit and its head op, or `null` for any other frame.
 */
function asHeadCommit(
  msg: unknown,
  did: string,
  stream: string,
): { frame: RawCommit; headCid: Cid } | null {
  if (typeof msg !== "object" || msg === null) return null;
  const m = msg as Record<string, unknown>;
  if (m.$type !== `${METHOD}#commit` || m.repo !== did) return null;
  if (
    typeof m.rev !== "string" ||
    !(m.blocks instanceof Uint8Array) ||
    !Array.isArray(m.ops)
  ) {
    throw new Error(`malformed #commit frame for ${did}`);
  }
  const frame = m as unknown as RawCommit;
  const path = formatDataKey(HEAD_NSID, headRkey(stream));
  const op = frame.ops.find(
    (o) => o.path === path && (o.action === "create" || o.action === "update"),
  );
  return op?.cid ? { frame, headCid: op.cid } : null;
}

/**
 * Keep only the blocks that prove one record: the signed commit, the MST
 * nodes from the root down to the record's key, and the record itself.
 *
 * @param blocks - A commit's blocks, such as a firehose frame's.
 * @param root - The commit's CID.
 * @param collection - The record's collection.
 * @param rkey - The record's key.
 * @returns The trimmed proof as CAR bytes.
 * @throws Error if a block on the path is missing.
 */
async function trimProof(
  blocks: BlockMap,
  root: Cid,
  collection: string,
  rkey: string,
): Promise<Uint8Array> {
  const store = new MemoryBlockstore(blocks);
  const commit = await store.readObj(root, def.commit);
  const mst = MST.load(store, commit.data);
  const path = await mst.cidsForPath(formatDataKey(collection, rkey));
  const proof = new BlockMap();
  for (const cid of [root, ...path]) {
    const bytes = blocks.get(cid);
    if (bytes === undefined) throw new Error(`missing block ${cid.toString()}`);
    proof.set(cid, bytes);
  }
  return blocksToCarFile(root, proof);
}

/**
 * Read the head record out of a commit's blocks.
 *
 * @param blocks - The commit's blocks.
 * @param headCid - CID of the head record.
 * @param stream - The stream, for the record key check.
 * @returns The head record, checked against the contract.
 */
function readHeadRecord(
  blocks: BlockMap,
  headCid: Cid,
  stream: string,
): HeadRecord {
  const bytes = blocks.get(headCid);
  if (bytes === undefined) throw new Error(`frame has no head block`);
  return parseHeadRecord(cborToLexRecord(bytes), headRkey(stream));
}

/**
 * Turn one head commit frame into a checkpoint with a trimmed proof.
 *
 * @param frame - The raw commit.
 * @param headCid - The head op's CID.
 * @param stream - The stream.
 * @param signingKey - The publisher's key from its DID document.
 * @returns The checkpoint.
 */
async function toCheckpoint(
  frame: RawCommit,
  headCid: Cid,
  stream: string,
  signingKey: string,
): Promise<WitnessCheckpoint> {
  const car = await readCarWithRoot(frame.blocks);
  if (!car.root.equals(frame.commit)) {
    throw new Error("frame blocks are rooted at a different commit");
  }
  const head = readHeadRecord(car.blocks, headCid, stream);
  const proof = await trimProof(
    car.blocks,
    car.root,
    HEAD_NSID,
    headRkey(stream),
  );
  return {
    did: frame.repo,
    stream,
    seq: head.seq,
    eventCid: head.eventCid,
    headCid: headCid.toString(),
    commitCid: frame.commit.toString(),
    rev: frame.rev,
    proofCar: Buffer.from(proof).toString("base64"),
    signingKey,
    // The witness's own clock. Nothing compares it, so it may vary by run.
    observedAt: new Date().toISOString(),
  };
}

/**
 * Wait until a condition holds or the time runs out.
 *
 * @param done - The condition.
 * @param ms - The most to wait.
 * @returns Whether the condition held in time.
 */
async function waitFor(done: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (!done() && Date.now() < end) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return done();
}

/**
 * Count the records in a repo by downloading it with `getRepo`.
 *
 * @param car - The repo CAR.
 * @returns The number of records.
 */
async function countRecords(car: Uint8Array): Promise<number> {
  const { root, blocks } = await readCarWithRoot(car);
  const store = new MemoryBlockstore(blocks);
  const commit = await store.readObj(root, def.commit);
  return MST.load(store, commit.data).leafCount();
}

/**
 * Capture checkpoints from the live stack and write them to a file.
 *
 * @param file - Where to write the capture.
 * @returns Whether every capture verified.
 */
async function capture(file: string): Promise<boolean> {
  const env = loadLocalEnv();
  const session = await login(env);
  const did = session.did;
  const stream = `wit${Date.now().toString(36)}`;
  const idResolver = new IdResolver({
    plcUrl: env.PLC_URL,
    fetch: globalThis.fetch,
  });

  const seen: { frame: RawCommit; headCid: Cid }[] = [];
  const abort = new AbortController();
  const sub = new Subscription<unknown>({
    service: env.PDS_URL.replace(/^http/, "ws"),
    method: METHOD,
    signal: abort.signal,
    validate: (value) => value,
  });
  const reading = (async () => {
    try {
      for await (const msg of sub) {
        const commit = asHeadCommit(msg, did, stream);
        if (commit !== null) seen.push(commit);
      }
    } catch (error) {
      if (!abort.signal.aborted) console.error("subscription:", error);
    }
  })();

  try {
    // ponytail: the feed starts at the live tail, so give the socket time to
    // open before writing. Only the last head has to be seen; earlier misses
    // are reported.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const published = await runPublish(
      { stream, count: EVENTS, seed: SEED },
      { session, log: (line) => console.log(line) },
    );
    const last = published.at(-1);
    if (last === undefined) throw new Error("published nothing");
    const arrived = await waitFor(() => seen.length >= EVENTS, WAIT_MS);
    console.log(`head commits seen: ${seen.length} of ${EVENTS}`);
    if (!arrived && seen.length === 0) {
      console.error("no head commit reached the subscription");
      return false;
    }

    const signingKey = await idResolver.did.resolveAtprotoKey(did);
    const otherKey = await idResolver.did.resolveAtprotoKey(env.WITNESS_DID);
    const checkpoints: WitnessCheckpoint[] = [];
    for (const { frame, headCid } of seen) {
      checkpoints.push(await toCheckpoint(frame, headCid, stream, signingKey));
    }
    const newest = checkpoints.at(-1);
    const newestFrame = seen.at(-1)?.frame;
    if (newest === undefined || newestFrame === undefined) return false;
    if (newest.seq !== last.seq || newest.eventCid !== last.cid) {
      console.error(
        `newest head is seq ${newest.seq} ${newest.eventCid}, expected seq ${last.seq} ${last.cid}`,
      );
      return false;
    }

    const repo = await session.agent.com.atproto.sync.getRepo({ did });
    const result: Capture = {
      checkpoints,
      frameCar: Buffer.from(newestFrame.blocks).toString("base64"),
      otherKey,
      repoRecords: await countRecords(repo.data),
    };
    await writeFile(file, `${JSON.stringify(result, null, 2)}\n`);

    let ok = true;
    for (const cp of checkpoints) {
      const check = await checkCheckpoint(cp);
      ok &&= check.valid;
      console.log(
        `seq ${cp.seq}: ${check.valid ? "verified" : `FAILED ${check.problem}`}, ` +
          `proof ${proofBytes(cp)} B`,
      );
    }
    const whole = await checkCheckpoint({
      ...newest,
      proofCar: result.frameCar,
    });
    ok &&= whole.valid;
    console.log(
      `seq ${newest.seq} with the whole frame: ${whole.valid ? "verified" : "FAILED"}, ` +
        `frame ${newestFrame.blocks.length} B`,
    );
    console.log(`publisher repo: ${result.repoRecords} records`);
    console.log(`wrote ${file}`);
    return ok;
  } finally {
    abort.abort();
    await reading;
  }
}

/**
 * Size of a checkpoint's proof CAR in bytes.
 *
 * @param cp - The checkpoint.
 * @returns The decoded `proofCar` length.
 */
function proofBytes(cp: WitnessCheckpoint): number {
  return Buffer.from(cp.proofCar, "base64").length;
}

/**
 * Flip the last byte of one block inside a CAR, leaving its CID alone.
 *
 * @param proofCar - Base64 CAR.
 * @param cid - The block to damage.
 * @returns The damaged CAR, base64.
 */
async function flipByteIn(proofCar: string, cid: string): Promise<string> {
  const car = Buffer.from(proofCar, "base64");
  const { blocks } = await readCarWithRoot(car);
  const block = blocks.get(parseCid(cid));
  if (block === undefined) throw new Error(`no block ${cid} in the proof`);
  const last = car.indexOf(block) + block.length - 1;
  car.writeUInt8(car.readUInt8(last) ^ 0x01, last);
  return car.toString("base64");
}

/**
 * Verify a capture with no network, and check that tampered copies fail.
 *
 * @param file - The capture written by `capture`.
 * @returns Whether every case came out as expected.
 */
async function verify(file: string): Promise<boolean> {
  globalThis.fetch = () =>
    Promise.reject(new Error("offline: verify must not use the network"));

  const raw = JSON.parse(await readFile(file, "utf8")) as Partial<Capture>;
  const checkpoints = (raw.checkpoints ?? []).map(parseWitnessCheckpoint);
  const cp = checkpoints.at(-1);
  const older = checkpoints.at(-2);
  if (cp === undefined || typeof raw.frameCar !== "string") {
    throw new Error(`${file} has no checkpoint; run capture first`);
  }
  if (typeof raw.otherKey !== "string") throw new Error("no otherKey");

  const cases: [string, WitnessCheckpoint, boolean][] = [
    ["the capture (trimmed proof)", cp, true],
    ["the capture (whole frame)", { ...cp, proofCar: raw.frameCar }, true],
    [
      "one byte flipped in the head record",
      { ...cp, proofCar: await flipByteIn(cp.proofCar, cp.headCid) },
      false,
    ],
    ["a different head CID", { ...cp, headCid: cp.eventCid }, false],
    ["the witness's key", { ...cp, signingKey: raw.otherKey }, false],
    ["seq one higher", { ...cp, seq: cp.seq + 1 }, false],
  ];
  if (older !== undefined) {
    cases.push(
      ["an older capture", older, true],
      [
        "the older proof under the newest claim",
        { ...cp, proofCar: older.proofCar },
        false,
      ],
    );
  }

  let ok = true;
  for (const [name, candidate, expected] of cases) {
    const check = await checkCheckpoint(candidate);
    const right = check.valid === expected;
    ok &&= right;
    const got = check.valid ? "valid" : `invalid: ${check.problem}`;
    console.log(`${right ? "ok  " : "BAD "} ${name}: ${got}`);
  }
  return ok;
}

/**
 * Build a signed repo with the publisher's layout: `events` linked events on
 * one stream and its head. One commit, a fixed key, and a fixed rev, so the
 * same `events` always gives the same bytes.
 *
 * @param events - Number of event records.
 * @param key - The signing key.
 * @returns The repo and its storage.
 */
async function buildRepo(
  events: number,
  key: Secp256k1Keypair,
): Promise<{ repo: Repo; storage: MemoryBlockstore }> {
  const stream = "releases";
  const writes: RecordCreateOp[] = [];
  let prevEventCid: string | undefined;
  for (const [index, payload] of makeWorkload(SEED, events).entries()) {
    const seq = index + 1;
    const record = {
      $type: EVENT_NSID,
      stream,
      seq,
      ...(prevEventCid === undefined ? {} : { prevEventCid }),
      kind: "release",
      payload: { ...payload },
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
    };
    prevEventCid = (await cidForRecord(record)).toString();
    writes.push({
      action: WriteOpAction.Create,
      collection: EVENT_NSID,
      rkey: eventRkey(stream, seq),
      record,
    });
  }
  writes.push({
    action: WriteOpAction.Create,
    collection: HEAD_NSID,
    rkey: headRkey(stream),
    record: { $type: HEAD_NSID, stream, seq: events, eventCid: prevEventCid },
  });
  const storage = new MemoryBlockstore();
  const commit = await Repo.formatInitCommit(
    storage,
    "did:plc:spikepublisher",
    key,
    writes,
    "3m5k2aaaaaa22",
  );
  return { repo: await Repo.createFromCommit(storage, commit), storage };
}

/**
 * Bytes a firehose frame would carry for a commit: `relevantBlocks` as a CAR.
 *
 * @param repo - The repo before the commit.
 * @param writes - The commit's writes.
 * @param key - The signing key.
 * @returns The frame's `blocks` size in bytes.
 */
async function frameBytes(
  repo: Repo,
  writes: RecordWriteOp[],
  key: Secp256k1Keypair,
): Promise<number> {
  const commit = await repo.formatCommit(writes, key);
  return (await blocksToCarFile(commit.cid, commit.relevantBlocks)).length;
}

/**
 * Print proof bytes by repo size, with the publisher's record layout.
 *
 * @returns Whether every proof verified.
 */
async function sizes(): Promise<boolean> {
  const key = await Secp256k1Keypair.import(
    createHash("sha256").update("wit-1 sizes").digest(),
  );
  console.log(
    "| Records | MST nodes on the head's path | Trimmed proof | `sync.getRecord` proof | Frame, head only | Frame, event + head | Verify (median) |",
  );
  console.log("| --- | --- | --- | --- | --- | --- | --- |");
  let ok = true;
  for (const records of [10, 100, 1_000, 10_000]) {
    const events = records - 1;
    const { repo, storage } = await buildRepo(events, key);
    const stream = "releases";
    const rkey = headRkey(stream);
    const headCid = await repo.data.get(formatDataKey(HEAD_NSID, rkey));
    if (headCid === null) throw new Error("no head");
    const blocks = storage.blocks;
    const trimmed = await trimProof(blocks, repo.cid, HEAD_NSID, rkey);
    const covering = await concatBytesAsync(
      getRecords(storage, repo.cid, [{ collection: HEAD_NSID, rkey }]),
    );
    const path = await repo.data.cidsForPath(formatDataKey(HEAD_NSID, rkey));
    const head = readHeadRecord(blocks, headCid, stream);

    // What the PDS's frame would hold for the next publish, today (#63 open:
    // the head is its own commit) and after #63 (event and head together).
    const nextHead = { ...head, seq: head.seq + 1 };
    const headOnly = await frameBytes(
      repo,
      [
        {
          action: WriteOpAction.Update,
          collection: HEAD_NSID,
          rkey,
          record: { ...nextHead },
        },
      ],
      key,
    );
    const together = await frameBytes(
      repo,
      [
        {
          action: WriteOpAction.Create,
          collection: EVENT_NSID,
          rkey: eventRkey(stream, records),
          record: {
            $type: EVENT_NSID,
            stream,
            seq: records,
            prevEventCid: head.eventCid,
            kind: "release",
            payload: { name: "next", version: "1.0.0", checksum: "sha256:00" },
            createdAt: "2026-02-01T00:00:00.000Z",
          },
        },
        {
          action: WriteOpAction.Update,
          collection: HEAD_NSID,
          rkey,
          record: { ...nextHead },
        },
      ],
      key,
    );

    const cp: WitnessCheckpoint = {
      did: "did:plc:spikepublisher",
      stream,
      seq: head.seq,
      eventCid: head.eventCid,
      headCid: headCid.toString(),
      commitCid: repo.cid.toString(),
      rev: repo.commit.rev,
      proofCar: Buffer.from(trimmed).toString("base64"),
      signingKey: key.did(),
      observedAt: "2026-11-17T00:00:00.000Z",
    };
    const times: number[] = [];
    for (let run = 0; run < 25; run += 1) {
      const start = performance.now();
      const check = await checkCheckpoint(cp);
      times.push(performance.now() - start);
      ok &&= check.valid;
    }
    times.sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)] ?? Number.NaN;

    console.log(
      `| ${records.toLocaleString("en-US")} | ${path.length - 1} | ${trimmed.length} B | ` +
        `${covering.length} B | ${headOnly} B | ${together} B | ${median.toFixed(1)} ms |`,
    );
  }
  return ok;
}

/**
 * Run one command and set the exit code from its result.
 *
 * @param argv - Command-line arguments after the script name.
 * @returns Resolves when the command is done.
 */
async function main(argv: readonly string[]): Promise<void> {
  const [command, file = DEFAULT_FILE] = argv;
  let ok: boolean;
  if (command === "capture") ok = await capture(file);
  else if (command === "verify") ok = await verify(file);
  else if (command === "sizes") ok = await sizes();
  else {
    console.error(
      "usage: capture-head.ts capture [file] | verify [file] | sizes",
    );
    ok = false;
  }
  if (!ok) process.exitCode = 1;
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

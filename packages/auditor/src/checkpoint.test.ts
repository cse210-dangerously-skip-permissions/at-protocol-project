import { createHash } from "node:crypto";
import { Secp256k1Keypair } from "@atproto/crypto";
import { parseCid } from "@atproto/lex-data";
import {
  blocksToCarFile,
  cidForRecord,
  concatBytesAsync,
  getFullRepo,
  getRecords,
  MemoryBlockstore,
  readCarWithRoot,
  Repo,
  type RecordCreateOp,
  WriteOpAction,
} from "@atproto/repo";
import {
  EVENT_NSID,
  eventRkey,
  HEAD_NSID,
  headRkey,
  type WitnessCheckpoint,
} from "@trustlab/contracts";
import { beforeAll, describe, expect, test } from "vitest";
import { checkCheckpoint, verifyCheckpoint } from "./checkpoint.js";

const DID = "did:plc:publisher";
const STREAM = "releases";
// A fixed key and rev make the commit, and so every CID below, the same on
// every run (secp256k1 signatures here are deterministic, RFC 6979).
const REV = "3m5k2aaaaaa22";

/**
 * A secp256k1 key derived from a label, so tests need no random keys.
 *
 * @param label - Any text; the same label gives the same key.
 * @returns The keypair.
 */
function fixedKey(label: string): Promise<Secp256k1Keypair> {
  return Secp256k1Keypair.import(createHash("sha256").update(label).digest());
}

/** A signed in-memory repo whose last record is the stream's head. */
interface Fixture {
  storage: MemoryBlockstore;
  repo: Repo;
  /** A checkpoint of the head, with the PDS-style `getRecord` proof. */
  checkpoint: WitnessCheckpoint;
}

/**
 * Build a publisher repo with `events` linked events and a head at the last
 * one, all in one commit signed with the "publisher" key.
 *
 * @param events - How many event records to write before the head.
 * @returns The repo and a checkpoint of its head.
 */
async function makeFixture(events: number): Promise<Fixture> {
  const key = await fixedKey("publisher");
  const writes: RecordCreateOp[] = [];
  let prevEventCid: string | undefined;
  for (let seq = 1; seq <= events; seq += 1) {
    const record = {
      $type: EVENT_NSID,
      stream: STREAM,
      seq,
      ...(prevEventCid === undefined ? {} : { prevEventCid }),
      kind: "release",
      payload: { name: "pkg", version: `1.0.${seq}`, checksum: "sha256:00" },
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
    };
    prevEventCid = (await cidForRecord(record)).toString();
    writes.push({
      action: WriteOpAction.Create,
      collection: EVENT_NSID,
      rkey: eventRkey(STREAM, seq),
      record,
    });
  }
  if (prevEventCid === undefined) throw new Error("need at least one event");
  const head = {
    $type: HEAD_NSID,
    stream: STREAM,
    seq: events,
    eventCid: prevEventCid,
  };
  writes.push({
    action: WriteOpAction.Create,
    collection: HEAD_NSID,
    rkey: headRkey(STREAM),
    record: head,
  });

  const storage = new MemoryBlockstore();
  const commit = await Repo.formatInitCommit(storage, DID, key, writes, REV);
  const repo = await Repo.createFromCommit(storage, commit);
  const proof = await concatBytesAsync(
    getRecords(storage, repo.cid, [
      { collection: HEAD_NSID, rkey: headRkey(STREAM) },
    ]),
  );
  return {
    storage,
    repo,
    checkpoint: {
      did: DID,
      stream: STREAM,
      seq: events,
      eventCid: prevEventCid,
      headCid: (await cidForRecord(head)).toString(),
      commitCid: repo.cid.toString(),
      rev: repo.commit.rev,
      proofCar: Buffer.from(proof).toString("base64"),
      signingKey: key.did(),
      observedAt: "2026-11-17T00:00:00.000Z",
    },
  };
}

/**
 * The CAR blocks of a checkpoint's proof.
 *
 * @param cp - The checkpoint.
 * @returns The root and blocks.
 */
function readProof(cp: WitnessCheckpoint) {
  return readCarWithRoot(Buffer.from(cp.proofCar, "base64"));
}

let small: Fixture;
let cp: WitnessCheckpoint;

beforeAll(async () => {
  small = await makeFixture(9);
  cp = small.checkpoint;
});

describe("verifyCheckpoint", () => {
  test("accepts the head's proof, signed by the stored key", async () => {
    expect(await checkCheckpoint(cp)).toEqual({ valid: true });
    expect(await verifyCheckpoint(cp)).toBe(true);
  });

  test("gives the same commit CID on every run", () => {
    // The fixture is deterministic, so a change here means the library or the
    // fixture changed how the commit is built.
    expect(cp.commitCid).toBe(
      "bafyreiewp6owmzf7f2ink45rmplhc3pj7gv4nipwcppjky52ce272zi4bm",
    );
  });

  test("accepts a CAR with more blocks than the proof, like a firehose frame", async () => {
    const full = await concatBytesAsync(
      getFullRepo(small.storage, small.repo.cid),
    );
    const withExtras = {
      ...cp,
      proofCar: Buffer.from(full).toString("base64"),
    };
    expect(await checkCheckpoint(withExtras)).toEqual({ valid: true });
  });

  test("accepts a head several MST levels deep", async () => {
    const large = await makeFixture(999);
    const { blocks } = await readProof(large.checkpoint);
    // The commit, the head record, and more than one MST node.
    expect(blocks.size).toBeGreaterThan(3);
    expect(await checkCheckpoint(large.checkpoint)).toEqual({ valid: true });
  });

  test("rejects a CAR with one byte flipped in the head record", async () => {
    const car = Buffer.from(cp.proofCar, "base64");
    const { blocks } = await readProof(cp);
    const record = blocks.get(parseCid(cp.headCid));
    if (record === undefined) throw new Error("fixture has no head block");
    const at = car.indexOf(record);
    expect(at).toBeGreaterThan(0);
    const last = at + record.length - 1;
    car.writeUInt8(car.readUInt8(last) ^ 0x01, last);
    const result = await checkCheckpoint({
      ...cp,
      proofCar: car.toString("base64"),
    });
    expect(result).toMatchObject({ valid: false });
  });

  test("rejects a checkpoint that claims a different head CID", async () => {
    // A real CID from the same repo, just not the head's.
    const result = await checkCheckpoint({ ...cp, headCid: cp.eventCid });
    expect(result).toEqual({
      valid: false,
      problem: `the signed commit does not have ${HEAD_NSID}/head-${STREAM} at ${cp.eventCid}`,
    });
  });

  test("rejects a checkpoint checked against a different key", async () => {
    const other = await fixedKey("someone else");
    const result = await checkCheckpoint({ ...cp, signingKey: other.did() });
    expect(result).toMatchObject({
      valid: false,
      problem: expect.stringContaining("Invalid signature"),
    });
  });

  test.each<[string, Partial<WitnessCheckpoint>, string]>([
    ["seq", { seq: 8 }, "the head record has seq 9, not 8"],
    [
      "eventCid",
      {
        eventCid: "bafyreidfayvfuwqa7qlnopdjiqrxzs6blmoeu4rujcjtnci5beludirz2a",
      },
      "the head record points at",
    ],
    ["rev", { rev: "3m5k2aaaaab22" }, `the commit has rev ${REV}`],
    ["did", { did: "did:plc:other" }, "Invalid repo did"],
    [
      "stream",
      { stream: "other" },
      "does not have dev.trustlab.head/head-other",
    ],
    [
      "commitCid",
      {
        commitCid:
          "bafyreidfayvfuwqa7qlnopdjiqrxzs6blmoeu4rujcjtnci5beludirz2a",
      },
      "the proof is for commit",
    ],
  ])(
    "rejects a %s the proof does not support",
    async (_field, change, problem) => {
      const result = await checkCheckpoint({ ...cp, ...change });
      expect(result).toMatchObject({
        valid: false,
        problem: expect.stringContaining(problem),
      });
    },
  );

  test("rejects a proof that leaves out the head record", async () => {
    const { root, blocks } = await readProof(cp);
    blocks.delete(parseCid(cp.headCid));
    const car = await blocksToCarFile(root, blocks);
    const result = await checkCheckpoint({
      ...cp,
      proofCar: Buffer.from(car).toString("base64"),
    });
    expect(result).toMatchObject({ valid: false });
  });

  test.each<[string, Partial<WitnessCheckpoint>]>([
    ["an empty proof", { proofCar: "" }],
    ["a proof that is not a CAR", { proofCar: "bm90IGEgQ0FS" }],
    ["a headCid that is not a CID", { headCid: "not-a-cid" }],
    ["a bad stream name", { stream: "Not-A-Stream" }],
    ["a signing key that is not a did:key", { signingKey: "nope" }],
  ])("returns false for %s instead of throwing", async (_name, change) => {
    await expect(verifyCheckpoint({ ...cp, ...change })).resolves.toBe(false);
  });
});

import { createHash } from "node:crypto";
import { Secp256k1Keypair } from "@atproto/crypto";
import {
  blocksToCarFile,
  cidForRecord,
  MemoryBlockstore,
  readCarWithRoot,
  Repo,
  WriteOpAction,
} from "@atproto/repo";
import { checkCheckpoint } from "@trustlab/auditor";
import {
  HEAD_NSID,
  headRkey,
  type LocalEnv,
  type WitnessCheckpoint,
} from "@trustlab/contracts";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { COMMIT_TYPE } from "./capture.js";
import { startWitness } from "./witness.js";

// Stand-ins for the network: the frames the PDS would send, and the key
// lookup on PLC.
const lib = vi.hoisted(() => ({
  frames: [] as unknown[],
  resolveKey: vi.fn<(did: string, force?: boolean) => Promise<string>>(),
}));
vi.mock("@atproto/xrpc-server", () => ({
  Subscription: class {
    async *[Symbol.asyncIterator]() {
      yield* lib.frames;
    }
  },
}));
vi.mock("@atproto/identity", () => ({
  IdResolver: class {
    did = { resolveAtprotoKey: lib.resolveKey };
  },
  MemoryCache: class {},
}));

const DID = "did:plc:publisher";
const STREAM = "releases";
// Any well-formed CID; this one is the example in lexicons/README.md.
const EVENT_CID = "bafyreidfayvfuwqa7qlnopdjiqrxzs6blmoeu4rujcjtnci5beludirz2a";
const env = {
  PDS_URL: "http://localhost:2583",
  PLC_URL: "http://localhost:2582",
} as LocalEnv;

let key: Secp256k1Keypair;
let frame: Record<string, unknown>;
let headCid: string;
let added: WitnessCheckpoint[];

/**
 * A secp256k1 key derived from a label, so tests need no random keys.
 *
 * @param label - Any text; the same label gives the same key.
 * @returns The keypair.
 */
function fixedKey(label: string): Promise<Secp256k1Keypair> {
  return Secp256k1Keypair.import(createHash("sha256").update(label).digest());
}

/**
 * Feed frames through a witness and wait until it has handled them all.
 *
 * @param frames - What the PDS sends.
 */
async function run(...frames: unknown[]): Promise<void> {
  lib.frames = frames;
  await startWitness({
    env,
    store: { add: (cp) => (added.push(cp), "stored") },
    allow: (did) => did === DID,
  }).stop();
}

beforeAll(async () => {
  // A signed commit that creates the head, as the PDS would emit it.
  key = await fixedKey("publisher");
  const head = {
    $type: HEAD_NSID,
    stream: STREAM,
    seq: 1,
    eventCid: EVENT_CID,
  };
  const commit = await Repo.formatInitCommit(
    new MemoryBlockstore(),
    DID,
    key,
    [
      {
        action: WriteOpAction.Create,
        collection: HEAD_NSID,
        rkey: headRkey(STREAM),
        record: head,
      },
    ],
    "3m5k2aaaaaa22",
  );
  const cid = await cidForRecord(head);
  headCid = cid.toString();
  frame = {
    $type: COMMIT_TYPE,
    repo: DID,
    commit: commit.cid,
    rev: commit.rev,
    blocks: await blocksToCarFile(commit.cid, commit.newBlocks),
    ops: [{ action: "create", path: `${HEAD_NSID}/${headRkey(STREAM)}`, cid }],
  };
});

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  lib.resolveKey.mockReset().mockResolvedValue(key.did());
  added = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

test("stores a checkpoint of a head update that verifies offline", async () => {
  await run(frame);

  expect(added).toHaveLength(1);
  const [cp] = added;
  expect(cp).toMatchObject({
    did: DID,
    stream: STREAM,
    seq: 1,
    eventCid: EVENT_CID,
    headCid,
    rev: frame.rev,
    signingKey: key.did(),
  });
  expect(await checkCheckpoint(cp!)).toEqual({ valid: true });
});

test("logs and stores nothing when one byte of the frame is changed", async () => {
  const blocks = Buffer.from(frame.blocks as Uint8Array);
  const record = (await readCarWithRoot(blocks)).blocks.get(
    (frame.ops as { cid: never }[])[0]!.cid,
  );
  const last = blocks.indexOf(record!) + record!.length - 1;
  blocks.writeUInt8(blocks.readUInt8(last) ^ 0x01, last);

  await run({ ...frame, blocks: new Uint8Array(blocks) });

  expect(added).toEqual([]);
  expect(console.error).toHaveBeenCalledWith(
    `witness: not stored did=${DID} rev=${String(frame.rev)} stream=${STREAM}:`,
    expect.any(String),
  );
});

test("refetches the key once when the cached one fails", async () => {
  const stale = await fixedKey("old key");
  lib.resolveKey.mockResolvedValueOnce(stale.did());

  await run(frame);

  expect(lib.resolveKey).toHaveBeenLastCalledWith(DID, true);
  expect(added.map((cp) => cp.signingKey)).toEqual([key.did()]);
});

test("ignores other DIDs and skips malformed frames", async () => {
  await run(
    { ...frame, repo: "did:plc:stranger" },
    { $type: COMMIT_TYPE, repo: DID, rev: 5 },
    { $type: "com.atproto.sync.subscribeRepos#identity", did: DID },
    frame,
  );

  expect(added).toHaveLength(1);
  expect(console.error).toHaveBeenCalledWith(
    "witness: skipped frame:",
    expect.any(Error),
  );
});

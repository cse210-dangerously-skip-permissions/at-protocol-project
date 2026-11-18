import { type Cid, isCid } from "@atproto/lex-data";
import {
  BlockMap,
  blocksToCarFile,
  cborToLexRecord,
  def,
  formatDataKey,
  MemoryBlockstore,
  MST,
  readCarWithRoot,
} from "@atproto/repo";
import {
  HEAD_NSID,
  headRkey,
  parseHeadRecord,
  parseHeadRkey,
  type WitnessCheckpoint,
} from "@trustlab/contracts";

/** `$type` of a commit frame on `com.atproto.sync.subscribeRepos`. */
export const COMMIT_TYPE = "com.atproto.sync.subscribeRepos#commit";

/** A commit frame that writes at least one stream head. */
export interface HeadCommit {
  /** The repo's DID. */
  repo: string;
  /** CID of the signed commit. */
  commit: Cid;
  /** Repo revision of the commit. */
  rev: string;
  /** The frame's blocks, as a CAR rooted at the commit. */
  blocks: Uint8Array;
  /** Each head the commit creates or updates. */
  heads: { stream: string; cid: Cid }[];
}

/**
 * Pick out the head writes in a raw firehose frame. Frames come off the
 * network, so every field is checked, not assumed.
 *
 * @param msg - The frame, with `$type` set by `Subscription`.
 * @param allow - Which repo DIDs to watch.
 * @returns The commit and its heads, or `null` for a frame we don't watch.
 * @throws Error if a watched repo's commit frame is malformed.
 */
export function readHeadCommit(
  msg: unknown,
  allow: (did: string) => boolean,
): HeadCommit | null {
  if (typeof msg !== "object" || msg === null) return null;
  const m = msg as Record<string, unknown>;
  if (m.$type !== COMMIT_TYPE) return null;
  if (typeof m.repo !== "string" || !allow(m.repo)) return null;
  if (
    !isCid(m.commit) ||
    typeof m.rev !== "string" ||
    !(m.blocks instanceof Uint8Array) ||
    !Array.isArray(m.ops)
  ) {
    throw new Error(`malformed #commit frame for ${m.repo}`);
  }

  const heads: HeadCommit["heads"] = [];
  for (const op of m.ops as unknown[]) {
    if (typeof op !== "object" || op === null) {
      throw new Error(`malformed op in #commit frame for ${m.repo}`);
    }
    const { action, path, cid } = op as Record<string, unknown>;
    if (typeof path !== "string") {
      throw new Error(`malformed op in #commit frame for ${m.repo}`);
    }
    const [collection, rkey = ""] = path.split("/");
    if (collection !== HEAD_NSID) continue;
    if (action !== "create" && action !== "update") continue;
    const stream = parseHeadRkey(rkey);
    if (stream === null || !isCid(cid)) {
      throw new Error(`malformed head op ${path} for ${m.repo}`);
    }
    heads.push({ stream, cid });
  }
  if (heads.length === 0) return null;
  return {
    repo: m.repo,
    commit: m.commit,
    rev: m.rev,
    blocks: m.blocks,
    heads,
  };
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
export async function trimProof(
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
 * Turn one head write into a checkpoint with a trimmed proof. Nothing here
 * checks the signature; run `checkCheckpoint` on the result.
 *
 * @param commit - The commit frame.
 * @param head - One of its heads.
 * @param signingKey - The publisher's key from its DID document.
 * @returns The checkpoint.
 * @throws Error if the blocks don't hold the commit or a valid head record.
 */
export async function toCheckpoint(
  commit: HeadCommit,
  head: HeadCommit["heads"][number],
  signingKey: string,
): Promise<WitnessCheckpoint> {
  const car = await readCarWithRoot(commit.blocks);
  if (!car.root.equals(commit.commit)) {
    throw new Error("frame blocks are rooted at a different commit");
  }
  const rkey = headRkey(head.stream);
  const bytes = car.blocks.get(head.cid);
  if (bytes === undefined) throw new Error("frame has no head block");
  const record = parseHeadRecord(cborToLexRecord(bytes), rkey);
  const proof = await trimProof(car.blocks, car.root, HEAD_NSID, rkey);
  return {
    did: commit.repo,
    stream: head.stream,
    seq: record.seq,
    eventCid: record.eventCid,
    headCid: head.cid.toString(),
    commitCid: commit.commit.toString(),
    rev: commit.rev,
    proofCar: Buffer.from(proof).toString("base64"),
    signingKey,
    observedAt: new Date().toISOString(),
  };
}

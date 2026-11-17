import { parseCidSafe } from "@atproto/lex-data";
import {
  cborToLexRecord,
  def,
  MemoryBlockstore,
  readCarWithRoot,
  verifyProofs,
} from "@atproto/repo";
import {
  HEAD_NSID,
  headRkey,
  parseHeadRecord,
  type WitnessCheckpoint,
} from "@trustlab/contracts";

/** The result of checking a witness checkpoint: valid, or the first problem found. */
export type CheckpointCheck =
  | { valid: true }
  | {
      valid: false;
      /** What failed, such as a bad signature or a field the proof does not support. */
      problem: string;
    };

/**
 * Check a witness checkpoint offline and say why it fails, if it does.
 *
 * It needs no network and no PDS. The checkpoint is valid only if all of these hold:
 *
 * - every block in `proofCar` matches its CID, and the CAR's root is `commitCid`;
 * - that commit is for `did`, has revision `rev`, and is signed by `signingKey`;
 * - the commit's MST maps `dev.trustlab.head/head-<stream>` to `headCid`;
 * - the head record in the CAR has the checkpoint's `stream`, `seq`, and `eventCid`.
 *
 * The proof is checked against `signingKey`, the key the witness stored. Trusting
 * that key is the caller's decision: ADR-003 rule 3 checks against the publisher's
 * DID document instead, which a caller does with
 * `checkCheckpoint({ ...cp, signingKey: keyFromDidDocument })`.
 *
 * @param cp - The checkpoint, as the witness stored it.
 * @returns `{ valid: true }`, or `{ valid: false, problem }`. It never throws.
 */
export async function checkCheckpoint(
  cp: WitnessCheckpoint,
): Promise<CheckpointCheck> {
  try {
    const problem = await findProblem(cp);
    return problem === null ? { valid: true } : { valid: false, problem };
  } catch (error) {
    // The library throws for a bad signature, a wrong DID, a block that does
    // not match its CID, or a missing block, where a wrong CID only comes back
    // `unverified`. Each one means the checkpoint does not hold.
    return {
      valid: false,
      problem: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Offline: no network, no PDS. True only if the proof shows the head record
 * had `headCid` in a commit signed by `signingKey`, and the head record says
 * what the checkpoint says. See `checkCheckpoint` for the full list of checks
 * and for which key to trust.
 *
 * @param cp - The checkpoint, as the witness stored it.
 * @returns Whether the checkpoint holds. It never throws.
 */
export async function verifyCheckpoint(
  cp: WitnessCheckpoint,
): Promise<boolean> {
  return (await checkCheckpoint(cp)).valid;
}

/**
 * Run the checks in order and describe the first that fails.
 *
 * @param cp - The checkpoint.
 * @returns The problem, or `null` if every check passes.
 * @throws Error from `@atproto/repo` for a bad signature, wrong DID, or bad block.
 */
async function findProblem(cp: WitnessCheckpoint): Promise<string | null> {
  const bytes = Buffer.from(cp.proofCar, "base64");
  // Checks each block against its CID, so a flipped byte fails here.
  const car = await readCarWithRoot(bytes);
  if (car.root.toString() !== cp.commitCid) {
    return `the proof is for commit ${car.root.toString()}, not ${cp.commitCid}`;
  }

  const headCid = parseCidSafe(cp.headCid);
  if (headCid === null) return `headCid is not a CID: ${cp.headCid}`;
  const rkey = headRkey(cp.stream);
  const { unverified } = await verifyProofs(
    bytes,
    [{ collection: HEAD_NSID, rkey, cid: headCid }],
    cp.did,
    cp.signingKey,
  );
  if (unverified.length > 0) {
    return `the signed commit does not have ${HEAD_NSID}/${rkey} at ${cp.headCid}`;
  }

  // verifyProofs checks the signature but does not return the commit.
  const commit = await new MemoryBlockstore(car.blocks).readObj(
    car.root,
    def.commit,
  );
  if (commit.rev !== cp.rev) {
    return `the commit has rev ${commit.rev}, not ${cp.rev}`;
  }

  // verifyProofs already read this block, so it is present and matches headCid.
  const recordBytes = car.blocks.get(headCid);
  if (recordBytes === undefined) return `the proof has no block ${cp.headCid}`;
  const head = parseHeadRecord(cborToLexRecord(recordBytes), rkey);
  if (head.seq !== cp.seq) {
    return `the head record has seq ${head.seq}, not ${cp.seq}`;
  }
  if (head.eventCid !== cp.eventCid) {
    return `the head record points at ${head.eventCid}, not ${cp.eventCid}`;
  }
  return null;
}

import type {
  HeadRecord,
  StoredEvent,
  Verdict,
  WitnessCheckpoint,
} from "@trustlab/contracts";
import { validateChain } from "./chain.js";
import { verifyCheckpoint } from "./checkpoint.js";

/** Checks one checkpoint offline. `verifyCheckpoint` is the default. */
export type CheckpointVerifier = (cp: WitnessCheckpoint) => Promise<boolean>;

/**
 * Audit one publisher stream against what a witness saw, following the rule
 * order in ADR-003. The first rule that matches wins:
 *
 * 1. `unknown` (`pds-unreachable`) when `events` is `"unreachable"`: there is
 *    no chain to check.
 * 2. `validateChain(events, head)`'s `conflict`, returned unchanged. A broken
 *    chain needs no witness, so this comes before the witness checks.
 * 3. `unknown` (`witness-unreachable`) when `checkpoints` is `"unreachable"`.
 * 4. `conflict` from a checkpoint that passes `verify`: the current head is
 *    below the witnessed seq (`truncated`), or the event at the witnessed seq
 *    has another CID (`rewritten`). Every checkpoint is checked, not only the
 *    newest, because the newest may postdate the rewrite.
 * 5. `unknown` (`bad-evidence`) when any checkpoint fails `verify`, or is for
 *    another DID or stream than `events`. A bad witness can never cause a
 *    `conflict`, so it cannot frame a publisher.
 * 6. `accept`: `extends-witness` when there are checkpoints, `no-witness`
 *    (a chain-only result) when there are none.
 *
 * The result does not depend on the order of `events` or `checkpoints`. When
 * several checkpoints conflict, the lowest witnessed seq is reported, as
 * `validateChain` reports the first broken seq.
 *
 * The default `verify` checks each proof against the `signingKey` the witness
 * stored. ADR-003 rule 3 trusts the key in the publisher's DID document
 * instead, so an AT caller passes
 * `(cp) => verifyCheckpoint({ ...cp, signingKey: keyFromDidDocument })`.
 * A `verify` that throws counts as a failed check.
 *
 * With no events there is no DID or stream to compare the checkpoints with,
 * so the caller must pass only the checkpoints for the stream it audits.
 *
 * @param events - Every event of one DID and stream, in any order, or
 *   `"unreachable"` when the PDS could not be read.
 * @param checkpoints - The witness's checkpoints for that stream, or
 *   `"unreachable"` when the witness could not be read.
 * @param verify - Checks one checkpoint offline.
 * @param head - The stream's current head record, when the caller has it.
 * @returns The verdict, with the witnessed and current CIDs as evidence for
 *   a witness conflict.
 */
export async function compareWithWitness(
  events: readonly StoredEvent[] | "unreachable",
  checkpoints: readonly WitnessCheckpoint[] | "unreachable",
  verify: CheckpointVerifier = verifyCheckpoint,
  head?: HeadRecord,
): Promise<Verdict> {
  if (events === "unreachable") {
    return { verdict: "unknown", reason: "pds-unreachable" };
  }
  const chain = validateChain(events, head);
  if (chain.verdict === "conflict") return chain;
  if (checkpoints === "unreachable") {
    return { verdict: "unknown", reason: "witness-unreachable" };
  }
  if (checkpoints.length === 0) {
    return { verdict: "accept", reason: "no-witness" };
  }

  // Lowest seq first, so the evidence picked below does not depend on the
  // order the witness returned them in. Two checkpoints at one seq (the
  // witness saw a rewrite) are ordered by CID.
  const ordered = [...checkpoints].sort(
    (left, right) =>
      left.seq - right.seq || compareStrings(left.eventCid, right.eventCid),
  );
  const subject = events[0];
  const checks = await Promise.all(
    ordered.map(async (cp) => {
      const sameStream =
        subject === undefined ||
        (cp.did === subject.did && cp.stream === subject.stream);
      return sameStream && (await safely(verify, cp));
    }),
  );

  const cidAt = new Map(events.map((event) => [event.seq, event.cid]));
  // validateChain accepted, so the events run 1..n with no gaps and the
  // current head is the highest seq (0 for an empty stream).
  let headSeq = 0;
  for (const seq of cidAt.keys()) headSeq = Math.max(headSeq, seq);
  for (const [index, cp] of ordered.entries()) {
    if (checks[index] !== true) continue;
    if (cp.seq > headSeq) {
      return witnessConflict("truncated", cp, undefined);
    }
    const currentCid = cidAt.get(cp.seq);
    if (currentCid !== cp.eventCid) {
      return witnessConflict("rewritten", cp, currentCid);
    }
  }

  const failed = ordered.find((_cp, index) => checks[index] !== true);
  if (failed !== undefined) {
    return {
      verdict: "unknown",
      reason: "bad-evidence",
      evidence: { seq: failed.seq, witnessedCid: failed.eventCid },
    };
  }
  return { verdict: "accept", reason: "extends-witness" };
}

/**
 * Build a conflict from a verified checkpoint the chain contradicts.
 *
 * @param reason - `truncated` or `rewritten`.
 * @param cp - The checkpoint.
 * @param currentCid - The CID the stream has at that seq now, if any.
 * @returns The conflict verdict.
 */
function witnessConflict(
  reason: "truncated" | "rewritten",
  cp: WitnessCheckpoint,
  currentCid: string | undefined,
): Verdict {
  return {
    verdict: "conflict",
    reason,
    evidence: {
      seq: cp.seq,
      witnessedCid: cp.eventCid,
      ...(currentCid === undefined ? {} : { currentCid }),
    },
  };
}

/**
 * Run a verifier and treat a throw as a failed check.
 *
 * @param verify - The verifier.
 * @param cp - The checkpoint to check.
 * @returns Whether the checkpoint verified.
 */
async function safely(
  verify: CheckpointVerifier,
  cp: WitnessCheckpoint,
): Promise<boolean> {
  try {
    return (await verify(cp)) === true;
  } catch {
    return false;
  }
}

/**
 * Order two strings by code unit, the same on every machine.
 *
 * @param left - First string.
 * @param right - Second string.
 * @returns Negative, zero, or positive, as `Array.prototype.sort` expects.
 */
function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

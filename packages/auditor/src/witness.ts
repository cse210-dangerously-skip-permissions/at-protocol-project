import type {
  HeadRecord,
  StoredEvent,
  Verdict,
  WitnessCheckpoint,
} from "@trustlab/contracts";
import { validateChain } from "./chain.js";

/**
 * Checks one checkpoint offline. On AT, build it from `verifyCheckpoint` with
 * the key from the publisher's DID document (ADR-003 rule 3).
 */
export type CheckpointVerifier = (cp: WitnessCheckpoint) => Promise<boolean>;

/** The publisher stream being audited. */
export interface AuditSubject {
  /** Publisher DID. */
  did: string;
  /** Stream name. */
  stream: string;
}

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
 * 5. `unknown` (`bad-evidence`) when any checkpoint fails `verify`, is for
 *    another DID or stream than `subject`, or there is no `verify` to check
 *    it with. A bad witness can never cause a `conflict`, so it cannot frame
 *    a publisher.
 * 6. `accept`: `extends-witness` when there are checkpoints, `no-witness`
 *    (a chain-only result) when there are none.
 *
 * The result does not depend on the order of `events` or `checkpoints`. When
 * several checkpoints conflict, the lowest witnessed seq is reported, as
 * `validateChain` reports the first broken seq.
 *
 * There is no default `verify`. `verifyCheckpoint` alone checks a proof
 * against the `signingKey` the witness stored, and a witness can store its
 * own key, so passing it would let a witness frame a publisher. An AT caller
 * passes `(cp) => verifyCheckpoint({ ...cp, signingKey: keyFromDidDocument })`.
 * Without checkpoints, `verify` is not needed. A `verify` that throws counts
 * as a failed check.
 *
 * `subject` is what the checkpoints are checked against, so an empty chain
 * still rejects a signed checkpoint from another stream.
 *
 * @param subject - The DID and stream being audited.
 * @param events - Every event of `subject`, in any order, or
 *   `"unreachable"` when the PDS could not be read.
 * @param checkpoints - The witness's checkpoints for `subject`, or
 *   `"unreachable"` when the witness could not be read.
 * @param verify - Checks one checkpoint offline. Required for any checkpoint
 *   to count.
 * @param head - The stream's current head record, when the caller has it.
 * @returns The verdict, with the witnessed and current CIDs as evidence for
 *   a witness conflict.
 * @throws Error if an event is for another DID or stream than `subject`.
 */
export async function compareWithWitness(
  subject: AuditSubject,
  events: readonly StoredEvent[] | "unreachable",
  checkpoints: readonly WitnessCheckpoint[] | "unreachable",
  verify?: CheckpointVerifier,
  head?: HeadRecord,
): Promise<Verdict> {
  if (events === "unreachable") {
    return { verdict: "unknown", reason: "pds-unreachable" };
  }
  const stranger = events.find((event) => !isSubject(event, subject));
  if (stranger !== undefined) {
    throw new Error(
      `event ${stranger.did}/${stranger.stream} passed to an audit of ${subject.did}/${subject.stream}`,
    );
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
  const checks = await Promise.all(
    ordered.map(
      async (cp) =>
        verify !== undefined &&
        isSubject(cp, subject) &&
        (await safely(verify, cp)),
    ),
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
 * Whether an event or checkpoint belongs to the audited stream.
 *
 * @param item - Anything with a DID and stream.
 * @param subject - The audited DID and stream.
 * @returns True when both match.
 */
function isSubject(item: AuditSubject, subject: AuditSubject): boolean {
  return item.did === subject.did && item.stream === subject.stream;
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

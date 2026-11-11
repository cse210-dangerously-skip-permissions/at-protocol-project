import { type LexiconDoc, Lexicons } from "@atproto/lexicon";
import eventLexicon from "@trustlab/lexicons/dev/trustlab/event.json" with { type: "json" };
import headLexicon from "@trustlab/lexicons/dev/trustlab/head.json" with { type: "json" };
import {
  EVENT_NSID,
  eventRkey,
  HEAD_NSID,
  headRkey,
  isSeq,
  isStreamName,
} from "./keys.js";
import {
  type CheckpointsResponse,
  EVENT_KINDS,
  type EventKind,
  type EventRecord,
  type HeadRecord,
  type WitnessCheckpoint,
} from "./types.js";

/** Thrown when a value read off the network does not match its contract. */
export class ContractError extends Error {
  /**
   * @param what - What was being read, such as `event record`.
   * @param problem - What is wrong with it.
   */
  constructor(what: string, problem: string) {
    super(`invalid ${what}: ${problem}`);
    this.name = "ContractError";
  }
}

const lexicons = new Lexicons([
  eventLexicon as LexiconDoc,
  headLexicon as LexiconDoc,
]);

/**
 * Check a value against a record Lexicon.
 *
 * @param what - What is being read, for the error message.
 * @param nsid - The record's collection.
 * @param value - The value to check.
 */
function assertLexicon(what: string, nsid: string, value: unknown): void {
  try {
    lexicons.assertValidRecord(nsid, value);
  } catch (error) {
    throw new ContractError(
      what,
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * Validate an event record read from a repo, the firehose, or a snapshot.
 *
 * Checks the Lexicon, then the rules a Lexicon can't express: the stream
 * name, the link rule (no `prevEventCid` at seq 1, one after it), the
 * `refSeq` rule for corrections and withdrawals, and, when a record key is
 * given, that the key matches the record.
 *
 * @param value - The record, with its `$type`.
 * @param rkey - The record key it was stored under, if known.
 * @returns The same value, typed.
 * @throws ContractError if the record breaks the contract.
 */
export function parseEventRecord(value: unknown, rkey?: string): EventRecord {
  const what = "event record";
  assertLexicon(what, EVENT_NSID, value);
  const record = value as EventRecord;
  if (!isStreamName(record.stream)) {
    throw new ContractError(what, `bad stream name "${record.stream}"`);
  }
  if (!isSeq(record.seq)) {
    throw new ContractError(what, `seq ${record.seq} is out of range`);
  }
  if (!EVENT_KINDS.includes(record.kind as EventKind)) {
    throw new ContractError(what, `unknown kind "${record.kind}"`);
  }
  if (record.seq === 1 && record.prevEventCid !== undefined) {
    throw new ContractError(what, "seq 1 must not have prevEventCid");
  }
  if (record.seq > 1 && record.prevEventCid === undefined) {
    throw new ContractError(what, `seq ${record.seq} must have prevEventCid`);
  }
  if (record.kind === "release") {
    if (record.refSeq !== undefined) {
      throw new ContractError(what, "a release must not have refSeq");
    }
  } else if (record.refSeq === undefined || record.refSeq >= record.seq) {
    throw new ContractError(
      what,
      `a ${record.kind} needs a refSeq lower than its seq`,
    );
  }
  if (rkey !== undefined && rkey !== eventRkey(record.stream, record.seq)) {
    throw new ContractError(
      what,
      `record key ${rkey} does not match ${record.stream} seq ${record.seq}`,
    );
  }
  return record;
}

/**
 * Validate a stream-head record read from a repo, the firehose, or a snapshot.
 *
 * @param value - The record, with its `$type`.
 * @param rkey - The record key it was stored under, if known.
 * @returns The same value, typed.
 * @throws ContractError if the record breaks the contract.
 */
export function parseHeadRecord(value: unknown, rkey?: string): HeadRecord {
  const what = "head record";
  assertLexicon(what, HEAD_NSID, value);
  const record = value as HeadRecord;
  if (!isStreamName(record.stream)) {
    throw new ContractError(what, `bad stream name "${record.stream}"`);
  }
  if (!isSeq(record.seq)) {
    throw new ContractError(what, `seq ${record.seq} is out of range`);
  }
  if (rkey !== undefined && rkey !== headRkey(record.stream)) {
    throw new ContractError(
      what,
      `record key ${rkey} does not match stream ${record.stream}`,
    );
  }
  return record;
}

const CHECKPOINT_STRING_FIELDS = [
  "did",
  "stream",
  "eventCid",
  "headCid",
  "commitCid",
  "rev",
  "proofCar",
  "signingKey",
  "observedAt",
] as const satisfies readonly (keyof WitnessCheckpoint)[];

/**
 * Validate the shape of one witness checkpoint. This checks field types only;
 * whether the proof inside it holds is the auditor's job.
 *
 * @param value - The value to check.
 * @returns The same value, typed.
 * @throws ContractError if a field is missing or has the wrong type.
 */
export function parseWitnessCheckpoint(value: unknown): WitnessCheckpoint {
  const what = "witness checkpoint";
  if (typeof value !== "object" || value === null) {
    throw new ContractError(what, "not an object");
  }
  const fields = value as Record<string, unknown>;
  for (const name of CHECKPOINT_STRING_FIELDS) {
    if (typeof fields[name] !== "string" || fields[name] === "") {
      throw new ContractError(what, `${name} must be a non-empty string`);
    }
  }
  if (typeof fields.seq !== "number" || !isSeq(fields.seq)) {
    throw new ContractError(what, "seq must be a positive integer");
  }
  if (!isStreamName(fields.stream as string)) {
    throw new ContractError(what, `bad stream name "${String(fields.stream)}"`);
  }
  return value as WitnessCheckpoint;
}

/**
 * Validate the witness API's `GET /checkpoints` response.
 *
 * @param value - The parsed JSON body.
 * @returns The same value, typed.
 * @throws ContractError if the body or any checkpoint is malformed.
 */
export function parseCheckpointsResponse(value: unknown): CheckpointsResponse {
  const checkpoints = (value as { checkpoints?: unknown } | null)?.checkpoints;
  if (!Array.isArray(checkpoints)) {
    throw new ContractError(
      "checkpoints response",
      "checkpoints must be an array",
    );
  }
  checkpoints.forEach(parseWitnessCheckpoint);
  return value as CheckpointsResponse;
}

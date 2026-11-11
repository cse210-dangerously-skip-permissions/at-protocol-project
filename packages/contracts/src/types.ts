/** What an event does. Corrections and withdrawals are new events, never edits. */
export type EventKind = "release" | "correct" | "withdraw";

/** Every event kind, for validation and iteration. */
export const EVENT_KINDS: readonly EventKind[] = [
  "release",
  "correct",
  "withdraw",
];

/** A synthetic software release, the payload of every event. */
export interface Payload {
  name: string;
  version: string;
  checksum: string;
}

/** An event record (`dev.trustlab.event`) as stored in a publisher's repo. */
export interface EventRecord {
  $type: "dev.trustlab.event";
  /** Stream name, such as `releases`. */
  stream: string;
  /** Position in the stream, from 1. */
  seq: number;
  /** CID of the event record at `seq - 1`. Absent only at seq 1. */
  prevEventCid?: string;
  kind: EventKind;
  /** For `correct` and `withdraw`: the seq of the event this one refers to. */
  refSeq?: number;
  payload: Payload;
  /** ISO 8601 time. */
  createdAt: string;
}

/** A stream-head record (`dev.trustlab.head`): the latest event of a stream. */
export interface HeadRecord {
  $type: "dev.trustlab.head";
  stream: string;
  /** The seq of the latest event. */
  seq: number;
  /** CID of the event record at that seq. */
  eventCid: string;
}

/** One event record as a consumer keeps it in its view. */
export interface StoredEvent {
  /** DID of the publisher's repo. */
  did: string;
  /** Stream name, such as `releases`. */
  stream: string;
  /** Position in the stream, from 1. */
  seq: number;
  /** Record key in the repo, such as `releases-000000000042`. */
  rkey: string;
  /** CID of the record, as a string. */
  cid: string;
  /** The record itself, in a JSON-serializable form. */
  record: unknown;
}

/** Where a consumer got to: the feed cursor and the last rev per DID. */
export interface ConsumerCheckpoint {
  /** Last firehose sequence number applied, or `null` before the first one. */
  cursor: number | null;
  /** Last applied repo revision, keyed by DID. */
  revs: Record<string, string>;
}

/** The three outcomes of an audit. */
export type VerdictKind = "accept" | "conflict" | "unknown";

/** Every verdict kind, for validation and iteration. */
export const VERDICT_KINDS: readonly VerdictKind[] = [
  "accept",
  "conflict",
  "unknown",
];

/** The result of auditing one `(DID, stream)`. */
export interface Verdict {
  verdict: VerdictKind;
  /** Short machine-readable code, such as `broken-link` or `no-witness`. */
  reason: string;
  /** Where the audit found a problem, when it found one. */
  evidence?: {
    seq: number;
    /** CID the witness saw at that seq. */
    witnessedCid?: string;
    /** CID the publisher's repo has at that seq now. */
    currentCid?: string;
  };
}

/**
 * What a witness keeps for one observed stream-head update: enough to prove
 * later, offline, that the publisher signed a repo in which the head record
 * had this content.
 */
export interface WitnessCheckpoint {
  /** DID of the publisher. */
  did: string;
  stream: string;
  /** The seq the head record held. */
  seq: number;
  /** The event CID the head record pointed at. */
  eventCid: string;
  /** CID of the head record itself. */
  headCid: string;
  /** CID of the signed commit. */
  commitCid: string;
  /** Repo revision of that commit. */
  rev: string;
  /** Base64 CAR file: the signed commit block, the MST proof blocks, and the head record. */
  proofCar: string;
  /** The publisher's signing key when observed, as a `did:key`. */
  signingKey: string;
  /** ISO 8601 time the witness saw the commit. */
  observedAt: string;
}

/** Response of the witness's `GET /checkpoints?did=&stream=`, newest first. */
export interface CheckpointsResponse {
  checkpoints: WitnessCheckpoint[];
}

/** The variables in `.env.local`, written by `npm run stack:seed`. */
export interface LocalEnv {
  PDS_URL: string;
  PLC_URL: string;
  PUBLISHER_DID: string;
  PUBLISHER_HANDLE: string;
  PUBLISHER_PASSWORD: string;
  WITNESS_DID: string;
  WITNESS_HANDLE: string;
  WITNESS_PASSWORD: string;
}

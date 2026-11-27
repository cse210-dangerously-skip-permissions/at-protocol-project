import { compareWithWitness } from "@trustlab/auditor";
import type {
  HeadRecord,
  LocalEnv,
  StoredEvent,
  Verdict,
  WitnessCheckpoint,
} from "@trustlab/contracts";
import {
  fetchSnapshot,
  planRebuild,
  type Snapshot,
  SnapshotError,
} from "@trustlab/recovery";
import type { CheckpointVerifier } from "./metrics.js";

/** One stream as a fresh consumer reads it. */
export interface StreamRead {
  /** Every event of the stream, lowest seq first. */
  events: StoredEvent[];
  /** The stream's head, or `undefined` before its first event. */
  head?: HeadRecord;
}

/**
 * Where a fresh consumer reads a publisher's streams from: the PDS for A0
 * and A1 (`atSource`), or the signed HTTP server for S0 and S1
 * (`baselineSource`). The auditor only sees what `read` returns, so the same
 * audit runs on both (ADR-007).
 */
export interface StreamSource {
  /**
   * Who the publisher is: its DID on AT, the configured public key (a
   * `did:key`) on S0. Every event `read` returns carries it as `did`.
   */
  readonly did: string;
  /**
   * Read one stream and check the publisher signed it.
   *
   * @param stream - The stream name.
   * @returns The stream, or `"unreachable"` when the server can't be read.
   * @throws Error if what the server serves doesn't verify.
   */
  read(stream: string): Promise<StreamRead | "unreachable">;
}

/** What a witness holds for one stream, for A1 and S1. */
export interface WitnessEvidence {
  /** The witness's checkpoints, or `"unreachable"`. */
  checkpoints: readonly WitnessCheckpoint[] | "unreachable";
  /**
   * Checks one checkpoint. On AT, use `pinnedVerifier` with the key from the
   * publisher's DID document (ADR-003 rule 3).
   */
  verify: CheckpointVerifier;
}

/**
 * Audit one stream as a fresh consumer: read it from `source`, then run
 * `compareWithWitness`. Without `witness` (A0, S0) no witness is queried and
 * a valid chain is `accept` (`no-witness`).
 *
 * @param source - Where to read the stream.
 * @param stream - The stream name.
 * @param witness - The witness's checkpoints and how to check them.
 * @returns The verdict.
 */
export async function auditStream(
  source: StreamSource,
  stream: string,
  witness?: WitnessEvidence,
): Promise<Verdict> {
  const subject = { did: source.did, stream };
  const read = await source.read(stream);
  if (read === "unreachable") {
    return compareWithWitness(subject, "unreachable", []);
  }
  return witness === undefined
    ? compareWithWitness(subject, read.events, [], undefined, read.head)
    : compareWithWitness(
        subject,
        read.events,
        witness.checkpoints,
        witness.verify,
        read.head,
      );
}

/**
 * Read streams from the publisher's PDS the way a fresh consumer rebuilds:
 * a `getRepo` snapshot verified against the key in the DID document (#43),
 * planned into events (#44).
 *
 * @param env - Where the PDS and PLC are, and the publisher's DID.
 * @param fetch - Used for the PDS and the PLC. Defaults to the global `fetch`.
 * @returns The source.
 */
export function atSource(
  env: Pick<LocalEnv, "PDS_URL" | "PLC_URL" | "PUBLISHER_DID">,
  fetch?: typeof globalThis.fetch,
): StreamSource {
  return {
    did: env.PUBLISHER_DID,
    async read(stream) {
      let snapshot: Snapshot;
      try {
        snapshot = await fetchSnapshot({
          pdsUrl: env.PDS_URL,
          plcUrl: env.PLC_URL,
          did: env.PUBLISHER_DID,
          ...(fetch === undefined ? {} : { fetch }),
        });
      } catch (error) {
        if (
          error instanceof SnapshotError &&
          error.problem === "pds-unreachable"
        ) {
          return "unreachable";
        }
        throw error;
      }
      const events = planRebuild(snapshot).events.filter(
        (event) => event.stream === stream,
      );
      const head = snapshot.head[stream];
      return head === undefined ? { events } : { events, head };
    },
  };
}

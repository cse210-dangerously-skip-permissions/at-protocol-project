import { parseEventRecord, type StoredEvent } from "@trustlab/contracts";
import type { Snapshot } from "./snapshot.js";

/** The seqs missing from one stream, as inclusive ranges in ascending order. */
export interface Gap {
  stream: string;
  /**
   * Ranges rather than one number per seq: a seq can be as large as
   * `MAX_SEQ`, so a list of every missing seq could exhaust memory.
   */
  missing: { from: number; to: number }[];
}

/** What to write to the view for one repo, and what it lacks. */
export interface RebuildPlan {
  /** Every event, ordered by stream, then seq. */
  events: StoredEvent[];
  /** Each stream with missing seqs between 1 and its highest seq. */
  gaps: Gap[];
}

/** The outcome of applying a rebuild to the view. */
export interface RebuildResult {
  /** How many events were written. */
  applied: number;
  gaps: Gap[];
}

/**
 * Plan the view for a repo from its snapshot. Pure: no I/O.
 *
 * Each event's stream and seq come from its record, checked against the
 * contract, never from the record key's string order or from time. Gaps are
 * reported, not fixed: the rebuild still applies, and the auditor decides
 * what a gap means (#79).
 *
 * @param snapshot - A verified snapshot, such as `fetchSnapshot` returns.
 * @returns The ordered events and the gaps per stream.
 * @throws Error if an event belongs to another DID, or two events share a
 *   stream and seq; a verified snapshot never has either.
 * @throws ContractError if an event's record breaks the contract.
 */
export function planRebuild(snapshot: Snapshot): RebuildPlan {
  const events = snapshot.events.map((event): StoredEvent => {
    if (event.did !== snapshot.did) {
      throw new Error(
        `the snapshot of ${snapshot.did} holds an event from ${event.did}`,
      );
    }
    const record = parseEventRecord(event.record, event.rkey);
    return { ...event, stream: record.stream, seq: record.seq, record };
  });
  events.sort((a, b) =>
    a.stream === b.stream ? a.seq - b.seq : a.stream < b.stream ? -1 : 1,
  );

  // One pass over the sorted events. `last` is the previous seq in the
  // current stream, 0 at a stream's start, so a first seq above 1 is a gap.
  const gaps: Gap[] = [];
  let gap: Gap | undefined;
  let last = 0;
  for (const event of events) {
    if (event.stream !== gap?.stream) {
      gap = { stream: event.stream, missing: [] };
      last = 0;
    }
    if (event.seq === last) {
      throw new Error(
        `duplicate event in stream ${event.stream} at seq ${event.seq}`,
      );
    }
    if (event.seq > last + 1) {
      if (gap.missing.length === 0) gaps.push(gap);
      gap.missing.push({ from: last + 1, to: event.seq - 1 });
    }
    last = event.seq;
  }
  return { events, gaps };
}

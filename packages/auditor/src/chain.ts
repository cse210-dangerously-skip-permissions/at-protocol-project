import type {
  EventRecord,
  HeadRecord,
  StoredEvent,
  Verdict,
} from "@trustlab/contracts";

/**
 * Return a chain conflict at the first sequence where it was found.
 *
 * @param reason - Machine-readable conflict reason.
 * @param seq - First sequence affected by the conflict.
 * @returns A conflict verdict with sequence evidence.
 */
function conflict(reason: string, seq: number): Verdict {
  return { verdict: "conflict", reason, evidence: { seq } };
}

/**
 * Read a stored record after the network boundary validated it.
 *
 * `StoredEvent.record` is `unknown` because stores can be populated from
 * network data. Consumer and recovery code must call `parseEventRecord`
 * before constructing a `StoredEvent`; this function checks relationships
 * between those individually valid records.
 *
 * @param event - A stored, already validated event.
 * @returns The event record used for chain checks.
 */
function recordOf(event: StoredEvent): EventRecord {
  return event.record as EventRecord;
}

/**
 * Validate one publisher stream's event chain and optional head.
 *
 * Input events may be in any order and are not mutated. Each record must
 * already have passed `parseEventRecord`; this function enforces rules that
 * span records: genesis, sequence continuity, CID links, amendment targets,
 * and the stream head.
 *
 * @param events - Events for one publisher DID and stream, in any order.
 * @param head - The stream's current head, when one exists.
 * @returns `accept` for a valid or empty chain, otherwise the first conflict.
 */
export function validateChain(
  events: readonly StoredEvent[],
  head?: HeadRecord,
): Verdict {
  if (events.length === 0) {
    return head === undefined
      ? { verdict: "accept", reason: "empty" }
      : conflict("head-mismatch", head.seq);
  }

  const ordered = [...events].sort((left, right) => left.seq - right.seq);
  const first = ordered[0];
  if (first === undefined) return { verdict: "accept", reason: "empty" };
  const firstRecord = recordOf(first);
  if (
    first.seq !== 1 ||
    firstRecord.seq !== 1 ||
    firstRecord.prevEventCid !== undefined
  ) {
    return conflict("bad-genesis", first.seq);
  }

  const seen = new Set<number>([1]);
  let previous = first;
  for (let index = 1; index < ordered.length; index += 1) {
    const event = ordered[index];
    if (event === undefined) continue;
    const record = recordOf(event);
    const expectedSeq = previous.seq + 1;
    if (event.seq !== expectedSeq || record.seq !== event.seq) {
      return conflict("gap", Math.min(event.seq, expectedSeq));
    }
    if (record.prevEventCid !== previous.cid) {
      return conflict("broken-link", event.seq);
    }
    if (
      record.kind === "release"
        ? record.refSeq !== undefined
        : record.refSeq === undefined || !seen.has(record.refSeq)
    ) {
      return conflict("bad-ref", event.seq);
    }
    seen.add(event.seq);
    previous = event;
  }

  if (
    head !== undefined &&
    (head.stream !== previous.stream ||
      head.seq !== previous.seq ||
      head.eventCid !== previous.cid)
  ) {
    return conflict("head-mismatch", head.seq);
  }

  return { verdict: "accept", reason: "ok" };
}

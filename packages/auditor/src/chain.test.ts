import {
  EVENT_NSID,
  eventRkey,
  HEAD_NSID,
  type EventKind,
  type EventRecord,
  type HeadRecord,
  type StoredEvent,
} from "@trustlab/contracts";
import { describe, expect, test } from "vitest";
import { validateChain } from "./chain.js";

const DID = "did:plc:publisher";
const STREAM = "releases";

/**
 * Build a stored event whose CID and previous link are easy to inspect.
 *
 * @param seq - Event position.
 * @param change - Record fields to override for a test case.
 * @returns A stored event fixture.
 */
function event(seq: number, change: Partial<EventRecord> = {}): StoredEvent {
  const record: EventRecord = {
    $type: EVENT_NSID,
    stream: STREAM,
    seq,
    ...(seq === 1 ? {} : { prevEventCid: `cid-${seq - 1}` }),
    kind: "release",
    payload: {
      name: "pkg",
      version: `1.0.${seq}`,
      checksum: `sha256:${seq}`,
    },
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
    ...change,
  };
  return {
    did: DID,
    stream: STREAM,
    seq,
    rkey: eventRkey(STREAM, seq),
    cid: `cid-${seq}`,
    record,
  };
}

/**
 * Build a valid chain of a requested length.
 *
 * @param length - Number of events to make.
 * @returns Consecutive, correctly linked events.
 */
function chain(length: number): StoredEvent[] {
  return Array.from({ length }, (_unused, index) => event(index + 1));
}

/**
 * Build a head for the event at `seq`.
 *
 * @param seq - Event position named by the head.
 * @param change - Head fields to override for a test case.
 * @returns A head fixture.
 */
function head(seq: number, change: Partial<HeadRecord> = {}): HeadRecord {
  return {
    $type: HEAD_NSID,
    stream: STREAM,
    seq,
    eventCid: `cid-${seq}`,
    ...change,
  };
}

describe("validateChain", () => {
  test.each([1, 2, 50])("accepts a valid chain of length %i", (length) => {
    expect(validateChain(chain(length), head(length))).toEqual({
      verdict: "accept",
      reason: "ok",
    });
  });

  test("accepts an empty stream", () => {
    expect(validateChain([])).toEqual({
      verdict: "accept",
      reason: "empty",
    });
  });

  test("sorts events without mutating the caller's array", () => {
    const events = chain(3).reverse();

    expect(validateChain(events, head(3))).toEqual({
      verdict: "accept",
      reason: "ok",
    });
    expect(events.map(({ seq }) => seq)).toEqual([3, 2, 1]);
  });

  test.each<
    [string, readonly StoredEvent[], HeadRecord | undefined, string, number]
  >([
    ["a missing genesis", [event(2)], undefined, "bad-genesis", 2],
    [
      "a linked genesis",
      [event(1, { prevEventCid: "cid-0" })],
      undefined,
      "bad-genesis",
      1,
    ],
    ["a sequence gap", [event(1), event(3)], undefined, "gap", 2],
    [
      "a duplicate sequence",
      [event(1), event(2), event(2)],
      undefined,
      "gap",
      2,
    ],
    [
      "a broken CID link",
      [event(1), event(2, { prevEventCid: "cid-other" })],
      undefined,
      "broken-link",
      2,
    ],
    [
      "a correction pointing forward",
      chainWithAmendment("correct", 3),
      undefined,
      "bad-ref",
      3,
    ],
    [
      "a release with a reference",
      [event(1), event(2, { refSeq: 1 })],
      undefined,
      "bad-ref",
      2,
    ],
    ["a head without events", [], head(1), "head-mismatch", 1],
    ["a head at the wrong sequence", chain(2), head(1), "head-mismatch", 1],
    [
      "a head pointing at the wrong CID",
      chain(2),
      head(2, { eventCid: "cid-other" }),
      "head-mismatch",
      2,
    ],
  ])("rejects %s", (_name, events, currentHead, reason, seq) => {
    expect(validateChain(events, currentHead)).toEqual({
      verdict: "conflict",
      reason,
      evidence: { seq },
    });
  });

  test.each<[EventKind, number]>([
    ["correct", 1],
    ["withdraw", 1],
  ])("accepts a valid %s event", (kind, refSeq) => {
    const events = [event(1), event(2, { kind, refSeq })];

    expect(validateChain(events, head(2))).toEqual({
      verdict: "accept",
      reason: "ok",
    });
  });
});

/**
 * Make a three-event chain with an invalid amendment target.
 *
 * @param kind - Correction or withdrawal kind.
 * @param refSeq - Target sequence.
 * @returns A chain whose final event has the requested amendment.
 */
function chainWithAmendment(
  kind: Exclude<EventKind, "release">,
  refSeq: number,
): StoredEvent[] {
  return [event(1), event(2), event(3, { kind, refSeq })];
}

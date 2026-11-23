import {
  EVENT_NSID,
  eventRkey,
  MAX_SEQ,
  type StoredEvent,
} from "@trustlab/contracts";
import { describe, expect, test } from "vitest";
import { planRebuild } from "./rebuild.js";
import type { Snapshot } from "./snapshot.js";

const DID = "did:plc:abcdefghijklmnopqrstuvwx";
// Any well-formed CID will do for `prevEventCid`: the plan does not check links.
const SOME_CID = "bafyreigivvxjiheshtgzossskzwhqs2q76q46mfmn6wnuxs5tmbodpkni4";

/**
 * A stored event whose record passes the contract validators.
 *
 * @param stream - Stream name.
 * @param seq - Seq, in both the record and the key.
 * @param cid - The event's CID as the view would store it.
 * @returns The event.
 */
function event(stream: string, seq: number, cid = `cid-${stream}-${seq}`) {
  const stored: StoredEvent = {
    did: DID,
    stream,
    seq,
    rkey: eventRkey(stream, seq),
    cid,
    record: {
      $type: EVENT_NSID,
      stream,
      seq,
      ...(seq > 1 ? { prevEventCid: SOME_CID } : {}),
      kind: "release",
      payload: { name: "pkg", version: `1.0.${seq}`, checksum: "sha256:00" },
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  };
  return stored;
}

/**
 * A snapshot holding the given events.
 *
 * @param events - The events, in any order.
 * @returns The snapshot.
 */
function snapshot(events: StoredEvent[]): Snapshot {
  return {
    did: DID,
    rev: "3m5k2aaaaaa22",
    commitCid: SOME_CID,
    events,
    head: {},
  };
}

/**
 * The plan's events as `stream:seq` labels, in order.
 *
 * @param events - The planned events.
 * @returns The labels.
 */
function labels(events: StoredEvent[]): string[] {
  return events.map((e) => `${e.stream}:${e.seq}`);
}

describe("planRebuild", () => {
  test("orders events by stream, then seq", () => {
    const plan = planRebuild(
      snapshot([event("zeta", 1), event("alpha", 2), event("alpha", 1)]),
    );

    expect(labels(plan.events)).toEqual(["alpha:1", "alpha:2", "zeta:1"]);
    expect(plan.gaps).toEqual([]);
  });

  test("sorts by the seq in the record, not by rkey or input order", () => {
    const seqs = [7, 12, 1, 10, 3, 9, 2, 11, 5, 8, 4, 6];

    const plan = planRebuild(snapshot(seqs.map((s) => event("releases", s))));

    expect(plan.events.map((e) => e.seq)).toEqual(
      Array.from({ length: 12 }, (_, i) => i + 1),
    );
  });

  test("reports one gap", () => {
    const plan = planRebuild(
      snapshot([
        event("releases", 1),
        event("releases", 2),
        event("releases", 4),
      ]),
    );

    expect(plan.gaps).toEqual([
      { stream: "releases", missing: [{ from: 3, to: 3 }] },
    ]);
    expect(plan.events).toHaveLength(3);
  });

  test("reports a gap at seq 1", () => {
    const plan = planRebuild(snapshot([event("zeta", 3)]));

    expect(plan.gaps).toEqual([
      { stream: "zeta", missing: [{ from: 1, to: 2 }] },
    ]);
  });

  test("reports gaps per stream", () => {
    const plan = planRebuild(
      snapshot([
        event("releases", 8),
        event("zeta", 1),
        event("releases", 1),
        event("releases", 5),
        event("releases", 4),
      ]),
    );

    expect(plan.gaps).toEqual([
      {
        stream: "releases",
        missing: [
          { from: 2, to: 3 },
          { from: 6, to: 7 },
        ],
      },
    ]);
  });

  test("keeps a huge gap small", () => {
    const plan = planRebuild(
      snapshot([event("releases", 1), event("releases", MAX_SEQ)]),
    );

    expect(plan.gaps).toEqual([
      { stream: "releases", missing: [{ from: 2, to: MAX_SEQ - 1 }] },
    ]);
  });

  test("throws on a duplicate seq", () => {
    expect(() =>
      planRebuild(
        snapshot([
          event("releases", 2, "cid-a"),
          event("releases", 2, "cid-b"),
        ]),
      ),
    ).toThrow(/duplicate.*releases.*seq 2/);
  });

  test("takes stream and seq from the record", () => {
    const mislabelled = { ...event("releases", 1), seq: 9, stream: "other" };

    const plan = planRebuild(snapshot([mislabelled]));

    expect(plan.events).toMatchObject([{ stream: "releases", seq: 1 }]);
    expect(plan.gaps).toEqual([]);
  });

  test("throws on an event from another DID", () => {
    const foreign = { ...event("releases", 1), did: "did:plc:other" };

    expect(() => planRebuild(snapshot([foreign]))).toThrow(/did:plc:other/);
  });

  test("does not change the snapshot", () => {
    const events = [event("releases", 2), event("releases", 1)];
    const before = structuredClone(events);
    const input = snapshot(events);

    planRebuild(input);

    expect(input.events).toBe(events);
    expect(events).toEqual(before);
  });

  test("returns nothing for an empty snapshot", () => {
    expect(planRebuild(snapshot([]))).toEqual({ events: [], gaps: [] });
  });
});

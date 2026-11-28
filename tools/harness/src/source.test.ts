import {
  EVENT_NSID,
  eventRkey,
  HEAD_NSID,
  type EventRecord,
  type HeadRecord,
  type StoredEvent,
  type WitnessCheckpoint,
} from "@trustlab/contracts";
import { recordCid } from "@trustlab/publisher";
import type { Snapshot } from "@trustlab/recovery";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { atSource, auditStream } from "./source.js";

// The snapshot stands in for the PDS and the PLC.
const lib = vi.hoisted(() => ({
  fetchSnapshot: vi.fn<(opts: unknown) => Promise<Snapshot>>(),
}));
vi.mock("@trustlab/recovery", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@trustlab/recovery")>()),
  fetchSnapshot: lib.fetchSnapshot,
}));
const { SnapshotError } = await import("@trustlab/recovery");

const env = {
  PDS_URL: "http://localhost:2583",
  PLC_URL: "http://localhost:2582",
  PUBLISHER_DID: "did:plc:publisher",
};

/**
 * A linked chain of `count` events on `stream`, with real CIDs.
 *
 * @param stream - The stream name.
 * @param count - How many events.
 * @returns The events, lowest seq first.
 */
async function chain(stream: string, count: number): Promise<StoredEvent[]> {
  const events: StoredEvent[] = [];
  for (let seq = 1; seq <= count; seq += 1) {
    const prev = events[seq - 2]?.cid;
    const record: EventRecord = {
      $type: EVENT_NSID,
      stream,
      seq,
      ...(prev === undefined ? {} : { prevEventCid: prev }),
      kind: "release",
      payload: { name: "pkg", version: `1.0.${seq}`, checksum: "sha256:00" },
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    events.push({
      did: env.PUBLISHER_DID,
      stream,
      seq,
      rkey: eventRkey(stream, seq),
      cid: await recordCid(record),
      record,
    });
  }
  return events;
}

/**
 * The head record of the last event.
 *
 * @param events - A chain.
 * @returns Its head.
 */
function headOf(events: readonly StoredEvent[]): HeadRecord {
  const last = events[events.length - 1] as StoredEvent;
  return {
    $type: HEAD_NSID,
    stream: last.stream,
    seq: last.seq,
    eventCid: last.cid,
  };
}

let releases: StoredEvent[];
let other: StoredEvent[];

beforeEach(async () => {
  lib.fetchSnapshot.mockReset();
  releases = await chain("releases", 3);
  other = await chain("other", 2);
  lib.fetchSnapshot.mockResolvedValue({
    did: env.PUBLISHER_DID,
    rev: "rev-1",
    commitCid: "commit",
    events: [...other, ...releases],
    head: { releases: headOf(releases), other: headOf(other) },
  });
});

describe("atSource", () => {
  test("reads one stream and its head from a verified snapshot", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const source = atSource(env, fetch);
    expect(source.did).toBe(env.PUBLISHER_DID);
    expect(await source.read("releases")).toEqual({
      events: releases,
      head: headOf(releases),
    });
    expect(lib.fetchSnapshot).toHaveBeenCalledWith({
      pdsUrl: env.PDS_URL,
      plcUrl: env.PLC_URL,
      did: env.PUBLISHER_DID,
      fetch,
    });
  });

  test("reads a stream the repo doesn't have as empty, with no head", async () => {
    expect(await atSource(env).read("missing")).toEqual({ events: [] });
  });

  test("is unreachable when the PDS is", async () => {
    lib.fetchSnapshot.mockRejectedValue(
      new SnapshotError("pds-unreachable", "connection refused"),
    );
    expect(await atSource(env).read("releases")).toBe("unreachable");
  });

  test("throws when the repo doesn't verify", async () => {
    lib.fetchSnapshot.mockRejectedValue(
      new SnapshotError("invalid-repo", "bad signature"),
    );
    await expect(atSource(env).read("releases")).rejects.toThrow(
      "bad signature",
    );
  });
});

describe("auditStream", () => {
  const witnessed = (seq: number, eventCid: string): WitnessCheckpoint => ({
    did: env.PUBLISHER_DID,
    stream: "releases",
    seq,
    eventCid,
    headCid: "-",
    commitCid: "-",
    rev: "-",
    proofCar: "",
    signingKey: "did:key:zStub",
    observedAt: "2026-01-01T00:00:00.000Z",
  });

  test("without a witness, never checks a checkpoint", async () => {
    expect(await auditStream(atSource(env), "releases")).toEqual({
      verdict: "accept",
      reason: "no-witness",
    });
  });

  test("with a witness, compares the stream with its checkpoints", async () => {
    const verify = vi.fn(async () => true);
    const cid = releases[1]?.cid as string;
    expect(
      await auditStream(atSource(env), "releases", {
        checkpoints: [witnessed(2, cid)],
        verify,
      }),
    ).toEqual({ verdict: "accept", reason: "extends-witness" });
    expect(verify).toHaveBeenCalledOnce();

    expect(
      await auditStream(atSource(env), "releases", {
        checkpoints: [witnessed(5, "gone")],
        verify,
      }),
    ).toEqual({
      verdict: "conflict",
      reason: "truncated",
      evidence: { seq: 5, witnessedCid: "gone" },
    });
  });

  test("checks the head the source read", async () => {
    lib.fetchSnapshot.mockResolvedValue({
      did: env.PUBLISHER_DID,
      rev: "rev-1",
      commitCid: "commit",
      events: releases,
      head: { releases: headOf(releases.slice(0, 2)) },
    });
    expect(await auditStream(atSource(env), "releases")).toEqual({
      verdict: "conflict",
      reason: "head-mismatch",
      evidence: { seq: 2 },
    });
  });

  test("is unknown when the source or the witness can't be read", async () => {
    expect(
      await auditStream(atSource(env), "releases", {
        checkpoints: "unreachable",
        verify: async () => true,
      }),
    ).toEqual({ verdict: "unknown", reason: "witness-unreachable" });

    lib.fetchSnapshot.mockRejectedValue(
      new SnapshotError("pds-unreachable", "connection refused"),
    );
    expect(await auditStream(atSource(env), "releases")).toEqual({
      verdict: "unknown",
      reason: "pds-unreachable",
    });
  });
});

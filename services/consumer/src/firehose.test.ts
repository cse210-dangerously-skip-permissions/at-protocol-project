import type { Event, FirehoseOptions as LibOptions } from "@atproto/sync";
import {
  EVENT_NSID,
  eventRkey,
  HEAD_NSID,
  headRkey,
  type LocalEnv,
} from "@trustlab/contracts";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { startFirehose } from "./firehose.js";
import { ConsumerStore, type VerifiedCommit } from "./store.js";

// Stand-in for the library: keeps the options so the test can drive them.
const lib = vi.hoisted(() => ({ opts: undefined as unknown }));
vi.mock("@atproto/sync", () => ({
  Firehose: class {
    constructor(opts: unknown) {
      lib.opts = opts;
    }
    start() {
      return Promise.resolve();
    }
    destroy() {
      return Promise.resolve();
    }
  },
}));

const ALLOWED = "did:plc:publisher";
const OTHER = "did:plc:stranger";
// Any well-formed CID; this one is the example in lexicons/README.md.
const PREV_CID = "bafyreidfayvfuwqa7qlnopdjiqrxzs6blmoeu4rujcjtnci5beludirz2a";
const env = {
  PDS_URL: "http://localhost:2583",
  PLC_URL: "http://localhost:2582",
} as LocalEnv;

let store: ConsumerStore;
let saved: VerifiedCommit[];

/** The options our code passed to the library's Firehose. */
function libOpts(): LibOptions {
  return lib.opts as LibOptions;
}

/** A verified create of event `seq` on `releases`, as the library hands it over. */
function eventCreate(did: string, seq: number, rev: string): Event {
  return {
    event: "create",
    did,
    rev,
    seq: 0,
    collection: EVENT_NSID,
    rkey: eventRkey("releases", seq),
    cid: { toString: () => `cid-event-${seq}` },
    record: {
      $type: EVENT_NSID,
      stream: "releases",
      seq,
      // The contract requires a link to the previous event after seq 1.
      ...(seq > 1 ? { prevEventCid: PREV_CID } : {}),
      kind: "release",
      payload: { name: "pkg", version: `1.0.${seq}`, checksum: "sha256:00" },
      createdAt: "2026-11-11T18:00:00.000Z",
    },
  } as unknown as Event;
}

/** A verified update of the `releases` head record. */
function headUpdate(did: string, rev: string): Event {
  return {
    event: "update",
    did,
    rev,
    collection: HEAD_NSID,
    rkey: headRkey("releases"),
    cid: { toString: () => "cid-head" },
    record: {
      $type: HEAD_NSID,
      stream: "releases",
      seq: 1,
      eventCid: PREV_CID,
    },
  } as unknown as Event;
}

/** Deliver one commit's writes the way the library does: one runner call. */
function deliver(did: string, seq: number, writes: Event[]): Promise<void> {
  const { runner, handleEvent } = libOpts();
  return runner!.trackEvent(did, seq, async () => {
    for (const write of writes) await handleEvent(write);
  });
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  store = new ConsumerStore(":memory:");
  saved = [];
  startFirehose({
    env,
    store,
    allow: (did) => did === ALLOWED,
    onCommit: (commit) => saved.push(commit),
  });
});

afterEach(() => {
  store.close();
  vi.restoreAllMocks();
});

test("connects to the local PDS over ws and filters to our collections", () => {
  expect(libOpts().service).toBe("ws://localhost:2583");
  expect(libOpts().filterCollections).toEqual([EVENT_NSID, HEAD_NSID]);
});

test("saves a commit's writes as one VerifiedCommit", async () => {
  await deliver(ALLOWED, 7, [
    eventCreate(ALLOWED, 1, "rev-a"),
    headUpdate(ALLOWED, "rev-a"),
  ]);

  expect(saved).toHaveLength(1);
  expect(saved).toMatchObject([
    { cursor: 7, did: ALLOWED, rev: "rev-a", events: [{ seq: 1 }] },
  ]);
  expect(store.getEvents(ALLOWED, "releases").map((e) => e.cid)).toEqual([
    "cid-event-1",
  ]);
  expect(store.getCheckpoint()).toEqual({
    cursor: 7,
    revs: { [ALLOWED]: "rev-a" },
  });
});

test("logs each verified write with DID, record key, CID, and rev", async () => {
  await deliver(ALLOWED, 7, [eventCreate(ALLOWED, 1, "rev-a")]);

  expect(console.log).toHaveBeenCalledWith(
    expect.stringContaining(
      `verified create did=${ALLOWED} rkey=releases-000000000001 cid=cid-event-1 rev=rev-a`,
    ),
  );
});

test("logs a verified delete without a CID and keeps it out of the view", async () => {
  const del = {
    event: "delete",
    did: ALLOWED,
    rev: "rev-d",
    collection: EVENT_NSID,
    rkey: eventRkey("releases", 1),
  } as unknown as Event;
  await deliver(ALLOWED, 9, [del]);

  expect(console.log).toHaveBeenCalledWith(
    expect.stringContaining(
      `verified delete did=${ALLOWED} rkey=releases-000000000001 cid=- rev=rev-d`,
    ),
  );
  expect(store.getEvents(ALLOWED, "releases")).toEqual([]);
  expect(store.getCheckpoint().cursor).toBe(9);
});

test("drops and counts DIDs that are not allowlisted", async () => {
  await deliver(OTHER, 7, [eventCreate(OTHER, 1, "rev-x")]);
  await deliver(OTHER, 8, [eventCreate(OTHER, 2, "rev-y")]);

  expect(saved).toEqual([]);
  expect(store.getCheckpoint().cursor).toBeNull();
  expect(console.log).toHaveBeenLastCalledWith(
    expect.stringContaining("2 dropped"),
  );
});

test("saves commits in feed order even when delivered without waiting", async () => {
  // The library calls trackEvent without awaiting it, so commit 8 can arrive
  // while commit 7's handler is still running.
  const first = deliver(ALLOWED, 7, [eventCreate(ALLOWED, 1, "rev-a")]);
  const second = deliver(ALLOWED, 8, [eventCreate(ALLOWED, 2, "rev-b")]);
  await Promise.all([first, second]);

  expect(saved.map((c) => c.cursor)).toEqual([7, 8]);
  expect(store.getEvents(ALLOWED, "releases").map((e) => e.seq)).toEqual([
    1, 2,
  ]);
});

test("resumes from the store's cursor", async () => {
  expect(libOpts().runner!.getCursor()).toBeUndefined();
  await deliver(ALLOWED, 7, [eventCreate(ALLOWED, 1, "rev-a")]);
  expect(libOpts().runner!.getCursor()).toBe(7);
});

test("a startup or post-commit audit failure cannot discard a saved commit or its callback", async () => {
  const fail = () => {
    throw new Error("audit unavailable");
  };
  vi.spyOn(store, "auditStreams")
    .mockImplementationOnce(fail)
    .mockImplementationOnce(fail);
  const sub = startFirehose({
    env,
    store,
    allow: () => true,
    onCommit: (commit) => saved.push(commit),
  });
  await deliver(ALLOWED, 1, [eventCreate(ALLOWED, 1, "a")]);
  await sub.stop();
  expect(store.getCheckpoint().cursor).toBe(1);
  expect(store.getEvents(ALLOWED, "releases")).toHaveLength(1);
  expect(saved.map((commit) => commit.cursor)).toEqual([1]);
  expect(console.error).toHaveBeenCalledWith(
    expect.stringContaining("startup audit failed"),
  );
  expect(console.error).toHaveBeenCalledWith(
    expect.stringContaining("audit failed for saved commit seq=1"),
  );
});

test("startup queries all publishers and a commit queries only its publisher", async () => {
  store.replaceRepo(OTHER, "a", [
    {
      did: OTHER,
      stream: "other",
      seq: 1,
      cid: "one",
      rkey: eventRkey("other", 1),
      record: { seq: 1, kind: "release" },
    },
  ]);
  const checkpoints = vi.fn().mockResolvedValue([]);
  const sub = startFirehose({
    env,
    store,
    allow: () => true,
    witness: { checkpoints, verify: vi.fn() },
  });
  await deliver(ALLOWED, 1, [eventCreate(ALLOWED, 1, "a")]);
  await sub.stop();
  expect(checkpoints.mock.calls).toEqual([
    [OTHER, "other"],
    [ALLOWED, "releases"],
  ]);
});

test.each(["create", "update"])(
  "persists conflict evidence for a malformed event %s and clears it on repair",
  async (operation) => {
    const valid = eventCreate(ALLOWED, 1, "a");
    if (operation === "update") await deliver(ALLOWED, 1, [valid]);
    const bad = {
      ...valid,
      event: operation,
      record: {},
      cid: { toString: () => "invalid-cid" },
    } as unknown as Event;
    await deliver(ALLOWED, 2, [bad]);
    await deliver(ALLOWED, 3, [
      { ...headUpdate(ALLOWED, "c"), event: "delete" } as Event,
    ]);
    expect(store.getCheckpoint().cursor).toBe(3);
    expect(store.getEvents(ALLOWED, "releases")).toHaveLength(
      operation === "update" ? 1 : 0,
    );
    expect(store.latestVerdicts()[0]?.verdict).toEqual({
      verdict: "conflict",
      reason: "invalid-event",
      evidence: { seq: 1, currentCid: "invalid-cid" },
    });
    await deliver(ALLOWED, 4, [{ ...valid, event: "update" } as Event]);
    expect(store.latestVerdicts()[0]?.verdict.verdict).toBe("accept");
  },
);

test("a malformed head flags its stream and preserves sibling events", async () => {
  const head = headUpdate(ALLOWED, "a");
  await deliver(ALLOWED, 1, [
    { ...head, record: {} } as Event,
    eventCreate(ALLOWED, 1, "a"),
  ]);
  expect(store.getEvents(ALLOWED, "releases")).toHaveLength(1);
  expect(store.latestVerdicts()[0]?.verdict).toEqual({
    verdict: "conflict",
    reason: "invalid-head",
  });
  await deliver(ALLOWED, 2, [{ ...head, event: "delete" } as Event]);
  expect(store.latestVerdicts()[0]?.verdict.verdict).toBe("accept");
});

test("audit follows updates, deletions and re-creates while preserving the original event", async () => {
  const create = eventCreate(ALLOWED, 1, "a");
  const update = {
    ...create,
    event: "update",
    cid: { toString: () => "edited" },
  } as unknown as Event;
  const recreate = {
    ...create,
    cid: { toString: () => "recreated" },
  } as unknown as Event;
  const del = { ...create, event: "delete" } as Event;
  const head = headUpdate(ALLOWED, "a");
  const delHead = { ...head, event: "delete" } as Event;
  await deliver(ALLOWED, 1, [create, head]);
  expect(store.latestVerdicts()[0]?.verdict.reason).toBe("head-mismatch");
  await deliver(ALLOWED, 2, [update, delHead]);
  expect(store.auditEvents(ALLOWED, "releases")[0]?.cid).toBe("edited");
  await deliver(ALLOWED, 3, [del]);
  expect(store.auditEvents(ALLOWED, "releases")).toEqual([]);
  await deliver(ALLOWED, 4, [recreate]);
  expect(store.auditEvents(ALLOWED, "releases")[0]?.cid).toBe("recreated");
  expect(store.getEvents(ALLOWED, "releases")[0]?.cid).toBe("cid-event-1");
});

test("startup audits existing events without refreshing the last verified PDS time", async () => {
  store.replaceRepo(ALLOWED, "a", [
    {
      did: ALLOWED,
      stream: "saved",
      seq: 1,
      rkey: eventRkey("saved", 1),
      cid: "one",
      record: { seq: 1, kind: "release" },
    },
  ]);
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2040-01-01T00:00:00Z"));
  const sub = startFirehose({ env, store, allow: () => true });
  try {
    await sub.stop();
  } finally {
    vi.useRealTimers();
  }
  expect(store.latestVerdicts()[0]?.verifiedAsOf).not.toBe(
    store.latestVerdicts()[0]?.checkedAt,
  );
  expect(store.latestVerdicts()).toMatchObject([
    {
      stream: "saved",
      verdict: { verdict: "accept" },
      verifiedAsOf: expect.any(String),
    },
  ]);
});

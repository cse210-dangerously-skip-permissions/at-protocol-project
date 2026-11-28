import type { FirehoseOptions as LibOptions } from "@atproto/sync";
import {
  EVENT_NSID,
  eventRkey,
  type LocalEnv,
  type StoredEvent,
} from "@trustlab/contracts";
import type { Snapshot } from "@trustlab/recovery";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { startConsumer } from "./restart.js";
import { ConsumerStore } from "./store.js";

// Stand-ins for the network: the firehose library keeps its options so the
// test can drive them, and the snapshot comes from `lib.snapshot`.
const lib = vi.hoisted(() => ({
  opts: undefined as unknown,
  fetchSnapshot: vi.fn<() => Promise<Snapshot>>(),
}));
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
vi.mock("@trustlab/recovery", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@trustlab/recovery")>()),
  fetchSnapshot: lib.fetchSnapshot,
}));

const DID = "did:plc:publisher";
// Any well-formed CID; this one is the example in lexicons/README.md.
const CID = "bafyreidfayvfuwqa7qlnopdjiqrxzs6blmoeu4rujcjtnci5beludirz2a";
const env = {
  PDS_URL: "http://localhost:2583",
  PLC_URL: "http://localhost:2582",
  PUBLISHER_DID: DID,
} as LocalEnv;

let store: ConsumerStore;

/**
 * A stored event on `releases`, as a verified snapshot holds it.
 *
 * @param seq - The event's seq.
 * @returns The event.
 */
function event(seq: number): StoredEvent {
  return {
    did: DID,
    stream: "releases",
    seq,
    rkey: eventRkey("releases", seq),
    cid: `cid-${seq}`,
    record: {
      $type: EVENT_NSID,
      stream: "releases",
      seq,
      ...(seq > 1 ? { prevEventCid: CID } : {}),
      kind: "release",
      payload: { name: "pkg", version: `1.0.${seq}`, checksum: "sha256:00" },
      createdAt: "2026-11-26T00:00:00.000Z",
    },
  };
}

/**
 * A snapshot of the publisher's repo holding events 1 to `count`.
 *
 * @param count - How many events.
 * @param rev - The repo revision.
 * @returns The snapshot.
 */
function snapshot(count: number, rev: string): Snapshot {
  return {
    did: DID,
    rev,
    commitCid: CID,
    events: Array.from({ length: count }, (_unused, i) => event(i + 1)),
    head: {},
  };
}

/** The options our code passed to the library's Firehose. */
function libOpts(): LibOptions {
  return lib.opts as LibOptions;
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  store = new ConsumerStore(":memory:");
  lib.opts = undefined;
  lib.fetchSnapshot.mockReset();
});

afterEach(() => {
  store.close();
  vi.restoreAllMocks();
});

test("with no checkpoint, rebuilds from a snapshot before following the feed", async () => {
  lib.fetchSnapshot.mockResolvedValue(snapshot(5, "rev-5"));

  await startConsumer({ env, store, allow: (did) => did === DID });

  expect(store.getEvents(DID, "releases").map((e) => e.seq)).toEqual([
    1, 2, 3, 4, 5,
  ]);
  expect(store.getCheckpoint().revs[DID]).toBe("rev-5");
  // No cursor yet, so the feed starts from now.
  expect(libOpts().runner!.getCursor()).toBeUndefined();
});

test("with a checkpoint, resumes from the cursor without a snapshot", async () => {
  store.applyCommit({ cursor: 42, did: DID, rev: "rev-a", events: [] });

  await startConsumer({ env, store, allow: (did) => did === DID });

  expect(lib.fetchSnapshot).not.toHaveBeenCalled();
  expect(libOpts().runner!.getCursor()).toBe(42);
});

test("when the PDS rejects the cursor as in the future, forgets it and rebuilds", async () => {
  store.applyCommit({ cursor: 900, did: DID, rev: "rev-a", events: [] });
  lib.fetchSnapshot.mockResolvedValue(snapshot(3, "rev-b"));
  await startConsumer({ env, store, allow: (did) => did === DID });

  const futureCursor = Object.assign(new Error("Cursor in the future."), {
    error: "FutureCursor",
  });
  libOpts().onError(
    new Error("error on firehose subscription", { cause: futureCursor }),
  );

  // The library reconnects with whatever getCursor says: now nothing.
  expect(libOpts().runner!.getCursor()).toBeUndefined();
  await vi.waitFor(() =>
    expect(store.getEvents(DID, "releases")).toHaveLength(3),
  );
});

test("other firehose errors keep the cursor", async () => {
  store.applyCommit({ cursor: 42, did: DID, rev: "rev-a", events: [] });
  await startConsumer({ env, store, allow: (did) => did === DID });

  libOpts().onError(new Error("socket closed", { cause: new Error("ECONN") }));

  expect(libOpts().runner!.getCursor()).toBe(42);
  expect(lib.fetchSnapshot).not.toHaveBeenCalled();
});

test("a failed startup rebuild stops the start", async () => {
  lib.fetchSnapshot.mockRejectedValue(new Error("pds-unreachable"));

  await expect(
    startConsumer({ env, store, allow: (did) => did === DID }),
  ).rejects.toThrow("pds-unreachable");
  expect(lib.opts).toBeUndefined();
});

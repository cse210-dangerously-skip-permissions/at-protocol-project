import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  ConsumerStore,
  EventConflictError,
  type VerifiedCommit,
} from "./store.js";

const DID = "did:plc:publisher";
const STREAM = "releases";

/**
 * Build commit number `n`: cursor `n`, rev `rev-n`, and one event at seq `n`.
 * With this shape the view and checkpoint are in sync exactly when the
 * event count, the cursor, and the rev all name the same `n`.
 */
function commit(n: number, cid = `cid-${n}`): VerifiedCommit {
  return {
    cursor: n,
    did: DID,
    rev: `rev-${n}`,
    events: [
      {
        stream: STREAM,
        seq: n,
        rkey: `${STREAM}-${String(n).padStart(12, "0")}`,
        cid,
        record: { name: "pkg", version: `1.0.${n}` },
      },
    ],
  };
}

/** Assert the view and checkpoint both sit at commit `n`. */
function expectInSyncAt(store: ConsumerStore, n: number): void {
  const events = store.getEvents(DID, STREAM);
  expect(events.map((event) => event.seq)).toEqual(
    Array.from({ length: n }, (_, i) => i + 1),
  );
  expect(store.getCheckpoint()).toEqual({
    cursor: n === 0 ? null : n,
    revs: n === 0 ? {} : { [DID]: `rev-${n}` },
  });
}

let dir: string;
let dbPath: string;
let store: ConsumerStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "consumer-store-"));
  dbPath = join(dir, "consumer.sqlite");
  store = new ConsumerStore(dbPath);
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Run SQL against the store's file on a separate connection. */
function execRaw(sql: string): void {
  const raw = new DatabaseSync(dbPath);
  try {
    raw.exec(sql);
  } finally {
    raw.close();
  }
}

describe("applyCommit", () => {
  test("starts empty", () => {
    expectInSyncAt(store, 0);
  });

  test("stores events and the checkpoint together", () => {
    expect(store.applyCommit(commit(1))).toBe(true);
    expect(store.applyCommit(commit(2))).toBe(true);

    expectInSyncAt(store, 2);
    expect(store.getEvents(DID, STREAM)[1]).toEqual({
      did: DID,
      stream: STREAM,
      seq: 2,
      rkey: "releases-000000000002",
      cid: "cid-2",
      record: { name: "pkg", version: "1.0.2" },
    });
  });

  test("returns events in seq order, not insert order", () => {
    store.applyCommit({ ...commit(2), cursor: 1 });
    store.applyCommit({ ...commit(1), cursor: 2 });

    expect(store.getEvents(DID, STREAM).map((event) => event.seq)).toEqual([
      1, 2,
    ]);
  });

  test("advances the cursor for a commit with none of our events", () => {
    store.applyCommit(commit(1));
    store.applyCommit({
      cursor: 2,
      did: "did:plc:other",
      rev: "x",
      events: [],
    });

    expect(store.getCheckpoint()).toEqual({
      cursor: 2,
      revs: { [DID]: "rev-1", "did:plc:other": "x" },
    });
  });

  test("skips a replayed commit", () => {
    store.applyCommit(commit(1));
    store.applyCommit(commit(2));

    expect(store.applyCommit(commit(2))).toBe(false);
    expect(store.applyCommit(commit(1, "cid-other"))).toBe(false);
    expectInSyncAt(store, 2);
  });

  test("accepts an event it already has with the same CID", () => {
    store.applyCommit(commit(1));

    expect(store.applyCommit({ ...commit(1), cursor: 2, rev: "rev-1" })).toBe(
      true,
    );
    expect(store.getEvents(DID, STREAM)).toHaveLength(1);
    expect(store.getCheckpoint().cursor).toBe(2);
  });

  test("rejects a non-integer cursor or seq without writing", () => {
    expect(() => store.applyCommit({ ...commit(1), cursor: 1.5 })).toThrow(
      RangeError,
    );
    const zeroSeq = commit(1);
    expect(() =>
      store.applyCommit({
        ...zeroSeq,
        events: [{ ...zeroSeq.events[0]!, seq: 0 }],
      }),
    ).toThrow(RangeError);
    expectInSyncAt(store, 0);
  });
});

describe("view and checkpoint stay in sync", () => {
  test("a different CID for a stored event rolls back the whole commit", () => {
    store.applyCommit(commit(1));
    store.applyCommit(commit(2));

    // Commit 3 carries a new event at seq 3, then a rewrite of seq 2.
    const rewrite: VerifiedCommit = {
      ...commit(3),
      events: [...commit(3).events, ...commit(2, "cid-rewritten").events],
    };

    expect(() => store.applyCommit(rewrite)).toThrow(EventConflictError);
    expectInSyncAt(store, 2);
    expect(store.getEvents(DID, STREAM)[1]?.cid).toBe("cid-2");
  });

  test("a failure after the view write and before the checkpoint write leaves both unchanged", () => {
    store.applyCommit(commit(1));
    store.applyCommit(commit(2));

    // Make the checkpoint write fail. By then the event row for commit 3
    // has already been inserted inside the same transaction.
    execRaw(`
      CREATE TRIGGER fail_cursor BEFORE UPDATE ON feed_cursor
      BEGIN SELECT RAISE(ABORT, 'injected crash'); END;
    `);
    expect(() => store.applyCommit(commit(3))).toThrow(/injected crash/);
    expectInSyncAt(store, 2);

    // After "restart" the store is still at commit 2 and carries on.
    execRaw("DROP TRIGGER fail_cursor");
    store.close();
    store = new ConsumerStore(dbPath);
    expectInSyncAt(store, 2);
    expect(store.applyCommit(commit(3))).toBe(true);
    expectInSyncAt(store, 3);
  });

  test("a failure between two events of one commit leaves both unchanged", () => {
    store.applyCommit(commit(1));

    execRaw(`
      CREATE TRIGGER fail_seq_3 BEFORE INSERT ON events WHEN NEW.seq = 3
      BEGIN SELECT RAISE(ABORT, 'injected crash'); END;
    `);
    const twoEvents: VerifiedCommit = {
      ...commit(2),
      events: [...commit(2).events, ...commit(3).events],
    };

    expect(() => store.applyCommit(twoEvents)).toThrow(/injected crash/);
    expectInSyncAt(store, 1);
  });

  test("a connection that dies mid-transaction loses only the open commit", () => {
    store.applyCommit(commit(1));
    store.applyCommit(commit(2));

    // Stand in for a killed process: write commit 3's event on another
    // connection and drop that connection without committing.
    const dying = new DatabaseSync(dbPath);
    dying.exec("BEGIN IMMEDIATE");
    dying
      .prepare(
        "INSERT INTO events (did, stream, seq, rkey, cid, record) VALUES (?, ?, 3, 'r', 'c', '{}')",
      )
      .run(DID, STREAM);
    dying.close();

    store.close();
    store = new ConsumerStore(dbPath);
    expectInSyncAt(store, 2);
  });
});

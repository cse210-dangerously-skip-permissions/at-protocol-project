import { describe, expect, test } from "vitest";
import { type BufferedCommit, drainBuffer } from "./cutover.js";

const DID = "did:plc:abcdefghijklmnopqrstuvwx";
const STREAM = "releases";
// Revs are TIDs: same length, later ones sort higher.
const SNAPSHOT_REV = "3m5k2aaaaaa25";

/**
 * A buffered commit that creates one event.
 *
 * @param cursor - Firehose seq of the commit.
 * @param rev - Its repo rev.
 * @param seq - The seq of the event it creates.
 * @param cid - That event's CID.
 * @returns The commit.
 */
function commit(
  cursor: number,
  rev: string,
  seq: number,
  cid = `cid-${seq}`,
): BufferedCommit {
  return { cursor, did: DID, rev, events: [{ stream: STREAM, seq, cid }] };
}

/**
 * A view lookup over a fixed set of events.
 *
 * @param held - CIDs by seq, for `DID` and `STREAM`.
 * @returns The `have` function `drainBuffer` takes.
 */
function view(held: Record<number, string>) {
  return (did: string, stream: string, seq: number) =>
    did === DID && stream === STREAM ? (held[seq] ?? null) : null;
}

/** Each returned commit as `cursor:seq,seq`. */
function summary(commits: readonly BufferedCommit[]): string[] {
  return commits.map(
    (c) => `${c.cursor}:${c.events.map((e) => e.seq).join(",")}`,
  );
}

describe("drainBuffer", () => {
  test("drops everything when every commit is at or below the snapshot", () => {
    const buffered = [
      commit(10, "3m5k2aaaaaa23", 1),
      commit(11, "3m5k2aaaaaa24", 2),
      commit(12, SNAPSHOT_REV, 3),
    ];

    expect(
      drainBuffer(
        buffered,
        SNAPSHOT_REV,
        view({ 1: "cid-1", 2: "cid-2", 3: "cid-3" }),
      ),
    ).toEqual([]);
  });

  test("keeps everything when every commit is newer than the snapshot", () => {
    const buffered = [
      commit(13, "3m5k2aaaaaa26", 4),
      commit(14, "3m5k2aaaaaa27", 5),
    ];

    const result = drainBuffer(
      buffered,
      SNAPSHOT_REV,
      view({ 1: "cid-1", 2: "cid-2", 3: "cid-3" }),
    );

    expect(result).toEqual(buffered);
    // Untouched commits are passed through as they are.
    expect(result[0]).toBe(buffered[0]);
  });

  test("keeps only the newer commits when the buffer overlaps the snapshot", () => {
    const buffered = [
      commit(11, "3m5k2aaaaaa24", 2),
      commit(12, SNAPSHOT_REV, 3),
      commit(13, "3m5k2aaaaaa26", 4),
      commit(14, "3m5k2aaaaaa27", 5),
    ];

    expect(
      summary(
        drainBuffer(
          buffered,
          SNAPSHOT_REV,
          view({ 1: "cid-1", 2: "cid-2", 3: "cid-3" }),
        ),
      ),
    ).toEqual(["13:4", "14:5"]);
  });

  test("removes an event the view already holds with the same CID", () => {
    const newer: BufferedCommit = {
      cursor: 13,
      did: DID,
      rev: "3m5k2aaaaaa26",
      events: [
        { stream: STREAM, seq: 3, cid: "cid-3" },
        { stream: STREAM, seq: 4, cid: "cid-4" },
      ],
    };

    const result = drainBuffer([newer], SNAPSHOT_REV, view({ 3: "cid-3" }));

    expect(summary(result)).toEqual(["13:4"]);
    expect(result[0]).toMatchObject({ cursor: 13, rev: "3m5k2aaaaaa26" });
  });

  test("keeps a commit whose events are all held, so the cursor and rev still advance", () => {
    const result = drainBuffer(
      [commit(13, "3m5k2aaaaaa26", 3)],
      SNAPSHOT_REV,
      view({ 3: "cid-3" }),
    );

    expect(result).toEqual([
      { cursor: 13, did: DID, rev: "3m5k2aaaaaa26", events: [] },
    ]);
  });

  test("keeps an event whose CID differs from the one held", () => {
    const rewritten = commit(13, "3m5k2aaaaaa26", 3, "cid-3-rewritten");

    expect(
      drainBuffer([rewritten], SNAPSHOT_REV, view({ 3: "cid-3" })),
    ).toEqual([rewritten]);
  });

  test("removes an event an earlier buffered commit already carries", () => {
    const buffered = [
      commit(13, "3m5k2aaaaaa26", 4),
      commit(14, "3m5k2aaaaaa27", 4),
      commit(15, "3m5k2aaaaaa28", 4, "cid-4-rewritten"),
    ];

    const result = drainBuffer(buffered, SNAPSHOT_REV, view({}));

    // The second copy is a duplicate; the third is a different record.
    expect(summary(result)).toEqual(["13:4", "14:", "15:4"]);
  });

  test("keeps a commit delivered twice only once", () => {
    const once = commit(13, "3m5k2aaaaaa26", 4);

    expect(drainBuffer([once, { ...once }], SNAPSHOT_REV, view({}))).toEqual([
      once,
    ]);
  });

  test("returns commits in cursor order and leaves the input alone", () => {
    const buffered = [
      commit(15, "3m5k2aaaaaa28", 6),
      commit(13, "3m5k2aaaaaa26", 4),
      commit(14, "3m5k2aaaaaa27", 5),
    ];
    const before = structuredClone(buffered);

    expect(summary(drainBuffer(buffered, SNAPSHOT_REV, view({})))).toEqual([
      "13:4",
      "14:5",
      "15:6",
    ]);
    expect(buffered).toEqual(before);
  });

  test("looks events up under the commit's own DID", () => {
    const other = { ...commit(13, "3m5k2aaaaaa26", 3), did: "did:plc:other" };

    // The view holds seq 3 for DID, not for the other repo.
    expect(drainBuffer([other], SNAPSHOT_REV, view({ 3: "cid-3" }))).toEqual([
      other,
    ]);
  });

  test("keeps the other fields of a commit it trims", () => {
    const withHeads = {
      ...commit(13, "3m5k2aaaaaa26", 3),
      heads: [{ stream: STREAM, record: null }],
    };

    const [result] = drainBuffer(
      [withHeads],
      SNAPSHOT_REV,
      view({ 3: "cid-3" }),
    );

    expect(result?.heads).toBe(withHeads.heads);
    expect(result?.events).toEqual([]);
  });

  test("returns nothing for an empty buffer", () => {
    expect(drainBuffer([], SNAPSHOT_REV, view({}))).toEqual([]);
  });
});

import { DatabaseSync } from "node:sqlite";

/** One event record as the consumer keeps it in its view. */
export interface StoredEvent {
  /** DID of the publisher's repo. */
  did: string;
  /** Stream name, such as `releases`. */
  stream: string;
  /** Position in the stream, starting at 1. */
  seq: number;
  /** Record key in the repo, such as `releases-000000000042`. */
  rkey: string;
  /** CID of the record, as a string. */
  cid: string;
  /** The record itself, in a JSON-serializable form. */
  record: unknown;
}

/** An event inside a commit. The DID comes from the commit. */
export type CommitEvent = Omit<StoredEvent, "did">;

/** One verified firehose commit, reduced to what the view needs. */
export interface VerifiedCommit {
  /** Firehose sequence number of this commit. */
  cursor: number;
  /** DID of the repo the commit belongs to. */
  did: string;
  /** Repo revision after this commit. */
  rev: string;
  /** Our events created by this commit. May be empty. */
  events: readonly CommitEvent[];
}

/** Where the consumer got to: the feed cursor and the last rev per DID. */
export interface ConsumerCheckpoint {
  /** Last firehose sequence number applied, or `null` before the first one. */
  cursor: number | null;
  /** Last applied repo revision, keyed by DID. */
  revs: Record<string, string>;
}

/** Thrown when a commit carries a different CID for an event already stored. */
export class EventConflictError extends Error {
  readonly did: string;
  readonly stream: string;
  readonly seq: number;
  readonly storedCid: string;
  readonly incomingCid: string;

  /**
   * @param event - The incoming event that disagrees with the view.
   * @param storedCid - The CID already stored for the same position.
   */
  constructor(event: StoredEvent, storedCid: string) {
    super(
      `${event.did} ${event.stream} seq ${event.seq} is stored as ${storedCid} but the commit has ${event.cid}`,
    );
    this.name = "EventConflictError";
    this.did = event.did;
    this.stream = event.stream;
    this.seq = event.seq;
    this.storedCid = storedCid;
    this.incomingCid = event.cid;
  }
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS events (
    did    TEXT    NOT NULL,
    stream TEXT    NOT NULL,
    seq    INTEGER NOT NULL CHECK (seq >= 1),
    rkey   TEXT    NOT NULL,
    cid    TEXT    NOT NULL,
    record TEXT    NOT NULL,
    PRIMARY KEY (did, stream, seq)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS feed_cursor (
    id     INTEGER PRIMARY KEY CHECK (id = 1),
    cursor INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS repo_revs (
    did TEXT PRIMARY KEY,
    rev TEXT NOT NULL
  ) STRICT;
`;

interface EventRow {
  did: string;
  stream: string;
  seq: number;
  rkey: string;
  cid: string;
  record: string;
}

/**
 * Turn a database row back into a stored event.
 *
 * @param row - A row from the `events` table.
 * @returns The event with its record parsed.
 */
function toStoredEvent(row: EventRow): StoredEvent {
  return { ...row, record: JSON.parse(row.record) as unknown };
}

/**
 * Check that a number is a safe integer no smaller than a minimum.
 *
 * @param name - Field name for the error message.
 * @param value - The number to check.
 * @param min - Smallest allowed value.
 */
function assertInteger(name: string, value: number, min: number): void {
  if (!Number.isSafeInteger(value) || value < min) {
    throw new RangeError(`${name} must be an integer >= ${min}, got ${value}`);
  }
}

/**
 * The consumer's SQLite view of events plus its checkpoint.
 *
 * The view and the checkpoint live in one database and change in one
 * transaction per commit, so a crash leaves both at the same commit.
 */
export class ConsumerStore {
  readonly #db: DatabaseSync;

  /**
   * Open the store, creating the schema if it is missing.
   *
   * @param path - Database file path, or `:memory:` for a throwaway store.
   */
  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec("PRAGMA journal_mode = WAL");
    this.#db.exec("PRAGMA busy_timeout = 5000");
    this.#db.exec(SCHEMA);
  }

  /**
   * Apply one verified commit: its events, the feed cursor, and the repo
   * rev are written in a single transaction.
   *
   * A commit at or below the stored cursor is a replay and is skipped. An
   * event already stored with the same CID is left alone. An event stored
   * with a different CID is never overwritten: the whole commit is rolled
   * back and an `EventConflictError` is thrown.
   *
   * @param commit - The verified commit to apply.
   * @returns `true` if the commit was applied, `false` if it was a replay.
   */
  applyCommit(commit: VerifiedCommit): boolean {
    assertInteger("cursor", commit.cursor, 0);
    for (const event of commit.events) {
      assertInteger("seq", event.seq, 1);
    }

    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const applied = this.#writeCommit(commit);
      this.#db.exec("COMMIT");
      return applied;
    } catch (error) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {
        // SQLite already rolled back; rethrow the original error below.
      }
      throw error;
    }
  }

  /**
   * Read the checkpoint.
   *
   * @returns The feed cursor and the last rev per DID.
   */
  getCheckpoint(): ConsumerCheckpoint {
    // `all()` rather than `get()`: on Node 22.5 `get()` returns a row of
    // nulls instead of `undefined` when nothing matches.
    const cursorRows = this.#db
      .prepare("SELECT cursor FROM feed_cursor WHERE id = 1")
      .all() as unknown as { cursor: number }[];
    const cursorRow = cursorRows[0];
    const revRows = this.#db
      .prepare("SELECT did, rev FROM repo_revs ORDER BY did")
      .all() as unknown as { did: string; rev: string }[];

    const revs: Record<string, string> = {};
    for (const row of revRows) {
      revs[row.did] = row.rev;
    }
    return { cursor: cursorRow?.cursor ?? null, revs };
  }

  /**
   * Read one stream's events in sequence order.
   *
   * @param did - Publisher DID.
   * @param stream - Stream name.
   * @returns The stored events, lowest `seq` first.
   */
  getEvents(did: string, stream: string): StoredEvent[] {
    const rows = this.#db
      .prepare(
        "SELECT did, stream, seq, rkey, cid, record FROM events WHERE did = ? AND stream = ? ORDER BY seq",
      )
      .all(did, stream) as unknown as EventRow[];
    return rows.map(toStoredEvent);
  }

  /** Close the database. */
  close(): void {
    this.#db.close();
  }

  /**
   * Write a commit's rows. Must run inside a transaction.
   *
   * @param commit - The verified commit to write.
   * @returns `true` if rows were written, `false` if the commit was a replay.
   */
  #writeCommit(commit: VerifiedCommit): boolean {
    const { cursor } = this.getCheckpoint();
    if (cursor !== null && commit.cursor <= cursor) {
      return false;
    }

    const findCid = this.#db.prepare(
      "SELECT cid FROM events WHERE did = ? AND stream = ? AND seq = ?",
    );
    const insertEvent = this.#db.prepare(
      "INSERT INTO events (did, stream, seq, rkey, cid, record) VALUES (?, ?, ?, ?, ?, ?)",
    );

    for (const commitEvent of commit.events) {
      const event: StoredEvent = { ...commitEvent, did: commit.did };
      const matches = findCid.all(
        event.did,
        event.stream,
        event.seq,
      ) as unknown as { cid: string }[];
      const stored = matches[0];
      if (stored === undefined) {
        insertEvent.run(
          event.did,
          event.stream,
          event.seq,
          event.rkey,
          event.cid,
          JSON.stringify(event.record),
        );
      } else if (stored.cid !== event.cid) {
        throw new EventConflictError(event, stored.cid);
      }
    }

    this.#db
      .prepare(
        "INSERT INTO feed_cursor (id, cursor) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET cursor = excluded.cursor",
      )
      .run(commit.cursor);
    this.#db
      .prepare(
        "INSERT INTO repo_revs (did, rev) VALUES (?, ?) ON CONFLICT (did) DO UPDATE SET rev = excluded.rev",
      )
      .run(commit.did, commit.rev);
    return true;
  }
}

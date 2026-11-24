import { DatabaseSync } from "node:sqlite";
import {
  type EventRecord,
  eventRkey,
  parseEventRecord,
} from "@trustlab/contracts";
import type { SignedHead } from "./head.js";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS events (
    stream TEXT    NOT NULL,
    seq    INTEGER NOT NULL CHECK (seq >= 1),
    cid    TEXT    NOT NULL,
    record TEXT    NOT NULL,
    PRIMARY KEY (stream, seq)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS heads (
    stream    TEXT    PRIMARY KEY,
    seq       INTEGER NOT NULL CHECK (seq >= 1),
    event_cid TEXT    NOT NULL,
    sig       TEXT    NOT NULL
  ) STRICT;
`;

/** One stored event with its CID. */
export interface BaselineEvent {
  seq: number;
  /** CID of the record, computed the way AT computes it. */
  cid: string;
  record: EventRecord;
}

/** One atomic change to a stream: what a single AT commit would carry. */
export interface StreamChange {
  /** Events to store, replacing any at the same seq. */
  put?: BaselineEvent[];
  /** Delete every event with a seq above this one. */
  deleteAfter?: number;
  /** The new signed head, if the head moves. */
  head?: SignedHead;
}

/** The baseline server's SQLite store: events and one signed head per stream. */
export class BaselineStore {
  readonly #db: DatabaseSync;

  /**
   * Open the store, creating the schema if it is missing.
   *
   * @param path - Database file path, or `:memory:` for a throwaway store.
   */
  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec(SCHEMA);
  }

  /**
   * Read a stream's events in seq order.
   *
   * @param stream - Stream name.
   * @returns Every stored event, lowest seq first.
   */
  events(stream: string): BaselineEvent[] {
    const rows = this.#db
      .prepare(
        "SELECT seq, cid, record FROM events WHERE stream = ? ORDER BY seq",
      )
      .all(stream) as unknown as { seq: number; cid: string; record: string }[];
    return rows.map((row) => ({
      seq: row.seq,
      cid: row.cid,
      record: parseEventRecord(
        JSON.parse(row.record),
        eventRkey(stream, row.seq),
      ),
    }));
  }

  /**
   * Read a stream's signed head.
   *
   * @param stream - Stream name.
   * @returns The head and its signature, or `null` for a stream with no events.
   */
  head(stream: string): SignedHead | null {
    const row = this.#db
      .prepare("SELECT seq, event_cid, sig FROM heads WHERE stream = ?")
      .get(stream) as
      { seq: number; event_cid: string; sig: string } | undefined;
    if (row === undefined) return null;
    return {
      head: { stream, seq: row.seq, eventCid: row.event_cid },
      sig: row.sig,
    };
  }

  /**
   * Apply one change in a single transaction, so a reader sees the stream
   * before it or after it, never halfway.
   *
   * @param stream - Stream name.
   * @param change - The events to store or delete, and the new head.
   */
  write(stream: string, change: StreamChange): void {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      if (change.deleteAfter !== undefined) {
        this.#db
          .prepare("DELETE FROM events WHERE stream = ? AND seq > ?")
          .run(stream, change.deleteAfter);
      }
      const put = this.#db.prepare(
        `INSERT INTO events (stream, seq, cid, record) VALUES (?, ?, ?, ?)
         ON CONFLICT (stream, seq) DO UPDATE SET cid = excluded.cid, record = excluded.record`,
      );
      for (const event of change.put ?? []) {
        put.run(stream, event.seq, event.cid, JSON.stringify(event.record));
      }
      if (change.head !== undefined) {
        this.#db
          .prepare(
            `INSERT INTO heads (stream, seq, event_cid, sig) VALUES (?, ?, ?, ?)
             ON CONFLICT (stream) DO UPDATE SET seq = excluded.seq,
               event_cid = excluded.event_cid, sig = excluded.sig`,
          )
          .run(
            stream,
            change.head.head.seq,
            change.head.head.eventCid,
            change.head.sig,
          );
      }
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Close the database. */
  close(): void {
    this.#db.close();
  }
}

import { DatabaseSync } from "node:sqlite";
import type { WitnessCheckpoint } from "@trustlab/contracts";

// `id` records the order the witness saw checkpoints in. The unique key is
// (did, stream, seq, commit_cid): the same seq under two commits is the
// evidence of a rewrite, so both rows stay.
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS checkpoints (
    id          INTEGER PRIMARY KEY,
    did         TEXT    NOT NULL,
    stream      TEXT    NOT NULL,
    seq         INTEGER NOT NULL CHECK (seq >= 1),
    event_cid   TEXT    NOT NULL,
    head_cid    TEXT    NOT NULL,
    commit_cid  TEXT    NOT NULL,
    rev         TEXT    NOT NULL,
    proof_car   TEXT    NOT NULL,
    signing_key TEXT    NOT NULL,
    observed_at TEXT    NOT NULL,
    UNIQUE (did, stream, seq, commit_cid)
  ) STRICT;
`;

const COLUMNS = `did, stream, seq, event_cid AS eventCid, head_cid AS headCid,
  commit_cid AS commitCid, rev, proof_car AS proofCar,
  signing_key AS signingKey, observed_at AS observedAt`;

/**
 * The witness's SQLite log of checkpoints.
 *
 * Append-only: a checkpoint is never updated or deleted. Reads return them
 * in the order the witness saw them, newest first, not sorted by seq, so
 * after a rollback `latest` is the lower head the publisher now claims and
 * the higher one is still in `list`.
 */
export class CheckpointStore {
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
   * Save a checkpoint. A checkpoint with the same DID, stream, seq, and
   * commit CID as a stored one is a duplicate, and the stored row is kept
   * as it is.
   *
   * @param cp - The checkpoint to save.
   * @returns `"stored"` for a new checkpoint, `"duplicate"` otherwise.
   */
  add(cp: WitnessCheckpoint): "stored" | "duplicate" {
    const result = this.#db
      .prepare(
        `INSERT INTO checkpoints (did, stream, seq, event_cid, head_cid,
           commit_cid, rev, proof_car, signing_key, observed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (did, stream, seq, commit_cid) DO NOTHING`,
      )
      .run(
        cp.did,
        cp.stream,
        cp.seq,
        cp.eventCid,
        cp.headCid,
        cp.commitCid,
        cp.rev,
        cp.proofCar,
        cp.signingKey,
        cp.observedAt,
      );
    return Number(result.changes) === 1 ? "stored" : "duplicate";
  }

  /**
   * Read every checkpoint of one stream.
   *
   * @param did - Publisher DID.
   * @param stream - Stream name.
   * @returns The checkpoints, most recently seen first. Empty if none.
   */
  list(did: string, stream: string): WitnessCheckpoint[] {
    return this.#db
      .prepare(
        `SELECT ${COLUMNS} FROM checkpoints
         WHERE did = ? AND stream = ? ORDER BY id DESC`,
      )
      .all(did, stream) as unknown as WitnessCheckpoint[];
  }

  /**
   * Read the checkpoint of one stream the witness saw most recently.
   *
   * @param did - Publisher DID.
   * @param stream - Stream name.
   * @returns That checkpoint, or `null` if there are none.
   */
  latest(did: string, stream: string): WitnessCheckpoint | null {
    const row = this.#db
      .prepare(
        `SELECT ${COLUMNS} FROM checkpoints
         WHERE did = ? AND stream = ? ORDER BY id DESC LIMIT 1`,
      )
      .get(did, stream) as WitnessCheckpoint | undefined;
    return row ?? null;
  }

  /** Close the database. */
  close(): void {
    this.#db.close();
  }
}

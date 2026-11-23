# @trustlab/witness

Captures signed heads and proofs, and serves checkpoints.

- **Team:** Trust
- **System:** Witness (WIT)

## Capture

`startWitness({ env, store, allow })` (`src/witness.ts`) reads raw `subscribeRepos` frames and turns every head write from an allowed DID into a `WitnessCheckpoint` (`src/capture.ts`). The proof is trimmed to the signed commit, the MST path, and the head record. Each checkpoint must pass `checkCheckpoint` against the key in the publisher's DID document before it is stored; on failure the key is fetched again once, and a checkpoint that still fails is logged and dropped. Checkpoints are never replaced, and a lower seq is stored too, as evidence of a rollback.

`store` is anything with `add(cp)`, such as `CheckpointStore`. Cursor and gap tracking are #78, receipts #77.

## Store

`CheckpointStore` (`src/store.ts`) keeps checkpoints in SQLite (`node:sqlite`). It is append-only: `add(cp)` returns `"duplicate"` for a checkpoint with the same DID, stream, seq, and commit CID, and never changes a stored row. Two different commits at one seq are both kept, since that is the evidence of a rewrite.

`list(did, stream)` and `latest(did, stream)` return checkpoints in the order the witness saw them, newest first, not sorted by seq. After a rollback, `latest` is the lower head the publisher now claims, and the higher one stays in `list`. The auditor checks every checkpoint, not only the latest (#80).

AI agents: read [AGENTS.md](../../AGENTS.md) first.

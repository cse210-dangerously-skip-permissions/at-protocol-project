# @trustlab/witness

Captures signed heads and proofs, and serves checkpoints.

- **Team:** Trust
- **System:** Witness (WIT)

## Capture

`startWitness({ env, store, allow })` (`src/witness.ts`) reads raw `subscribeRepos` frames and turns every head write from an allowed DID into a `WitnessCheckpoint` (`src/capture.ts`). The proof is trimmed to the signed commit, the MST path, and the head record. Each checkpoint must pass `checkCheckpoint` against the key in the publisher's DID document before it is stored; on failure the key is fetched again once, and a checkpoint that still fails is logged and dropped. Checkpoints are never replaced, and a lower seq is stored too, as evidence of a rollback.

`store` is anything with `add(cp)`; #48's `CheckpointStore` fits. Cursor and gap tracking are #78, receipts #77.

AI agents: read [AGENTS.md](../../AGENTS.md) first.

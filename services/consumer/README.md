# @trustlab/consumer

Verified firehose subscription, DID allowlist, view, and checkpoint.

- **Team:** Pipeline
- **System:** Consumer (CNS)

## Store

`ConsumerStore` (`src/store.ts`) keeps the event view and the checkpoint in one SQLite database, using Node's built-in `node:sqlite`. `applyCommit` writes a commit's events, the feed cursor, and the repo rev in one transaction, so a crash leaves the view and checkpoint at the same commit.

`StoredEvent` and `ConsumerCheckpoint` come from `@trustlab/contracts`.

AI agents: read [AGENTS.md](../../AGENTS.md) first.

# @trustlab/consumer

Verified firehose subscription, DID allowlist, view, and checkpoint.

- **Team:** Pipeline
- **System:** Consumer (CNS)

## Allowlist

`makeAllowlist(dids)` (`src/allowlist.ts`) returns an `Allowlist`: `allow(did)` says whether to process data from that repo, and `dropped()` counts the calls that returned false. DIDs match exactly, and an empty list allows nothing. `allowlistFromEnv(env)` allows only `PUBLISHER_DID` from `.env.local`.

Call `allow` with a commit's repo DID before parsing or storing anything from it. The file imports only `@trustlab/contracts`, so it stays free of consumer internals.

## Store

`ConsumerStore` (`src/store.ts`) keeps the event view and the checkpoint in one SQLite database, using Node's built-in `node:sqlite`. `applyCommit` writes a commit's events, the feed cursor, and the repo rev in one transaction, so a crash leaves the view and checkpoint at the same commit.

`StoredEvent` and `ConsumerCheckpoint` come from `@trustlab/contracts`.

AI agents: read [AGENTS.md](../../AGENTS.md) first.

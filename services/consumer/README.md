# @trustlab/consumer

Verified firehose subscription, DID allowlist, view, and checkpoint.

- **Team:** Pipeline
- **System:** Consumer (CNS)

## Run

`npm run consume` follows the firehose and saves into `consumer.db`, resuming from its checkpoint after a restart. `npm run consume -- --fresh` uses an empty in-memory database instead: no memory of earlier history, as the experiments require, and no file touched. `--db <path>` picks another file. `--pds <url>` replaces `PDS_URL` from `.env.local`, such as the fault proxy from `npm run fault` ([infra/README.md](../../infra/README.md#cutting-a-service-off-from-the-pds)). Stop with Ctrl+C. The snapshot rebuild on startup comes with #45.

## Freshness

`freshVerdict(stored, verifiedAsOf, now, maxAgeMs)` (`src/freshness.ts`) decides what verdict to report. If the last successful check against the PDS is older than `FRESHNESS_MS` (default 30 seconds, read with `freshnessMs`), or there never was one, the answer is `unknown` with reason `stale`, whatever the stored verdict was. Storing `verified_as_of` with each verdict comes with #68.

## Allowlist

`makeAllowlist(dids)` (`src/allowlist.ts`) returns an `Allowlist`: `allow(did)` says whether to process data from that repo, and `dropped()` counts the calls that returned false. DIDs match exactly, and an empty list allows nothing. `allowlistFromEnv(env)` allows only `PUBLISHER_DID` from `.env.local`.

Call `allow` with a commit's repo DID before parsing or storing anything from it. The file imports only `@trustlab/contracts`, so it stays free of consumer internals.

## Store

`ConsumerStore` (`src/store.ts`) keeps the event view and the checkpoint in one SQLite database, using Node's built-in `node:sqlite`. `applyCommit` writes a commit's events, the feed cursor, and the repo rev in one transaction, so a crash leaves the view and checkpoint at the same commit.

`replaceRepo(did, rev, events)` writes a rebuild from a snapshot (`planRebuild` in `@trustlab/recovery`, #44): in one transaction it deletes the DID's events, stores the new ones, and sets the DID's rev. The view then matches what the publisher serves now. The feed cursor and other DIDs stay as they are. It writes nothing if an event belongs to another DID, a seq is not a positive integer, two events share a stream and seq, or the rev is older than the stored one.

`StoredEvent` and `ConsumerCheckpoint` come from `@trustlab/contracts`.

AI agents: read [AGENTS.md](../../AGENTS.md) first.

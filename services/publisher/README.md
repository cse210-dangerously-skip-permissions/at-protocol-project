# @trustlab/publisher

Publishes events and stream heads to the PDS.

- **Team:** Pipeline
- **System:** Publisher (PUB)

## Library

`src/publisher.ts` is what the CLI, the tamper tools, and the harness call:

- `login(env)` logs in to the PDS as the seeded publisher from `.env.local`.
- `readHead(session, stream)` returns the stream's head record, or `null` for a new stream.
- `publishEvent(session, input)` writes the next event with its `prevEventCid` and moves the head to it, in one commit.

Both records are checked with the `@trustlab/contracts` validators before they are sent, because the PDS does not know our Lexicons.

The event and the head go in one `com.atproto.repo.applyWrites` call, so one commit carries both and the head is never behind its event. The call sets `swapCommit` to the repo's latest commit, read just before. If another commit landed first the PDS answers `InvalidSwap`, and `publishEvent` waits a short random time, reads again, and retries, up to 10 attempts before it throws `PublishConflictError`. Two publishers on one stream therefore never reuse or skip a seq.

The head names the event's CID, so the CID is computed locally with `cidForRecord` from `@atproto/repo` before the write and checked against what the PDS returns.

If the request fails for any other reason, the response may have been lost after the commit. `publishEvent` reads the head again, and if it is already at this seq with this event's CID it returns instead of publishing twice. In that one case `commitCid` and `rev` are the repo's latest commit at the re-read, which is a later one if another write landed in between.

`swapCommit` guards the whole repo, not one stream, so any other write to the account also causes a retry.

## The `publish` command

```
npm run publish-events -- --stream releases --count 5 --seed 1
```

It publishes a seeded workload of release events and prints one JSON line per event. The `msg` field contains `published releases seq=1 cid=...`. `src/workload.ts` makes the payloads and `src/cli.ts` holds `runPublish`, which `trustlab publish` (#59) and the harness (#50) call.

The workload reads like a release feed: each package starts at `1.0.0`, every later release of it bumps the patch, minor, or major number, and no package and version repeats. With seed 1 the stream starts `date-kit@1.0.0`, `safe-merge@1.0.0`, `env-check@1.0.0`, `safe-merge@1.0.1`. The checksum is the SHA-256 of `name@version` (`releaseChecksum`), so anyone can recompute it and a tampered one stands out.

The event at seq n depends only on the seed and n: its payload is entry n of the workload and its `createdAt` is derived from the seed and the seq, not the clock. The command reads the head first and continues from there, so publishing 3 and then 3 writes the same records, with the same CIDs, as publishing 6 at once.

`publishEvent` has no default for `createdAt`. Every caller passes a time, or a function from the seq to a time, so nothing falls back to the clock by accident. Anything the harness compares across runs should pass `workloadCreatedAt(seed, seq)`.

## Corrections and withdrawals

```
npm run publish-events -- withdraw --stream releases --seq 2 --seed 1
npm run publish-events -- correct --stream releases --seq 2 --seed 1 --checksum sha256:fixed
```

Both append a new event of kind `withdraw` or `correct` with `refSeq` set to `--seq`. The event at `--seq` is read and never written, so its CID stays the same. The new event copies that event's payload, and `correct` replaces the fields given with `--version` or `--checksum`. `--seed` gives the new event's `createdAt` from its seq, as `publish` does.

A `--seq` the stream does not have is rejected before anything is written. `src/amend.ts` holds `amendEvent` and `runAmend` for the harness and `trustlab` (#59).

## Tamper tools

```
npm run publish-events -- tamper edit --stream releases --seq 2
npm run publish-events -- tamper rewrite --stream releases --from 3
npm run publish-events -- tamper truncate --stream releases --to 3
```

`src/tamper.ts` breaks the contract on purpose, for experiments. These are legal writes by the account owner, so the PDS accepts them and only the chain and the witness can catch them.

Each tool sends one `applyWrites`, so a tamper is one commit: a consumer on the firehose sees the stream before it or after it, never halfway. The call sets `swapCommit` to the commit read before anything else. If a publish lands while the tool is reading, it throws `TamperConflictError` with nothing written, and does not retry. One commit takes at most 200 writes (`MAX_TAMPER_WRITES`), so `rewrite` covers up to 199 events and `truncate` deletes up to 199.

- `tamperEdit(session, stream, seq)` changes one event's payload in place. The event gets a new CID and the next event's `prevEventCid` no longer matches.
- `tamperRewrite(session, stream, from)` rewrites every event from `from` to the head with a changed payload, then moves the head. The event at `from` keeps its link to the untouched event before it, and each later one links to the rewritten event before it. The chain is valid on its own; only the CIDs differ from what was published before.
- `tamperTruncate(session, stream, to)` deletes the events after `to` and moves the head back to `to`.

The changed checksum (`withChangedPayload`, also used by the S0 baseline in #83) is `tampered:` plus the SHA-256 of the old one, so it has the same length however often an event is tampered with. Each function returns the new CIDs, the head it wrote, and the commit, and the command prints them: `tampered releases rewrite seq=3 cid=...` per event, or `tampered releases truncate to=3 cid=...`.

Never run these against a stream you want to keep.

The integration test is `tests/integration/publisher.test.ts`. Run it with `npm run stack:up`, then `npm run test:integration`.

AI agents: read [AGENTS.md](../../AGENTS.md) first.

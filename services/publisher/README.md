# @trustlab/publisher

Publishes events and stream heads to the PDS.

- **Team:** Pipeline
- **System:** Publisher (PUB)

## Library

`src/publisher.ts` is what the CLI, the tamper tools, and the harness call:

- `login(env)` logs in to the PDS as the seeded publisher from `.env.local`.
- `readHead(session, stream)` returns the stream's head record, or `null` for a new stream.
- `publishEvent(session, input)` writes the next event with its `prevEventCid`, then moves the head to it.

Both records are checked with the `@trustlab/contracts` validators before they are sent, because the PDS does not know our Lexicons.

The event and the head are two separate writes for now. If the process dies between them, the head stays one behind. #63 makes them atomic. Do not publish to one stream from two places at once.

## The `publish` command

```
npm run publish-events -- --stream releases --count 5 --seed 1
```

It publishes a seeded workload of release events and prints one line per event: `published releases seq=1 cid=...`. `src/workload.ts` makes the payloads and `src/cli.ts` holds `runPublish`, which `trustlab publish` (#59) and the harness (#50) call.

The event at seq n depends only on the seed and n: its payload is entry n of the workload and its `createdAt` is derived from the seed and the seq, not the clock. The command reads the head first and continues from there, so publishing 3 and then 3 writes the same records, with the same CIDs, as publishing 6 at once.

`publishEvent` has no default for `createdAt`. Every caller passes a time, or a function from the seq to a time, so nothing falls back to the clock by accident. Anything the harness compares across runs should pass `workloadCreatedAt(seed, seq)`.

## Corrections and withdrawals

```
npm run publish-events -- withdraw --stream releases --seq 2 --seed 1
npm run publish-events -- correct --stream releases --seq 2 --seed 1 --checksum sha256:fixed
```

Both append a new event of kind `withdraw` or `correct` with `refSeq` set to `--seq`. The event at `--seq` is read and never written, so its CID stays the same. The new event copies that event's payload, and `correct` replaces the fields given with `--version` or `--checksum`. `--seed` gives the new event's `createdAt` from its seq, as `publish` does.

A `--seq` the stream does not have is rejected before anything is written. `src/amend.ts` holds `amendEvent` and `runAmend` for the harness and `trustlab` (#59).

The integration test is `tests/integration/publisher.test.ts`. Run it with `npm run stack:up`, then `npm run test:integration`.

AI agents: read [AGENTS.md](../../AGENTS.md) first.

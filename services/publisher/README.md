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

The payloads and each `createdAt` come from the seed, not the clock. The same seed on a fresh stream writes the same records and gets the same CIDs. On a stream that already has events, the seq and `prevEventCid` differ, so the CIDs do too.

The integration test is `tests/integration/publisher.test.ts`. Run it with `npm run stack:up`, then `npm run test:integration`.

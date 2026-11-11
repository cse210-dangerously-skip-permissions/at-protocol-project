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

The integration test is `tests/integration/publisher.test.ts`. Run it with `npm run stack:up`, then `npm run test:integration`.

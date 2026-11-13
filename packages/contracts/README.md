# @trustlab/contracts

Shared types, record keys, and runtime validators. This is the only code the services share: they talk to each other through AT or through the types here, never through each other's internals.

- **Team:** Foundation
- **System:** Contracts & Integration (CTR)

## What's in it

| File              | Exports                                                                                                                                        |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/keys.ts`     | `EVENT_NSID`, `HEAD_NSID`, and the record keys: `eventRkey`, `headRkey`, `parseEventRkey`, `parseHeadRkey`, `isStreamName`, `isSeq`            |
| `src/types.ts`    | `EventRecord`, `HeadRecord`, `Payload`, `StoredEvent`, `ConsumerCheckpoint`, `Verdict`, `WitnessCheckpoint`, `CheckpointsResponse`, `LocalEnv` |
| `src/validate.ts` | `parseEventRecord`, `parseHeadRecord`, `parseWitnessCheckpoint`, `parseCheckpointsResponse`, `ContractError`                                   |
| `src/env.ts`      | `loadLocalEnv`, which reads `.env.local`                                                                                                       |

```ts
import {
  EVENT_NSID,
  eventRkey,
  loadLocalEnv,
  parseEventRecord,
} from "@trustlab/contracts";

const env = loadLocalEnv(); // PDS_URL, PLC_URL, PUBLISHER_DID, ...
const rkey = eventRkey("releases", 42); // "releases-000000000042"
const event = parseEventRecord(recordFromTheFirehose, rkey); // throws ContractError if invalid
```

## Validate at the boundary

TypeScript types are gone at runtime, so anything read off the network is `unknown` until a `parse*` function has checked it: records from the firehose, `getRepo`, and `getRecord`, and the witness API's response. Call the validator where the data comes in and pass the typed value inward.

`parseEventRecord` and `parseHeadRecord` check the Lexicons in [`lexicons/`](../../lexicons) with `@atproto/lexicon`, then the cross-field rules a Lexicon can't express. The Lexicon README lists them.

The validators check one record's shape. Whether a chain of events is valid, or whether a checkpoint's proof holds, is the auditor's job.

## Changing this package

A change here changes the contract for every team, so it needs a review from each team that uses it. Keep network, database, and service code out: only types, constants, pure helpers, and validators belong here.

The interfaces in `src/types.ts` are written by hand to match the Lexicons. Generating them from `lexicons/` is the second half of CTR-2 (#30).

AI agents: read [AGENTS.md](../../AGENTS.md) first.

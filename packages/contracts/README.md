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
| `src/generated/`  | Not exported. Record types and Lexicon validators that `npm run codegen` generates from `lexicons/`; `validate.ts` calls them                  |

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

`parseEventRecord` and `parseHeadRecord` check the Lexicons in [`lexicons/`](../../lexicons) with the validators generated from them, then the cross-field rules a Lexicon can't express. The Lexicon README lists them.

The validators check one record's shape. Whether a chain of events is valid, or whether a checkpoint's proof holds, is the auditor's job.

## Changing this package

A change here changes the contract for every team, so it needs a review from each team that uses it. Keep network, database, and service code out: only types, constants, pure helpers, and validators belong here.

## Generated code

`npm run codegen` runs `@atproto/lex-cli` on every Lexicon in `lexicons/` and writes `src/generated/`. Don't edit those files; change the Lexicon and run it again. CI runs `npm run codegen:check`, which fails if the committed files are not what a fresh run produces.

The types everyone imports (`EventRecord`, `HeadRecord`, `Payload`, `EventKind`) stay hand-written in `src/types.ts`, because the generated ones allow any extra field and any `kind` string. `src/lexicon.test.ts` compares the two at compile time, so when a Lexicon changes, `npm run typecheck` fails until `types.ts` matches it. ADR-002 records why lex-cli.

AI agents: read [AGENTS.md](../../AGENTS.md) first.

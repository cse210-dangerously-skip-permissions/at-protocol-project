# @trustlab/auditor

Chain validation, witness comparison, and verdicts.

- **Team:** Trust
- **System:** Auditor & Test Harness (AUD)

## Chain validation

`validateChain(events, head?)` (`src/chain.ts`) checks one publisher stream
without network or database access. It accepts events in any order and checks
the genesis rule, sequence continuity, every `prevEventCid`, correction and
withdrawal targets, and the optional head. It returns the first conflict with
the affected sequence, or `accept` with reason `ok` or `empty`.

Records must pass `parseEventRecord` before they are put in a `StoredEvent`.
The validator checks relationships between those individually valid records.

## Checkpoints

`verifyCheckpoint(cp)` (`src/checkpoint.ts`) checks a `WitnessCheckpoint` offline, with no network and no PDS. It returns true only if:

- every block in `proofCar` matches its CID, and the CAR's root is `commitCid`;
- that commit is for `did`, has revision `rev`, and is signed by `signingKey`;
- the commit's MST maps `dev.trustlab.head/head-<stream>` to `headCid`;
- the head record in the CAR has the checkpoint's `stream`, `seq`, and `eventCid`.

`checkCheckpoint(cp)` runs the same checks and says which one failed. Neither throws: a malformed checkpoint is just invalid.

The proof is checked against `signingKey`, the key the witness stored. ADR-003 rule 3 trusts the publisher's DID document instead, so the auditor passes `{ ...cp, signingKey: keyFromDidDocument }`. A checkpoint that fails against that key is `bad-evidence`, never `conflict`.

`proofCar` can be the whole `blocks` CAR of the firehose commit or just the commit, the MST path, and the head record; both verify. [The #46 spike](../../tools/harness/spikes/README.md) has the sizes.

## Tampered-commit fixtures

`src/commit-fixtures.test.ts` (#51) runs `parseCommitAuthenticated` from `@atproto/sync`, the verifier the consumer's firehose uses, on one real commit from the local PDS and four tampered copies. It needs no stack: the resolver is a stub that returns the key saved with the capture.

| Case                                | Result                             |
| ----------------------------------- | ---------------------------------- |
| The original capture                | both ops verified                  |
| Commit re-signed with a flipped sig | throws `Invalid signature`         |
| Event bytes changed, same CID       | throws `Not a valid CID for bytes` |
| Event op claims a different CID     | event op dropped, no error         |
| `repo` set to another DID           | throws `Invalid repo did`          |

The fourth case is the silent drop ADR-002 describes. The fixture is `test/fixtures/commit.json`; [`capture-commit.ts`](../../tools/harness/spikes/README.md) rewrites it.

AI agents: read [AGENTS.md](../../AGENTS.md) first.

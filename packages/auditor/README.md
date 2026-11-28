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

## Witness comparison

`compareWithWitness(subject, events, checkpoints, verify?, head?)` (`src/witness.ts`) applies the verdict rules in ADR-003, in order. `subject` is the `{ did, stream }` being audited:

| Rule                                                                              | Verdict    | Reason                                                 |
| --------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------ |
| `events` is `"unreachable"`                                                       | `unknown`  | `pds-unreachable`                                      |
| `validateChain(events, head)` finds a conflict                                    | `conflict` | unchanged, such as `broken-link`                       |
| `checkpoints` is `"unreachable"`                                                  | `unknown`  | `witness-unreachable`                                  |
| A verified checkpoint is above the current head, or has another CID at its seq    | `conflict` | `truncated`, `rewritten`                               |
| A checkpoint fails `verify`, is for another DID or stream, or there's no `verify` | `unknown`  | `bad-evidence`                                         |
| Otherwise                                                                         | `accept`   | `extends-witness`, or `no-witness` with no checkpoints |

Every checkpoint is checked, not only the newest, since the newest may postdate the rewrite. A checkpoint that fails verification never leads to `conflict`, so a bad witness can't frame a publisher. When several checkpoints conflict, the lowest seq is reported, with the witnessed and current CIDs as evidence. The result doesn't depend on input order.

Checkpoints are checked against `subject`, not the events, so an empty chain still rejects a signed checkpoint from another stream. An event for another DID or stream than `subject` throws.

`verify` has no default. `verifyCheckpoint` alone trusts the key the witness stored, and a witness can store its own key. On AT, pass one that uses the key from the publisher's DID document (ADR-003 rule 3), as `e2e/observed-rollback.spec.ts` does. Without `verify`, any checkpoint is `bad-evidence`, and a call with no checkpoints works as before. A `verify` that throws counts as a failed check.

Story #21's spec, `e2e/observed-rollback.spec.ts`, runs a real witness while the publisher writes five events, then rewrites or truncates them with the tamper tools. A fresh consumer rebuilt from a snapshot gets `accept` (`no-witness`) without the checkpoints and `conflict` (`rewritten` or `truncated`) with them.

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

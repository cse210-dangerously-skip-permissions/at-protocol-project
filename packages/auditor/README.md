# @trustlab/auditor

Chain validation, witness comparison, and verdicts.

- **Team:** Trust
- **System:** Auditor & Test Harness (AUD)

## Checkpoints

`verifyCheckpoint(cp)` (`src/checkpoint.ts`) checks a `WitnessCheckpoint` offline, with no network and no PDS. It returns true only if:

- every block in `proofCar` matches its CID, and the CAR's root is `commitCid`;
- that commit is for `did`, has revision `rev`, and is signed by `signingKey`;
- the commit's MST maps `dev.trustlab.head/head-<stream>` to `headCid`;
- the head record in the CAR has the checkpoint's `stream`, `seq`, and `eventCid`.

`checkCheckpoint(cp)` runs the same checks and says which one failed. Neither throws: a malformed checkpoint is just invalid.

The proof is checked against `signingKey`, the key the witness stored. ADR-003 rule 3 trusts the publisher's DID document instead, so the auditor passes `{ ...cp, signingKey: keyFromDidDocument }`. A checkpoint that fails against that key is `bad-evidence`, never `conflict`.

`proofCar` can be the whole `blocks` CAR of the firehose commit or just the commit, the MST path, and the head record; both verify. [The #46 spike](../../tools/harness/spikes/README.md) has the sizes.

AI agents: read [AGENTS.md](../../AGENTS.md) first.

# @trustlab/recovery

`getRepo` snapshot fetch, verification, and view rebuild.

- **Team:** Pipeline
- **System:** Recovery (REC)

## Snapshots

`fetchSnapshot({ pdsUrl, plcUrl, did })` (`src/snapshot.ts`) downloads a publisher's whole repo with `com.atproto.sync.getRepo` and verifies it before returning anything:

- every block matches its CID, so a flipped byte fails;
- the commit is for `did` and is signed by the key in the DID document on the PLC, never a key the PDS supplies (ADR-003);
- every record block is present;
- the MST's keys are strictly in order. `@atproto/repo` does not check this, and a signed tree holding a key twice gives a full walk and a key lookup (which proofs use) different records for the same commit.

It returns a `Snapshot`: the commit's `rev` and `commitCid`, every `dev.trustlab.event` record as a `StoredEvent` ordered by stream and seq, and each stream's head record by stream name. Other collections are left out. Our records are checked with the `@trustlab/contracts` validators, so a signed record that breaks the contract throws `ContractError`.

Failures throw `SnapshotError`, whose `problem` says which step failed:

| `problem`         | When                                                                                                                                                                   |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pds-unreachable` | The PDS could not be reached, `getRepo` returned an error, or the repo did not arrive within `timeoutMs` (default 30 s) or was larger than `maxBytes` (default 64 MiB) |
| `did-unresolved`  | The PLC could not be reached, or has no DID document or key for `did`; or `verifySnapshot` was given no DID or key                                                     |
| `invalid-repo`    | A bad block, the wrong DID, a bad signature, a missing or malformed record, or MST keys that repeat or are out of order                                                |

`verifySnapshot(car, did, signingKey)` is the offline half, for a CAR and key the caller already has.

Both default to the global `fetch`, which reaches the local network. `@atproto/identity`'s own default refuses localhost; pass a `fetch` to change either.

The package returns plain data and does not import the consumer.

## Rebuild

`planRebuild(snapshot)` (`src/rebuild.ts`) turns a snapshot into what the view should hold. It is pure. Each event's stream and seq come from its record, checked against the contract, never from the record key or a time, and the events come back ordered by stream, then seq.

Gaps are reported, not fixed: for each stream, the seqs missing between 1 and its highest seq, as inclusive ranges. Events 1, 2, and 4 give `{ stream, missing: [{ from: 3, to: 3 }] }`. Ranges keep the result small even when a publisher signs an event at `MAX_SEQ`. The auditor decides what a gap means (#79).

An event from another DID, or two events with the same stream and seq, throws: a verified snapshot never has either.

The consumer writes the plan with `ConsumerStore.replaceRepo`, which replaces that DID's events and rev in one transaction (#45 wires the two together). A rebuild replaces the view: it matches what the publisher serves now.

The integration test is `tests/integration/recovery.test.ts`. Run it with `npm run stack:up`, then `npm run test:integration`.

AI agents: read [AGENTS.md](../../AGENTS.md) first.

# ADR 004: Event contract

- Status: proposed
- Date: 2026-11-18

## Context

The experiment asks whether a witness can catch a publisher rewriting its history (ADR-003). For "history" to mean anything, events need an order and must never change once published. AT Protocol does not give us either.

An AT repo holds the _current_ state of its records. Every commit is signed, and the MST proves which records exist at that commit, but the owner can update or delete any record at any time and sign the result. The new commit is just as valid as the old one. Nothing in AT says that record A came before record B, or that a record still has the value it had yesterday. The firehose shows changes as they happen, but a consumer that starts later sees only the current repo.

Order and immutability have to be rules of our application, written into the records themselves and checked by the auditor. This ADR is that contract. The schema is in the `dev.trustlab.event` and `dev.trustlab.head` Lexicons (#34, [lexicons/README.md](../../lexicons/README.md)), and the cross-field rules are checked by `parseEventRecord` and `parseHeadRecord` in `@trustlab/contracts`.

## Decision

### Records and namespace

Two record types, in two collections:

| NSID                 | Record key                                                 | What it holds                                                                                                         |
| -------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `dev.trustlab.event` | `<stream>-<12-digit seq>`, such as `releases-000000000042` | `stream`, `seq`, `prevEventCid` (after seq 1), `kind`, `refSeq` (corrections and withdrawals), `payload`, `createdAt` |
| `dev.trustlab.head`  | `head-<stream>`, such as `head-releases`                   | `stream`, `seq`, and `eventCid` of the latest event                                                                   |

The NSIDs use the authority `dev.trustlab`, which implies the domain `trustlab.dev`. **We do not own that domain.** On the local network nothing resolves Lexicons by domain, so this works. Before any record is published to the public AT network, the NSIDs must move to a domain the team controls, and that is a contract change that needs its own issue.

### Sequences are per (DID, stream)

A stream is identified by the publisher's DID and a stream name. Each stream has its own sequence: the first event is seq 1, and each event is exactly one more than the one before it, with no gaps or repeats. Seq is our own counter. It is not the firehose sequence number, the repo `rev`, or a TID, and it is not shared between streams or publishers. Two publishers can both have `releases` seq 1.

A stream name is a lowercase letter followed by up to 31 lowercase letters or digits, so it contains no hyphen and the record key splits back into stream and seq unambiguously. Seq goes up to `MAX_SEQ` (twelve digits).

### Every event after the first links to the one before it

- The event at seq 1 has no `prevEventCid`.
- Every event at seq > 1 has a `prevEventCid`, and it must be the record CID of the event at `seq - 1` in the same stream: the CID the PDS reports when it writes the record, and the one `getRepo` and the firehose carry.

Because an event's CID is a hash of the whole record, including its `prevEventCid`, each event commits to the entire chain before it. This is the hash chain the auditor walks (#79).

### The head names the latest event

Each stream has one head record at `head-<stream>`, holding the latest event's seq and record CID. The head is the one record the witness captures and signs evidence for (ADR-003, ADR-008). The event and its head update are written in one `applyWrites` call guarded by `swapCommit` (#63), so a reader never sees one without the other.

### Record keys are deterministic

Record keys come from the record's own fields, through `eventRkey` and `headRkey` in `@trustlab/contracts`, never from a TID or a random value, and never formatted by hand. That means:

- Anyone can fetch event N of a stream with `getRecord` without listing the collection.
- The key itself is part of the contract: a record whose key does not match its `stream` and `seq` is invalid, and `parseEventRecord(value, rkey)` rejects it.
- Two writes for the same seq collide on the same key, so the PDS (with `swapCommit`) rejects a duplicate instead of silently adding a second event.
- The 12-digit zero-padding makes keys sort in seq order, though consumers still order by `seq`, not by key.

### Corrections and withdrawals are new events

Published events are never changed. To correct or withdraw one, the publisher appends a new event at the next seq:

- `kind: "correct"` with `refSeq` set to the seq it corrects, and the corrected payload.
- `kind: "withdraw"` with `refSeq` set to the seq it withdraws.
- `refSeq` must be lower than the new event's own seq. A `release` has no `refSeq`.

The original event stays in the chain unchanged. A correction or withdrawal extends every earlier head, so the auditor returns `accept` for it (ADR-003), not `conflict`. Consumers apply the correction or withdrawal when they build their view.

### Editing or deleting a published event violates the contract

Once an event is written, the publisher must not update it, delete it, or replace the head with one that does not extend it. AT allows all three, and the tamper tools (#65) do them on purpose, but each one breaks this contract. A publisher that does one is treated as dishonest, and the auditor reports it as `conflict` whenever the evidence can show it.

### What the chain catches, and what it cannot

The chain alone, without a witness, catches an **in-place edit of an interior event**. If event N changes, its CID changes, and event N+1 still names the old CID in `prevEventCid`. The link is broken and the auditor returns `conflict` (`broken-link`) from the current repo alone. Deleting an interior event leaves a gap in seq, which it also catches.

The chain alone cannot catch a **rewritten suffix** or a **truncation** where the publisher keeps the chain consistent:

- Rewrite events N onward, re-link each new event to the one before it, and move the head to the new last event. Every link is valid.
- Delete events after N and move the head back to N. The remaining chain is valid and the head matches it.

In both cases the current repo is a valid chain, and nothing in it shows that a different chain existed earlier. Only someone who kept an earlier signed head can show the difference. That is why the witness exists (ADR-003): a checkpoint pins the CID at a witnessed seq, and a current chain that differs at or below that seq is `conflict`.

## Alternatives considered

- **Rely on AT alone, using record order or repo `rev`:** AT orders commits, not our events, and a rewrite produces new commits with newer revs. The current repo carries no evidence of what it replaced.
- **TID record keys:** They are AT's default and sort by time, but they are generated, not derived. A reader could not fetch event N directly, and two writes for the same seq would land under different keys instead of colliding.
- **Corrections and withdrawals as updates to the original record:** Simpler for consumers, but an update is exactly what a rewrite looks like. The auditor could not tell an honest correction from tampering.
- **Link with a hash of the payload instead of the record CID:** It would leave `seq`, `kind`, and `createdAt` out of the chain, and we would have to define our own hashing. The record CID is what AT already signs and the firehose already carries.
- **One sequence per publisher instead of per stream:** Simpler keys, but unrelated streams would block each other and a correction in one stream would move the seq of another.
- **Register a domain we own for the NSID now:** Not needed on a local network, and it would delay the Lexicons. Recorded here as a change required before going public.

## Consequences

- `parseEventRecord` and `parseHeadRecord` enforce the per-record rules (stream name, seq range, link presence, `refSeq`, rkey match). The chain validator (#79) enforces the rules that span records: seq continuity, each `prevEventCid` matching the previous event's CID, and the head matching the latest event.
- Publisher code builds keys only with `eventRkey` and `headRkey`, and writes events and heads only through the atomic publish path (#63). Corrections and withdrawals go through the same path (#141).
- Consumers, recovery, and the auditor order events by `seq`, and treat any update or delete of an event record as evidence to flag (CNS-5), not as a new value to apply.
- The headline demo is a suffix rewrite or truncation, not an interior edit (ADR-003), since only the former needs the witness.
- Moving to the public network requires new NSIDs under a domain the team owns. Any change to these rules after the Sprint 2 contract freeze needs an issue and sign-off from every team that reads the records.

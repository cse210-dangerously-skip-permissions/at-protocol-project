# ADR 003: Threat model and audit verdicts

- Status: proposed
- Date: 2026-11-11

## Context

A publisher controls its own repo. It can rewrite its history and re-sign the result, and the new history is valid and self-consistent. Looking only at what the publisher serves now, nobody can tell "it was always like this" from "it was just changed". A rewrite can only be detected by someone other than the publisher who kept an earlier signed version. In this project that someone is the witness. Without one, the most anyone can verify is the current state, which is what AT already provides.

The auditor (#79, #80) turns this evidence into one of three verdicts, `accept`, `conflict`, or `unknown` (`VerdictKind` in `packages/contracts`). The design doc's Threat model and Trust model sections say who is trusted, but not the exact rules or what happens when several conditions hold at once.

The design doc's headline demo is also the wrong scenario. It replaces event 2 in place and leaves event 3 untouched. Event 3 still carries the old event-2 CID, so the chain alone catches it (ADR-004, #37), and the demo shows nothing A1 adds over A0. The case only a witness can catch is a rewritten suffix that is re-linked, or a truncation: the result is a valid chain that differs from what was seen before.

**Terms.** _Seq_ is an event's position in its `(publisher DID, stream)`, from 1 with no gaps (ADR-004). It is not the firehose sequence number or the repo `rev`. A _witness checkpoint_ (`WitnessCheckpoint`) is a snapshot the witness takes each time the stream head changes: how far the stream had been written at that moment (the head's seq and event CID), plus the publisher-signed commit and MST proof that let anyone verify it offline. As the stream grows the witness takes a new snapshot, so it holds many, each from a different moment. This is different from the _consumer checkpoint_ (`ConsumerCheckpoint`), which only records how far a consumer has processed the firehose. "Checkpoint" below always means a witness checkpoint.

## Decision

### Who is trusted

- **Adversary:** one dishonest publisher. It controls its own repo and signing key, and can edit, delete, re-link, or truncate any of its records at any time.
- **Witness:** one honest witness that saw and stored at least one earlier head of the stream. "Honest" means it stores what it saw and serves it back. It can still be offline or behind.
- **Consumer:** chooses which publisher DIDs and which witness to trust (local allowlist). It trusts nothing it cannot verify with a publisher signature.
- **AT Protocol:** PDS commit signatures, MST proofs, and DID resolution work as specified. AT gives us signed _current_ state, not history. History comes from our hash chain (ADR-004) plus the witness.

A signature proves who signed something, not that it is honest or current. A witness can withhold checkpoints or serve old ones. It cannot forge a checkpoint for an uncompromised publisher key.

### Verdict rules

The auditor applies these in order and stops at the first that matches.

1. **`conflict`: the chain alone is broken** (#79, rules in ADR-004). This needs no witness, so it does not wait for one.
2. **`unknown`: the evidence cannot be fetched.** The PDS or witness is unreachable.
3. **`conflict`: the chain contradicts a verified checkpoint** (#80). For any checkpoint that passes offline verification (publisher signature and MST proof):
   - the current head is below the witnessed seq (`truncated`), or
   - the current event at the witnessed seq has a different CID than the one witnessed (`rewritten`).

   Every stored checkpoint is checked, not only the latest, because the latest may postdate the rewrite.

4. **`unknown`: a checkpoint fails verification** (`bad-evidence`). A bad or broken witness must not be able to frame a publisher, so failed evidence never counts toward `conflict`.
5. **`accept`: otherwise.** The chain is valid and extends every verified checkpoint (`extends-witness`), or there are no checkpoints yet (`no-witness`, a chain-only result).

A signed `correct` or `withdraw` is a new event at the next seq. It extends every earlier head, so it is `accept`, never a rollback.

### One checkpoint pins the whole prefix

Each event's CID covers its `prevEventCid`, so if the event at a witnessed seq still has the witnessed CID, every event before it is unchanged too. This has three consequences:

- Checking a checkpoint takes one CID comparison, not a replay.
- The witness only needs to keep heads, not every event.
- A witness that starts late still protects everything before its first checkpoint, provided nothing was rewritten before then.

The same reasoning applies to more than one witness, which is out of scope for P0. Two verified checkpoints with different CIDs at the same seq are both signed by the publisher, so either one is enough for `conflict`. Witnesses do not need to vote.

### Scenarios

| Scenario                                                      | Caught by | Verdict                                                          | Scope                                      |
| ------------------------------------------------------------- | --------- | ---------------------------------------------------------------- | ------------------------------------------ |
| Rewrite a suffix after a witnessed head, re-linking the chain | Witness   | `conflict` (`rewritten`)                                         | **Headline demo** (A0 accepts, A1 rejects) |
| Truncate below a witnessed head                               | Witness   | `conflict` (`truncated`)                                         | Core test                                  |
| Edit an interior event in place, leaving later links          | Chain     | `conflict` (`broken-link`)                                       | Core test (A0 and A1 both reject)          |
| Legitimate signed withdrawal or correction                    | —         | `accept`                                                         | Control                                    |
| PDS or witness unreachable                                    | —         | `unknown`                                                        | Core test                                  |
| Witness serves only old checkpoints                           | —         | `accept`, but only proves history up to the newest seq it served | Accepted risk                              |
| Rewrite before any honest witness saw the head                | Nothing   | `accept`                                                         | Out of scope                               |
| Rewrite while the witness is down, repaired before it returns | Nothing   | `accept`                                                         | Out of scope                               |
| Witness and publisher collude, or stolen publisher key        | Nothing   | No guarantee                                                     | Out of scope                               |
| PDS shows different views to witness and consumer             | —         | —                                                                | Stretch                                    |
| Key rotation without verifiable key history                   | —         | `unknown`                                                        | Out of scope for P0 (#96)                  |

### What no witness can catch

- A rewrite before the witness first saw the head. There is no earlier evidence to compare against, so a fresh consumer sees a valid chain and accepts.
- Anything that happens and is undone while the witness is down. It only knows heads it observed.
- A witness keeps evidence, not content. If the PDS loses event content, the witness can show what the publisher signed, not restore the events.

### No witness signature in P0

With one honest witness that the consumer queries directly, every checkpoint is checked against the publisher's signature, so a witness signature adds nothing yet. It becomes necessary once there are several witnesses or checkpoints are passed between parties, to show which witness saw a head and when. This is deferred, not rejected: see #77 (receipts in the witness's own repo). What the witness stores is decided in ADR-008 (#66).

## Alternatives considered

- **Keep the in-place interior edit as the headline demo:** It is simpler to stage, but the chain alone catches it, so the A0/A1 comparison would show no difference.
- **Return `unknown` whenever the witness is unreachable, even with a broken chain:** It is more conservative, but it hides a contradiction the publisher signed itself, and makes A0 results depend on witness uptime.
- **Treat a checkpoint that fails verification as `conflict`:** It catches more, but lets a faulty or malicious witness frame an honest publisher.
- **Skip checkpoints that fail verification and judge on the rest:** A single corrupt checkpoint would no longer turn every audit into `unknown`. But a checkpoint that fails verification means the witness store is corrupt or the witness is misbehaving, which breaks the honest-witness assumption. Reporting it as `unknown` makes that visible instead of hiding it.
- **Return `unknown` when there are no checkpoints yet:** It is honest about missing evidence, but every A0 run would be `unknown`, so A0 would no longer be a usable baseline. `no-witness` keeps the result `accept` and records why.
- **A fourth verdict (`unresolved`) for key-rotation gaps, as the design doc mentions:** `VerdictKind` has three values, and key rotation is out of scope for P0, so it maps to `unknown`.

## Consequences

- The demo and story #21 use a suffix rewrite or truncation as the headline scenario, not the interior edit in the design doc. The interior edit stays as a chain-only test.
- `validateChain` (#79) runs first and its `conflict` is returned unchanged. `compareWithWitness` (#80) only adds witness checks.
- Tamper tools need a re-linking suffix rewrite and a truncation, not only an in-place edit.
- The A0/A1 detection rate is measured on witness-only scenarios. Chain-only scenarios are reported separately so they do not inflate A1's advantage.
- In A0, the consumer audits a fresh rebuild and does not compare against its own earlier view. A long-running consumer that kept its view would itself act as a witness for everything it saw.
- Adding more witnesses or sharing checkpoints between consumers requires witness signatures (#77) and a revisit of this ADR.

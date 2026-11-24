# ADR 007: Predicted results

- Status: proposed
- Date: 2026-11-23

## Context

The results run (#97) compares four setups (design doc, "Benchmarks"):

|                    | No witness                                          | One witness             |
| ------------------ | --------------------------------------------------- | ----------------------- |
| Signed HTTP server | **S0**: signed chain, configured URL and public key | **S1**: S0 plus witness |
| AT Protocol        | **A0**: signed PDS repo, DID-based discovery        | **A1**: A0 plus witness |

The experiment tests two claims:

1. **Witness claim (A0 against A1):** one honest witness lets a fresh consumer detect a suffix rewrite or truncation that the chain alone cannot, without flagging a signed withdrawal.
2. **AT claim (S against A):** AT adds something over an equivalently witnessed signed HTTP server.

If the predictions are written after the results, any result can be explained. This ADR fixes them first. It has to merge before #97 runs, and the scenario suite (#81) asserts the verdicts in the table below.

## Decision

### Equivalent setups

S and A are "equivalent" when only the way the consumer finds and trusts the publisher differs. Everything else is held fixed.

**Same in all four cells:**

- The seeded workload: the same events, rkeys, `createdAt` values, write order, and payloads.
- The event schema, seq rules, and `prevEventCid` links (ADR-004). S0 computes each event's CID with `cidForRecord`, as AT does, so the chain validator (#79) runs unchanged.
- The tamper operations: in-place edit, re-linked suffix rewrite, and truncation (#65 on AT, the `PUT`/`DELETE` routes in #83 on S0). In both, the publisher re-signs after tampering, because it holds its own key.
- The witness: same capture trigger (each head change), same checkpoint store (#48), same API, same poll interval.
- The auditor: `validateChain` (#79), `compareWithWitness` (#80), and the rule order in ADR-003. Only the `verify` function passed to #80 differs per source (#84).
- Each run audits a fresh consumer with no stored view (ADR-003, Consequences).
- The failure schedule: the same steps happen at the same seq in each cell.

**What differs, and is the variable being measured:**

|                                       | S0 / S1                                | A0 / A1                                                               |
| ------------------------------------- | -------------------------------------- | --------------------------------------------------------------------- |
| Consumer bootstrap                    | Configured URL and public key          | A DID; the PDS and signing key come from the DID document via the PLC |
| What the publisher signs              | The head (`{ stream, seq, eventCid }`) | The repo commit; the head record is proven by an MST proof            |
| Witness checkpoint proof              | The signed head                        | Commit plus MST proof CAR                                             |
| Key the checkpoint is checked against | The configured public key              | The signing key in the DID document (ADR-003, rule 3)                 |
| Key rotation                          | Not supported: reconfigure by hand     | Possible through the DID document; out of scope in P0 (#96)           |

A difference in any "same" row makes the S/A comparison invalid for that scenario, and the results write-up (#98) has to say so.

### Predicted verdicts

#63 has merged, so the `head-behind` exception in ADR-003 rule 1 no longer applies. Any head mismatch is `conflict`.

| Scenario (#81)                    | S0                            | S1                            | A0                            | A1                            | Caught by         |
| --------------------------------- | ----------------------------- | ----------------------------- | ----------------------------- | ----------------------------- | ----------------- |
| `interior-edit`                   | `conflict` (`broken-link`)    | `conflict` (`broken-link`)    | `conflict` (`broken-link`)    | `conflict` (`broken-link`)    | Chain             |
| `suffix-rewrite`                  | `accept` (`no-witness`)       | `conflict` (`rewritten`)      | `accept` (`no-witness`)       | `conflict` (`rewritten`)      | Witness only      |
| `truncation`                      | `accept` (`no-witness`)       | `conflict` (`truncated`)      | `accept` (`no-witness`)       | `conflict` (`truncated`)      | Witness only      |
| `rewrite-before-witness`          | `accept` (`no-witness`)       | `accept` (`extends-witness`)  | `accept` (`no-witness`)       | `accept` (`extends-witness`)  | Nothing (ADR-003) |
| `signed-withdrawal`               | `accept` (`no-witness`)       | `accept` (`extends-witness`)  | `accept` (`no-witness`)       | `accept` (`extends-witness`)  | Control           |
| `pds-unreachable` (P1, needs #56) | `unknown` (`pds-unreachable`) | `unknown` (`pds-unreachable`) | `unknown` (`pds-unreachable`) | `unknown` (`pds-unreachable`) | —                 |

On S0 and S1, `pds-unreachable` means the signed HTTP server is unreachable. The reason code is the same so the table compares directly.

In S0 and A0 no witness is configured, so the auditor must never query one. A `witness-unreachable` there means the setup is wrong, not that the prediction failed.

Every run repeats three times (#97). The prediction is that all three runs of a cell give the same verdict and reason.

### Measurements to collect

Per scenario, per cell, per run. Names are the `metricKeys` from #82 where one exists.

| Measurement                                                           | Source                                            | Used for                                                                                              |
| --------------------------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Verdict and reason                                                    | Auditor                                           | The table above                                                                                       |
| Witness detection rate                                                | `suffix-rewrite` and `truncation` only            | Witness claim. `interior-edit` is reported separately so it does not inflate A1's advantage (ADR-003) |
| False conflicts                                                       | `signed-withdrawal` and `rewrite-before-witness`  | Witness claim                                                                                         |
| Rebuild time (`recovery`), p95 over runs                              | Consumer rebuild (#44, #45)                       | AT claim                                                                                              |
| Missing and duplicate events, final-view equality                     | Consumer view against the seeded workload         | AT claim                                                                                              |
| Verification time (`verifyCheckpoint`)                                | Auditor                                           | AT claim                                                                                              |
| Retained proof bytes (`proofBytesTotal`, `proofBytesMax`)             | Witness store                                     | AT claim                                                                                              |
| Checkpoints and how many verified (`checkpoints`, `checkpointsValid`) | Auditor                                           | Sanity check: every checkpoint from an honest witness should verify                                   |
| Chain walk length (`chainWalkLength`)                                 | Auditor                                           | Sanity check: equal across S and A for the same scenario                                              |
| Onboarding steps and failures                                         | Written up by hand in #98; no ticket automates it | AT claim                                                                                              |

### Predicted overhead

These are order-of-magnitude ranges for the seeded workload (tens of events, one stream). A result outside a range is worth explaining in #98, not a failure.

| Measurement                      | S1          | A1                   | Why                                                                                                                                                                                                            |
| -------------------------------- | ----------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Proof bytes per checkpoint       | About 200 B | 1–3 KB (5–20× S1)    | S1 stores the head plus a 64-byte signature. A1 stores the signed commit, the MST nodes on the path to the head record, and the record itself. A1 grows with the log of the repo size; S1 stays constant.      |
| Verification time per checkpoint | Under 1 ms  | 2–15 ms (3–20× S1)   | Both check one secp256k1 signature. A1 also resolves the DID from the PLC over HTTP, parses the CAR, and hashes the MST path. DID resolution should dominate; if it is cached, A1 should come within 2× of S1. |
| Rebuild time (`recovery`), p95   | Under 1 s   | Under 1 s, 1.5–5× S0 | A0 downloads and verifies the whole repo CAR and resolves the DID. S0 fetches the events as JSON and recomputes their CIDs. At this size both are fast, and the gap is not meaningful for users.               |

The prediction is that AT costs more on all three, and that the cost is small in absolute terms. A1 faster or smaller than S1 on any of them would mean the two setups are not doing the same work.

### What would disprove the hypothesis

**Witness claim.** Any of these, in any run:

- A1 returns `accept` on `suffix-rewrite` or `truncation`. The witness did not catch what it exists to catch.
- A1 returns `conflict` on `signed-withdrawal`. The witness flags legitimate history.
- A0 returns `conflict` on `suffix-rewrite` or `truncation`. Either the chain alone catches it, contradicting ADR-004, or the A0 consumer is not fresh and is acting as a witness itself. In both cases A0 is not a valid baseline.
- Any cell returns `conflict` on `rewrite-before-witness`. Someone holds evidence they could not have had, so the setup leaks state between runs.

Before a mismatch counts against the hypothesis, rule out a harness bug: rerun the cell and check that the tamper tool did what the scenario says (for example, that `truncation` moved the head back). A mismatch that survives the rerun is reported as a result, not fixed quietly.

**AT claim.** The prediction is that S1 and A1 give identical verdicts on every scenario. Detection comes from the hash chain and the witness, which both setups share. On integrity, AT is expected to add nothing.

- If S1 and A1 differ on any scenario, either the setups are not equivalent or one source adapter has a bug. That is investigated before any conclusion is drawn.
- If verdicts match, as predicted, the AT claim rests on onboarding, recovery, and overhead alone. If A1 shows no advantage on those and costs materially more, the results report that AT adds nothing measurable for this workload. The design doc counts that as a valid outcome.

## Alternatives considered

- **Assert only A0 and A1:** The baseline (#83 to #85) is the first scope cut if Sprint 3 slips. But the AT claim cannot be tested without S, so the S columns are written now. If the baseline is cut, #97 leaves them empty and #98 says so.
- **Count `interior-edit` in the detection rate:** It raises A1's number, but A0 catches it too, so it says nothing about the witness.
- **Predict only verdicts, not reasons:** Simpler, but a right verdict for the wrong reason (for example `conflict` from `broken-link` where `rewritten` was expected) would pass unnoticed.
- **Leave overhead unpredicted and only report it:** Then there is nothing to be wrong about. A rough range is enough to be surprised by.

## Consequences

- #81 asserts the verdict and reason for each row and column above. Changing a prediction after #97 starts needs a new ADR or a dated amendment here, not an edit.
- #84 and #85 are done when S0 and S1 produce the same verdict types and reasons as A0 and A1.
- #97 records every measurement above for all three runs and keeps failed runs in the table.
- #98 compares each prediction with its result, including the overhead ranges, and reports the AT claim even if the result is negative.
- The DID-only onboarding comparison has no ticket. Unless one is added, #98 describes it qualitatively and the results do not claim a measured onboarding advantage.

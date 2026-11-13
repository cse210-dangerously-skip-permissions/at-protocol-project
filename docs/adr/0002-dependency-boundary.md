# ADR 002: Dependency boundary

- Status: proposed
- Date: 2026-11-12

## Context

The experiment asks whether one witness lets a fresh consumer detect a publisher rewriting its history. For the result to mean anything, the parts that answer that question must be ours, and everything else must be standard AT Protocol behavior we did not change. AT already gives us signed current state: commit signatures, MST proofs, DID resolution, and a firehose. Reimplementing those would add bugs without adding evidence, and copying an existing event system would hide which part did the detecting.

The definition of done says a PR that adds a dependency adds a row here. This ADR is that list.

## Decision

### What we own

None of these come from a library:

- The event contract: the `dev.trustlab.event` and `dev.trustlab.head` Lexicons, record keys, and the cross-field rules in `@trustlab/contracts`.
- The chain validator (ADR-004, #79).
- The witness: what it captures, its checkpoint store, its HTTP API, and its evidence format (ADR-008, #66).
- Recovery and live cutover (REC).
- The auditor and its verdict rules (ADR-003, #80).
- The test harness and experiment runner (AUD).

### Dependencies

Each row says what the dependency does, why it is outside the experiment, what we own next to it, and which test checks the boundary. "Planned" means the ticket that adds it has not landed. The `@atproto/sync` and `@atproto/repo` rows follow the 0.4.25 / 0.11.5 findings in #41 and will be updated when the live-stack part of that spike is posted.

| Dependency                                      | What it does for us                                                                                     | Why it is outside the experiment                                          | What we own instead                                                                    | Boundary test                                                        |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `@atproto/api`                                  | XRPC client: create session, `putRecord`, `applyWrites`, `getRecord` (publisher, #63)                   | Standard way to write to a PDS                                            | Which records we write, in what order, and the chain links                             | `tests/integration/publisher.test.ts`                                |
| `@atproto/lexicon`                              | Checks each record field against our Lexicon JSON                                                       | Lexicon type checking is part of AT                                       | The cross-field rules (seq, `prevEventCid`, `refSeq`, rkey) in `contracts/validate.ts` | `packages/contracts/src/validate.test.ts`                            |
| `@atproto/sync` (planned, #38)                  | Firehose subscription that verifies commit signatures and record proofs before our handler runs         | Verifying the firehose is AT's job, not something we are testing          | Grouping events into `VerifiedCommit`, the DID allowlist, the consumer view            | #38 tests: a commit with a bad signature never reaches `applyCommit` |
| `@atproto/repo` (planned, #43, #46, #83)        | `verifyRepoCar`, `verifyProofs`, CAR helpers, `cidForRecord`                                            | Signature and MST proof checking is AT's; we only call it                 | When to verify, what the witness keeps as evidence, how proofs feed the verdict        | #43 and #51: a tampered CAR fails verification                       |
| `@atproto/identity` (planned, #38, #43)         | Resolves a DID to its document and signing key via our local PLC                                        | DID resolution is AT's                                                    | Which key is trusted (the DID document's, never one stored or served by the PDS)       | #43: the key comes from PLC, not from the PDS that served the repo   |
| `@atproto/crypto` (planned, #83)                | secp256k1 signing for the S0 signed HTTP server                                                         | Key generation and signatures are standard primitives                     | What is signed (the head) and how the consumer is configured with the key              | #83 tests: a head with a wrong signature is rejected                 |
| Lexicon codegen (planned, #30 PR B)             | `npm run codegen` turns `lexicons/*.json` into TypeScript types; `@atproto/lex-cli` is the candidate    | Generated code, not logic                                                 | The Lexicons themselves and the hand-written types until codegen lands                 | `npm run typecheck` in CI                                            |
| PDS image `ghcr.io/bluesky-social/pds:0.4.5051` | The PDS on the local network                                                                            | Stock AT server; using it unchanged is what makes the results apply to AT | Its configuration in `infra/compose.yaml` (no crawlers, local PLC only)                | `infra/scripts/checks.test.mjs`                                      |
| PLC server (`did-method-plc` at `29f1a70`)      | Local DID directory, built from the official repo at a pinned commit, with `postgres:17-alpine` storage | Stock AT directory, local so no DID reaches the real `plc.directory`      | The pin and its configuration                                                          | `infra/scripts/checks.test.mjs`                                      |
| `node:sqlite`                                   | Consumer view and checkpoint                                                                            | Built into Node 22.5+, so no driver package                               | The schema, and writing a commit and its checkpoint in one transaction                 | `services/consumer/src/store.test.ts`                                |
| Vitest, `@vitest/coverage-v8`                   | Unit and integration tests, coverage ratchet                                                            | Test runner                                                               | The tests and `scripts/check-coverage.mjs`                                             | n/a                                                                  |
| Playwright                                      | End-to-end tests                                                                                        | Test runner                                                               | The e2e specs                                                                          | n/a                                                                  |
| Dev tooling                                     | TypeScript, `tsx`, ESLint, Prettier, TypeDoc, husky, lint-staged                                        | Build and review tooling; nothing ships at runtime                        | Their configuration                                                                    | CI (`lint`, `typecheck`)                                             |

### Prior art, not dependencies

- **Tap** and **Ramjet** are existing AT event systems. We read them for ideas but do not depend on them or copy their code. Using either would put an existing event system between the publisher and the consumer, and the experiment would then measure that system rather than our witness.

### Rules for adding a dependency

- The PR adds a row to the table above.
- A library may verify what AT already defines (signatures, proofs, DID documents). It must not decide a verdict, store witness evidence, or validate our chain.
- Data from the network is still validated when read (ADR-001), even when it comes through a library.

## Alternatives considered

- **Reimplement signature and MST proof checks:** It would make the witness self-contained, but these checks are AT's and well tested upstream. Our versions would be a new source of bugs that the experiment is not about.
- **Use Tap or Ramjet as the event pipeline:** Less code to write, but the detection result would depend on how those systems handle history, which is the question we are asking.
- **An SQLite driver package such as `better-sqlite3`:** More mature API, but it needs a native build, and `node:sqlite` covers what we use.
- **No written list, dependencies reviewed per PR:** Faster at first, but nothing would stop a library from quietly taking over part of what we are measuring.

## Consequences

- Adding a dependency takes one table row in the same PR. Reviewers check the row, not just `package.json`.
- The verdict, the chain rules, and the witness evidence stay in our code, so a detection result can be traced to our logic and AT's guarantees, nothing else.
- When #41 posts its live-stack findings, the `@atproto/sync` and `@atproto/repo` rows are updated. If `blocks` turns out not to be enough for `verifyProofs`, the witness reads the raw frame and that is noted here.
- Planned rows move to their real tests as #30, #38, #43, and #83 land.

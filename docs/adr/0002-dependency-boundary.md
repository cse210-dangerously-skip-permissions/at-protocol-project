# ADR 002: Dependency boundary

- Status: proposed
- Date: 2026-11-13

## Context

The experiment asks whether one witness lets a fresh consumer detect a publisher rewriting its history. For the result to mean anything, the parts that answer that question must be ours, and everything else must be standard AT Protocol behavior we did not change. AT already gives us signed current state: commit signatures, MST proofs, DID resolution, and a firehose. Reimplementing those would add bugs without adding evidence, and copying an existing event system would hide which part did the detecting.

The definition of done says a PR that adds a dependency adds a row here. This ADR is that list.

## Decision

### What we own

None of these come from a library:

- The publisher's workload: the seeded events, rkeys, `createdAt` values, write order, and chain links (PUB, #12).
- The tamper tools (#65).
- The event contract: the `dev.trustlab.event` and `dev.trustlab.head` Lexicons, record keys, and the cross-field rules in `@trustlab/contracts`.
- The chain validator (ADR-004, #79).
- The witness: what it captures, its checkpoint store, its HTTP API, and its evidence format (ADR-008, #66).
- The consumer: the DID allowlist, the SQLite view, and its checkpoint (CNS, #13).
- Recovery and live cutover (REC, #14).
- The auditor and its verdict rules (ADR-003, #80).
- The test harness and experiment runner (AUD, #16).
- The S0 signed HTTP baseline server (#83).

### Dependencies

Each row says what the dependency does, why it is outside the experiment, what we own next to it, and which test checks the boundary. "Planned" means the ticket that adds it has not landed. The `@atproto/sync` and `@atproto/repo` rows follow the 0.4.25 / 0.11.5 findings in #41's description and will be updated when the live-stack part of that spike is posted.

| Dependency                                      | What it does for us                                                                                     | Why it is outside the experiment                                          | What we own instead                                                                                                         | Boundary test                                                                                                                           |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `@atproto/api`                                  | XRPC client: create session, `createRecord`, `putRecord`, `getRecord`; `applyWrites` planned (#63)      | Standard way to write to a PDS                                            | Which records we write, their rkeys and `createdAt`, the order, and the chain links                                         | `tests/integration/publisher.test.ts`                                                                                                   |
| `@atproto/lexicon`                              | Checks each record field against our Lexicon JSON                                                       | Lexicon type checking is part of AT                                       | The cross-field rules (seq, `prevEventCid`, `refSeq`, rkey) in `contracts/validate.ts`                                      | `packages/contracts/src/validate.test.ts`                                                                                               |
| `@atproto/sync`                                 | Firehose subscription that verifies commit signatures and record proofs before our handler runs (#38)   | Verifying the firehose is AT's job, not something we are testing          | Grouping events into `VerifiedCommit`, the DID allowlist, the consumer view                                                 | Planned, #51: a commit with a bad signature never reaches the store                                                                     |
| `@atproto/repo` (planned, #43, #46, #83)        | `verifyRepoCar`, `verifyProofs`, CAR helpers, `cidForRecord`                                            | Signature and MST proof checking is AT's; we only call it                 | When to verify, what the witness keeps as evidence, how proofs feed the verdict                                             | #43 and #51: a tampered CAR fails verification                                                                                          |
| `@atproto/identity`                             | Resolves a DID to its document and signing key via our local PLC (#38; planned for #43)                 | DID resolution is AT's                                                    | Which key is trusted: the DID document's, never one stored or served by the PDS or stored in a witness checkpoint (ADR-003) | #43: the key comes from PLC, not from the PDS that served the repo; #80: a checkpoint signed with a swapped-in key gives `bad-evidence` |
| `@atproto/crypto` (planned, #83)                | secp256k1 signing for the S0 signed HTTP server                                                         | Key generation and signatures are standard primitives                     | What is signed (the head) and how the consumer is configured with the key                                                   | #83 tests: a head with a wrong signature is rejected                                                                                    |
| Lexicon codegen (planned, #30 PR B)             | `npm run codegen` turns `lexicons/*.json` into TypeScript types; `@atproto/lex-cli` is the candidate    | Generated code, not logic                                                 | The Lexicons themselves and the hand-written types until codegen lands                                                      | `npm run typecheck` in CI                                                                                                               |
| PDS image `ghcr.io/bluesky-social/pds:0.4.5051` | The PDS on the local network                                                                            | Stock AT server; using it unchanged is what makes the results apply to AT | Its configuration in `infra/compose.yaml` (local PLC only; no crawlers, which is config only and not tested)                | `npm run stack:check` (`checkDidDocument`: the account's DID is on the local PLC)                                                       |
| PLC server (`did-method-plc` at `29f1a70`)      | Local DID directory, built from the official repo at a pinned commit, with `postgres:17-alpine` storage | Stock AT directory, local so no DID reaches the real `plc.directory`      | The pin and its configuration                                                                                               | `npm run stack:check` (`checkDidDocument`)                                                                                              |
| `node:sqlite`                                   | Consumer view and consumer checkpoint                                                                   | Built into Node, so no driver package                                     | The schema, and writing a commit and its checkpoint in one transaction                                                      | `services/consumer/src/store.test.ts`                                                                                                   |
| Vitest, `@vitest/coverage-v8`                   | Unit and integration tests, coverage ratchet                                                            | Test runner                                                               | The tests and `scripts/check-coverage.mjs`                                                                                  | n/a                                                                                                                                     |
| Playwright                                      | End-to-end tests                                                                                        | Test runner                                                               | The e2e specs                                                                                                               | n/a                                                                                                                                     |
| `tsx`                                           | Runs the publisher CLI (`npm run publish-events`) without a build step                                  | TypeScript loader; it runs our code and does not change it                | The CLI                                                                                                                     | n/a (on the run path, but no test runs the CLI yet)                                                                                     |
| Dev tooling                                     | TypeScript, ESLint, Prettier, TypeDoc, husky, lint-staged                                               | Build and review tooling; nothing ships at runtime                        | Their configuration                                                                                                         | CI (`lint`, `typecheck`)                                                                                                                |

Notes:

- **Node floor:** `engines` requires Node 22.19+ (#119), because `@atproto/identity` pulls in undici 8, which needs it.
- **`node:sqlite` is experimental** in Node 22 and prints a warning on every run. If its API changes in a minor release, the store breaks; the pinned floor and `store.test.ts` are how we would notice.
- **`@atproto/sync` drops failed ops silently.** When an op's proof fails, the library leaves it out and still delivers the rest of the commit, with no error to our handler. A tampered op therefore goes missing from the consumer view instead of being rejected. Until #51 adds a check, the consumer cannot tell a dropped op from one that was never written. The witness must not capture heads through `sync` for the same reason, or it would skip a checkpoint without saying so.
- **Values the PDS picks:** the commit CID, `rev`, and firehose seq come from the PDS and change between runs. The publisher returns `commitCid` and `rev` from the PDS (`services/publisher/src/publisher.ts`), so the harness compares only event CIDs, which come from the seed.

### Prior art, not dependencies

- **Tap** and **Ramjet** are existing AT event systems. We read them for ideas but do not depend on them or copy their code. Using either would put an existing event system between the publisher and the consumer, and the experiment would then measure that system rather than our witness.

### What counts as a dependency

- A direct dependency in any `package.json` gets a row.
- An indirect dependency gets a note when it changes one of our requirements, as undici 8 did for the Node floor.
- A Node built-in counts when it replaces a package, as `node:sqlite` does.

### Rules for adding a dependency

- The PR adds a row to the table above.
- A library may verify what AT already defines (signatures, proofs, DID documents). It must not decide a verdict, store witness evidence, or validate our chain.
- A verification failure must reach our code. Where a library drops data instead (as `@atproto/sync` does for an op whose proof fails), the table or its notes say so and our code counts what it expected but did not get.
- A library or the PDS never picks a value that goes into our records (rkey, `createdAt`, order). We pass them in, so a run repeats from its seed. A `createRecord` call without an rkey would let the PDS pick a clock-based TID.
- Data from the network is still validated when read (ADR-001), even when it comes through a library.

## Alternatives considered

- **Reimplement signature and MST proof checks:** It would make the witness self-contained, but these checks are AT's and well tested upstream. Our versions would be a new source of bugs that the experiment is not about.
- **Use Tap or Ramjet as the event pipeline:** Less code to write, but the detection result would depend on how those systems handle history, which is the question we are asking.
- **An SQLite driver package such as `better-sqlite3`:** More mature API, but it needs a native build, and `node:sqlite` covers what we use.
- **No written list, dependencies reviewed per PR:** Faster at first, but nothing would stop a library from quietly taking over part of what we are measuring.

## Consequences

- Adding a dependency takes one table row in the same PR. Reviewers check the row, not just `package.json`.
- The verdict, the chain rules, and the witness evidence stay in our code, so a detection result can be traced to our logic and AT's guarantees. This holds only where failures reach our code: until #51 counts the ops `@atproto/sync` drops, a missing event in the consumer view could be a dropped tampered op.
- When #41 posts its live-stack findings, the `@atproto/sync` and `@atproto/repo` rows are updated. If `blocks` turns out not to be enough for `verifyProofs`, the witness reads the raw frame and that is noted here.
- Planned rows move to their real tests as #30, #43, #51, #63, and #83 land.

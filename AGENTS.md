# AGENTS.md

Guide for AI coding agents in this repo. Humans start at [README.md](README.md) and [CONTRIBUTING.md](CONTRIBUTING.md).

**Project:** a publisher writes a hash-chained event stream (`prevEventCid` links) to its AT Protocol repo; a witness keeps signed proofs of earlier stream heads; an auditor checks the current history against them and returns `accept`, `conflict`, or `unknown`. Decisions are recorded in `docs/adr/`.

## Repo map

npm workspaces. Import other packages as `@trustlab/<name>` through their `src/index.ts`, never by path. Owning teams are in [.github/CODEOWNERS](.github/CODEOWNERS).

| Path                 | Team       | State                                                         |
| -------------------- | ---------- | ------------------------------------------------------------- |
| `lexicons/`          | Pipeline   | `dev.trustlab.event`, `dev.trustlab.head`                     |
| `packages/contracts` | all teams  | Types, record keys, `parse*` validators, `loadLocalEnv`       |
| `services/publisher` | Pipeline   | `login`, `publishEvent`, `readHead`, seeded `publish` command |
| `services/consumer`  | Pipeline   | `ConsumerStore` (SQLite view + checkpoint); firehose in #117  |
| `infra/`             | Foundation | Local PDS + PLC in Docker; seeds `.env.local`                 |
| `packages/auditor`   | Trust      | Stub                                                          |
| `packages/recovery`  | Pipeline   | Stub                                                          |
| `services/witness`   | Trust      | Stub                                                          |
| `tools/cli`          | Foundation | Stub                                                          |
| `tools/harness`      | Trust      | Stub                                                          |

Each package README has the details; read it before editing that package.

## Commands

Node version: `engines` in `package.json`. Run from the repo root.

```
npm run lint && npm run typecheck && npm test   # run all three before calling a change done
npm run test:coverage     # coverage must not drop below coverage-baseline.json
npm run stack:up          # local AT network (Docker); writes .env.local
npm run test:integration  # tests/integration/, needs stack:up
npm run docs              # TypeDoc; warnings are errors
```

CI runs `lint`, `format:check`, `typecheck`, `test:coverage`, and `docs` on every PR. It doesn't run integration tests, so run those yourself when you touch AT code. The pre-commit hook runs Prettier.

## Tests

- Unit: `src/**/*.test.ts` next to the code. No network or Docker: fake the PDS or library (see `services/publisher/src/test-support.ts`).
- Integration: `tests/integration/`, against the real stack. Use a fresh stream name per run.
- E2E: Playwright in `e2e/`. Each user story names the spec that proves it.

## Rules

- **No contract edits without an issue.** `lexicons/` and `packages/contracts` need a review from every team that uses them. CODEOWNERS requests those reviews but one approval can merge, so make sure each team has reviewed.
- **Services talk only through AT or `packages/contracts`.** Never import another package's `src/`.
- **Validate network input at runtime.** Records from the firehose, `getRepo`, `getRecord`, or the witness API are `unknown` until a `parse*` from `@trustlab/contracts` checks them.
- **Never disable type checks:** no `@ts-ignore`, no `any` to silence an error, no loosening `tsconfig.json` or lint rules.
- **No code copied from other projects.** Cite prior art instead.
- **New dependencies go in ADR-002** with the reason. Significant decisions get an ADR from `docs/adr/0000-template.md`.
- Never hardcode DIDs or passwords; read `.env.local` with `loadLocalEnv()`.
- No `console` in `packages/`; services, tools, and tests may log.
- JSDoc on new or changed functions; types in TypeScript, not JSDoc tags.

## TypeScript gotchas

- NodeNext modules: relative imports end in `.js` (`./store.js`).
- `verbatimModuleSyntax`: type-only imports need `import type` or `type` modifiers.
- `noUncheckedIndexedAccess`: `arr[0]` is `T | undefined`; check it.

## AT gotchas

- The local PLC is `PLC_URL`, not `plc.directory`. `@atproto/identity`'s default fetch refuses localhost, so pass `fetch: globalThis.fetch` to `IdResolver` locally.
- `.test` handles don't resolve through DNS; use DIDs.
- Event rkeys are `<stream>-<12-digit seq>`; use `eventRkey`/`headRkey`, don't format them by hand.

## PRs

Branch `yourname/topic`, one responsibility per PR, title `type: summary` (feat, fix, docs, test, refactor, chore, ci), squash merge, reviewed by a non-author. Tick "AI-assisted: yes" in the PR template.

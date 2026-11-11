# ADR 001: TypeScript in one monorepo

- Status: proposed
- Date: 2026-11-10

## Context

The publisher, consumer, witness, and auditor run as separate processes and agree only through shared contracts (Lexicons, witness API, verdict types). A contract mismatch should fail at compile time, not during an experiment. AI agents write much of the code, and typed contracts with a strict CI typecheck catch invented fields and wrong shapes before review. atproto's reference PDS and main libraries (sync, repo, crypto, identity, Lexicon codegen) are TypeScript. CONTRIBUTING.md had planned JavaScript with JSDoc types.

## Decision

Strict TypeScript (`"strict": true`) for every service, the CLI, and all tests, in one npm-workspaces monorepo. A shared `packages/contracts` package holds the types generated from the Lexicons plus the shared types, and every service imports them from there. `npm run typecheck` runs `tsc` in CI.

## Alternatives considered

- **JavaScript with JSDoc types:** Lexicon codegen outputs TypeScript, and JSDoc types are awkward for shared contract types.
- **Go:** Tap and the relay are written in Go, but the libraries we depend on are TypeScript, so we would have to reimplement or wrap them.
- **Python:** Dynamic typing weakens the contract checks this project relies on.
- **Rust:** Too much ramp-up for a three-week project.
- **Separate repos per service:** Every service shares the contracts, so a contract change would need coordinated releases across repos.

## Consequences

- Types disappear at runtime, so records, firehose events, and witness responses are validated when read.
- Generated Lexicon code may need cleanup. If so, exclude it from compilation and wrap it with hand-written types.
- The JSDoc docs site (#4) switches to TypeDoc or is closed.
- Node is fast enough at this scale.
- JSDoc docs (#4) become TypeDoc, or #4 gets closed.
- There’s a build or typecheck step.
- Team is comfortable with TypeScript.

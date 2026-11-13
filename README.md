# AT Protocol Project

<one paragraph: what this is>

## Getting started

Use Node.js 22.19 or newer (`nvm use` reads `.nvmrc`), then run `npm install`. Installing also sets up the pre-commit hook that formats staged files.

To run the local AT network (a PDS and a PLC directory in Docker), run `npm run stack:up`. It also creates the seed accounts and writes their DIDs to `.env.local`. [infra/README.md](infra/README.md) covers what it runs and how to use it.

| Command                 | What it does                                                         |
| ----------------------- | -------------------------------------------------------------------- |
| `npm test`              | Unit tests (`src/**/*.test.ts` in any package, plus `infra/scripts`) |
| `npm run test:coverage` | Unit tests plus the coverage baseline check                          |
| `npm run lint`          | ESLint across every package                                          |
| `npm run typecheck`     | `tsc` in strict mode, whole repo                                     |
| `npm run docs`          | Builds API docs in `dist/docs/`                                      |
| `npm run format:check`  | Prettier check only                                                  |
| `npm run format`        | Prettier, writing fixes                                              |

## Layout

This is an npm workspaces monorepo. Each package's README names the team that owns it.

| Path                 | What lives there                                    |
| -------------------- | --------------------------------------------------- |
| `lexicons/`          | AT Protocol Lexicon definitions                     |
| `packages/contracts` | Shared types; the only code services share          |
| `packages/auditor`   | Chain validation, witness comparison, verdicts      |
| `packages/recovery`  | `getRepo` snapshot fetch and view rebuild           |
| `services/publisher` | Publishes events and stream heads                   |
| `services/consumer`  | Verified firehose subscription, view, checkpoint    |
| `services/witness`   | Captures signed heads and proofs, serves them       |
| `tools/cli`          | The `trustlab` command-line interface               |
| `tools/harness`      | Experiment harness                                  |
| `infra/`             | Docker Compose and scripts for the local AT network |

Import shared packages by name, such as `@trustlab/contracts`. Services must not import each other's internals.

## API documentation

The [API reference](https://cse210-dangerously-skip-permissions.github.io/at-protocol-project/) documents exported types and functions across packages, services, and tools (available after the first Pages deployment).

## Decisions

See docs/adr/ - one ADR per significant decision

## Contributing

See CONTRIBUTING.md

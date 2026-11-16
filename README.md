# AT Protocol Project

<one paragraph: what this is>

## Run the stack

From a fresh clone to a running local AT network (a PDS and a PLC directory in Docker) should take under 30 minutes, most of it the first image build.

You need:

- Git
- Node.js 22.19 or newer. `node -v` shows yours.
- Docker with Compose, running: Docker Desktop or OrbStack on macOS, Docker Desktop on Windows, Docker Engine with the Compose plugin on Linux. `docker info` should succeed.
- Ports 2582 and 2583 free

Then:

```sh
git clone https://github.com/cse210-dangerously-skip-permissions/at-protocol-project.git
cd at-protocol-project
nvm install        # if you use nvm; installs and selects the newest Node 22 from .nvmrc
npm install
npm run stack:up
```

`npm install` also sets up the pre-commit hook that formats staged files. npm 11 may warn that esbuild and fsevents have install scripts not covered by `allowScripts`. That warning is safe to ignore: `tsx` still works without them.

`npm run stack:up` starts the containers, checks them end to end, and creates the seed accounts. It worked when the output ends with:

```
All checks passed.
Seeding the local AT network:
  ok    publisher.test created (did:plc:...)
  ok    witness.test created (did:plc:...)
Wrote .../.env.local.
```

`.env.local` at the repo root now holds the seed accounts' DIDs and passwords, which services read. Stop the stack with `npm run stack:down`; your data is kept. [infra/README.md](infra/README.md) covers every stack command, what the checks test, and how to use the network from code.

### Troubleshooting

#### `Cannot connect to the Docker daemon` or `failed to connect to the docker API`

Start Docker Desktop or OrbStack (on Linux, the Docker service). When `docker info` succeeds, run `npm run stack:up` again. Skip the suggested `stack:logs`: it needs Docker too.

#### `Docker is not installed or not on your PATH`

Install Docker (see "You need" above), then run `npm run stack:up`.

#### `port is already allocated`, `address already in use`, `HTTP 404 from http://localhost:2583/xrpc/_health`, or `could not connect to http://localhost:2583`

Another program is using port 2582 or 2583.

1. Find it: `lsof -nP -iTCP:2583 -sTCP:LISTEN` on macOS or Linux, `netstat -ano | findstr :2583` on Windows. Do the same for 2582.
2. Stop that program. If it is the stack from another clone, run `npm run stack:down` there.
3. Run `npm run stack:down`, then `npm run stack:up`.

#### `The stack scripts need Node.js 22.19 or newer`, or `npm install` warns `EBADENGINE`

Run `nvm install` (or install Node 22.19+ another way), check `node -v`, then run `npm install` again.

#### The first `stack:up` sits for several minutes

This is normal: it downloads images and builds the PLC server. Let it run; it waits up to 15 minutes. If the build stops on a network error, run `npm run stack:up` again.

#### You deleted or lost `infra/.env` or `.env.local`

Run `npm run stack:reset`, then `npm run stack:up`. Do this even if `stack:up` still passes: without the original `infra/.env`, updating the seed accounts' DIDs fails with `Invalid signature on op`. Reset deletes all accounts and records, so the seed accounts get new DIDs.

#### You have two clones of the repo

They share one stack. Run the stack from one clone only, or run `npm run stack:reset` when you switch.

#### Anything else

Run `npm run stack:logs` to see what the PDS or PLC reported. For a clean start, run `npm run stack:reset`, then `npm run stack:up`.

## Commands

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

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

**Docker isn't running.** `stack:up` prints `Cannot connect to the Docker daemon` or `failed to connect to the docker API`, then `The stack did not become healthy`. Ignore its hint to read `stack:logs`, which needs Docker too. Start Docker Desktop or OrbStack (on Linux, the Docker service), wait until `docker info` succeeds, and run `npm run stack:up` again. If it says `Docker is not installed or not on your PATH`, install it first.

**A port is already in use.** Something else is listening on 2582 or 2583, often a copy of the stack started from another clone. Depending on your Docker, this shows up in one of two ways:

- Compose fails with `port is already allocated` or `address already in use`.
- The containers start, but a check fails with `HTTP 404 from http://localhost:2583/xrpc/_health` (another program answered) or `could not connect to http://localhost:2583`. We saw this with OrbStack.

To see what holds the port, run `lsof -nP -iTCP:2583 -sTCP:LISTEN` on macOS or Linux, or `netstat -ano | findstr :2583` on Windows. Stop that program, then run `npm run stack:down` and `npm run stack:up`. The `down` matters: a container started while the port was taken keeps a broken port mapping until it is recreated.

**Node is older than 22.19.** `stack:up` stops with `The stack scripts need Node.js 22.19 or newer`, and `npm install` warns `EBADENGINE`. `.nvmrc` only says `22`, so `nvm use` can pick an older 22.x you already have. Run `nvm install` to get the newest 22, check `node -v`, then run `npm install` again.

**The first `stack:up` sits for minutes.** The first run downloads the PDS and Postgres images and builds the PLC server from source, which can take several minutes. `stack:up` waits up to 15 minutes, so let it finish. Later starts take seconds. If the build fails on a network error, run `npm run stack:up` again.

**`infra/.env` was deleted.** This one fails silently. `stack:up` makes new PDS secrets, every check passes, and the seed accounts still log in, but the PDS no longer holds the key that controls their DIDs: any PLC update for them fails with `Invalid signature on op`. Run `npm run stack:reset`, then `npm run stack:up`. Reset deletes all accounts and records, so the seed accounts get new DIDs and `.env.local` is rewritten. Do the same if you lose `.env.local`, since the passwords in it can't be recovered.

**Two clones share one stack.** The containers and volumes are named `trustlab`, whichever folder you run from. `stack:reset` in one clone deletes the other clone's data, and the other clone's `infra/.env` no longer matches. Keep one clone running the stack, or reset when you switch.

**Something else fails.** Run `npm run stack:logs` to see what the PDS or PLC reported. `npm run stack:reset` and then `npm run stack:up` gives a clean start.

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

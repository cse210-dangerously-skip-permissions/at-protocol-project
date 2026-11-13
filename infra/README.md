# @trustlab/infra

Docker Compose and scripts for the local AT network.

- **Team:** Foundation
- **System:** Platform (PLT)

## The local AT network

One PDS and one PLC directory run in Docker, reachable only from your machine. Nothing in this network talks to Bluesky's network.

| Service       | Address                                                    | What it is                                                 |
| ------------- | ---------------------------------------------------------- | ---------------------------------------------------------- |
| PDS           | `http://localhost:2583`                                    | Bluesky's PDS image, version 0.4.5051. Handles end `.test` |
| Firehose      | `ws://localhost:2583/xrpc/com.atproto.sync.subscribeRepos` | The PDS's own event stream                                 |
| PLC directory | `http://localhost:2582`                                    | The official PLC server, built from a pinned commit        |

The PLC directory also uses a Postgres container that is not published on any port.

### What you need

- Docker with Compose: Docker Desktop on macOS or Windows, or Docker Engine with the Compose plugin on Linux
- Node.js 22.19 or newer, as for the rest of the repo
- Ports 2582 and 2583 free

### Commands

Run these from the repo root.

| Command               | What it does                                                                            |
| --------------------- | --------------------------------------------------------------------------------------- |
| `npm run stack:up`    | Starts the network, waits until it is healthy, then runs `stack:check` and `stack:seed` |
| `npm run stack:check` | Checks the running network end to end (below)                                           |
| `npm run stack:seed`  | Makes sure the seed accounts exist and writes `.env.local` (below)                      |
| `npm run stack:down`  | Stops the network and keeps its data                                                    |
| `npm run stack:reset` | Stops the network and deletes its data, for a clean start                               |
| `npm run stack:logs`  | Follows the containers' logs                                                            |

The first `stack:up` downloads the images and builds the PLC server, which takes a few minutes. Later starts take seconds.

`stack:check` passes when:

1. The PLC directory and the PDS both answer their health checks.
2. The PDS gives out `.test` handles.
3. A new probe account's DID document on the local PLC points at the local PDS.
4. A record written to that account shows up on the firehose.
5. `getRepo` returns the account's repo.

It deletes the probe account afterwards.

### Seed accounts and `.env.local`

`stack:seed` makes sure two accounts exist on the PDS, `publisher.test` and `witness.test`, and writes `.env.local` at the repo root. Git ignores that file. Services read these variables and never hardcode a DID:

| Variable                                                  | What it is                        |
| --------------------------------------------------------- | --------------------------------- |
| `PDS_URL`                                                 | `http://localhost:2583`           |
| `PLC_URL`                                                 | `http://localhost:2582`           |
| `PUBLISHER_DID`, `PUBLISHER_HANDLE`, `PUBLISHER_PASSWORD` | The account that publishes events |
| `WITNESS_DID`, `WITNESS_HANDLE`, `WITNESS_PASSWORD`       | The witness's own account         |

These names are part of the contract between teams, so changing one needs the same sign-off as a change to `packages/contracts`.

Running `stack:seed` again changes nothing. After `npm run stack:reset` the old accounts are gone, so the next `stack:up` creates new ones with new DIDs and replaces the file. If `.env.local` is lost while the accounts still exist, the passwords can't be recovered: run `npm run stack:reset`, then `npm run stack:up`.

### The scripts

| File                 | What it holds                                                                      |
| -------------------- | ---------------------------------------------------------------------------------- |
| `scripts/stack.mjs`  | The commands: one function each for `up`, `check`, `down`, `reset`, and `logs`     |
| `scripts/checks.mjs` | The `stack:check` steps, one named function each, in the order `runChecks()` calls |
| `scripts/env.mjs`    | Creating and reading `infra/.env`                                                  |
| `scripts/seed.mjs`   | The `stack:seed` command: the seed accounts and `.env.local`                       |
| `scripts/*.test.mjs` | Unit tests for the files above. `npm test` runs them                               |

The unit tests need no Docker. `stack:check` tests the parts they can't: the containers themselves.

### Does data survive a restart?

| What happens                                  | PDS accounts and records | PLC DID documents |
| --------------------------------------------- | ------------------------ | ----------------- |
| `npm run stack:down`, then `npm run stack:up` | Kept                     | Kept              |
| Docker or the computer restarts               | Kept                     | Kept              |
| `npm run stack:reset`                         | Deleted                  | Deleted           |

Data lives in two Docker volumes, `trustlab_pds-data` and `trustlab_plc-db`. The containers don't restart on their own after Docker restarts, so run `npm run stack:up` again.

`stack:up` writes the PDS's secrets to `infra/.env` the first time, and git ignores that file. Keep it: existing accounts depend on those values. If you lose it, run `npm run stack:reset` and start again.

### Using it from code

- Resolve DIDs against `http://localhost:2582`, not `https://plc.directory`.
- Handles such as `publisher.test` don't resolve through DNS. Use DIDs, or ask the PDS with `com.atproto.identity.resolveHandle`.
- The seed accounts and their credentials are in `.env.local` (above).

### What this network can't show

There is no relay, AppView, or second PDS, so nothing is federated. Consumers read the PDS's own firehose. ADR-005 (#29) records why we develop against a local network and what that leaves out.

### If something goes wrong

- **Port already in use:** another program holds 2582 or 2583. Stop it, or run `npm run stack:down` if an old copy of the stack is still running.
- **`docker` not found, or cannot connect to the Docker daemon:** start Docker Desktop, or on Linux start the Docker service and make sure your user can run `docker`.
- **A check fails:** run `npm run stack:logs` to see what the PDS or PLC reported, or `npm run stack:reset` and then `npm run stack:up` for a clean start.

AI agents: read [AGENTS.md](../AGENTS.md) first.

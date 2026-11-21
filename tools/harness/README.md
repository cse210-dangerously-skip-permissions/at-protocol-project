# @trustlab/harness

Experiment harness: runs named scenarios and writes results.

- **Team:** Trust
- **System:** Auditor & Test Harness (AUD)

`spikes/` holds one-off scripts that answer a question against the local stack; [spikes/README.md](spikes/README.md) lists them and their findings.

AI agents: read [AGENTS.md](../../AGENTS.md) first.

## Running a scenario

From the repo root with Docker Compose running:

```sh
npm run harness -- --scenario smoke --runs 2
```

Each repetition deletes the local stack's data volumes, starts the stack, and seeds its accounts. Smoke publishes one deterministic event and records the event count. Its `timingsMs.publish` measures the whole `runPublish` call, including login, the head read, and the write. Scenarios that need to exclude login time can pass an existing session to `runPublish`. Only scenarios that audit a stream return a verdict.

`--runs` defaults to 1 and `--config` to `A0`. The runner passes the selected configuration (`A0`, `A1`, `S0`, or `S1`) and one-based run number to the scenario. To add a scenario, implement `Scenario` and add it to the list in `src/runner.ts`.

Each completed run appends a row to the JSON array in `results/<UTC start date>/<scenario>.json`. Each row includes a unique `runId`. The harness sets `RUN_ID` for each repetition so publisher, consumer, and witness logs can be matched to that row. Run numbers restart at 1 for each invocation. A failed step stops the command with a nonzero exit code and keeps previously completed rows. The runner uses `results/.running` to prevent overlapping resets. If a process is forcibly terminated, remove this empty directory after confirming the runner has stopped.

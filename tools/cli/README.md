# @trustlab/cli

The `trustlab` command-line interface.

- **Team:** Foundation
- **System:** Contracts & Integration (CTR)

AI agents: read [AGENTS.md](../../AGENTS.md) first.

## Usage

From the repo root:

```sh
npx trustlab --help
npx trustlab <command> --help
```

Exit codes: 0 success, 2 bad arguments, 1 anything else.

| Command                          | Calls                 | State                   |
| -------------------------------- | --------------------- | ----------------------- |
| `stack up\|down\|reset\|seed`    | `infra/scripts`       | not implemented         |
| `publish`, `correct`, `withdraw` | `@trustlab/publisher` | works; needs the stack  |
| `tamper edit\|rewrite\|truncate` | `@trustlab/publisher` | works; needs the stack  |
| `consume [--fresh]`              | `@trustlab/consumer`  | not implemented         |
| `witness`                        | `@trustlab/witness`   | not implemented         |
| `audit [--db <path>]`            | `@trustlab/consumer`  | prints stored verdicts  |
| `demo --scenario`                | `@trustlab/harness`   | works; resets the stack |

`demo` prints one line per run: `demo <scenario> run=<n> config=<c> verdict=<v|none>`.

A command that is not implemented prints `<command>: not implemented` and exits 1. To implement one, add a `run` to its entry in `src/cli.ts` that calls its package's exported function.

import { parseArgs } from "node:util";
import { formatAudit } from "./audit.js";
import { readLatestVerdicts, DEFAULT_DB } from "@trustlab/consumer";
import { isConfig, runScenario } from "@trustlab/harness";
import { runPublisherCli } from "@trustlab/publisher";

/** Where output lines go: normal lines and error lines. */
export interface CliIo {
  log: (line: string) => void;
  error: (line: string) => void;
}

const consoleIo: CliIo = {
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

/** One `trustlab` subcommand. */
interface Command {
  /** One line for the top-level usage. */
  summary: string;
  /** `--help` text. Commands that parse their own arguments print their own. */
  usage?: string;
  /** Runs the command. Missing means it prints `not implemented`. */
  run?: (argv: readonly string[], io: CliIo) => Promise<number>;
}

// Each command without `run` becomes a one-line call once its package exports the function (#59).
const commands: Record<string, Command> = {
  stack: {
    summary: "Start, stop, reset, or seed the local AT stack",
    usage: `Usage: trustlab stack <up|down|reset|seed>

Manage the local PDS and PLC in Docker.

  up     Start the stack and write .env.local
  down   Stop the stack
  reset  Delete the stack's data volumes
  seed   Create the seeded accounts

Not implemented yet: use npm run stack:<command> for now.`,
  },
  publish: {
    summary: "Publish seeded events to the local PDS",
    run: (argv, io) => runPublisherCli(argv, { log: io.log }),
  },
  correct: {
    summary: "Publish a correction to an earlier event",
    run: (argv, io) => runPublisherCli(["correct", ...argv], { log: io.log }),
  },
  withdraw: {
    summary: "Publish a withdrawal of an earlier event",
    run: (argv, io) => runPublisherCli(["withdraw", ...argv], { log: io.log }),
  },
  tamper: {
    summary: "Break a stream on purpose: edit, rewrite, or truncate",
    run: (argv, io) => runPublisherCli(["tamper", ...argv], { log: io.log }),
  },
  consume: {
    summary: "Follow the firehose into the consumer's view",
    usage: `Usage: trustlab consume [--fresh]

Follow the firehose and keep the consumer's SQLite view and checkpoint.

  --fresh  Start from an empty in-memory view
  --help   Show this text

Not implemented yet: use npm run consume for now.`,
  },
  witness: {
    summary: "Run the witness that keeps signed proofs of stream heads",
    usage: `Usage: trustlab witness

Run the witness, which keeps signed proofs of earlier stream heads.

Not implemented yet.`,
  },
  audit: {
    summary: "Print the consumer's latest verdict for each stream",
    run: audit,
  },
  demo: {
    summary: "Run a harness scenario on a fresh local stack",
    usage: `Usage: trustlab demo --scenario <name> [--runs <n>] [--config <A0|A1|S0|S1>]

Reset the local stack, run a harness scenario, and print one line per run.

  --scenario  Scenario name, such as smoke
  --runs      How many repetitions. Default 1
  --config    A0, A1, S0, or S1. Default A0
  --help      Show this text`,
    run: demo,
  },
};

const USAGE = `Usage: trustlab <command> [options]

Commands:
${Object.entries(commands)
  .map(([name, command]) => `  ${name.padEnd(9)} ${command.summary}`)
  .join("\n")}

Run trustlab <command> --help for a command's options.`;

/**
 * Run the `trustlab` CLI.
 *
 * @param argv - The arguments after `trustlab`.
 * @param io - Where output goes. Defaults to the console.
 * @returns The exit code: 0 on success, 2 for bad arguments, 1 otherwise.
 */
export async function main(
  argv: readonly string[],
  io: CliIo = consoleIo,
): Promise<number> {
  const [name, ...rest] = argv;
  if (name === undefined || name === "--help" || name === "help") {
    io.log(USAGE);
    return 0;
  }
  const command = Object.hasOwn(commands, name) ? commands[name] : undefined;
  if (command === undefined) {
    io.error(`unknown command ${JSON.stringify(name)}`);
    io.error(USAGE);
    return 2;
  }
  if (command.run !== undefined) return command.run(rest, io);
  if (rest.includes("--help")) {
    io.log(command.usage ?? command.summary);
    return 0;
  }
  io.error(`${name}: not implemented`);
  return 1;
}

/**
 * Run `trustlab demo`.
 *
 * @param argv - The arguments after `demo`.
 * @param io - Where output goes.
 * @returns The exit code.
 */
async function demo(argv: readonly string[], io: CliIo): Promise<number> {
  const usage = commands.demo?.usage ?? "";
  let scenario: string;
  let runs: number;
  let config: string;
  try {
    const { values } = parseArgs({
      args: [...argv],
      options: {
        scenario: { type: "string" },
        runs: { type: "string", default: "1" },
        config: { type: "string", default: "A0" },
        help: { type: "boolean" },
      },
    });
    if (values.help) {
      io.log(usage);
      return 0;
    }
    if (values.scenario === undefined)
      throw new RangeError("--scenario is required");
    if (!/^[1-9]\d*$/.test(values.runs))
      throw new RangeError("--runs needs a positive whole number");
    scenario = values.scenario;
    runs = Number(values.runs);
    config = values.config;
  } catch (error) {
    io.error(error instanceof Error ? error.message : String(error));
    io.error(usage);
    return 2;
  }
  if (!isConfig(config)) {
    io.error("--config must be A0, A1, S0, or S1");
    return 2;
  }
  try {
    const rows = await runScenario(scenario, { runs, config });
    for (const row of rows) {
      io.log(
        `demo ${row.scenario} run=${row.run} config=${row.config} verdict=${row.outcome.verdict?.verdict ?? "none"}`,
      );
    }
    return 0;
  } catch (error) {
    io.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

/** Print the latest persisted verdicts from the selected consumer database. */
async function audit(argv: readonly string[], io: CliIo): Promise<number> {
  let db: string;
  try {
    const { values } = parseArgs({
      args: [...argv],
      options: {
        db: { type: "string", default: DEFAULT_DB },
        help: { type: "boolean" },
      },
    });
    if (values.help) {
      io.log("Usage: trustlab audit [--db <path>]");
      return 0;
    }
    db = values.db;
  } catch (error) {
    io.error(String(error));
    return 2;
  }
  try {
    io.log(formatAudit(readLatestVerdicts(db)).trimEnd());
    return 0;
  } catch (error) {
    io.error(String(error));
    return 1;
  }
}

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { isStreamName, loadLocalEnv } from "@trustlab/contracts";
import { amendMain, isAmendKind } from "./amend.js";
import {
  login,
  publishEvent,
  type Published,
  type PublisherSession,
  readHead,
} from "./publisher.js";
import { publisherLog } from "./log.js";
import { integerOption } from "./args.js";
import { tamperMain } from "./tamper.js";
import { makeWorkload, workloadCreatedAt } from "./workload.js";

const USAGE = `Usage: publish --stream <name> --count <n> --seed <n>

Publish a deterministic workload of release events to the local PDS.

  --stream  Stream name, such as releases
  --count   How many events to publish
  --seed    Workload seed. The same seed gives the same event at each seq
  --help    Show this text

To amend an earlier event, run correct --help or withdraw --help.
To break a stream on purpose, run tamper --help.`;

/** What `runPublish` needs to publish a workload. */
export interface PublishArgs {
  /** Stream name, such as `releases`. */
  stream: string;
  /** How many more events to publish, continuing from the stream's head. */
  count: number;
  /** Workload seed. The same seed gives the same event at each seq. */
  seed: number;
}

/** Optional overrides for `runPublish`, used by tests and the harness. */
export interface PublishOptions {
  /** An existing session. Defaults to logging in with `.env.local`. */
  session?: PublisherSession;
  /** Where the per-event lines go. Defaults to structured output on stdout. */
  log?: (line: string) => void;
}

/**
 * Publish the next `count` events of a seeded workload, printing one line
 * per event.
 *
 * The event at seq n depends only on the seed and n. Reading the head first,
 * this continues the workload from wherever the stream is, so publishing 3
 * and then 3 writes the same records, with the same CIDs, as publishing 6
 * at once.
 *
 * @param args - Stream, count, and seed.
 * @param options - A session and a log function, when not using the defaults.
 * @returns What was published, in order.
 */
export async function runPublish(
  args: PublishArgs,
  options: PublishOptions = {},
): Promise<Published[]> {
  if (!isStreamName(args.stream)) {
    throw new RangeError(`bad stream name ${JSON.stringify(args.stream)}`);
  }
  // Checks the seed and count before anything touches the network.
  makeWorkload(args.seed, args.count);
  const log = options.log ?? publisherLog;
  const session = options.session ?? (await login(loadLocalEnv()));

  const head = await readHead(session, args.stream);
  const start = head?.seq ?? 0;
  // The payload at seq n is entry n - 1 of the workload, whatever the count.
  const payloads = makeWorkload(args.seed, start + args.count).slice(start);

  const published: Published[] = [];
  for (const [index, payload] of payloads.entries()) {
    const event = await publishEvent(session, {
      stream: args.stream,
      kind: "release",
      payload,
      createdAt: (seq) => workloadCreatedAt(args.seed, seq),
    });
    if (event.seq !== start + index + 1) {
      throw new Error(
        `${args.stream} moved while publishing: expected seq ${start + index + 1}, got ${event.seq}`,
      );
    }
    log(`published ${args.stream} seq=${event.seq} cid=${event.cid}`);
    published.push(event);
  }
  return published;
}

/**
 * Parse `publish` command-line arguments.
 *
 * @param argv - The arguments after the command name.
 * @returns The publish arguments, or `null` when `--help` was asked for.
 * @throws If an option is missing, unknown, or not a whole number.
 */
export function parsePublishArgs(argv: readonly string[]): PublishArgs | null {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      stream: { type: "string" },
      count: { type: "string" },
      seed: { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help) return null;
  if (values.stream === undefined) {
    throw new RangeError("--stream is required");
  }
  return {
    stream: values.stream,
    count: integerOption("count", values.count),
    seed: integerOption("seed", values.seed),
  };
}

/**
 * Run the publisher CLI: `publish` by default, or `correct`, `withdraw`, or
 * `tamper` when that is the first argument.
 *
 * @param argv - The command-line arguments.
 * @param options - A session and a log function, when not using the defaults.
 * @returns The exit code: 0 on success, 2 for bad arguments, 1 otherwise.
 */
export async function main(
  argv: readonly string[],
  options: PublishOptions = {},
): Promise<number> {
  const [command, ...rest] = argv;
  if (isAmendKind(command)) return amendMain(command, rest, options);
  if (command === "tamper") return tamperMain(rest, options);

  let args: PublishArgs | null;
  try {
    args = parsePublishArgs(argv);
  } catch (error) {
    publisherLog(error, console.error);
    publisherLog(USAGE, console.error);
    return 2;
  }
  if (args === null) {
    (options.log ?? console.log)(USAGE);
    return 0;
  }
  try {
    await runPublish(args, options);
    return 0;
  } catch (error) {
    publisherLog(error, console.error);
    return error instanceof RangeError ? 2 : 1;
  }
}

/**
 * Whether this file was started directly, rather than imported.
 *
 * @returns True when run as a script.
 */
function isRunDirectly(): boolean {
  const script = process.argv[1];
  if (script === undefined) return false;
  try {
    return realpathSync(script) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isRunDirectly()) {
  process.exitCode = await main(process.argv.slice(2));
}

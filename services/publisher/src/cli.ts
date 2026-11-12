import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { isStreamName, loadLocalEnv } from "@trustlab/contracts";
import {
  login,
  publishEvent,
  type Published,
  type PublisherSession,
  readHead,
} from "./publisher.js";
import { makeWorkload, workloadCreatedAt } from "./workload.js";

const USAGE = `Usage: publish --stream <name> --count <n> --seed <n>

Publish a deterministic workload of release events to the local PDS.

  --stream  Stream name, such as releases
  --count   How many events to publish
  --seed    Workload seed. The same seed gives the same event at each seq
  --help    Show this text`;

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
  /** Where the per-event lines go. Defaults to `console.log`. */
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
  const log = options.log ?? ((line: string) => console.log(line));
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
 * Read a whole-number option.
 *
 * @param name - Option name, for the error message.
 * @param value - The raw text, if the option was given.
 * @returns The number.
 */
function integerOption(name: string, value: string | undefined): number {
  if (value === undefined || !/^-?\d+$/.test(value)) {
    throw new RangeError(`--${name} needs a whole number`);
  }
  return Number(value);
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
 * Run the `publish` command.
 *
 * @param argv - The arguments after the command name.
 * @param options - A session and a log function, when not using the defaults.
 * @returns The exit code: 0 on success, 2 for bad arguments, 1 otherwise.
 */
export async function main(
  argv: readonly string[],
  options: PublishOptions = {},
): Promise<number> {
  const log = options.log ?? ((line: string) => console.log(line));
  let args: PublishArgs | null;
  try {
    args = parsePublishArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(USAGE);
    return 2;
  }
  if (args === null) {
    log(USAGE);
    return 0;
  }
  try {
    await runPublish(args, options);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
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

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadLocalEnv, log } from "@trustlab/contracts";
import { allowlistFromEnv } from "./allowlist.js";
import { startFirehose } from "./firehose.js";
import { ConsumerStore } from "./store.js";

const USAGE = "usage: npm run consume -- [--fresh] [--db <path>]";

/** Where the consumer keeps its view and checkpoint unless told otherwise. */
export const DEFAULT_DB = "consumer.db";

/**
 * Pick the database from `consume` arguments.
 *
 * `--fresh` gives an in-memory database: empty on every start and gone on
 * exit, so it never touches or deletes a file on disk.
 *
 * @param argv - The arguments after the command name.
 * @returns The database path, or `null` when `--help` was asked for.
 * @throws If an option is unknown or `--fresh` is combined with `--db`.
 */
export function parseConsumeArgs(argv: readonly string[]): string | null {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      fresh: { type: "boolean" },
      db: { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help) return null;
  if (values.fresh && values.db !== undefined) {
    throw new RangeError("--fresh and --db can't be used together");
  }
  return values.fresh ? ":memory:" : (values.db ?? DEFAULT_DB);
}

/**
 * Run the consumer until Ctrl+C: follow the firehose and save verified
 * events from the publisher in `.env.local`.
 *
 * A fresh consumer starts from the live tail with no memory of earlier
 * history. #45 adds the snapshot rebuild it needs first.
 *
 * @param argv - The command-line arguments.
 * @returns The exit code: 0 on a clean stop, 2 for bad arguments.
 */
export async function main(argv: readonly string[]): Promise<number> {
  let db: string | null;
  try {
    db = parseConsumeArgs(argv);
  } catch (error) {
    log(
      "consumer",
      error instanceof Error ? error.message : String(error),
      console.error,
    );
    log("consumer", USAGE, console.error);
    return 2;
  }
  if (db === null) {
    console.log(USAGE);
    return 0;
  }

  const env = loadLocalEnv();
  const store = new ConsumerStore(db);
  const firehose = startFirehose({
    env,
    store,
    allow: allowlistFromEnv(env).allow,
  });
  log(
    "consumer",
    `consuming ${env.PDS_URL} into ${db === ":memory:" ? "memory (fresh)" : db}`,
    console.log,
  );

  await new Promise((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  await firehose.stop();
  store.close();
  log("consumer", "stopped", console.log);
  return 0;
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
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    log("consumer", String(error), console.error);
    process.exitCode = 1;
  }
}

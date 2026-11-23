import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, rename, rmdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Verdict } from "@trustlab/contracts";
import { runPublish } from "@trustlab/publisher";

const configs = ["A0", "A1", "S0", "S1"] as const;

/** Settings for one clean-stack repetition. Run numbers start at one per invocation. */
export interface RunContext {
  config: (typeof configs)[number];
  run: number;
  runId: string;
}

/** Measurements produced by one scenario. */
export interface ScenarioOutcome {
  verdict?: Verdict;
  counts?: Record<string, number>;
  timingsMs?: Record<string, number>;
}

/** An experiment that executes once against a freshly seeded stack. */
export interface Scenario {
  name: string;
  run(ctx: RunContext): Promise<ScenarioOutcome>;
}

/** A completed run as stored in the daily results file. */
export interface ResultRow extends RunContext {
  scenario: string;
  startedAt: string;
  outcome: ScenarioOutcome;
}

/** Check a configuration name before resetting the stack. */
export function isConfig(value: string): value is RunContext["config"] {
  return configs.some((config) => config === value);
}

const scenarios: Scenario[] = [
  {
    name: "smoke",
    /** Publish one deterministic event and measure the publisher operation. */
    async run() {
      const start = performance.now();
      const published = await runPublish({
        stream: "smoke",
        count: 1,
        seed: 1,
      });
      return {
        counts: { published: published.length },
        timingsMs: { publish: performance.now() - start },
      };
    },
  },
];

/** Load previous runs for this UTC day, preserving results across invocations. */
async function readRows(path: string): Promise<unknown[]> {
  let data: string;
  try {
    data = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const rows: unknown = JSON.parse(data);
  if (!Array.isArray(rows))
    throw new Error(`Expected a results array in ${path}`);
  return rows;
}

/** Reset and seed the local stack for each repetition, recording each success before continuing. */
export async function runScenario(
  name: string,
  opts: { config: RunContext["config"]; runs: number },
): Promise<ResultRow[]> {
  const scenario = scenarios.find((entry) => entry.name === name);
  if (!scenario) throw new Error(`Unknown scenario: ${name}`);
  if (!isConfig(opts.config))
    throw new Error(`Unknown configuration: ${opts.config}`);
  if (!Number.isSafeInteger(opts.runs) || opts.runs < 1)
    throw new Error("Runs must be a positive integer");

  const stackScript = fileURLToPath(
    new URL("../../../infra/scripts/stack.mjs", import.meta.url),
  );
  const lock = join("results", ".running");
  await mkdir("results", { recursive: true });
  try {
    await mkdir(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    throw new Error(
      `Harness lock exists at ${lock}. Wait for the active run to finish. If it was interrupted, confirm it has stopped before removing the directory.`,
      { cause: error },
    );
  }
  const previousRunId = process.env.RUN_ID;
  try {
    const completed: ResultRow[] = [];
    for (let run = 1; run <= opts.runs; run++) {
      const runId = randomUUID();
      process.env.RUN_ID = runId;
      const startedAt = new Date().toISOString();
      const dir = join("results", startedAt.slice(0, 10));
      const path = join(dir, `${name}.json`);
      const previous = await readRows(path);
      // stack:up seeds the accounts after its health checks pass.
      for (const step of ["reset", "up"]) {
        const child = spawn(process.execPath, [stackScript, step], {
          stdio: "inherit",
        });
        const [code] = await once(child, "close");
        if (code !== 0) throw new Error(`stack:${step} failed (exit ${code})`);
      }
      const ctx = { run, runId, config: opts.config };
      const outcome = await scenario.run(ctx);
      const row = { scenario: name, ...ctx, startedAt, outcome };
      await mkdir(dir, { recursive: true });
      await writeFile(
        path + ".tmp",
        JSON.stringify([...previous, row], null, 2) + "\n",
      );
      await rename(path + ".tmp", path);
      completed.push(row);
    }
    return completed;
  } finally {
    if (previousRunId === undefined) delete process.env.RUN_ID;
    else process.env.RUN_ID = previousRunId;
    await rmdir(lock);
  }
}

import { ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPublish } from "@trustlab/publisher";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { runScenario } from "./runner.js";

vi.mock("node:child_process", { spy: true });
vi.mock("@trustlab/publisher", () => ({ runPublish: vi.fn() }));

/** Return a child that completes on the next event loop turn. */
function successfulStep() {
  const child = new ChildProcess();
  setImmediate(() => child.emit("close", 0));
  return child;
}

const cwd = process.cwd();
const published = [
  { seq: 1, rkey: "event", cid: "record", commitCid: "commit", rev: "rev" },
];
let dir: string;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-19T12:00:00Z"));
  dir = await mkdtemp(join(tmpdir(), "trustlab-harness-"));
  process.chdir(dir);
  vi.mocked(spawn).mockImplementation(successfulStep);
  vi.mocked(runPublish).mockResolvedValue(published);
});
afterEach(async () => {
  process.chdir(cwd);
  await rm(dir, { recursive: true, force: true });
  vi.useRealTimers();
  vi.resetAllMocks();
});

test("resets and seeds before every publish and retains earlier configurations", async () => {
  const events: string[] = [];
  const runIds: (string | undefined)[] = [];
  const parentId = process.env.RUN_ID;
  vi.mocked(spawn).mockImplementation((_file, args) => {
    runIds.push(process.env.RUN_ID);
    if (Array.isArray(args)) events.push(args[1]);
    return successfulStep();
  });
  vi.mocked(runPublish).mockImplementation(async () => {
    runIds.push(process.env.RUN_ID);
    events.push("publish");
    return published;
  });
  const first = await runScenario("smoke", { runs: 2, config: "A0" });
  expect(events).toEqual(["reset", "up", "publish", "reset", "up", "publish"]);
  expect(new Set(first.map((row) => row.runId)).size).toBe(2);
  expect(runIds).toEqual(
    first.flatMap((row) => [row.runId, row.runId, row.runId]),
  );
  expect(process.env.RUN_ID).toBe(parentId);
  expect(first.map((row) => row.run)).toEqual([1, 2]);
  const second = await runScenario("smoke", { runs: 1, config: "S1" });
  expect(second[0]).toMatchObject({
    scenario: "smoke",
    config: "S1",
    run: 1,
    outcome: {
      counts: { published: 1 },
      timingsMs: { publish: expect.any(Number) },
    },
  });
  const path = join(
    dir,
    "results",
    first[0]!.startedAt.slice(0, 10),
    "smoke.json",
  );
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual([
    ...first,
    ...second,
  ]);
});

test("rejects invalid requests before reset and releases the lock after failure", async () => {
  await expect(
    runScenario("unknown", { runs: 1, config: "A1" }),
  ).rejects.toThrow("Unknown scenario");
  await expect(runScenario("smoke", { runs: 0, config: "A1" })).rejects.toThrow(
    "positive integer",
  );
  expect(spawn).not.toHaveBeenCalled();
  vi.mocked(spawn).mockImplementationOnce(() => {
    throw new Error("reset failed");
  });
  await expect(runScenario("smoke", { runs: 1, config: "A1" })).rejects.toThrow(
    "reset failed",
  );
  expect(runPublish).not.toHaveBeenCalled();
  await expect(
    runScenario("smoke", { runs: 1, config: "A1" }),
  ).resolves.toHaveLength(1);
});

test("keeps an existing lock and stops before resetting the stack", async () => {
  const lock = join("results", ".running");
  await mkdir(lock, { recursive: true });
  await expect(runScenario("smoke", { runs: 1, config: "A0" })).rejects.toThrow(
    "Wait for the active run to finish",
  );
  expect(spawn).not.toHaveBeenCalled();
  await expect(mkdir(lock)).rejects.toMatchObject({ code: "EEXIST" });
});

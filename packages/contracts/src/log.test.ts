import { afterEach, expect, test, vi } from "vitest";
import { log } from "./log.js";

afterEach(() => vi.unstubAllEnvs());

test("emits one JSON line per message with the current run ID", () => {
  const write = vi.fn<(line: string) => void>();
  for (const runId of ["run-1", "run-2", undefined]) {
    vi.stubEnv("RUN_ID", runId);
    const msg = 'line one\n"line two"';
    log("witness", msg, write);
    const [line] = write.mock.lastCall!;
    expect(line).not.toContain("\n");
    const entry = JSON.parse(line);
    expect(entry).toEqual({
      ts: new Date(entry.ts).toISOString(),
      service: "witness",
      runId: runId ?? null,
      msg,
    });
  }
});

import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConsumerStore } from "@trustlab/consumer";
import { runScenario } from "@trustlab/harness";
import { expect, test, vi } from "vitest";
import { main } from "./cli.js";

vi.mock("@trustlab/harness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@trustlab/harness")>()),
  runScenario: vi.fn(),
}));

/**
 * Run the CLI and collect what it printed.
 *
 * @param argv - The arguments after `trustlab`.
 * @returns The exit code and the printed lines.
 */
async function run(...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, {
    log: (line) => out.push(line),
    error: (line) => err.push(line),
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

test("prints usage with no command or --help", async () => {
  for (const argv of [[], ["--help"]]) {
    const { code, out } = await run(...argv);
    expect(code).toBe(0);
    expect(out).toContain("Usage: trustlab <command>");
  }
});

test("rejects an unknown command", async () => {
  const { code, err } = await run("bogus");
  expect(code).toBe(2);
  expect(err).toContain('unknown command "bogus"');
});

const all = [
  "stack",
  "publish",
  "correct",
  "withdraw",
  "tamper",
  "consume",
  "witness",
  "audit",
  "demo",
];

test("lists every subcommand", async () => {
  const { out } = await run("--help");
  for (const command of all) expect(out).toContain(`  ${command} `);
});

test("each subcommand has --help", async () => {
  for (const command of all) {
    const { code, out } = await run(command, "--help");
    expect(code).toBe(0);
    expect(out).toContain("Usage:");
  }
});

test("unimplemented subcommands say so", async () => {
  for (const command of ["stack", "consume", "witness"]) {
    const { code, err } = await run(command);
    expect(code).toBe(1);
    expect(err).toBe(`${command}: not implemented`);
  }
});

test("demo checks its arguments before touching the stack", async () => {
  expect((await run("demo")).err).toContain("--scenario is required");
  for (const runs of ["x", "0"]) {
    const { code, err } = await run(
      "demo",
      "--scenario",
      "smoke",
      "--runs",
      runs,
    );
    expect(code).toBe(2);
    expect(err).toContain("--runs needs a positive whole number");
  }
  const bad = await run("demo", "--scenario", "smoke", "--config", "Z9");
  expect(bad.code).toBe(2);
  expect(bad.err).toContain("--config must be");
});

test("demo prints one line per run with the verdict kind", async () => {
  vi.mocked(runScenario).mockResolvedValue([
    {
      scenario: "smoke",
      run: 1,
      runId: "run-1",
      config: "A0",
      startedAt: "2026-11-23T00:00:00.000Z",
      outcome: { verdict: { verdict: "conflict", reason: "broken-link" } },
    },
    {
      scenario: "smoke",
      run: 2,
      runId: "run-2",
      config: "A0",
      startedAt: "2026-11-23T00:00:01.000Z",
      outcome: {},
    },
  ]);
  const { code, out } = await run("demo", "--scenario", "smoke", "--runs", "2");
  expect(code).toBe(0);
  expect(out).toBe(
    "demo smoke run=1 config=A0 verdict=conflict\n" +
      "demo smoke run=2 config=A0 verdict=none",
  );
});

test("audit reads the latest verdict per stream in stable order", async () => {
  const dir = mkdtempSync(join(tmpdir(), "audit-cli-"));
  const path = join(dir, "consumer.db");
  try {
    expect((await run("audit", "--db", path)).code).toBe(1);
    expect((await run("audit", "--bad")).code).toBe(2);
    new DatabaseSync(path).close();
    expect((await run("audit", "--db", path)).out).toBe("no streams audited");
    const store = new ConsumerStore(path);
    try {
      expect((await run("audit", "--db", path)).out).toBe("no streams audited");
      for (const stream of ["z", "a"])
        store.saveVerdict(
          "did:example:p",
          stream,
          {
            verdict: "accept",
            reason: "ok",
          },
          null,
        );
      store.saveVerdict(
        "did:example:p",
        "a",
        {
          verdict: "conflict",
          reason: "broken-link",
          evidence: { seq: 2 },
        },
        null,
      );
      const { out, code } = await run("audit", "--db", path);
      expect(code).toBe(0);
      expect(out).toMatch(/^stream a .*reason {4}broken-link.*stream z /s);
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true });
  }
});

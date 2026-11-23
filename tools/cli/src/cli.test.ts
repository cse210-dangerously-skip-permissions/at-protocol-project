import { expect, test } from "vitest";
import { main } from "./cli.js";

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
  for (const command of ["stack", "consume", "witness", "audit"]) {
    const { code, err } = await run(command);
    expect(code).toBe(1);
    expect(err).toBe(`${command}: not implemented`);
  }
});

test("demo checks its arguments before touching the stack", async () => {
  expect((await run("demo")).err).toContain("--scenario is required");
  expect((await run("demo", "--scenario", "smoke", "--runs", "x")).code).toBe(
    2,
  );
  const bad = await run("demo", "--scenario", "smoke", "--config", "Z9");
  expect(bad.code).toBe(2);
  expect(bad.err).toContain("--config must be");
});

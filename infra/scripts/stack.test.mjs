import { describe, expect, test } from "vitest";
import { isSupportedNode } from "./stack.mjs";

describe("isSupportedNode", () => {
  test.each([
    ["22.19.0", true],
    ["22.23.4", true],
    ["24.1.0", true],
    ["22.18.0", false],
    ["22.5.0", false],
    ["20.20.2", false],
    ["18.19.1", false],
  ])("Node %s supported: %s", (version, supported) => {
    expect(isSupportedNode(version)).toBe(supported);
  });

  test("importing the script does not run a command", () => {
    // If it had, Usage or a docker error would have set an exit code.
    expect(process.exitCode ?? 0).toBe(0);
  });
});

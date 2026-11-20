import { expect, test } from "vitest";
import { createHash } from "node:crypto";
import {
  makeWorkload,
  releaseChecksum,
  seededRandom,
  workloadCreatedAt,
} from "./workload.js";

test("the same seed gives the same payloads", () => {
  expect(makeWorkload(7, 20)).toEqual(makeWorkload(7, 20));
});

test("different seeds give different payloads", () => {
  expect(makeWorkload(1, 5)).not.toEqual(makeWorkload(2, 5));
});

test("a longer workload starts with the shorter one", () => {
  expect(makeWorkload(3, 10).slice(0, 4)).toEqual(makeWorkload(3, 4));
});

test("payloads have a name, a version, and a sha256 checksum", () => {
  const payloads = makeWorkload(42, 50);

  expect(payloads).toHaveLength(50);
  for (const payload of payloads) {
    expect(payload.name).toMatch(/^[a-z]+-[a-z]+$/);
    expect(payload.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(payload.checksum).toMatch(/^sha256:[0-9a-f]{64}$/);
  }
});

test("seed 1 starts with a feed a person can read", () => {
  expect(
    makeWorkload(1, 6).map((payload) => `${payload.name}@${payload.version}`),
  ).toMatchInlineSnapshot(`
    [
      "date-kit@1.0.0",
      "safe-merge@1.0.0",
      "env-check@1.0.0",
      "safe-merge@1.0.1",
      "json-lens@1.0.0",
      "json-lens@1.0.1",
    ]
  `);
});

test("each package starts at 1.0.0 and its versions only go up", () => {
  const latest = new Map<string, number[]>();
  for (const payload of makeWorkload(42, 300)) {
    const version = payload.version.split(".").map(Number);
    const previous = latest.get(payload.name);
    if (previous === undefined) {
      expect(payload.version).toBe("1.0.0");
    } else {
      const [major, minor, patch] = previous as [number, number, number];
      expect([
        [major + 1, 0, 0],
        [major, minor + 1, 0],
        [major, minor, patch + 1],
      ]).toContainEqual(version);
    }
    latest.set(payload.name, version);
  }
  expect(latest.size).toBeGreaterThan(1);
});

test("no package and version is released twice", () => {
  const releases = makeWorkload(7, 500).map(
    (payload) => `${payload.name}@${payload.version}`,
  );

  expect(new Set(releases).size).toBe(500);
});

test("the checksum is the SHA-256 of name@version", () => {
  const expected = createHash("sha256").update("left-pad@1.0.0").digest("hex");

  expect(releaseChecksum("left-pad", "1.0.0")).toBe(`sha256:${expected}`);
  for (const payload of makeWorkload(3, 20)) {
    expect(payload.checksum).toBe(
      releaseChecksum(payload.name, payload.version),
    );
  }
});

test("a count of zero gives an empty workload", () => {
  expect(makeWorkload(1, 0)).toEqual([]);
});

test("rejects a bad seed or count", () => {
  expect(() => makeWorkload(1.5, 1)).toThrow(RangeError);
  expect(() => makeWorkload(1, -1)).toThrow(RangeError);
  expect(() => makeWorkload(1, 2.5)).toThrow(RangeError);
});

test("seededRandom stays in [0, 1) and repeats for a seed", () => {
  const a = seededRandom(9);
  const b = seededRandom(9);
  for (let i = 0; i < 1000; i += 1) {
    const value = a();
    expect(value).toBe(b());
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThan(1);
  }
});

test("createdAt comes from the seed and seq, and only moves forward", () => {
  expect(workloadCreatedAt(1, 1)).toBe("2026-01-02T00:00:00.000Z");
  expect(workloadCreatedAt(1, 3)).toBe("2026-01-02T00:00:02.000Z");
  expect(workloadCreatedAt(5, 3)).toBe(workloadCreatedAt(5, 3));
  expect(workloadCreatedAt(5, 3) < workloadCreatedAt(5, 4)).toBe(true);
  expect(() => workloadCreatedAt(1, 0)).toThrow(RangeError);
  expect(() => workloadCreatedAt(1, 1.5)).toThrow(RangeError);
});

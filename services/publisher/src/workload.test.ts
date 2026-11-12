import { expect, test } from "vitest";
import { makeWorkload, seededRandom, workloadCreatedAt } from "./workload.js";

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

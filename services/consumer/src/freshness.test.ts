import type { Verdict } from "@trustlab/contracts";
import { describe, expect, test } from "vitest";
import {
  DEFAULT_FRESHNESS_MS,
  freshnessMs,
  freshVerdict,
} from "./freshness.js";

const NOW = new Date("2026-11-22T12:00:30.000Z");
const CONFLICT: Verdict = {
  verdict: "conflict",
  reason: "witness-mismatch",
  evidence: { seq: 3, witnessedCid: "bafy-old", currentCid: "bafy-new" },
};
const STALE: Verdict = { verdict: "unknown", reason: "stale" };

describe("freshVerdict", () => {
  test("keeps the stored verdict while it is fresh", () => {
    expect(
      freshVerdict(CONFLICT, "2026-11-22T12:00:10.000Z", NOW, 30_000),
    ).toBe(CONFLICT);
  });

  test("keeps it at exactly the threshold", () => {
    expect(
      freshVerdict(CONFLICT, "2026-11-22T12:00:00.000Z", NOW, 30_000),
    ).toBe(CONFLICT);
  });

  test("reports unknown/stale past the threshold, whatever was stored", () => {
    const old = "2026-11-22T11:59:59.999Z";
    expect(freshVerdict(CONFLICT, old, NOW, 30_000)).toEqual(STALE);
    expect(
      freshVerdict({ verdict: "accept", reason: "ok" }, old, NOW, 30_000),
    ).toEqual(STALE);
  });

  test("treats a missing or unreadable check time as stale", () => {
    expect(freshVerdict(CONFLICT, null, NOW, 30_000)).toEqual(STALE);
    expect(freshVerdict(CONFLICT, "yesterday", NOW, 30_000)).toEqual(STALE);
  });
});

describe("freshnessMs", () => {
  test("defaults to 30 seconds", () => {
    expect(freshnessMs(undefined)).toBe(DEFAULT_FRESHNESS_MS);
    expect(freshnessMs("")).toBe(30_000);
  });

  test("reads a positive whole number", () => {
    expect(freshnessMs("5000")).toBe(5000);
  });

  test.each(["0", "-1", "1.5", "30s", "abc"])("rejects %j", (value) => {
    expect(() => freshnessMs(value)).toThrow(RangeError);
  });
});

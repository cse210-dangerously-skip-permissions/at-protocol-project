import { verifyCheckpoint } from "@trustlab/auditor";
import type { WitnessCheckpoint } from "@trustlab/contracts";
import { afterEach, expect, test, vi } from "vitest";
import { Metrics, metricKeys } from "./metrics.js";

vi.mock("@trustlab/auditor", () => ({ verifyCheckpoint: vi.fn() }));

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

/** A checkpoint whose proof decodes to `size` bytes; other fields are unused here. */
function checkpoint(size: number): WitnessCheckpoint {
  return {
    did: "did:plc:test",
    stream: "s",
    seq: 1,
    eventCid: "event",
    headCid: "head",
    commitCid: "commit",
    rev: "rev",
    proofCar: Buffer.alloc(size).toString("base64"),
    signingKey: "did:key:test",
    observedAt: "2026-11-21T00:00:00Z",
  };
}

test("adds repeated timings and counts under the same key", async () => {
  vi.useFakeTimers({ toFake: ["performance"] });
  const metrics = new Metrics();
  for (const ms of [30, 12]) {
    await metrics.time(metricKeys.recovery, async () => {
      vi.advanceTimersByTime(ms);
    });
  }
  metrics.count(metricKeys.chainWalkLength, 5);
  metrics.count(metricKeys.chainWalkLength, 2);

  expect(metrics.outcome()).toEqual({
    counts: { chainWalkLength: 7 },
    timingsMs: { recovery: 42 },
  });
});

test("returns the timed value and records nothing when the operation throws", async () => {
  const metrics = new Metrics();
  await expect(metrics.time("x", async () => "done")).resolves.toBe("done");
  await expect(
    metrics.time("y", () => Promise.reject(new Error("rebuild failed"))),
  ).rejects.toThrow("rebuild failed");

  expect(Object.keys(metrics.outcome().timingsMs)).toEqual(["x"]);
});

test("rejects a count that is not finite", () => {
  expect(() => new Metrics().count("n", Number.NaN)).toThrow("not finite");
});

test("verifies checkpoints and records decoded proof bytes and validity", async () => {
  vi.mocked(verifyCheckpoint)
    .mockResolvedValueOnce(true)
    .mockResolvedValueOnce(false);
  const metrics = new Metrics();
  const cps = [checkpoint(1100), checkpoint(2400)];

  await expect(metrics.verifyCheckpoints(cps)).resolves.toEqual([true, false]);

  expect(verifyCheckpoint).toHaveBeenCalledTimes(2);
  const { counts, timingsMs } = metrics.outcome();
  expect(counts).toEqual({
    checkpoints: 2,
    checkpointsValid: 1,
    proofBytesTotal: 3500,
    proofBytesMax: 2400,
  });
  expect(timingsMs.verifyCheckpoint).toBeGreaterThanOrEqual(0);
});

test("records zero checkpoints without a verification timing", async () => {
  const metrics = new Metrics();
  await metrics.verifyCheckpoints([]);

  expect(metrics.outcome()).toEqual({
    counts: { checkpoints: 0, checkpointsValid: 0 },
    timingsMs: {},
  });
});

test("outcome returns a snapshot", () => {
  const metrics = new Metrics();
  const before = metrics.outcome();
  metrics.count("n", 1);

  expect(before.counts).toEqual({});
});

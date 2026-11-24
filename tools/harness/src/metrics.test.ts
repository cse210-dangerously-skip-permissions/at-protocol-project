import type { WitnessCheckpoint } from "@trustlab/contracts";
import { afterEach, expect, test, vi } from "vitest";
import { Metrics, metricKeys, pinnedVerifier } from "./metrics.js";

const { verifyCheckpoint } = vi.hoisted(() => ({
  verifyCheckpoint: vi.fn(async () => true),
}));
vi.mock("@trustlab/auditor", () => ({ verifyCheckpoint }));

afterEach(() => {
  vi.useRealTimers();
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

test("rejects a count or max that is not finite", () => {
  expect(() => new Metrics().count("n", Number.NaN)).toThrow("not finite");
  expect(() => new Metrics().max("n", Infinity)).toThrow("not finite");
});

test("max keeps the largest value instead of adding", () => {
  const metrics = new Metrics();
  metrics.max("m", 2400);
  metrics.max("m", 2400);
  metrics.max("m", 1100);

  expect(metrics.outcome().counts).toEqual({ m: 2400 });
});

test("names that exist on Object.prototype start at zero", () => {
  const metrics = new Metrics();
  metrics.count("constructor", 1);
  metrics.count("toString", 2);

  expect(metrics.outcome().counts).toEqual({ constructor: 1, toString: 2 });
});

test("verifies checkpoints with the given verifier and records proof bytes and validity", async () => {
  vi.useFakeTimers({ toFake: ["performance"] });
  const verify = vi
    .fn<(cp: WitnessCheckpoint) => Promise<boolean>>()
    .mockImplementationOnce(async () => {
      vi.advanceTimersByTime(5);
      return true;
    })
    .mockImplementationOnce(async () => {
      vi.advanceTimersByTime(7);
      return false;
    });
  const metrics = new Metrics();
  const cps = [checkpoint(1100), checkpoint(2400)];

  await expect(metrics.verifyCheckpoints(cps, verify)).resolves.toEqual([
    true,
    false,
  ]);

  expect(verify.mock.calls.map(([cp]) => cp)).toEqual(cps);
  expect(metrics.outcome()).toEqual({
    counts: {
      checkpoints: 2,
      checkpointsValid: 1,
      proofBytesTotal: 3500,
      proofBytesMax: 2400,
    },
    timingsMs: { verification: 12 },
  });
});

test("a malformed checkpoint counts as not valid without reaching the verifier", async () => {
  const verify = vi.fn(async () => true);
  const metrics = new Metrics();
  const bad = {
    ...checkpoint(10),
    proofCar: null,
  } as unknown as WitnessCheckpoint;

  await expect(
    metrics.verifyCheckpoints([checkpoint(100), bad], verify),
  ).resolves.toEqual([true, false]);

  expect(verify).toHaveBeenCalledTimes(1);
  expect(metrics.outcome().counts).toEqual({
    checkpoints: 2,
    checkpointsValid: 1,
    proofBytesTotal: 100,
    proofBytesMax: 100,
  });
});

test("records nothing from verifyCheckpoints when the verifier throws", async () => {
  const verify = vi
    .fn<(cp: WitnessCheckpoint) => Promise<boolean>>()
    .mockResolvedValueOnce(true)
    .mockRejectedValueOnce(new Error("resolver down"));
  const metrics = new Metrics();

  await expect(
    metrics.verifyCheckpoints([checkpoint(100), checkpoint(200)], verify),
  ).rejects.toThrow("resolver down");

  expect(metrics.outcome()).toEqual({ counts: {}, timingsMs: {} });
});

test("an empty checkpoint list writes the same keys as zeros", async () => {
  const metrics = new Metrics();
  await metrics.verifyCheckpoints([], vi.fn());

  expect(metrics.outcome()).toEqual({
    counts: {
      checkpoints: 0,
      checkpointsValid: 0,
      proofBytesTotal: 0,
      proofBytesMax: 0,
    },
    timingsMs: { verification: 0 },
  });
});

test("outcome returns a snapshot", async () => {
  const metrics = new Metrics();
  const before = metrics.outcome();
  metrics.count("n", 1);
  await metrics.time("t", async () => undefined);

  expect(before).toEqual({ counts: {}, timingsMs: {} });
});

test("pinnedVerifier checks against the DID document key, not the witness's", async () => {
  const cp = checkpoint(1);

  await expect(pinnedVerifier("did:key:doc")(cp)).resolves.toBe(true);

  expect(verifyCheckpoint).toHaveBeenCalledWith({
    ...cp,
    signingKey: "did:key:doc",
  });
});

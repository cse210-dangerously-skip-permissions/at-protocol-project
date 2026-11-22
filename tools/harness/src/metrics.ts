import { verifyCheckpoint } from "@trustlab/auditor";
import type { WitnessCheckpoint } from "@trustlab/contracts";
import type { ScenarioOutcome } from "./runner.js";

/**
 * Keys that scenarios write into `ScenarioOutcome.timingsMs` and `counts`.
 * The results write-up reads these names, so use them instead of new spellings.
 */
export const metricKeys = {
  /** Timing: rebuilding the consumer view from a repo snapshot. */
  recovery: "recovery",
  /** Timing: total time in `verifyCheckpoint` across every checkpoint checked. */
  verification: "verifyCheckpoint",
  /** Count: checkpoints passed to `verifyCheckpoints`. */
  checkpoints: "checkpoints",
  /** Count: checkpoints that verified. */
  checkpointsValid: "checkpointsValid",
  /** Count: raw (decoded) proof CAR bytes summed across checkpoints. */
  proofBytesTotal: "proofBytesTotal",
  /** Count: the largest single proof CAR, in raw bytes. */
  proofBytesMax: "proofBytesMax",
  /** Count: events the auditor walked along the chain. */
  chainWalkLength: "chainWalkLength",
} as const;

/**
 * Collects one scenario's measurements in the shape `ScenarioOutcome` stores.
 * Timings and counts written twice under the same key add up, so a scenario
 * can time several rebuilds or walks and report the total.
 */
export class Metrics {
  private readonly counts: Record<string, number> = {};
  private readonly timingsMs: Record<string, number> = {};

  /**
   * Run `fn` and add its wall-clock time to `timingsMs[name]`.
   *
   * @param name - Timing key, usually one of `metricKeys`.
   * @param fn - The operation to time.
   * @returns What `fn` returns. If `fn` throws, nothing is recorded.
   */
  async time<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const start = performance.now();
    const value = await fn();
    this.add(this.timingsMs, name, performance.now() - start);
    return value;
  }

  /**
   * Add `n` to `counts[name]`.
   *
   * @param name - Count key, usually one of `metricKeys`.
   * @param n - Amount to add; must be a finite number.
   */
  count(name: string, n: number): void {
    if (!Number.isFinite(n)) throw new Error(`Count ${name} is not finite`);
    this.add(this.counts, name, n);
  }

  /**
   * Verify each checkpoint offline, timing only the verification, and record
   * how many there were, how many held, and their proof sizes.
   *
   * @param checkpoints - Checkpoints as the witness stored them.
   * @returns Whether each checkpoint verified, in input order.
   */
  async verifyCheckpoints(
    checkpoints: readonly WitnessCheckpoint[],
  ): Promise<boolean[]> {
    const results: boolean[] = [];
    for (const cp of checkpoints) {
      const bytes = Buffer.from(cp.proofCar, "base64").length;
      this.count(metricKeys.proofBytesTotal, bytes);
      this.counts[metricKeys.proofBytesMax] = Math.max(
        this.counts[metricKeys.proofBytesMax] ?? 0,
        bytes,
      );
      results.push(
        await this.time(metricKeys.verification, () => verifyCheckpoint(cp)),
      );
    }
    this.count(metricKeys.checkpoints, checkpoints.length);
    this.count(
      metricKeys.checkpointsValid,
      results.filter((valid) => valid).length,
    );
    return results;
  }

  /**
   * The measurements so far, ready to return from `Scenario.run`.
   *
   * @returns Copies of the counts and timings; later calls do not change them.
   */
  outcome(): Required<Pick<ScenarioOutcome, "counts" | "timingsMs">> {
    return { counts: { ...this.counts }, timingsMs: { ...this.timingsMs } };
  }

  /** Add `n` to `record[name]`, starting from zero. */
  private add(record: Record<string, number>, name: string, n: number): void {
    record[name] = (record[name] ?? 0) + n;
  }
}

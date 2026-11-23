import { parseWitnessCheckpoint } from "@trustlab/contracts";
import type { WitnessCheckpoint } from "@trustlab/contracts";
import type { ScenarioOutcome } from "./runner.js";

/**
 * Keys that scenarios write into `ScenarioOutcome.timingsMs` and `counts`.
 * The results write-up reads these names, so use them instead of new spellings.
 * `verifyCheckpoints` writes its keys even for an empty list, so every row of a
 * scenario has the same keys.
 */
export const metricKeys = {
  /** Timing: rebuilding the consumer view from a repo snapshot. */
  recovery: "recovery",
  /**
   * Timing: total time in the verifier across every checkpoint checked. Run 1
   * of a process also pays one-time JIT and crypto setup, so report the median
   * across runs, not the mean.
   */
  verification: "verification",
  /** Count: checkpoints passed to `verifyCheckpoints`. */
  checkpoints: "checkpoints",
  /** Count: checkpoints that verified. */
  checkpointsValid: "checkpointsValid",
  /** Count: raw (decoded) proof CAR bytes summed across checkpoints. */
  proofBytesTotal: "proofBytesTotal",
  /** Max: the largest single proof CAR, in raw bytes. */
  proofBytesMax: "proofBytesMax",
  /** Count: events the auditor walked along the chain. */
  chainWalkLength: "chainWalkLength",
} as const;

/**
 * Checks one checkpoint and says whether it holds. Pass one that checks the
 * signature against the publisher's key from their DID document, not the
 * `signingKey` the witness supplies (ADR-003 rule 3), e.g.
 * `(cp) => verifyCheckpoint({ ...cp, signingKey: didDocKey })`, so the counts
 * agree with the auditor's verdict.
 */
export type CheckpointVerifier = (cp: WitnessCheckpoint) => Promise<boolean>;

/**
 * Collects one run's measurements in the shape `ScenarioOutcome` stores.
 * Create a new `Metrics` inside each `Scenario.run`, so runs do not share
 * totals. Timings and counts written twice under the same key add up, so a
 * scenario can time several rebuilds or walks and report the total; keys
 * written with `max` keep the largest value instead.
 */
export class Metrics {
  private readonly counts = emptyRecord();
  private readonly timingsMs = emptyRecord();

  /**
   * Run `fn` and add its wall-clock time to `timingsMs[name]`. Timed calls on
   * the same key must run one after another: overlapping calls would each add
   * the shared wall-clock time.
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
    this.add(this.counts, name, n);
  }

  /**
   * Set `counts[name]` to `n` if `n` is larger. Use it for keys that hold a
   * maximum, such as `metricKeys.proofBytesMax`; do not mix it with `count`
   * on the same key.
   *
   * @param name - Count key, usually one of `metricKeys`.
   * @param n - Candidate value; must be a finite number.
   */
  max(name: string, n: number): void {
    assertFinite(name, n);
    this.counts[name] = Math.max(this.counts[name] ?? 0, n);
  }

  /**
   * Verify each checkpoint, timing only the verifier, and record how many
   * there were, how many held, and their proof sizes. A checkpoint that is not
   * well formed counts as not valid and adds no proof bytes; it is not passed
   * to `verify`.
   *
   * @param checkpoints - Checkpoints as the witness stored them.
   * @param verify - Decides whether one checkpoint holds; see `CheckpointVerifier`.
   * @returns Whether each checkpoint verified, in input order.
   * @throws Whatever `verify` throws; nothing is recorded for the call then.
   */
  async verifyCheckpoints(
    checkpoints: readonly WitnessCheckpoint[],
    verify: CheckpointVerifier,
  ): Promise<boolean[]> {
    const results: boolean[] = [];
    const sizes: number[] = [];
    let elapsed = 0;
    for (const cp of checkpoints) {
      if (!isWellFormed(cp)) {
        results.push(false);
        continue;
      }
      sizes.push(Buffer.from(cp.proofCar, "base64").length);
      const start = performance.now();
      results.push(await verify(cp));
      elapsed += performance.now() - start;
    }

    // Written together, so a throw above leaves no partial counts.
    this.add(this.timingsMs, metricKeys.verification, elapsed);
    this.count(metricKeys.checkpoints, checkpoints.length);
    this.count(
      metricKeys.checkpointsValid,
      results.filter((valid) => valid).length,
    );
    this.count(
      metricKeys.proofBytesTotal,
      sizes.reduce((sum, n) => sum + n, 0),
    );
    this.max(metricKeys.proofBytesMax, Math.max(0, ...sizes));
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
    assertFinite(name, n);
    record[name] = (record[name] ?? 0) + n;
  }
}

/** A record with no prototype, so names like `constructor` start at zero. */
function emptyRecord(): Record<string, number> {
  return Object.create(null) as Record<string, number>;
}

/** Throw unless `n` is a finite number. */
function assertFinite(name: string, n: number): void {
  if (!Number.isFinite(n)) throw new Error(`Metric ${name} is not finite`);
}

/** Whether `cp` passes the contract check, so its proof can be decoded. */
function isWellFormed(cp: WitnessCheckpoint): boolean {
  try {
    parseWitnessCheckpoint(cp);
    return true;
  } catch {
    return false;
  }
}

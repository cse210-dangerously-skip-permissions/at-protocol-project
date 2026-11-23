import type { Verdict } from "@trustlab/contracts";

/** How old a verdict may get before it is reported as stale: 30 seconds. */
export const DEFAULT_FRESHNESS_MS = 30_000;

/**
 * Read the freshness threshold from `FRESHNESS_MS`.
 *
 * @param value - The variable's value, such as `process.env.FRESHNESS_MS`.
 * @returns The threshold in milliseconds, or the default when unset.
 * @throws RangeError if it is set but not a positive whole number.
 */
export function freshnessMs(value: string | undefined): number {
  if (value === undefined || value === "") return DEFAULT_FRESHNESS_MS;
  if (!/^\d+$/.test(value) || Number(value) === 0) {
    throw new RangeError(
      `FRESHNESS_MS must be a positive whole number: ${value}`,
    );
  }
  return Number(value);
}

/**
 * The verdict to report for a stream, given when it was last checked.
 *
 * A stored verdict only holds while the PDS keeps answering. If the last
 * successful check (`verifiedAsOf`) is older than `maxAgeMs`, or there never
 * was one, the result is `unknown` with reason `stale`, whatever the stored
 * verdict says: a `conflict` or `accept` from before the PDS went quiet may
 * no longer be true.
 *
 * @param stored - The verdict from the last audit.
 * @param verifiedAsOf - ISO 8601 time of the last successful check, or `null`.
 * @param now - The current time.
 * @param maxAgeMs - The threshold, from `freshnessMs`.
 * @returns The stored verdict, or `unknown`/`stale`.
 */
export function freshVerdict(
  stored: Verdict,
  verifiedAsOf: string | null,
  now: Date,
  maxAgeMs: number,
): Verdict {
  const checked = verifiedAsOf === null ? Number.NaN : Date.parse(verifiedAsOf);
  // A missing or unreadable time counts as stale, never as fresh.
  if (!(now.getTime() - checked <= maxAgeMs)) {
    return { verdict: "unknown", reason: "stale" };
  }
  return stored;
}

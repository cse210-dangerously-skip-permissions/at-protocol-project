import { createHash } from "node:crypto";
import type { Payload } from "@trustlab/contracts";

const NAMES = [
  "left-pad",
  "tiny-router",
  "fast-queue",
  "json-lens",
  "safe-merge",
  "date-kit",
  "retry-loop",
  "env-check",
] as const;

/** Events of one workload are this far apart, so `createdAt` keeps their order. */
const STEP_MS = 1000;
const DAY_MS = 86_400_000;
const EPOCH_MS = Date.UTC(2026, 0, 1);

/**
 * Throw unless a number is a safe integer no smaller than zero.
 *
 * @param name - Field name for the error message.
 * @param value - The number to check.
 */
function assertCount(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be an integer >= 0, got ${value}`);
  }
}

/**
 * Make a seeded random number generator (mulberry32). `Math.random` cannot
 * be seeded, and a workload has to be the same on every run.
 *
 * @param seed - Any integer. The same seed gives the same sequence.
 * @returns A function returning the next number in [0, 1).
 */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The checksum a synthetic release carries: the SHA-256 of `name@version`.
 * Anyone reading a demo can recompute it, so a tampered checksum stands out.
 *
 * @param name - Package name.
 * @param version - Package version.
 * @returns `sha256:` followed by 64 hex digits.
 */
export function releaseChecksum(name: string, version: string): string {
  const digest = createHash("sha256")
    .update(`${name}@${version}`)
    .digest("hex");
  return `sha256:${digest}`;
}

/**
 * Make a list of synthetic releases that reads like a real release feed:
 * each package starts at 1.0.0 and every later release of it bumps the
 * patch, minor, or major number, so no package and version repeats.
 *
 * Pure: the same seed and count always give the same list, and a longer
 * list starts with the shorter one.
 *
 * @param seed - Any integer.
 * @param count - How many payloads to make.
 * @returns The payloads, in publish order.
 */
export function makeWorkload(seed: number, count: number): Payload[] {
  if (!Number.isSafeInteger(seed)) {
    throw new RangeError(`seed must be an integer, got ${seed}`);
  }
  assertCount("count", count);

  const random = seededRandom(seed);
  const pick = (n: number) => Math.floor(random() * n);
  const latest = new Map<string, [number, number, number]>();
  const payloads: Payload[] = [];
  for (let i = 0; i < count; i += 1) {
    const name = NAMES[pick(NAMES.length)] as string;
    // Both numbers are drawn for every event, so the event at a position
    // never depends on how many packages have been released before it.
    const roll = pick(10);
    const previous = latest.get(name);
    let next: [number, number, number] = [1, 0, 0];
    if (previous !== undefined) {
      const [major, minor, patch] = previous;
      // Mostly patches, some minors, a rare major.
      if (roll === 0) next = [major + 1, 0, 0];
      else if (roll <= 3) next = [major, minor + 1, 0];
      else next = [major, minor, patch + 1];
    }
    latest.set(name, next);
    const version = next.join(".");
    payloads.push({ name, version, checksum: releaseChecksum(name, version) });
  }
  return payloads;
}

/**
 * The `createdAt` of the workload event at a seq. It comes from the seed and
 * the seq, never from the clock, so the event at a seq is the same however
 * the workload was split into runs, and time only moves forward on a stream.
 *
 * @param seed - The workload's seed.
 * @param seq - The event's seq in its stream, from 1.
 * @returns An ISO 8601 time.
 */
export function workloadCreatedAt(seed: number, seq: number): string {
  if (!Number.isSafeInteger(seq) || seq < 1) {
    throw new RangeError(`seq must be an integer >= 1, got ${seq}`);
  }
  const day = (seed >>> 0) % 365;
  return new Date(EPOCH_MS + day * DAY_MS + (seq - 1) * STEP_MS).toISOString();
}

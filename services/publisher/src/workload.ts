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
 * Make a list of synthetic releases. Pure: the same seed and count always
 * give the same list, and a longer list starts with the shorter one.
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
  const payloads: Payload[] = [];
  for (let i = 0; i < count; i += 1) {
    const name = NAMES[pick(NAMES.length)] as string;
    const version = `${pick(3)}.${pick(10)}.${pick(20)}`;
    let checksum = "sha256:";
    for (let word = 0; word < 8; word += 1) {
      checksum += pick(0x1_0000_0000).toString(16).padStart(8, "0");
    }
    payloads.push({ name, version, checksum });
  }
  return payloads;
}

/**
 * The `createdAt` of one workload event. It comes from the seed and the
 * event's position, never from the clock, so two runs of a workload write
 * byte-identical records.
 *
 * @param seed - The workload's seed.
 * @param index - Position of the event in the workload, from 0.
 * @returns An ISO 8601 time.
 */
export function workloadCreatedAt(seed: number, index: number): string {
  assertCount("index", index);
  const day = (seed >>> 0) % 365;
  return new Date(EPOCH_MS + day * DAY_MS + index * STEP_MS).toISOString();
}

import { readFileSync } from "node:fs";

const METRICS = ["lines", "statements", "functions", "branches"];

/**
 * Reads and parses a JSON file.
 * @param {string} path File to read.
 * @returns {any} The parsed contents.
 */
function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * Gets a metric's percentage from the coverage summary.
 * @param {{ pct: number | string }} metric Summary entry; pct is "Unknown" when there is nothing to measure.
 * @returns {number} The percentage, or 100 when there is nothing to measure.
 */
function percent(metric) {
  return typeof metric.pct === "number" ? metric.pct : 100;
}

const baseline = readJson("coverage-baseline.json");
const { total } = readJson("coverage/coverage-summary.json");
const current = Object.fromEntries(
  METRICS.map((metric) => [metric, percent(total[metric])]),
);

console.log(`Baseline: ${JSON.stringify(baseline)}`);
console.log(`Current:  ${JSON.stringify(current)}`);

// Written as !(a >= b) so a missing or malformed baseline number also fails.
const dropped = METRICS.filter(
  (metric) => !(current[metric] >= baseline[metric]),
);

if (dropped.length > 0) {
  console.error(`Coverage dropped below the baseline: ${dropped.join(", ")}`);
  process.exitCode = 1;
}

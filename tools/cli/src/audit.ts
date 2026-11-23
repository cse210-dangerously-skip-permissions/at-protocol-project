import type { Verdict } from "@trustlab/contracts";

/** One audited stream, as `trustlab audit` prints it. */
export interface StreamVerdict {
  did: string;
  stream: string;
  verdict: Verdict;
}

/**
 * Format audit results for a person to read: one block per stream with the
 * verdict, its reason, and the evidence (what the witness saw versus what the
 * repo has now). A missing value prints as `-`.
 *
 * The line format is stable: Playwright specs match on it, so change it only
 * together with them.
 *
 * @example
 * ```text
 * stream releases did=did:plc:abc
 *   verdict   conflict
 *   reason    witness-mismatch
 *   witnessed seq=3 cid=bafy...x
 *   current   seq=3 cid=bafy...y
 * ```
 *
 * @param results - The audited streams, in the order to print them.
 * @returns The text, ending in a newline.
 */
export function formatAudit(results: readonly StreamVerdict[]): string {
  if (results.length === 0) return "no streams audited\n";
  const blocks = results.map(({ did, stream, verdict }) => {
    const seq = verdict.evidence?.seq ?? "-";
    return [
      `stream ${stream} did=${did}`,
      `  verdict   ${verdict.verdict}`,
      `  reason    ${verdict.reason}`,
      `  witnessed seq=${seq} cid=${verdict.evidence?.witnessedCid ?? "-"}`,
      `  current   seq=${seq} cid=${verdict.evidence?.currentCid ?? "-"}`,
    ].join("\n");
  });
  return `${blocks.join("\n\n")}\n`;
}

import { expect, test } from "vitest";
import { formatAudit } from "./audit.js";

const DID = "did:plc:publisher";

test("a conflict shows the reason and both CIDs at the seq", () => {
  expect(
    formatAudit([
      {
        did: DID,
        stream: "releases",
        verdict: {
          verdict: "conflict",
          reason: "witness-mismatch",
          evidence: {
            seq: 3,
            witnessedCid: "bafy-old",
            currentCid: "bafy-new",
          },
        },
      },
    ]),
  ).toBe(
    [
      "stream releases did=did:plc:publisher",
      "  verdict   conflict",
      "  reason    witness-mismatch",
      "  witnessed seq=3 cid=bafy-old",
      "  current   seq=3 cid=bafy-new",
      "",
    ].join("\n"),
  );
});

test("missing evidence prints as -, and streams are separated by a blank line", () => {
  const text = formatAudit([
    {
      did: DID,
      stream: "releases",
      verdict: { verdict: "accept", reason: "ok" },
    },
    {
      did: DID,
      stream: "builds",
      verdict: {
        verdict: "unknown",
        reason: "no-witness",
        evidence: { seq: 5, currentCid: "bafy-now" },
      },
    },
  ]);

  expect(text.split("\n\n")).toEqual([
    [
      "stream releases did=did:plc:publisher",
      "  verdict   accept",
      "  reason    ok",
      "  witnessed seq=- cid=-",
      "  current   seq=- cid=-",
    ].join("\n"),
    [
      "stream builds did=did:plc:publisher",
      "  verdict   unknown",
      "  reason    no-witness",
      "  witnessed seq=- cid=-",
      "  current   seq=5 cid=bafy-now",
      "",
    ].join("\n"),
  ]);
});

test("a chain conflict with no CIDs still shows its seq on the current line", () => {
  expect(
    formatAudit([
      {
        did: DID,
        stream: "releases",
        verdict: {
          verdict: "conflict",
          reason: "broken-link",
          evidence: { seq: 4 },
        },
      },
    ]),
  ).toContain("  witnessed seq=- cid=-\n  current   seq=4 cid=-\n");
});

test("says so when there is nothing to show", () => {
  expect(formatAudit([])).toBe("no streams audited\n");
});

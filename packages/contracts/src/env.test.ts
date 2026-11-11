import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { findLocalEnv, loadLocalEnv, parseLocalEnv } from "./env.js";

const TEXT = `# Local AT network addresses and seed accounts.
PDS_URL=http://localhost:2583
PLC_URL=http://localhost:2582
PUBLISHER_DID=did:plc:pub
PUBLISHER_HANDLE=publisher.test
PUBLISHER_PASSWORD=pw=1
WITNESS_DID=did:plc:wit
WITNESS_HANDLE=witness.test
WITNESS_PASSWORD=pw2
EXTRA=ignored
`;

describe("parseLocalEnv", () => {
  test("reads every variable and drops the rest", () => {
    const env = parseLocalEnv(TEXT);
    expect(env.PDS_URL).toBe("http://localhost:2583");
    expect(env.PUBLISHER_DID).toBe("did:plc:pub");
    expect(env.PUBLISHER_PASSWORD).toBe("pw=1");
    expect(env.WITNESS_HANDLE).toBe("witness.test");
    expect(Object.keys(env)).toHaveLength(8);
  });

  test("names what is missing or empty", () => {
    const text = TEXT.replace(/^PLC_URL=.*$/m, "").replace(
      /^WITNESS_DID=.*$/m,
      "WITNESS_DID=",
    );
    expect(() => parseLocalEnv(text)).toThrow(
      ".env.local is missing PLC_URL, WITNESS_DID",
    );
  });
});

describe("loadLocalEnv", () => {
  test("finds the file in a directory above", () => {
    const root = mkdtempSync(join(tmpdir(), "env-"));
    const nested = join(root, "services", "consumer");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(root, ".env.local"), TEXT);
    expect(findLocalEnv(nested)).toBe(join(root, ".env.local"));
    expect(loadLocalEnv(join(root, ".env.local")).WITNESS_DID).toBe(
      "did:plc:wit",
    );
  });

  test("says how to create the file when it is missing", () => {
    const empty = mkdtempSync(join(tmpdir(), "env-"));
    expect(() => loadLocalEnv(join(empty, ".env.local"))).toThrow(
      "npm run stack:up",
    );
  });
});

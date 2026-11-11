import { createECDH } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createEnvFile, k256PrivateKeyHex, readEnvValue } from "./env.mjs";

let dir;
let envPath;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "stack-env-"));
  envPath = join(dir, ".env");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("k256PrivateKeyHex", () => {
  test("returns a valid secp256k1 private key as 64 hex characters", () => {
    const key = k256PrivateKeyHex();

    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(() =>
      createECDH("secp256k1").setPrivateKey(Buffer.from(key, "hex")),
    ).not.toThrow();
  });

  test("returns a different key each time", () => {
    expect(k256PrivateKeyHex()).not.toBe(k256PrivateKeyHex());
  });
});

describe("createEnvFile", () => {
  test("writes the three PDS secrets that compose.yaml needs", () => {
    expect(createEnvFile(envPath)).toBe(true);

    expect(readEnvValue(envPath, "PDS_JWT_SECRET")).toMatch(/^[0-9a-f]{64}$/);
    expect(readEnvValue(envPath, "PDS_ADMIN_PASSWORD")).toMatch(
      /^[0-9a-f]{32}$/,
    );
    expect(
      readEnvValue(envPath, "PDS_PLC_ROTATION_KEY_K256_PRIVATE_KEY_HEX"),
    ).toMatch(/^[0-9a-f]{64}$/);
  });

  test("never replaces an existing file", () => {
    writeFileSync(envPath, "PDS_ADMIN_PASSWORD=keep-me\n");

    expect(createEnvFile(envPath)).toBe(false);
    expect(readFileSync(envPath, "utf8")).toBe("PDS_ADMIN_PASSWORD=keep-me\n");
  });

  test.skipIf(process.platform === "win32")(
    "makes the file readable only by its owner",
    () => {
      createEnvFile(envPath);

      expect(statSync(envPath).mode & 0o777).toBe(0o600);
    },
  );
});

describe("readEnvValue", () => {
  test("reads a value, keeping any = inside it", () => {
    writeFileSync(envPath, "# comment\nA=1\nTOKEN=abc=def\n");

    expect(readEnvValue(envPath, "A")).toBe("1");
    expect(readEnvValue(envPath, "TOKEN")).toBe("abc=def");
  });

  test("reads files with Windows line endings", () => {
    writeFileSync(envPath, "A=1\r\nB=2\r\n");

    expect(readEnvValue(envPath, "B")).toBe("2");
  });

  test("does not match a variable whose name only starts the same way", () => {
    writeFileSync(envPath, "PDS_ADMIN_PASSWORD_OLD=old\n");

    expect(readEnvValue(envPath, "PDS_ADMIN_PASSWORD")).toBeUndefined();
  });

  test("returns undefined for a missing variable or a missing file", () => {
    writeFileSync(envPath, "A=1\n");

    expect(readEnvValue(envPath, "B")).toBeUndefined();
    expect(readEnvValue(join(dir, "nope"), "A")).toBeUndefined();
  });
});

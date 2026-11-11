import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { ensureAccount, formatEnv, parseEnv, seed } from "./seed.mjs";

/**
 * A stand-in for the PDS that remembers the accounts it created.
 *
 * @returns {import("./seed.mjs").PdsApi & { accounts: Map<string, { did: string, password: string }> }}
 */
function fakePds() {
  const accounts = new Map();
  return {
    accounts,
    createSession: vi.fn(async (identifier, password) => {
      const account = accounts.get(identifier);
      if (!account || account.password !== password) {
        throw new Error("HTTP 401 from createSession: AuthenticationRequired");
      }
      return { did: account.did };
    }),
    createAccount: vi.fn(async ({ handle, password }) => {
      if (accounts.has(handle)) {
        throw new Error("HTTP 400 from createAccount: Handle already taken");
      }
      const did = `did:plc:${handle.split(".")[0]}${accounts.size}`;
      accounts.set(handle, { did, password });
      return { did };
    }),
  };
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("parseEnv and formatEnv", () => {
  test("round trip, ignoring comments and blank lines", () => {
    const values = { PDS_URL: "http://localhost:2583", A_DID: "did:plc:abc" };
    expect(parseEnv(formatEnv(values))).toEqual(values);
  });

  test("keeps an equals sign inside a value", () => {
    expect(parseEnv("TOKEN=a=b\n")).toEqual({ TOKEN: "a=b" });
  });
});

describe("ensureAccount", () => {
  test("creates the account when there is no stored password", async () => {
    const pds = fakePds();
    const account = await ensureAccount({ handle: "publisher.test" }, pds);
    expect(account.created).toBe(true);
    expect(account.did).toBe(pds.accounts.get("publisher.test").did);
    expect(pds.createSession).not.toHaveBeenCalled();
  });

  test("reuses the account when the stored password still works", async () => {
    const pds = fakePds();
    const first = await ensureAccount({ handle: "publisher.test" }, pds);
    const second = await ensureAccount(
      { handle: "publisher.test", password: first.password },
      pds,
    );
    expect(second).toEqual({ ...first, created: false });
    expect(pds.createAccount).toHaveBeenCalledTimes(1);
  });

  test("creates the account again after a reset wiped it", async () => {
    const pds = fakePds();
    const first = await ensureAccount({ handle: "publisher.test" }, pds);
    pds.accounts.clear();
    const second = await ensureAccount(
      { handle: "publisher.test", password: first.password },
      pds,
    );
    expect(second.created).toBe(true);
  });

  test("explains what to do when the handle exists but the password is lost", async () => {
    const pds = fakePds();
    await ensureAccount({ handle: "publisher.test" }, pds);
    await expect(
      ensureAccount({ handle: "publisher.test" }, pds),
    ).rejects.toThrow("npm run stack:reset");
  });

  test("does not hide a connection failure", async () => {
    const down = {
      createSession: async () => {
        throw new Error("could not connect to http://localhost:2583");
      },
      createAccount: vi.fn(),
    };
    await expect(
      ensureAccount({ handle: "publisher.test", password: "x" }, down),
    ).rejects.toThrow("could not connect");
    expect(down.createAccount).not.toHaveBeenCalled();
  });
});

describe("seed", () => {
  test("writes both accounts, and a second run changes nothing", async () => {
    const pds = fakePds();
    const envPath = join(mkdtempSync(join(tmpdir(), "seed-")), ".env.local");

    expect(await seed({ envPath, api: pds })).toBe(0);
    const first = readFileSync(envPath, "utf8");
    expect(Object.keys(parseEnv(first))).toEqual([
      "PDS_URL",
      "PLC_URL",
      "PUBLISHER_DID",
      "PUBLISHER_HANDLE",
      "PUBLISHER_PASSWORD",
      "WITNESS_DID",
      "WITNESS_HANDLE",
      "WITNESS_PASSWORD",
    ]);

    expect(await seed({ envPath, api: pds })).toBe(0);
    expect(readFileSync(envPath, "utf8")).toBe(first);
    expect(pds.createAccount).toHaveBeenCalledTimes(2);
  });

  test("replaces stale accounts after a reset", async () => {
    const pds = fakePds();
    const envPath = join(mkdtempSync(join(tmpdir(), "seed-")), ".env.local");
    writeFileSync(
      envPath,
      "PUBLISHER_DID=did:plc:old\nPUBLISHER_PASSWORD=old\n",
    );
    expect(await seed({ envPath, api: pds })).toBe(0);
    const values = parseEnv(readFileSync(envPath, "utf8"));
    expect(values.PUBLISHER_DID).toBe(pds.accounts.get("publisher.test").did);
    expect(values.PUBLISHER_PASSWORD).not.toBe("old");
  });

  test("fails without writing the file when the PDS is down", async () => {
    const envPath = join(mkdtempSync(join(tmpdir(), "seed-")), ".env.local");
    const down = {
      createSession: vi.fn(),
      createAccount: async () => {
        throw new Error("could not connect to http://localhost:2583");
      },
    };
    expect(await seed({ envPath, api: down })).toBe(1);
    expect(() => readFileSync(envPath)).toThrow();
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { DEFAULT_DB, main, parseConsumeArgs } from "./main.js";
import { ConsumerStore } from "./store.js";

let dir: string | undefined;

afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true });
  dir = undefined;
  vi.restoreAllMocks();
});

test("uses the database on disk by default, or the one given", () => {
  expect(parseConsumeArgs([])?.db).toBe(DEFAULT_DB);
  expect(parseConsumeArgs(["--db", "other.db"])?.db).toBe("other.db");
});

test("--pds overrides the PDS URL, and is unset otherwise", () => {
  expect(parseConsumeArgs([])?.pds).toBeUndefined();
  expect(parseConsumeArgs(["--pds", "http://127.0.0.1:2584"])?.pds).toBe(
    "http://127.0.0.1:2584",
  );
});

test("--fresh starts empty and leaves the saved database alone", () => {
  dir = mkdtempSync(join(tmpdir(), "consume-"));
  const path = join(dir, "consumer.db");
  const saved = new ConsumerStore(path);
  saved.applyCommit({ cursor: 7, did: "did:plc:p", rev: "rev-a", events: [] });
  saved.close();

  const fresh = new ConsumerStore(parseConsumeArgs(["--fresh"])!.db);
  expect(fresh.getCheckpoint()).toEqual({ cursor: null, revs: {} });
  fresh.close();

  const reopened = new ConsumerStore(parseConsumeArgs(["--db", path])!.db);
  expect(reopened.getCheckpoint().cursor).toBe(7);
  reopened.close();
});

test("rejects --fresh with --db and unknown options", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  expect(() => parseConsumeArgs(["--fresh", "--db", "x.db"])).toThrow(
    RangeError,
  );
  expect(await main(["--fresh", "--db", "x.db"])).toBe(2);
  expect(await main(["--nope"])).toBe(2);
});

test("--help prints usage and exits 0", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  expect(await main(["--help"])).toBe(0);
  expect(log).toHaveBeenCalledWith(expect.stringContaining("--fresh"));
});

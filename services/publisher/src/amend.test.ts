import { XRPCError } from "@atproto/api";
import { ContractError, EVENT_NSID } from "@trustlab/contracts";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  amendEvent,
  amendMain,
  parseAmendArgs,
  readEvent,
  runAmend,
} from "./amend.js";
import { main, runPublish } from "./cli.js";
import type { PublisherSession } from "./publisher.js";
import { FakeRepo, fakeSession } from "./test-support.js";
import { makeWorkload, workloadCreatedAt } from "./workload.js";

const CREATED_AT = "2026-01-01T00:00:00.000Z";

let repo: FakeRepo;
let session: PublisherSession;
let lines: string[];
const log = (line: string) => lines.push(line);

/** Record key of an event on the `releases` stream. */
function rkey(seq: number): string {
  return `releases-${String(seq).padStart(12, "0")}`;
}

beforeEach(async () => {
  repo = new FakeRepo();
  session = fakeSession(repo);
  lines = [];
  await runPublish(
    { stream: "releases", count: 3, seed: 1 },
    { session, log: () => {} },
  );
});

describe("readEvent", () => {
  test("returns the event at a seq", async () => {
    expect(await readEvent(session, "releases", 2)).toEqual(
      repo.event(rkey(2)).value,
    );
  });

  test("returns null when the stream has no event there", async () => {
    expect(await readEvent(session, "releases", 4)).toBeNull();
    expect(await readEvent(session, "other", 1)).toBeNull();
  });

  test("rethrows errors other than a missing record", async () => {
    repo.getRecord = async () => {
      throw new XRPCError(500, "InternalServerError", "boom");
    };

    await expect(readEvent(session, "releases", 1)).rejects.toThrow("boom");
  });
});

describe("amendEvent", () => {
  test("a withdrawal is a new event that refers to the earlier one", async () => {
    const before = repo.event(rkey(2));

    const published = await amendEvent(session, {
      stream: "releases",
      kind: "withdraw",
      refSeq: 2,
      createdAt: CREATED_AT,
    });

    expect(published.seq).toBe(4);
    expect(repo.event(rkey(4)).value).toMatchObject({
      seq: 4,
      kind: "withdraw",
      refSeq: 2,
      prevEventCid: repo.event(rkey(3)).cid,
      payload: before.value.payload,
    });
    expect(repo.head("releases")).toMatchObject({
      seq: 4,
      eventCid: published.cid,
    });
  });

  test("never writes the event it refers to", async () => {
    const before = { ...repo.event(rkey(2)) };
    const callsBefore = repo.calls.length;

    await amendEvent(session, {
      stream: "releases",
      kind: "withdraw",
      refSeq: 2,
      createdAt: CREATED_AT,
    });

    expect(repo.event(rkey(2))).toEqual(before);
    expect(
      repo.calls.slice(callsBefore).filter((call) => call.includes(rkey(2))),
    ).toEqual([]);
  });

  test("a correction copies the payload and applies the changes", async () => {
    const original = repo.event(rkey(1)).value.payload;

    const published = await amendEvent(session, {
      stream: "releases",
      kind: "correct",
      refSeq: 1,
      changes: { checksum: "sha256:fixed" },
      createdAt: CREATED_AT,
    });

    expect(repo.event(published.rkey).value).toMatchObject({
      kind: "correct",
      refSeq: 1,
      payload: { ...original, checksum: "sha256:fixed" },
    });
    expect(repo.event(rkey(1)).value.payload).toEqual(original);
  });

  test("rejects a seq the stream does not have, writing nothing", async () => {
    const callsBefore = [...repo.calls];

    for (const refSeq of [4, 99]) {
      await expect(
        amendEvent(session, {
          stream: "releases",
          kind: "withdraw",
          refSeq,
          createdAt: CREATED_AT,
        }),
      ).rejects.toThrow(`releases has no event at seq ${refSeq} to withdraw`);
    }
    await expect(
      amendEvent(session, {
        stream: "empty",
        kind: "correct",
        refSeq: 1,
        createdAt: CREATED_AT,
      }),
    ).rejects.toThrow(RangeError);
    expect(repo.calls).toEqual(callsBefore);
  });

  test("rejects a seq that is not a positive whole number", async () => {
    for (const refSeq of [0, -1, 1.5]) {
      await expect(
        amendEvent(session, {
          stream: "releases",
          kind: "withdraw",
          refSeq,
          createdAt: CREATED_AT,
        }),
      ).rejects.toThrow(RangeError);
    }
  });

  test("rejects changes that break the payload contract", async () => {
    await expect(
      amendEvent(session, {
        stream: "releases",
        kind: "correct",
        refSeq: 1,
        changes: { checksum: 5 as never },
        createdAt: CREATED_AT,
      }),
    ).rejects.toThrow(ContractError);
    expect(repo.head("releases").seq).toBe(3);
  });
});

describe("parseAmendArgs", () => {
  test("reads a withdrawal", () => {
    expect(
      parseAmendArgs("withdraw", [
        "--stream",
        "a",
        "--seq",
        "2",
        "--seed",
        "1",
      ]),
    ).toEqual({ kind: "withdraw", stream: "a", seq: 2, seed: 1 });
  });

  test("reads a correction with its changes", () => {
    expect(
      parseAmendArgs("correct", [
        "--stream",
        "a",
        "--seq",
        "2",
        "--seed",
        "1",
        "--version",
        "2.0.1",
        "--checksum",
        "sha256:x",
      ]),
    ).toEqual({
      kind: "correct",
      stream: "a",
      seq: 2,
      seed: 1,
      changes: { version: "2.0.1", checksum: "sha256:x" },
    });
  });

  test("returns null for --help", () => {
    expect(parseAmendArgs("withdraw", ["--help"])).toBeNull();
  });

  test("rejects missing options and options that do not fit the command", () => {
    const base = ["--stream", "a", "--seq", "2", "--seed", "1"];
    expect(() => parseAmendArgs("withdraw", base.slice(2))).toThrow(
      /--stream is required/,
    );
    expect(() => parseAmendArgs("withdraw", base.slice(0, 2))).toThrow(
      /--seq needs a whole number/,
    );
    expect(() => parseAmendArgs("withdraw", base.slice(0, 4))).toThrow(
      /--seed needs a whole number/,
    );
    expect(() =>
      parseAmendArgs("withdraw", [...base, "--checksum", "x"]),
    ).toThrow(/withdraw takes no/);
    expect(() => parseAmendArgs("correct", base)).toThrow(
      /correct needs --version or --checksum/,
    );
  });
});

describe("runAmend", () => {
  test("prints the new event and takes its time from the seed and seq", async () => {
    const published = await runAmend(
      { kind: "withdraw", stream: "releases", seq: 2, seed: 1 },
      { session, log },
    );

    expect(lines).toEqual([
      `published releases seq=4 cid=${published.cid} kind=withdraw refSeq=2`,
    ]);
    const { value } = repo.event(rkey(4));
    expect(value.createdAt).toBe(workloadCreatedAt(1, 4));
    expect(value.payload).toEqual(makeWorkload(1, 2)[1]);
  });

  test("rejects a bad stream or seq before reading anything", async () => {
    let reads = 0;
    const realGet = repo.getRecord;
    repo.getRecord = async (params) => {
      reads += 1;
      return realGet(params);
    };

    await expect(
      runAmend(
        { kind: "withdraw", stream: "Bad-Stream", seq: 1, seed: 1 },
        { session, log },
      ),
    ).rejects.toThrow(RangeError);
    await expect(
      runAmend(
        { kind: "withdraw", stream: "releases", seq: 0, seed: 1 },
        { session, log },
      ),
    ).rejects.toThrow(RangeError);
    expect(reads).toBe(0);
  });
});

describe("the command line", () => {
  let errors: string[];

  beforeEach(() => {
    errors = [];
    vi.spyOn(console, "error").mockImplementation((line: string) => {
      errors.push(line);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("`withdraw` and `correct` run through the publisher's main", async () => {
    const options = { session, log };

    expect(
      await main(
        ["withdraw", "--stream", "releases", "--seq", "2", "--seed", "1"],
        options,
      ),
    ).toBe(0);
    expect(
      await main(
        [
          "correct",
          "--stream",
          "releases",
          "--seq",
          "1",
          "--seed",
          "1",
          "--checksum",
          "sha256:fixed",
        ],
        options,
      ),
    ).toBe(0);

    expect(lines).toHaveLength(2);
    expect(repo.event(rkey(4)).value).toMatchObject({
      kind: "withdraw",
      refSeq: 2,
    });
    expect(repo.event(rkey(5)).value).toMatchObject({
      kind: "correct",
      refSeq: 1,
    });
    expect(
      [...repo.records.keys()].filter((key) => key.startsWith(EVENT_NSID)),
    ).toHaveLength(5);
  });

  test("prints usage for --help and exits 0", async () => {
    expect(await amendMain("withdraw", ["--help"], { log })).toBe(0);
    expect(lines.join("\n")).toMatch(/^Usage: correct/);
  });

  test("exits 2 with usage for bad arguments", async () => {
    expect(await amendMain("correct", ["--stream", "a"], { log })).toBe(2);
    expect(errors.join("\n")).toMatch(/correct needs[\s\S]*Usage:/);
  });

  test("exits 2 for a seq the stream does not have", async () => {
    const code = await amendMain(
      "withdraw",
      ["--stream", "releases", "--seq", "9", "--seed", "1"],
      { session, log },
    );

    expect(code).toBe(2);
    expect(errors.join("\n")).toMatch(/no event at seq 9/);
  });

  test("exits 1 when publishing fails", async () => {
    repo.returnCommit = false;

    const code = await amendMain(
      "withdraw",
      ["--stream", "releases", "--seq", "2", "--seed", "1"],
      { session, log },
    );

    expect(code).toBe(1);
    expect(errors.join("\n")).toMatch(/no commit/);
  });
});

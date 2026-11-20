import { XRPCError } from "@atproto/api";
import { EVENT_NSID, HEAD_NSID, parseEventRecord } from "@trustlab/contracts";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { main, runPublish } from "./cli.js";
import type { PublisherSession } from "./publisher.js";
import {
  parseTamperArgs,
  runTamper,
  TamperConflictError,
  tamperEdit,
  tamperMain,
  tamperRewrite,
  tamperTruncate,
} from "./tamper.js";
import { FakeRepo, fakeSession } from "./test-support.js";

let repo: FakeRepo;
let session: PublisherSession;
let lines: string[];
const log = (line: string) => lines.push(line);

/** Record key of an event on the `releases` stream. */
function rkey(seq: number): string {
  return `releases-${String(seq).padStart(12, "0")}`;
}

/** Every stored event's CID, by seq. */
function cids(): (string | undefined)[] {
  return [1, 2, 3, 4, 5].map(
    (seq) => repo.records.get(`${EVENT_NSID}/${rkey(seq)}`)?.cid,
  );
}

/** Whether each event links to the stored event before it, and the head to the last. */
function chainIsValid(length: number): boolean {
  for (let seq = 1; seq <= length; seq += 1) {
    const { value } = repo.event(rkey(seq));
    parseEventRecord(value, rkey(seq));
    const expected = seq === 1 ? undefined : repo.event(rkey(seq - 1)).cid;
    if (value.prevEventCid !== expected) return false;
  }
  const head = repo.head("releases");
  return head.seq === length && head.eventCid === repo.event(rkey(length)).cid;
}

/**
 * Make another commit land the first time a tool reads a record, as a
 * publish racing the tool would.
 */
function raceOnePublish(): void {
  const realGet = repo.getRecord;
  let raced = false;
  repo.getRecord = async (params) => {
    if (!raced) {
      raced = true;
      await runPublish(
        { stream: "other", count: 1, seed: 1 },
        { session, log: () => {} },
      );
      repo.calls.length = 0;
    }
    return realGet(params);
  };
}

beforeEach(async () => {
  repo = new FakeRepo();
  session = fakeSession(repo);
  lines = [];
  await runPublish(
    { stream: "releases", count: 5, seed: 1 },
    { session, log: () => {} },
  );
  repo.calls.length = 0;
});

describe("tamperEdit", () => {
  test("changes one event in place and breaks the next link", async () => {
    const before = cids();
    const original = repo.event(rkey(2)).value;

    const result = await tamperEdit(session, "releases", 2);

    expect(repo.calls).toEqual([`update ${EVENT_NSID}/${rkey(2)}`]);
    const after = cids();
    expect(after[1]).not.toBe(before[1]);
    expect([after[0], ...after.slice(2)]).toEqual([
      before[0],
      ...before.slice(2),
    ]);
    const edited = repo.event(rkey(2)).value;
    expect(edited.payload).not.toEqual(original.payload);
    expect({ ...edited, payload: original.payload }).toEqual(original);
    expect(repo.event(rkey(3)).value.prevEventCid).toBe(before[1]);
    expect(chainIsValid(5)).toBe(false);
    expect(result).toEqual({
      events: [{ seq: 2, cid: after[1] }],
      commitCid: repo.commitCid,
      rev: expect.any(String),
    });
  });

  test("editing the last event leaves the head pointing at the old CID", async () => {
    const before = cids();

    await tamperEdit(session, "releases", 5);

    expect(repo.head("releases").eventCid).toBe(before[4]);
    expect(cids()[4]).not.toBe(before[4]);
  });

  test("the checksum keeps its length however often an event is edited", async () => {
    const seen = new Set<string>();
    for (let round = 0; round < 30; round += 1) {
      await tamperEdit(session, "releases", 2);
      seen.add(repo.event(rkey(2)).value.payload.checksum);
    }
    expect(seen.size).toBe(30);
    expect(new Set([...seen].map((checksum) => checksum.length)).size).toBe(1);
  });

  test("rejects a seq the stream does not have, writing nothing", async () => {
    await expect(tamperEdit(session, "releases", 6)).rejects.toThrow(
      /seq 6 is out of range: releases has 5 events/,
    );
    await expect(tamperEdit(session, "releases", 0)).rejects.toThrow(
      RangeError,
    );
    await expect(tamperEdit(session, "empty", 1)).rejects.toThrow(
      /empty has no events/,
    );
    expect(repo.calls).toEqual([]);
  });
});

describe("tamperRewrite", () => {
  test("replaces events from a seq onward in one commit and keeps the chain valid", async () => {
    const before = cids();
    const commitBefore = repo.commitCid;
    const commitsBefore = repo.commits;

    const result = await tamperRewrite(session, "releases", 3);

    const after = cids();
    expect(after.slice(0, 2)).toEqual(before.slice(0, 2));
    for (const index of [2, 3, 4]) {
      expect(after[index]).not.toBe(before[index]);
    }
    expect(chainIsValid(5)).toBe(true);
    // One applyWrites: the fake records a batch's writes together and makes
    // one commit per batch.
    expect(repo.calls).toEqual([
      `update ${EVENT_NSID}/${rkey(3)}`,
      `update ${EVENT_NSID}/${rkey(4)}`,
      `update ${EVENT_NSID}/${rkey(5)}`,
      `update ${HEAD_NSID}/head-releases`,
    ]);
    expect(repo.commits).toBe(commitsBefore + 1);
    expect(result.commitCid).toBe(repo.commitCid);
    expect(result.commitCid).not.toBe(commitBefore);
    expect(result.events).toEqual(
      [3, 4, 5].map((seq) => ({ seq, cid: after[seq - 1] })),
    );
    expect(result.head).toEqual({ seq: 5, eventCid: after[4] });
  });

  test("the first rewritten event keeps its link to the untouched one before it", async () => {
    const before = cids();

    await tamperRewrite(session, "releases", 3);

    expect(repo.event(rkey(3)).value.prevEventCid).toBe(before[1]);
  });

  test("rewrites a whole stream from seq 1", async () => {
    const before = cids();

    await tamperRewrite(session, "releases", 1);

    expect(repo.event(rkey(1)).value).not.toHaveProperty("prevEventCid");
    expect(cids().every((cid, index) => cid !== before[index])).toBe(true);
    expect(chainIsValid(5)).toBe(true);
  });

  test("rewriting only the last event moves the head to it", async () => {
    await tamperRewrite(session, "releases", 5);

    expect(chainIsValid(5)).toBe(true);
  });

  test("writes nothing if an event in the range is missing", async () => {
    repo.records.delete(`${EVENT_NSID}/${rkey(4)}`);

    await expect(tamperRewrite(session, "releases", 2)).rejects.toThrow(
      /releases has no event at seq 4/,
    );
    expect(repo.calls).toEqual([]);
  });

  test("writes nothing if a publish lands while it is reading", async () => {
    const before = cids();
    raceOnePublish();

    await expect(tamperRewrite(session, "releases", 3)).rejects.toThrow(
      TamperConflictError,
    );
    expect(repo.calls).toEqual([]);
    expect(cids()).toEqual(before);
    expect(chainIsValid(5)).toBe(true);
  });

  test("writes nothing if the PDS refuses the batch", async () => {
    const before = cids();
    repo.applyWrites = async () => {
      throw new XRPCError(500, "InternalServerError", "boom");
    };

    await expect(tamperRewrite(session, "releases", 3)).rejects.toThrow(/boom/);
    expect(cids()).toEqual(before);
  });

  test("rejects a seq past the head", async () => {
    await expect(tamperRewrite(session, "releases", 6)).rejects.toThrow(
      RangeError,
    );
    expect(repo.calls).toEqual([]);
  });

  test("rejects a range too long for one commit", async () => {
    await runPublish(
      { stream: "long", count: 201, seed: 1 },
      { session, log: () => {} },
    );
    repo.calls.length = 0;

    await expect(tamperRewrite(session, "long", 2)).rejects.toThrow(
      /needs 201 writes, and one commit takes at most 200/,
    );
    expect(repo.calls).toEqual([]);
  });
});

describe("tamperTruncate", () => {
  test("deletes later events and moves the head back in one commit", async () => {
    const before = cids();
    const commitsBefore = repo.commits;

    const result = await tamperTruncate(session, "releases", 3);

    expect(cids()).toEqual([...before.slice(0, 3), undefined, undefined]);
    expect(chainIsValid(3)).toBe(true);
    expect(repo.calls).toEqual([
      `delete ${EVENT_NSID}/${rkey(4)}`,
      `delete ${EVENT_NSID}/${rkey(5)}`,
      `update ${HEAD_NSID}/head-releases`,
    ]);
    expect(repo.commits).toBe(commitsBefore + 1);
    expect(result).toEqual({
      events: [],
      head: { seq: 3, eventCid: before[2] },
      commitCid: repo.commitCid,
      rev: expect.any(String),
    });
  });

  test("rejects a seq that is not below the head, saying so", async () => {
    await expect(tamperTruncate(session, "releases", 5)).rejects.toThrow(
      /truncate needs a seq below the head \(5\), got 5/,
    );
    for (const to of [6, 0]) {
      await expect(tamperTruncate(session, "releases", to)).rejects.toThrow(
        RangeError,
      );
    }
    expect(repo.calls).toEqual([]);
  });

  test("rejects a kept event that is missing or malformed, writing nothing", async () => {
    const key = `${EVENT_NSID}/${rkey(3)}`;
    const stored = repo.records.get(key);
    repo.records.set(key, { cid: "x", value: { nope: true } });
    await expect(tamperTruncate(session, "releases", 3)).rejects.toThrow(
      /invalid event record/,
    );

    repo.records.delete(key);
    await expect(tamperTruncate(session, "releases", 3)).rejects.toThrow(
      RangeError,
    );
    expect(repo.calls).toEqual([]);
    expect(stored).toBeDefined();
  });

  test("writes nothing if a publish lands while it is reading", async () => {
    const before = cids();
    raceOnePublish();

    await expect(tamperTruncate(session, "releases", 3)).rejects.toThrow(
      /the repo changed while tampering with releases; nothing was written/,
    );
    expect(cids()).toEqual(before);
    expect(repo.head("releases").seq).toBe(5);
  });
});

describe("parseTamperArgs", () => {
  test("reads each tool with its own option", () => {
    expect(parseTamperArgs(["edit", "--stream", "a", "--seq", "2"])).toEqual({
      tool: "edit",
      stream: "a",
      seq: 2,
    });
    expect(
      parseTamperArgs(["rewrite", "--stream", "a", "--from", "3"]),
    ).toEqual({ tool: "rewrite", stream: "a", from: 3 });
    expect(parseTamperArgs(["truncate", "--stream", "a", "--to", "1"])).toEqual(
      { tool: "truncate", stream: "a", to: 1 },
    );
  });

  test("returns null for --help", () => {
    expect(parseTamperArgs(["--help"])).toBeNull();
  });

  test("rejects an unknown tool, extra words, and missing options", () => {
    expect(() => parseTamperArgs(["--stream", "a"])).toThrow(/one of: edit/);
    expect(() => parseTamperArgs(["erase", "--stream", "a"])).toThrow(
      /one of: edit/,
    );
    expect(() => parseTamperArgs(["edit", "more", "--stream", "a"])).toThrow(
      /unexpected argument "more"/,
    );
    expect(() => parseTamperArgs(["edit", "--seq", "2"])).toThrow(
      /--stream is required/,
    );
    expect(() => parseTamperArgs(["edit", "--stream", "a"])).toThrow(
      /--seq needs a whole number/,
    );
    expect(() => parseTamperArgs(["rewrite", "--stream", "a"])).toThrow(
      /--from needs a whole number/,
    );
    expect(() => parseTamperArgs(["truncate", "--stream", "a"])).toThrow(
      /--to needs a whole number/,
    );
  });

  test("rejects an option that belongs to another tool", () => {
    expect(() =>
      parseTamperArgs([
        "truncate",
        "--stream",
        "a",
        "--to",
        "3",
        "--from",
        "1",
      ]),
    ).toThrow(/truncate takes --to, not --from/);
    expect(() =>
      parseTamperArgs(["edit", "--stream", "a", "--seq", "2", "--to", "1"]),
    ).toThrow(/edit takes --seq, not --to/);
    expect(() =>
      parseTamperArgs([
        "rewrite",
        "--stream",
        "a",
        "--from",
        "2",
        "--seq",
        "1",
      ]),
    ).toThrow(/rewrite takes --from, not --seq/);
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

  test("`tamper` runs each tool through the publisher's main", async () => {
    const options = { session, log };

    expect(
      await main(
        ["tamper", "edit", "--stream", "releases", "--seq", "2"],
        options,
      ),
    ).toBe(0);
    expect(
      await main(
        ["tamper", "rewrite", "--stream", "releases", "--from", "4"],
        options,
      ),
    ).toBe(0);
    expect(
      await main(
        ["tamper", "truncate", "--stream", "releases", "--to", "4"],
        options,
      ),
    ).toBe(0);

    expect(repo.head("releases").seq).toBe(4);
    expect(lines).toEqual([
      expect.stringMatching(/^tampered releases edit seq=2 cid=b\w+$/),
      expect.stringMatching(/^tampered releases rewrite seq=4 cid=b\w+$/),
      expect.stringMatching(/^tampered releases rewrite seq=5 cid=b\w+$/),
      `tampered releases truncate to=4 cid=${repo.event(rkey(4)).cid}`,
    ]);
  });

  test("rejects a bad stream name or seq before logging in", async () => {
    await expect(
      runTamper({ tool: "edit", stream: "Bad-Stream", seq: 1 }, { log }),
    ).rejects.toThrow(/bad stream name/);
    // No session is passed, so reaching login would fail another way.
    expect(
      await tamperMain(["edit", "--stream", "releases", "--seq", "0"]),
    ).toBe(2);
    expect(errors.join("\n")).toMatch(/seq must be an integer/);
  });

  test("runTamper returns what the tool wrote", async () => {
    const result = await runTamper(
      { tool: "rewrite", stream: "releases", from: 4 },
      { session, log },
    );
    expect(result.events.map((event) => event.seq)).toEqual([4, 5]);
    expect(result.head).toEqual({ seq: 5, eventCid: repo.event(rkey(5)).cid });
  });

  test("prints usage for --help and exits 0", async () => {
    expect(await tamperMain(["--help"], { log })).toBe(0);
    expect(lines.join("\n")).toMatch(/^Usage: tamper edit/);
  });

  test("exits 2 with usage for bad arguments", async () => {
    expect(await tamperMain(["erase"], { log })).toBe(2);
    expect(errors.join("\n")).toMatch(/one of: edit[\s\S]*Usage:/);
  });

  test("exits 2 for a seq out of range and 1 when the PDS fails", async () => {
    const options = { session, log };
    expect(
      await tamperMain(["edit", "--stream", "releases", "--seq", "9"], options),
    ).toBe(2);

    repo.applyWrites = async () => {
      throw new XRPCError(500, "InternalServerError", "boom");
    };
    expect(
      await tamperMain(["edit", "--stream", "releases", "--seq", "2"], options),
    ).toBe(1);
    expect(errors.join("\n")).toMatch(/out of range[\s\S]*boom/);
  });
});

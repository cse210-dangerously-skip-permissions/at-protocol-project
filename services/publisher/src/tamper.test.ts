import { XRPCError } from "@atproto/api";
import { EVENT_NSID, HEAD_NSID, parseEventRecord } from "@trustlab/contracts";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { main, runPublish } from "./cli.js";
import type { PublisherSession } from "./publisher.js";
import {
  parseTamperArgs,
  runTamper,
  tamperEdit,
  tamperMain,
  tamperRewrite,
  tamperTruncate,
} from "./tamper.js";
import { cidOf, FakeRepo, fakeSession } from "./test-support.js";

interface RecordParams {
  repo: string;
  collection: string;
  rkey: string;
}

/**
 * The fake repo plus the direct writes only the tamper tools make.
 *
 * @returns A fake repo with `putRecord`, `deleteRecord`, and a log of both.
 */
function tamperRepo() {
  const base = new FakeRepo();
  const direct: string[] = [];
  return Object.assign(base, {
    direct,
    putRecord: async (
      params: RecordParams & { record: Record<string, unknown> },
    ) => {
      direct.push(`put ${params.collection}/${params.rkey}`);
      const cid = cidOf(JSON.stringify(params.record));
      base.records.set(`${params.collection}/${params.rkey}`, {
        cid,
        value: params.record,
      });
      return { data: { uri: "at://x", cid } };
    },
    deleteRecord: async (params: RecordParams) => {
      direct.push(`delete ${params.collection}/${params.rkey}`);
      base.records.delete(`${params.collection}/${params.rkey}`);
      return { data: {} };
    },
  });
}

let repo: ReturnType<typeof tamperRepo>;
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

beforeEach(async () => {
  repo = tamperRepo();
  session = fakeSession(repo);
  lines = [];
  await runPublish(
    { stream: "releases", count: 5, seed: 1 },
    { session, log: () => {} },
  );
  repo.direct.length = 0;
});

describe("tamperEdit", () => {
  test("changes one event in place and breaks the next link", async () => {
    const before = cids();
    const original = repo.event(rkey(2)).value;

    await tamperEdit(session, "releases", 2);

    expect(repo.direct).toEqual([`put ${EVENT_NSID}/${rkey(2)}`]);
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
  });

  test("editing the last event leaves the head pointing at the old CID", async () => {
    const before = cids();

    await tamperEdit(session, "releases", 5);

    expect(repo.head("releases").eventCid).toBe(before[4]);
    expect(cids()[4]).not.toBe(before[4]);
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
    expect(repo.direct).toEqual([]);
  });
});

describe("tamperRewrite", () => {
  test("replaces events from a seq onward and keeps the chain valid", async () => {
    const before = cids();

    await tamperRewrite(session, "releases", 3);

    const after = cids();
    expect(after.slice(0, 2)).toEqual(before.slice(0, 2));
    for (const index of [2, 3, 4]) {
      expect(after[index]).not.toBe(before[index]);
    }
    expect(chainIsValid(5)).toBe(true);
    expect(repo.direct).toEqual([
      `put ${EVENT_NSID}/${rkey(3)}`,
      `put ${EVENT_NSID}/${rkey(4)}`,
      `put ${EVENT_NSID}/${rkey(5)}`,
      `put ${HEAD_NSID}/head-releases`,
    ]);
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
    expect(repo.direct).toEqual([]);
  });

  test("rejects a seq past the head", async () => {
    await expect(tamperRewrite(session, "releases", 6)).rejects.toThrow(
      RangeError,
    );
    expect(repo.direct).toEqual([]);
  });
});

describe("tamperTruncate", () => {
  test("deletes later events and moves the head back", async () => {
    const before = cids();

    await tamperTruncate(session, "releases", 3);

    expect(cids()).toEqual([...before.slice(0, 3), undefined, undefined]);
    expect(chainIsValid(3)).toBe(true);
    expect(repo.direct).toEqual([
      `delete ${EVENT_NSID}/${rkey(4)}`,
      `delete ${EVENT_NSID}/${rkey(5)}`,
      `put ${HEAD_NSID}/head-releases`,
    ]);
  });

  test("rejects a seq that is not below the head", async () => {
    for (const to of [5, 6, 0]) {
      await expect(tamperTruncate(session, "releases", to)).rejects.toThrow(
        RangeError,
      );
    }
    expect(repo.direct).toEqual([]);
  });

  test("fails without deleting if the kept event has no CID", async () => {
    const realGet = repo.getRecord;
    repo.getRecord = async (params) => {
      const response = await realGet(params);
      if (params.collection !== EVENT_NSID) return response;
      return { data: { ...response.data, cid: undefined as never } };
    };

    await expect(tamperTruncate(session, "releases", 3)).rejects.toThrow(
      /no CID/,
    );
    expect(repo.direct).toEqual([]);
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
    expect(() =>
      parseTamperArgs(["rewrite", "--stream", "a", "--seq", "2"]),
    ).toThrow(/--from needs a whole number/);
    expect(() => parseTamperArgs(["truncate", "--stream", "a"])).toThrow(
      /--to needs a whole number/,
    );
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

    expect(lines).toEqual([
      "tampered releases edit seq=2",
      "tampered releases rewrite from=4",
      "tampered releases truncate to=4",
    ]);
    expect(repo.head("releases").seq).toBe(4);
  });

  test("rejects a bad stream name before logging in", async () => {
    await expect(
      runTamper({ tool: "edit", stream: "Bad-Stream", seq: 1 }, { log }),
    ).rejects.toThrow(/bad stream name/);
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

    repo.putRecord = async () => {
      throw new XRPCError(500, "InternalServerError", "boom");
    };
    expect(
      await tamperMain(["edit", "--stream", "releases", "--seq", "2"], options),
    ).toBe(1);
    expect(errors.join("\n")).toMatch(/out of range[\s\S]*boom/);
  });
});

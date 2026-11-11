import { describe, expect, test } from "vitest";
import {
  eventRkey,
  headRkey,
  isSeq,
  isStreamName,
  MAX_SEQ,
  parseEventRkey,
  parseHeadRkey,
} from "./keys.js";

describe("stream names", () => {
  test.each(["releases", "a", "v2builds", "a".repeat(32)])(
    "accepts %s",
    (stream) => {
      expect(isStreamName(stream)).toBe(true);
    },
  );

  test.each(["", "Releases", "2fast", "my-stream", "a".repeat(33), "a b"])(
    "rejects %j",
    (stream) => {
      expect(isStreamName(stream)).toBe(false);
    },
  );
});

describe("isSeq", () => {
  test.each([
    [1, true],
    [MAX_SEQ, true],
    [0, false],
    [-1, false],
    [1.5, false],
    [MAX_SEQ + 1, false],
    [Number.NaN, false],
  ])("%d valid: %s", (seq, valid) => {
    expect(isSeq(seq)).toBe(valid);
  });
});

describe("event record keys", () => {
  test("pads the seq to twelve digits", () => {
    expect(eventRkey("releases", 42)).toBe("releases-000000000042");
    expect(eventRkey("releases", MAX_SEQ)).toBe("releases-999999999999");
  });

  test("sort in seq order as strings", () => {
    const keys = [10, 9, 100, 1].map((seq) => eventRkey("releases", seq));
    expect(keys.sort()).toEqual(
      [1, 9, 10, 100].map((seq) => eventRkey("releases", seq)),
    );
  });

  test("round trip through parseEventRkey", () => {
    expect(parseEventRkey(eventRkey("v2builds", 7))).toEqual({
      stream: "v2builds",
      seq: 7,
    });
  });

  test("reject a bad stream or seq", () => {
    expect(() => eventRkey("my-stream", 1)).toThrow(RangeError);
    expect(() => eventRkey("releases", 0)).toThrow(RangeError);
    expect(() => eventRkey("releases", MAX_SEQ + 1)).toThrow(RangeError);
  });

  test.each([
    "releases-42",
    "releases-000000000000",
    "head-releases",
    "releases",
    "Releases-000000000001",
    "releases-000000000001-x",
  ])("parseEventRkey returns null for %s", (rkey) => {
    expect(parseEventRkey(rkey)).toBeNull();
  });
});

describe("head record keys", () => {
  test("round trip through parseHeadRkey", () => {
    expect(headRkey("releases")).toBe("head-releases");
    expect(parseHeadRkey("head-releases")).toBe("releases");
  });

  test("reject a bad stream", () => {
    expect(() => headRkey("")).toThrow(RangeError);
  });

  test.each(["releases-000000000001", "head-", "head-My"])(
    "parseHeadRkey returns null for %s",
    (rkey) => {
      expect(parseHeadRkey(rkey)).toBeNull();
    },
  );
});

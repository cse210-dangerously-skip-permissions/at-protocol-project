import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { main, parsePublishArgs, runPublish } from "./cli.js";
import { FakeRepo, fakeSession } from "./test-support.js";
import { makeWorkload } from "./workload.js";

let repo: FakeRepo;
let lines: string[];
const log = (line: string) => lines.push(line);

beforeEach(() => {
  repo = new FakeRepo();
  lines = [];
});

describe("runPublish", () => {
  test("publishes the seeded workload in order and prints each seq and CID", async () => {
    const published = await runPublish(
      { stream: "releases", count: 5, seed: 1 },
      { session: fakeSession(repo), log },
    );

    expect(published.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(lines).toEqual(
      published.map(
        (event) => `published releases seq=${event.seq} cid=${event.cid}`,
      ),
    );
    const payloads = makeWorkload(1, 5);
    published.forEach((event, index) => {
      const { value } = repo.event(event.rkey);
      expect(value.kind).toBe("release");
      expect(value.payload).toEqual(payloads[index]);
    });
    expect(repo.head("releases").seq).toBe(5);
  });

  test("the same seed on a fresh stream writes identical events", async () => {
    const other = new FakeRepo();
    const args = { stream: "releases", count: 6, seed: 99 };

    const first = await runPublish(args, { session: fakeSession(repo), log });
    const second = await runPublish(args, { session: fakeSession(other), log });

    expect(second.map((event) => event.cid)).toEqual(
      first.map((event) => event.cid),
    );
    for (const event of first) {
      expect(other.event(event.rkey).value).toEqual(
        repo.event(event.rkey).value,
      );
    }
  });

  test("a different seed writes different events", async () => {
    const other = new FakeRepo();

    const first = await runPublish(
      { stream: "releases", count: 3, seed: 1 },
      { session: fakeSession(repo), log },
    );
    const second = await runPublish(
      { stream: "releases", count: 3, seed: 2 },
      { session: fakeSession(other), log },
    );

    expect(second[0]?.cid).not.toBe(first[0]?.cid);
  });

  test("continues after the head on a stream that has events", async () => {
    const session = fakeSession(repo);
    await runPublish(
      { stream: "releases", count: 2, seed: 1 },
      { session, log },
    );

    const more = await runPublish(
      { stream: "releases", count: 2, seed: 1 },
      { session, log },
    );

    expect(more.map((event) => event.seq)).toEqual([3, 4]);
  });

  test("rejects a bad stream or count before writing", async () => {
    const options = { session: fakeSession(repo), log };

    await expect(
      runPublish({ stream: "Bad-Stream", count: 1, seed: 1 }, options),
    ).rejects.toThrow(RangeError);
    await expect(
      runPublish({ stream: "releases", count: -1, seed: 1 }, options),
    ).rejects.toThrow(RangeError);
    expect(repo.calls).toEqual([]);
  });
});

describe("parsePublishArgs", () => {
  test("reads stream, count, and seed", () => {
    expect(
      parsePublishArgs(["--stream", "releases", "--count", "5", "--seed", "1"]),
    ).toEqual({ stream: "releases", count: 5, seed: 1 });
  });

  test("returns null for --help", () => {
    expect(parsePublishArgs(["--help"])).toBeNull();
  });

  test("rejects missing, non-numeric, and unknown options", () => {
    expect(() => parsePublishArgs(["--count", "5", "--seed", "1"])).toThrow(
      /--stream is required/,
    );
    expect(() => parsePublishArgs(["--stream", "a", "--seed", "1"])).toThrow(
      /--count needs a whole number/,
    );
    expect(() =>
      parsePublishArgs(["--stream", "a", "--count", "x", "--seed", "1"]),
    ).toThrow(/--count needs a whole number/);
    expect(() =>
      parsePublishArgs(["--stream", "a", "--count", "1", "--seed", "1.5"]),
    ).toThrow(/--seed needs a whole number/);
    expect(() => parsePublishArgs(["--nope"])).toThrow();
  });
});

describe("main", () => {
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

  test("publishes and exits 0", async () => {
    const code = await main(
      ["--stream", "releases", "--count", "2", "--seed", "1"],
      { session: fakeSession(repo), log },
    );

    expect(code).toBe(0);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^published releases seq=1 cid=b[a-z2-7]+$/);
  });

  test("prints usage for --help and exits 0", async () => {
    expect(await main(["--help"], { log })).toBe(0);
    expect(lines.join("\n")).toMatch(/^Usage: publish --stream/);
  });

  test("exits 2 with usage for bad arguments", async () => {
    expect(await main(["--count", "2"], { log })).toBe(2);
    expect(errors.join("\n")).toMatch(/--stream is required[\s\S]*Usage:/);
  });

  test("exits 2 for a bad stream name", async () => {
    const code = await main(
      ["--stream", "Bad-Stream", "--count", "1", "--seed", "1"],
      { session: fakeSession(repo), log },
    );

    expect(code).toBe(2);
    expect(errors.join("\n")).toMatch(/bad stream name/);
  });

  test("exits 1 when publishing fails", async () => {
    repo.returnCommit = false;

    const code = await main(
      ["--stream", "releases", "--count", "1", "--seed", "1"],
      { session: fakeSession(repo), log },
    );

    expect(code).toBe(1);
    expect(errors.join("\n")).toMatch(/no commit/);
  });
});

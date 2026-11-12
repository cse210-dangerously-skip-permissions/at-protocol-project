import { XRPCError } from "@atproto/api";
import { ContractError, EVENT_NSID, HEAD_NSID } from "@trustlab/contracts";
import { beforeEach, describe, expect, test } from "vitest";
import { publishEvent, type PublisherSession, readHead } from "./publisher.js";
import { cidOf, FakeRepo, fakeSession } from "./test-support.js";

const DID = "did:plc:publisher";
const PAYLOAD = { name: "pkg", version: "1.0.0", checksum: "sha256:abc" };
const CREATED_AT = "2026-01-01T00:00:00.000Z";

let repo: FakeRepo;
let session: PublisherSession;

beforeEach(() => {
  repo = new FakeRepo();
  session = fakeSession(repo, DID);
});

/** Publish one release on a stream. */
function release(stream = "releases") {
  return publishEvent(session, {
    stream,
    kind: "release",
    payload: PAYLOAD,
    createdAt: CREATED_AT,
  });
}

describe("readHead", () => {
  test("returns null for a stream with no events", async () => {
    expect(await readHead(session, "releases")).toBeNull();
  });

  test("returns the head after a publish", async () => {
    const published = await release();

    expect(await readHead(session, "releases")).toEqual({
      $type: HEAD_NSID,
      stream: "releases",
      seq: 1,
      eventCid: published.cid,
    });
  });

  test("rethrows errors other than a missing record", async () => {
    repo.getRecord = async () => {
      throw new XRPCError(500, "InternalServerError", "boom");
    };

    await expect(readHead(session, "releases")).rejects.toThrow("boom");
  });

  test("rejects a stored head that breaks the contract", async () => {
    repo.records.set(`${HEAD_NSID}/head-releases`, {
      cid: cidOf("bad"),
      value: {
        $type: HEAD_NSID,
        stream: "other",
        seq: 1,
        eventCid: cidOf("e"),
      },
    });

    await expect(readHead(session, "releases")).rejects.toThrow(ContractError);
  });
});

describe("publishEvent", () => {
  test("starts a stream at seq 1 with no link", async () => {
    const published = await release();

    expect(published).toEqual({
      seq: 1,
      rkey: "releases-000000000001",
      cid: repo.event("releases-000000000001").cid,
      commitCid: cidOf("commit-1"),
      rev: "rev-1",
    });
    const { value } = repo.event(published.rkey);
    expect(value).toMatchObject({
      $type: EVENT_NSID,
      stream: "releases",
      seq: 1,
      kind: "release",
      payload: PAYLOAD,
    });
    expect(value).not.toHaveProperty("prevEventCid");
    expect(value.createdAt).toBe(CREATED_AT);
  });

  test("asks a createdAt function for the time, passing the seq", async () => {
    const createdAt = (seq: number) => `2026-01-01T00:00:0${seq}.000Z`;
    const input = { stream: "releases", kind: "release", payload: PAYLOAD };

    await publishEvent(session, { ...input, kind: "release", createdAt });
    const second = await publishEvent(session, {
      ...input,
      kind: "release",
      createdAt,
    });

    expect(repo.event(second.rkey).value.createdAt).toBe(
      "2026-01-01T00:00:02.000Z",
    );
  });

  test("rejects a createdAt that is not a datetime", async () => {
    await expect(
      publishEvent(session, {
        stream: "releases",
        kind: "release",
        payload: PAYLOAD,
        createdAt: "yesterday",
      }),
    ).rejects.toThrow(ContractError);
    expect(repo.calls).toEqual([]);
  });

  test("writes the event first, then the head", async () => {
    await release();

    expect(repo.calls).toEqual([
      `create ${EVENT_NSID}/releases-000000000001`,
      `put ${HEAD_NSID}/head-releases`,
    ]);
  });

  test("ten publishes give seq 1 to 10, valid links, and a head at 10", async () => {
    const published = [];
    for (let i = 0; i < 10; i += 1) published.push(await release());

    expect(published.map((p) => p.seq)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
    for (let i = 1; i < 10; i += 1) {
      const { value } = repo.event(published[i]!.rkey);
      expect(value.prevEventCid).toBe(published[i - 1]!.cid);
    }
    expect(repo.head("releases")).toMatchObject({
      seq: 10,
      eventCid: published[9]!.cid,
    });
  });

  test("keeps streams separate", async () => {
    await release("alpha");
    await release("alpha");
    const first = await release("beta");

    expect(first.seq).toBe(1);
    expect(repo.head("alpha").seq).toBe(2);
    expect(repo.head("beta").seq).toBe(1);
  });

  test("publishes a correction that refers to an earlier seq", async () => {
    await release();
    const correction = await publishEvent(session, {
      stream: "releases",
      kind: "correct",
      payload: PAYLOAD,
      refSeq: 1,
      createdAt: CREATED_AT,
    });

    expect(repo.event(correction.rkey).value).toMatchObject({
      seq: 2,
      kind: "correct",
      refSeq: 1,
    });
  });

  test("writes nothing when the event would break the contract", async () => {
    await release();
    const before = [...repo.calls];

    await expect(
      publishEvent(session, {
        stream: "releases",
        kind: "withdraw",
        payload: PAYLOAD,
        createdAt: CREATED_AT,
      }),
    ).rejects.toThrow(ContractError);
    await expect(
      publishEvent(session, {
        stream: "releases",
        kind: "release",
        payload: { name: "pkg" } as never,
        createdAt: CREATED_AT,
      }),
    ).rejects.toThrow(ContractError);
    expect(repo.calls).toEqual(before);
  });

  test("writes nothing for a bad stream name", async () => {
    await expect(release("Bad-Stream")).rejects.toThrow(RangeError);
    expect(repo.calls).toEqual([]);
  });

  test("fails if the PDS returns no commit", async () => {
    repo.returnCommit = false;

    await expect(release()).rejects.toThrow(/no commit/);
  });
});

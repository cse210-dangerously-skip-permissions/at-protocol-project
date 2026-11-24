import { Secp256k1Keypair } from "@atproto/crypto";
import { parseEventRecord } from "@trustlab/contracts";
import {
  makeWorkload,
  recordCid,
  workloadCreatedAt,
} from "@trustlab/publisher";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  type BaselineClient,
  baselineClient,
  BaselineRequestError,
  publishWorkload,
} from "./client.js";
import { parseSignedHead, signHead, verifyHead } from "./head.js";
import { type RunningBaseline, startBaselineServer } from "./server.js";

const TOKEN = "publisher-token-for-tests";
const STREAM = "releases";

let server: RunningBaseline;
let publisher: BaselineClient;
let reader: BaselineClient;

beforeEach(async () => {
  server = await startBaselineServer({ publisherToken: TOKEN });
  publisher = baselineClient(server.url, TOKEN);
  reader = baselineClient(server.url);
});

afterEach(async () => {
  await server.close();
});

/** Publish the first `count` events of seed 1. */
function publish(count: number) {
  return publishWorkload(publisher, { stream: STREAM, count, seed: 1 });
}

/** The CID of every stored event, lowest seq first. */
async function cids(): Promise<string[]> {
  return (await reader.events(STREAM)).map((event) => event.cid);
}

/** Whether each event links to the one before it and the signed head names the last. */
async function chainIsValid(): Promise<boolean> {
  const events = await reader.events(STREAM);
  const linked = events.every(
    (event, index) => event.record.prevEventCid === events[index - 1]?.cid,
  );
  const signed = await reader.head(STREAM);
  const last = events[events.length - 1];
  return (
    linked &&
    signed.head.seq === last?.seq &&
    signed.head.eventCid === last.cid &&
    (await verifyHead(server.publicKey, signed))
  );
}

/** The status a rejected call was answered with. */
async function statusOf(call: Promise<unknown>): Promise<number> {
  const error = await call.then(
    () => null,
    (reason: unknown) => reason,
  );
  if (!(error instanceof BaselineRequestError)) {
    throw new Error("expected the server to refuse");
  }
  return error.status;
}

describe("appending", () => {
  test("stores the same records, links, and CIDs as the AT publisher", async () => {
    const published = await publish(3);

    const events = await reader.events(STREAM);
    expect(events.map(({ seq, cid }) => ({ seq, cid }))).toEqual(published);
    const payloads = makeWorkload(1, 3);
    for (const [index, event] of events.entries()) {
      const seq = index + 1;
      // Exactly the record `publishEvent` writes for this seed and seq.
      expect(event.record).toEqual({
        $type: "dev.trustlab.event",
        stream: STREAM,
        seq,
        ...(seq === 1 ? {} : { prevEventCid: events[index - 1]?.cid }),
        kind: "release",
        payload: payloads[index],
        createdAt: workloadCreatedAt(1, seq),
      });
      expect(event.cid).toBe(await recordCid(event.record));
    }
    expect(await chainIsValid()).toBe(true);
  });

  test("continues from the head, so 2 then 1 equals 3 at once", async () => {
    await publish(2);
    await publish(1);
    const split = await cids();

    const other = await startBaselineServer({ publisherToken: TOKEN });
    try {
      const client = baselineClient(other.url, TOKEN);
      await publishWorkload(client, { stream: STREAM, count: 3, seed: 1 });
      expect((await client.events(STREAM)).map((e) => e.cid)).toEqual(split);
    } finally {
      await other.close();
    }
  });

  test("concurrent appends never reuse or skip a seq", async () => {
    const [payload] = makeWorkload(1, 1);
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        publisher.append(STREAM, {
          kind: "release",
          payload: { ...payload!, version: `1.0.${index}` },
          createdAt: workloadCreatedAt(1, 1),
        }),
      ),
    );
    expect(results.map((r) => r.seq).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 12 }, (_, index) => index + 1),
    );
    expect(await chainIsValid()).toBe(true);
  });

  test("accepts a withdrawal that refers to an earlier event", async () => {
    await publish(2);
    const [payload] = makeWorkload(1, 1);
    const withdrawn = await publisher.append(STREAM, {
      kind: "withdraw",
      refSeq: 1,
      payload: payload!,
      createdAt: workloadCreatedAt(1, 3),
    });
    expect(withdrawn.seq).toBe(3);
    expect(await chainIsValid()).toBe(true);
  });

  test("rejects an event that breaks the contract, storing nothing", async () => {
    const [payload] = makeWorkload(1, 1);
    const createdAt = workloadCreatedAt(1, 1);
    expect(
      await statusOf(
        publisher.append(STREAM, {
          kind: "withdraw",
          payload: payload!,
          createdAt,
        }),
      ),
    ).toBe(400);
    expect(
      await statusOf(
        publisher.append(STREAM, {
          kind: "release",
          payload: { name: "x" } as never,
          createdAt,
        }),
      ),
    ).toBe(400);
    expect(
      await statusOf(
        publisher.append("Bad-Stream", {
          kind: "release",
          payload: payload!,
          createdAt,
        }),
      ),
    ).toBe(400);
    expect(await reader.events(STREAM)).toEqual([]);
  });

  test("needs the publisher token", async () => {
    const [payload] = makeWorkload(1, 1);
    const event = {
      kind: "release" as const,
      payload: payload!,
      createdAt: workloadCreatedAt(1, 1),
    };
    expect(await statusOf(reader.append(STREAM, event))).toBe(401);
    expect(
      await statusOf(baselineClient(server.url, "wrong").append(STREAM, event)),
    ).toBe(401);
    expect(await reader.events(STREAM)).toEqual([]);
  });
});

describe("the signed head", () => {
  test("verifies against the server's key and no other", async () => {
    await publish(2);
    const signed = await reader.head(STREAM);

    expect(signed.head).toEqual({
      stream: STREAM,
      seq: 2,
      eventCid: (await cids())[1],
    });
    expect(await verifyHead(server.publicKey, signed)).toBe(true);
    const other = await Secp256k1Keypair.create();
    expect(await verifyHead(other.did(), signed)).toBe(false);
  });

  test("fails if any signed field is changed", async () => {
    await publish(2);
    const signed = await reader.head(STREAM);
    const [first] = await cids();

    for (const head of [
      { ...signed.head, seq: 1 },
      { ...signed.head, eventCid: first as string },
      { ...signed.head, stream: "other" },
    ]) {
      expect(await verifyHead(server.publicKey, { ...signed, head })).toBe(
        false,
      );
    }
    expect(
      await verifyHead(server.publicKey, { ...signed, sig: "not base64!" }),
    ).toBe(false);
    expect(await verifyHead("not-a-key", signed)).toBe(false);
  });

  test("is 404 for a stream with no events", async () => {
    expect(await statusOf(reader.head(STREAM))).toBe(404);
  });

  test("keeps signing with a key that is passed in", async () => {
    const keypair = await Secp256k1Keypair.create();
    const fixed = await startBaselineServer({ publisherToken: TOKEN, keypair });
    try {
      expect(fixed.publicKey).toBe(keypair.did());
    } finally {
      await fixed.close();
    }
  });

  test("parseSignedHead rejects a malformed body", async () => {
    const keypair = await Secp256k1Keypair.create();
    const good = await signHead(keypair, {
      stream: STREAM,
      seq: 1,
      eventCid: "bafy",
    });
    expect(parseSignedHead(good)).toEqual(good);
    for (const bad of [
      null,
      "x",
      {},
      { head: null, sig: "s" },
      { ...good, sig: 1 },
      { ...good, head: { ...good.head, seq: 0 } },
      { ...good, head: { ...good.head, stream: "Bad" } },
      { ...good, head: { ...good.head, eventCid: 5 } },
    ]) {
      expect(() => parseSignedHead(bad)).toThrow(TypeError);
    }
  });
});

describe("tamper operations, mirroring the AT tools", () => {
  test("edit changes one event in place and breaks the next link", async () => {
    await publish(5);
    const before = await cids();
    const original = (await reader.events(STREAM))[1]!.record;

    const result = await publisher.edit(STREAM, 2);

    const after = await cids();
    expect(result).toEqual({ events: [{ seq: 2, cid: after[1] }] });
    expect(after[1]).not.toBe(before[1]);
    expect([after[0], ...after.slice(2)]).toEqual([
      before[0],
      ...before.slice(2),
    ]);
    const events = await reader.events(STREAM);
    expect({ ...events[1]!.record, payload: original.payload }).toEqual(
      original,
    );
    expect(events[2]!.record.prevEventCid).toBe(before[1]);
    expect(await chainIsValid()).toBe(false);
  });

  test("editing the last event leaves the signed head on the old CID", async () => {
    await publish(3);
    const before = await cids();

    await publisher.edit(STREAM, 3);

    const signed = await reader.head(STREAM);
    expect(signed.head.eventCid).toBe(before[2]);
    expect(await verifyHead(server.publicKey, signed)).toBe(true);
    expect((await cids())[2]).not.toBe(before[2]);
  });

  test("rewrite leaves a valid, re-signed chain with new CIDs from N on", async () => {
    await publish(5);
    const before = await cids();

    const result = await publisher.rewrite(STREAM, 3);

    const after = await cids();
    expect(after.slice(0, 2)).toEqual(before.slice(0, 2));
    for (const index of [2, 3, 4]) expect(after[index]).not.toBe(before[index]);
    expect(result).toEqual({
      events: [3, 4, 5].map((seq) => ({ seq, cid: after[seq - 1] })),
      head: { seq: 5, eventCid: after[4] },
    });
    // The event at N keeps its link to the untouched event before it.
    expect((await reader.events(STREAM))[2]!.record.prevEventCid).toBe(
      before[1],
    );
    expect(await chainIsValid()).toBe(true);
  });

  test("rewrite from seq 1 replaces the whole stream", async () => {
    await publish(3);
    const before = await cids();

    await publisher.rewrite(STREAM, 1);

    const events = await reader.events(STREAM);
    expect(events[0]!.record).not.toHaveProperty("prevEventCid");
    expect(events.every((event, index) => event.cid !== before[index])).toBe(
      true,
    );
    expect(await chainIsValid()).toBe(true);
  });

  test("truncate deletes later events and re-signs the head at N", async () => {
    await publish(5);
    const before = await cids();

    const result = await publisher.truncate(STREAM, 3);

    expect(await cids()).toEqual(before.slice(0, 3));
    expect(result).toEqual({
      events: [],
      head: { seq: 3, eventCid: before[2] },
    });
    expect(await chainIsValid()).toBe(true);
    // The stream goes on from the new head.
    expect((await publish(1))[0]?.seq).toBe(4);
  });

  test("the tampered events are the ones the AT tools would write", async () => {
    await publish(2);
    const original = (await reader.events(STREAM))[1]!.record;

    await publisher.edit(STREAM, 2);
    await publisher.edit(STREAM, 2);

    const edited = (await reader.events(STREAM))[1]!.record;
    parseEventRecord(edited);
    // Same rule as #65: a fixed-length checksum, however often it is edited.
    expect(edited.payload.checksum).toMatch(/^tampered:[0-9a-f]{64}$/);
    expect(edited.payload.checksum).not.toBe(original.payload.checksum);
  });

  test("rejects a seq the stream does not have, changing nothing", async () => {
    await publish(3);
    const before = await cids();

    expect(await statusOf(publisher.edit(STREAM, 4))).toBe(404);
    expect(await statusOf(publisher.rewrite(STREAM, 9))).toBe(404);
    expect(await statusOf(publisher.truncate(STREAM, 3))).toBe(400);
    expect(await statusOf(publisher.truncate(STREAM, 7))).toBe(404);
    expect(await statusOf(publisher.truncate(STREAM, 0))).toBe(400);
    expect(await statusOf(publisher.edit("empty", 1))).toBe(404);
    expect(await cids()).toEqual(before);
    expect(await chainIsValid()).toBe(true);
  });

  test("needs the publisher token", async () => {
    await publish(3);
    const before = await cids();

    expect(await statusOf(reader.edit(STREAM, 2))).toBe(401);
    expect(await statusOf(reader.rewrite(STREAM, 2))).toBe(401);
    expect(await statusOf(reader.truncate(STREAM, 2))).toBe(401);
    expect(await cids()).toEqual(before);
  });
});

describe("the HTTP surface", () => {
  /** Send a raw request with the publisher token. */
  async function raw(
    method: string,
    path: string,
    body?: string,
  ): Promise<number> {
    const response = await fetch(`${server.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${TOKEN}` },
      ...(body === undefined ? {} : { body }),
    });
    await response.json();
    return response.status;
  }

  test("answers unknown paths, methods, and bad input with the right status", async () => {
    await publish(2);

    expect(await raw("GET", "/")).toBe(404);
    expect(await raw("GET", "/streams/releases")).toBe(404);
    expect(await raw("GET", "/streams/releases/other")).toBe(404);
    expect(await raw("GET", "/streams/releases/events/1/extra")).toBe(404);
    expect(await raw("POST", "/streams/releases/head")).toBe(405);
    expect(await raw("PATCH", "/streams/releases/events")).toBe(405);
    expect(await raw("GET", "/streams/releases/events/1")).toBe(405);
    expect(await raw("PUT", "/streams/releases/events/one")).toBe(400);
    expect(await raw("PUT", "/streams/releases/events/1", "{not json")).toBe(
      400,
    );
    expect(
      await raw("PUT", "/streams/releases/events/1", '{"mode":"erase"}'),
    ).toBe(400);
    expect(await raw("POST", "/streams/releases/events", "[]")).toBe(400);
    expect(
      await raw("POST", "/streams/releases/events", "x".repeat(70_000)),
    ).toBe(413);
    expect(await raw("GET", "/streams/Bad-Stream/events")).toBe(400);
    expect(await raw("DELETE", "/streams/releases/events/1")).toBe(400);
  });

  test("PUT with no body is an edit", async () => {
    await publish(2);
    const before = await cids();

    expect(await raw("PUT", "/streams/releases/events/1")).toBe(200);

    const after = await cids();
    expect(after[0]).not.toBe(before[0]);
    expect(after[1]).toBe(before[1]);
  });

  test("the client rejects a response that is not a valid event list", async () => {
    const fake = await startBaselineServer({ publisherToken: TOKEN });
    const realFetch = globalThis.fetch;
    try {
      for (const body of [
        {},
        { events: [{ seq: 2, cid: "c", record: {} }] },
        { events: [{ seq: 1, cid: 5, record: {} }] },
        { events: [{ seq: 1, cid: "c", record: { nope: true } }] },
      ]) {
        globalThis.fetch = async () => Response.json(body);
        await expect(baselineClient(fake.url).events(STREAM)).rejects.toThrow();
      }
      globalThis.fetch = async () =>
        Response.json({ wrong: true }, { status: 500 });
      await expect(baselineClient(fake.url).events(STREAM)).rejects.toThrow(
        /answered 500: unknown error/,
      );
    } finally {
      globalThis.fetch = realFetch;
      await fake.close();
    }
  });
});

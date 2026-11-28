import { Secp256k1Keypair } from "@atproto/crypto";
import {
  eventRkey,
  HEAD_NSID,
  type WitnessCheckpoint,
} from "@trustlab/contracts";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { auditStream } from "../source.js";
import {
  type BaselineClient,
  baselineClient,
  publishWorkload,
} from "./client.js";
import { type RunningBaseline, startBaselineServer } from "./server.js";
import { baselineSource, BaselineSourceError } from "./source.js";

const TOKEN = "publisher-token-for-tests";
const STREAM = "releases";

let server: RunningBaseline;
let publisher: BaselineClient;

beforeEach(async () => {
  server = await startBaselineServer({ publisherToken: TOKEN });
  publisher = baselineClient(server.url, TOKEN);
});

afterEach(async () => {
  await server.close();
});

/**
 * Publish the next `count` events of seed 1.
 *
 * @param count - How many.
 * @returns The CID of each, in order.
 */
async function publish(count: number): Promise<string[]> {
  const published = await publishWorkload(publisher, {
    stream: STREAM,
    count,
    seed: 1,
  });
  return published.map((event) => event.cid);
}

/**
 * A source configured with the server's URL and key.
 *
 * @param fetch - Sends the requests, when a test needs to step in.
 * @returns The source.
 */
function source(fetch?: typeof globalThis.fetch) {
  return baselineSource({
    url: server.url,
    publicKey: server.publicKey,
    ...(fetch === undefined ? {} : { fetch }),
  });
}

/**
 * Whether a request is the read of the stream's events.
 *
 * @param input - The request URL.
 * @param init - The request options.
 * @returns True for `GET /streams/releases/events`.
 */
function isEventsRead(input: string | URL | Request, init?: RequestInit) {
  return (
    String(input).endsWith(`/streams/${STREAM}/events`) &&
    (init?.method ?? "GET") === "GET"
  );
}

describe("baselineSource", () => {
  test("reads events and the signed head in the shapes the auditor takes", async () => {
    const cids = await publish(3);
    expect(await source().read(STREAM)).toEqual({
      events: cids.map((cid, index) => ({
        did: server.publicKey,
        stream: STREAM,
        seq: index + 1,
        rkey: eventRkey(STREAM, index + 1),
        cid,
        record: expect.objectContaining({ seq: index + 1 }),
      })),
      head: { $type: HEAD_NSID, stream: STREAM, seq: 3, eventCid: cids[2] },
    });
  });

  test("reads a stream with no events as empty, with no head", async () => {
    expect(await source().read(STREAM)).toEqual({ events: [] });
  });

  test("refuses a head the configured key didn't sign", async () => {
    await publish(2);
    const other = await Secp256k1Keypair.create();
    const wrongKey = baselineSource({
      url: server.url,
      publicKey: other.did(),
    });
    await expect(wrongKey.read(STREAM)).rejects.toThrow(BaselineSourceError);
  });

  test("reads again when the stream changes between requests", async () => {
    await publish(3);
    let eventReads = 0;
    const racing: typeof globalThis.fetch = async (input, init) => {
      const response = await fetch(input, init);
      if (isEventsRead(input, init)) {
        eventReads += 1;
        // Another append lands right after the first read of the events.
        if (eventReads === 1) await publish(1);
      }
      return response;
    };
    const read = await source(racing).read(STREAM);
    expect(read).toMatchObject({ head: { seq: 4 } });
    expect(read !== "unreachable" && read.events.length).toBe(4);
    expect(eventReads).toBe(4);
  });

  test("gives up when the stream keeps changing", async () => {
    await publish(1);
    const busy: typeof globalThis.fetch = async (input, init) => {
      const response = await fetch(input, init);
      if (isEventsRead(input, init)) await publish(1);
      return response;
    };
    await expect(source(busy).read(STREAM)).rejects.toThrow(
      "changed during each of 3 reads",
    );
  });

  test("is unreachable when it can't connect or gets an error status", async () => {
    await publish(1);
    const failing: typeof globalThis.fetch = async () =>
      Response.json({ error: "overloaded" }, { status: 503 });
    expect(await source(failing).read(STREAM)).toBe("unreachable");

    const closed = source();
    await server.close();
    expect(await closed.read(STREAM)).toBe("unreachable");
  });

  test("throws for a malformed answer instead of calling it unreachable", async () => {
    const malformed: typeof globalThis.fetch = async () =>
      Response.json({ events: "not a list" });
    await expect(source(malformed).read(STREAM)).rejects.toThrow(
      "invalid events response",
    );
  });
});

describe("auditStream on S0", () => {
  // The S0 column of ADR-007: no witness, so only the chain can catch a
  // tamper, and only the in-place edit breaks it.
  test.each([
    {
      scenario: "interior-edit",
      tamper: () => publisher.edit(STREAM, 2),
      verdict: {
        verdict: "conflict",
        reason: "broken-link",
        evidence: { seq: 3 },
      },
    },
    {
      scenario: "suffix-rewrite",
      tamper: () => publisher.rewrite(STREAM, 3),
      verdict: { verdict: "accept", reason: "no-witness" },
    },
    {
      scenario: "truncation",
      tamper: () => publisher.truncate(STREAM, 3),
      verdict: { verdict: "accept", reason: "no-witness" },
    },
    {
      scenario: "signed-withdrawal",
      tamper: () =>
        publisher.append(STREAM, {
          kind: "withdraw",
          refSeq: 2,
          payload: { name: "pkg", version: "1.0.2", checksum: "sha256:00" },
          createdAt: "2026-01-01T00:01:00.000Z",
        }),
      verdict: { verdict: "accept", reason: "no-witness" },
    },
    {
      scenario: "pds-unreachable",
      tamper: () => server.close(),
      verdict: { verdict: "unknown", reason: "pds-unreachable" },
    },
  ])("$scenario gives $verdict.verdict", async ({ tamper, verdict }) => {
    await publish(5);
    await tamper();
    expect(await auditStream(source(), STREAM)).toEqual(verdict);
  });

  test("compares S0 events with checkpoints the same way as on AT", async () => {
    // A stand-in for S1 (#85): a checkpoint of the head at seq 5, with a stub
    // verify, since the signed-head proof check is #85's.
    const cids = await publish(5);
    const witnessed: WitnessCheckpoint = {
      did: server.publicKey,
      stream: STREAM,
      seq: 5,
      eventCid: cids[4] as string,
      headCid: "-",
      commitCid: "-",
      rev: "-",
      proofCar: "",
      signingKey: server.publicKey,
      observedAt: "2026-01-01T00:00:00.000Z",
    };
    const witness = { checkpoints: [witnessed], verify: async () => true };
    expect(await auditStream(source(), STREAM, witness)).toEqual({
      verdict: "accept",
      reason: "extends-witness",
    });

    const rewritten = await publisher.rewrite(STREAM, 3);
    expect(await auditStream(source(), STREAM, witness)).toEqual({
      verdict: "conflict",
      reason: "rewritten",
      evidence: {
        seq: 5,
        witnessedCid: cids[4],
        currentCid: rewritten.events[2]?.cid,
      },
    });
  });
});

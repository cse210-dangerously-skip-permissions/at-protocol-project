import { AtpAgent } from "@atproto/api";
import {
  EVENT_NSID,
  HEAD_NSID,
  headRkey,
  loadLocalEnv,
  parseEventRecord,
  parseEventRkey,
} from "@trustlab/contracts";
import {
  login,
  publishEvent,
  type Published,
  readHead,
  runPublish,
} from "@trustlab/publisher";
import { beforeAll, expect, test } from "vitest";

// Needs the local AT network: `npm run stack:up`.
const env = loadLocalEnv();

beforeAll(async () => {
  const health = await fetch(`${env.PDS_URL}/xrpc/_health`).catch(() => null);
  if (health === null || !health.ok) {
    throw new Error(
      `No PDS at ${env.PDS_URL}. Start the local network with \`npm run stack:up\`.`,
    );
  }
});

/**
 * List one stream's event records from the PDS, without logging in.
 *
 * @param stream - Stream name.
 * @returns Each record's key, CID, and value, lowest seq first.
 */
async function listStream(stream: string) {
  const reader = new AtpAgent({ service: env.PDS_URL });
  const records = [];
  let cursor: string | undefined;
  do {
    const page = await reader.com.atproto.repo.listRecords({
      repo: env.PUBLISHER_DID,
      collection: EVENT_NSID,
      limit: 100,
      cursor,
    });
    records.push(...page.data.records);
    cursor = page.data.cursor;
  } while (cursor !== undefined);

  return records
    .map((record) => ({
      rkey: record.uri.split("/").pop() as string,
      cid: record.cid,
      value: record.value,
    }))
    .filter((record) => parseEventRkey(record.rkey)?.stream === stream)
    .sort((a, b) => a.rkey.localeCompare(b.rkey));
}

test("publishing 10 events yields seq 1 to 10 with valid links and a head at 10", async () => {
  // A fresh stream per run, so earlier runs don't get in the way.
  const stream = `it${Date.now().toString(36)}`;
  const session = await login(env);
  expect(session.did).toBe(env.PUBLISHER_DID);
  expect(await readHead(session, stream)).toBeNull();

  const published: Published[] = [];
  for (let i = 1; i <= 10; i += 1) {
    published.push(
      await publishEvent(session, {
        stream,
        kind: "release",
        payload: { name: "pkg", version: `1.0.${i}`, checksum: `sha256:${i}` },
      }),
    );
  }

  const stored = await listStream(stream);
  expect(stored).toHaveLength(10);
  stored.forEach((record, index) => {
    const event = parseEventRecord(record.value, record.rkey);
    expect(event.seq).toBe(index + 1);
    expect(event.prevEventCid).toBe(stored[index - 1]?.cid);
    expect(record.cid).toBe(published[index]?.cid);
  });

  const head = await readHead(session, stream);
  expect(head).toMatchObject({ stream, seq: 10, eventCid: stored[9]?.cid });
});

test("the same seed on a fresh stream gets the same CIDs from the PDS", async () => {
  const stream = `seed${Date.now().toString(36)}`;
  const session = await login(env);
  const args = { stream, count: 3, seed: 7 };
  const lines: string[] = [];
  const options = { session, log: (line: string) => lines.push(line) };

  const first = await runPublish(args, options);
  expect(lines).toEqual(
    first.map(
      (event) => `published ${stream} seq=${event.seq} cid=${event.cid}`,
    ),
  );

  // Make the stream fresh again by deleting its records. Real publishers
  // never delete events; this throwaway stream exists only for this check.
  const repo = session.agent.com.atproto.repo;
  for (const event of first) {
    await repo.deleteRecord({
      repo: session.did,
      collection: EVENT_NSID,
      rkey: event.rkey,
    });
  }
  await repo.deleteRecord({
    repo: session.did,
    collection: HEAD_NSID,
    rkey: headRkey(stream),
  });
  expect(await readHead(session, stream)).toBeNull();

  const second = await runPublish(args, options);
  expect(second.map((event) => event.seq)).toEqual([1, 2, 3]);
  expect(second.map((event) => event.cid)).toEqual(
    first.map((event) => event.cid),
  );
});

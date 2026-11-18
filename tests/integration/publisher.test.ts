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
  runAmend,
  runPublish,
  tamperEdit,
  tamperRewrite,
  tamperTruncate,
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
        createdAt: new Date().toISOString(),
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

test("two publishers at once write seq 1 to 40 with no duplicate and no gap", async () => {
  const stream = `race${Date.now().toString(36)}`;

  /** Log in separately and publish 20 events, as its own process would. */
  const publishTwenty = async (name: string) => {
    const session = await login(env);
    const published: Published[] = [];
    for (let i = 1; i <= 20; i += 1) {
      published.push(
        await publishEvent(session, {
          stream,
          kind: "release",
          payload: { name, version: `1.0.${i}`, checksum: `sha256:${i}` },
          createdAt: new Date().toISOString(),
        }),
      );
    }
    return published;
  };

  const published = (
    await Promise.all([publishTwenty("left"), publishTwenty("right")])
  ).flat();
  expect(published.map((event) => event.seq).sort((a, b) => a - b)).toEqual(
    Array.from({ length: 40 }, (_, index) => index + 1),
  );

  const stored = await listStream(stream);
  expect(stored).toHaveLength(40);
  stored.forEach((record, index) => {
    const event = parseEventRecord(record.value, record.rkey);
    expect(event.seq).toBe(index + 1);
    expect(event.prevEventCid).toBe(stored[index - 1]?.cid);
  });
  // Each publisher's result names the event it wrote, not the other's.
  for (const event of published) {
    expect(stored[event.seq - 1]?.cid).toBe(event.cid);
  }

  const reader = await login(env);
  expect(await readHead(reader, stream)).toMatchObject({
    seq: 40,
    eventCid: stored[39]?.cid,
  });
});

test("publishing 3 then 3 gets the same CIDs from the PDS as publishing 6", async () => {
  const stream = `seed${Date.now().toString(36)}`;
  const session = await login(env);
  const lines: string[] = [];
  const options = { session, log: (line: string) => lines.push(line) };

  const split = [
    ...(await runPublish({ stream, count: 3, seed: 7 }, options)),
    ...(await runPublish({ stream, count: 3, seed: 7 }, options)),
  ];
  expect(split.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6]);
  expect(lines).toEqual(
    split.map(
      (event) => `published ${stream} seq=${event.seq} cid=${event.cid}`,
    ),
  );

  // Empty the stream by deleting its records, so the same seqs can be
  // published again. Real publishers never delete events; this throwaway
  // stream exists only for this check.
  const repo = session.agent.com.atproto.repo;
  for (const event of split) {
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

  const atOnce = await runPublish({ stream, count: 6, seed: 7 }, options);
  expect(atOnce.map((event) => event.cid)).toEqual(
    split.map((event) => event.cid),
  );
});

test("withdrawing seq 2 of 3 appends event 4 and leaves event 2 alone", async () => {
  const stream = `wd${Date.now().toString(36)}`;
  const session = await login(env);
  const options = { session, log: () => {} };

  const published = await runPublish({ stream, count: 3, seed: 7 }, options);
  const withdrawal = await runAmend(
    { kind: "withdraw", stream, seq: 2, seed: 7 },
    options,
  );

  const stored = await listStream(stream);
  expect(stored).toHaveLength(4);
  expect(stored[1]?.cid).toBe(published[1]?.cid);
  const last = parseEventRecord(stored[3]?.value, stored[3]?.rkey);
  expect(last).toMatchObject({
    seq: 4,
    kind: "withdraw",
    refSeq: 2,
    prevEventCid: published[2]?.cid,
    payload: parseEventRecord(stored[1]?.value).payload,
  });
  expect(await readHead(session, stream)).toMatchObject({
    seq: 4,
    eventCid: withdrawal.cid,
  });

  await expect(
    runAmend({ kind: "withdraw", stream, seq: 9, seed: 7 }, options),
  ).rejects.toThrow(/no event at seq 9/);
  expect(await listStream(stream)).toHaveLength(4);
});

/**
 * Whether each stored event links to the one before it.
 *
 * @param stored - A stream's records, lowest seq first.
 * @returns `true` if every `prevEventCid` matches.
 */
function linksAreValid(stored: Awaited<ReturnType<typeof listStream>>) {
  return stored.every((record, index) => {
    const event = parseEventRecord(record.value, record.rkey);
    return (
      event.seq === index + 1 && event.prevEventCid === stored[index - 1]?.cid
    );
  });
}

test("tamperEdit gives event N a new CID and breaks the link from N+1", async () => {
  const stream = `te${Date.now().toString(36)}`;
  const session = await login(env);
  const published = await runPublish(
    { stream, count: 4, seed: 7 },
    { session, log: () => {} },
  );

  await tamperEdit(session, stream, 2);

  const stored = await listStream(stream);
  expect(stored).toHaveLength(4);
  expect(stored[1]?.cid).not.toBe(published[1]?.cid);
  const next = parseEventRecord(stored[2]?.value, stored[2]?.rkey);
  expect(next.prevEventCid).toBe(published[1]?.cid);
  expect(next.prevEventCid).not.toBe(stored[1]?.cid);
  expect(linksAreValid(stored)).toBe(false);
});

test("tamperRewrite leaves a valid chain with new CIDs from N on", async () => {
  const stream = `tr${Date.now().toString(36)}`;
  const session = await login(env);
  const published = await runPublish(
    { stream, count: 5, seed: 7 },
    { session, log: () => {} },
  );

  await tamperRewrite(session, stream, 3);

  const stored = await listStream(stream);
  expect(stored).toHaveLength(5);
  expect(linksAreValid(stored)).toBe(true);
  stored.forEach((record, index) => {
    if (index < 2) expect(record.cid).toBe(published[index]?.cid);
    else expect(record.cid).not.toBe(published[index]?.cid);
  });
  expect(await readHead(session, stream)).toMatchObject({
    seq: 5,
    eventCid: stored[4]?.cid,
  });
});

test("tamperTruncate deletes later events and puts the head at N", async () => {
  const stream = `tt${Date.now().toString(36)}`;
  const session = await login(env);
  const published = await runPublish(
    { stream, count: 5, seed: 7 },
    { session, log: () => {} },
  );

  await tamperTruncate(session, stream, 3);

  const stored = await listStream(stream);
  expect(stored.map((record) => record.cid)).toEqual(
    published.slice(0, 3).map((event) => event.cid),
  );
  expect(linksAreValid(stored)).toBe(true);
  expect(await readHead(session, stream)).toMatchObject({
    seq: 3,
    eventCid: published[2]?.cid,
  });
});

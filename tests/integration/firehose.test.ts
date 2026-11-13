import { AtpAgent } from "@atproto/api";
import { EVENT_NSID, eventRkey, loadLocalEnv } from "@trustlab/contracts";
import {
  ConsumerStore,
  startFirehose,
  type VerifiedCommit,
} from "@trustlab/consumer";
import { login, publishEvent, type Published } from "@trustlab/publisher";
import { afterAll, beforeAll, expect, test, vi } from "vitest";

// Needs the local AT network: `npm run stack:up`.
const env = loadLocalEnv();
const store = new ConsumerStore(":memory:");
const commits: VerifiedCommit[] = [];
let firehose: { stop(): Promise<void> } | undefined;

beforeAll(async () => {
  const health = await fetch(`${env.PDS_URL}/xrpc/_health`).catch(() => null);
  if (health === null || !health.ok) {
    throw new Error(
      `No PDS at ${env.PDS_URL}. Start the local network with \`npm run stack:up\`.`,
    );
  }
  firehose = startFirehose({
    env,
    store,
    allow: (did) => did === env.PUBLISHER_DID,
    onCommit: (commit) => commits.push(commit),
  });
  // ponytail: fixed wait for the socket to open, since a fresh consumer only
  // sees commits made after it connects. Poll the PDS instead if this flakes.
  await new Promise((resolve) => setTimeout(resolve, 1000));
});

afterAll(async () => {
  await firehose?.stop();
  store.close();
});

test("saves verified events from the allowlisted publisher and drops other DIDs", async () => {
  const stream = `fh${Date.now().toString(36)}`;

  // The witness account is real and signs its commits, but it isn't allowlisted.
  const witness = new AtpAgent({ service: env.PDS_URL });
  await witness.login({
    identifier: env.WITNESS_DID,
    password: env.WITNESS_PASSWORD,
  });
  await witness.com.atproto.repo.createRecord({
    repo: env.WITNESS_DID,
    collection: EVENT_NSID,
    rkey: eventRkey(stream, 1),
    record: {
      $type: EVENT_NSID,
      stream,
      seq: 1,
      kind: "release",
      payload: { name: "pkg", version: "9.9.9", checksum: "sha256:x" },
      createdAt: new Date().toISOString(),
    },
  });

  const session = await login(env);
  const published: Published[] = [];
  for (let i = 1; i <= 3; i += 1) {
    published.push(
      await publishEvent(session, {
        stream,
        kind: "release",
        payload: { name: "pkg", version: `1.0.${i}`, checksum: `sha256:${i}` },
        createdAt: new Date().toISOString(),
      }),
    );
  }

  await vi.waitFor(
    () => expect(store.getEvents(env.PUBLISHER_DID, stream)).toHaveLength(3),
    { timeout: 10_000 },
  );
  const stored = store.getEvents(env.PUBLISHER_DID, stream);
  expect(stored.map((e) => e.seq)).toEqual([1, 2, 3]);
  expect(stored.map((e) => e.cid)).toEqual(published.map((p) => p.cid));

  // Commits arrive in order, so the witness's earlier one was already seen.
  expect(store.getEvents(env.WITNESS_DID, stream)).toEqual([]);
  expect(commits.every((c) => c.did === env.PUBLISHER_DID)).toBe(true);

  const { cursor, revs } = store.getCheckpoint();
  expect(cursor).toBe(commits.at(-1)?.cursor);
  expect(revs[env.PUBLISHER_DID]).toBe(commits.at(-1)?.rev);

  // A real signed delete is verified and logged. Real publishers never delete
  // events; this throwaway stream exists only for this check.
  const log = vi.spyOn(console, "log");
  const rkey = eventRkey(stream, 3);
  await session.agent.com.atproto.repo.deleteRecord({
    repo: session.did,
    collection: EVENT_NSID,
    rkey,
  });
  await vi.waitFor(
    () =>
      expect(log).toHaveBeenCalledWith(
        expect.stringMatching(
          `^verified delete did=${env.PUBLISHER_DID} rkey=${rkey} cid=- rev=`,
        ),
      ),
    { timeout: 10_000 },
  );
  log.mockRestore();

  // Leave the witness repo clean for the real witness service.
  await witness.com.atproto.repo.deleteRecord({
    repo: env.WITNESS_DID,
    collection: EVENT_NSID,
    rkey: eventRkey(stream, 1),
  });
});

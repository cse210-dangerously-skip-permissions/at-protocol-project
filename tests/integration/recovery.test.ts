import { loadLocalEnv } from "@trustlab/contracts";
import { login, publishEvent, type Published } from "@trustlab/publisher";
import { fetchSnapshot } from "@trustlab/recovery";
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

test("fetchSnapshot returns the 5 events just published, with the CIDs the PDS gave", async () => {
  // A fresh stream per run, so earlier runs don't get in the way.
  const stream = `snap${Date.now().toString(36)}`;
  const session = await login(env);
  const published: Published[] = [];
  for (let i = 1; i <= 5; i += 1) {
    published.push(
      await publishEvent(session, {
        stream,
        kind: "release",
        payload: { name: "pkg", version: `1.0.${i}`, checksum: `sha256:${i}` },
        createdAt: new Date().toISOString(),
      }),
    );
  }
  const last = published[4];
  if (last === undefined) throw new Error("published fewer than 5 events");

  const snapshot = await fetchSnapshot({
    pdsUrl: env.PDS_URL,
    plcUrl: env.PLC_URL,
    did: env.PUBLISHER_DID,
  });

  expect(snapshot.did).toBe(env.PUBLISHER_DID);
  expect(
    snapshot.events
      .filter((event) => event.stream === stream)
      .map((event) => [event.seq, event.cid]),
  ).toEqual(published.map((event) => [event.seq, event.cid]));
  expect(snapshot.head[stream]).toMatchObject({ seq: 5, eventCid: last.cid });
  // Other tests may publish at the same time, so the snapshot can be newer.
  // Revs are TIDs, which sort by time.
  expect(snapshot.rev >= last.rev).toBe(true);
});

test("fetchSnapshot rejects another account's repo served for the publisher's DID", async () => {
  // A PDS that answers getRepo for the publisher with the witness's repo,
  // which is validly signed, but by another account.
  const swapping: typeof fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname.endsWith("/com.atproto.sync.getRepo")) {
      url.searchParams.set("did", env.WITNESS_DID);
    }
    return fetch(url, init);
  };

  await expect(
    fetchSnapshot({
      pdsUrl: env.PDS_URL,
      plcUrl: env.PLC_URL,
      did: env.PUBLISHER_DID,
      fetch: swapping,
    }),
  ).rejects.toMatchObject({ name: "SnapshotError", problem: "invalid-repo" });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadLocalEnv } from "@trustlab/contracts";
import {
  allowlistFromEnv,
  ConsumerStore,
  type RunningFirehose,
  startConsumer,
} from "@trustlab/consumer";
import { login, publishEvent, type Published } from "@trustlab/publisher";
import { afterAll, beforeAll, expect, test, vi } from "vitest";

// Needs the local AT network: `npm run stack:up`.
const env = loadLocalEnv();
const dir = mkdtempSync(join(tmpdir(), "restart-"));
const dbPath = join(dir, "consumer.db");

beforeAll(async () => {
  const health = await fetch(`${env.PDS_URL}/xrpc/_health`).catch(() => null);
  if (health === null || !health.ok) {
    throw new Error(
      `No PDS at ${env.PDS_URL}. Start the local network with \`npm run stack:up\`.`,
    );
  }
});

afterAll(() => {
  rmSync(dir, { recursive: true });
});

/**
 * Open the consumer's database file and start the consumer on it.
 *
 * @returns The store and the running consumer.
 */
async function start(): Promise<{
  store: ConsumerStore;
  consumer: RunningFirehose;
}> {
  const store = new ConsumerStore(dbPath);
  const consumer = await startConsumer({
    env,
    store,
    allow: allowlistFromEnv(env).allow,
  });
  // ponytail: fixed wait for the socket to open, as in firehose.test.ts.
  await new Promise((resolve) => setTimeout(resolve, 1000));
  return { store, consumer };
}

test("a restart after downtime catches up with no manual step", async () => {
  const stream = `rs${Date.now().toString(36)}`;
  const session = await login(env);
  const published: Published[] = [];
  const publish = async (count: number) => {
    for (let i = 0; i < count; i += 1) {
      const n = published.length + 1;
      published.push(
        await publishEvent(session, {
          stream,
          kind: "release",
          payload: {
            name: "pkg",
            version: `1.0.${n}`,
            checksum: `sha256:${n}`,
          },
          createdAt: new Date().toISOString(),
        }),
      );
    }
  };
  const log = vi.spyOn(console, "log");
  const rebuilds = () =>
    log.mock.calls.filter(([line]) => String(line).includes("rebuilt did="))
      .length;

  // Published before the consumer ever ran: only a snapshot can recover them.
  await publish(5);
  let { store, consumer } = await start();
  expect(rebuilds()).toBe(1);
  expect(store.getEvents(env.PUBLISHER_DID, stream)).toHaveLength(5);

  // One live event, so the checkpoint has a cursor to resume from.
  await publish(1);
  await vi.waitFor(
    () => expect(store.getEvents(env.PUBLISHER_DID, stream)).toHaveLength(6),
    { timeout: 10_000 },
  );
  await consumer.stop();
  store.close();

  // Downtime: these four are published while nothing is listening.
  await publish(4);
  ({ store, consumer } = await start());
  await vi.waitFor(
    () => expect(store.getEvents(env.PUBLISHER_DID, stream)).toHaveLength(10),
    { timeout: 10_000 },
  );
  // The second start resumed from the cursor instead of rebuilding.
  expect(rebuilds()).toBe(1);
  expect(store.getEvents(env.PUBLISHER_DID, stream).map((e) => e.cid)).toEqual(
    published.map((p) => p.cid),
  );

  await consumer.stop();
  store.close();
  log.mockRestore();
});

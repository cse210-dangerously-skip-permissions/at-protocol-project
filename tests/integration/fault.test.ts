import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { loadLocalEnv } from "@trustlab/contracts";
import { ConsumerStore, startFirehose } from "@trustlab/consumer";
import { login, publishEvent } from "@trustlab/publisher";
import { afterAll, beforeAll, expect, test, vi } from "vitest";

// Needs the local AT network: `npm run stack:up`. Uses the consumer's fault
// proxy ports from infra/scripts/fault.mjs, so nothing else may hold them.
const env = loadLocalEnv();
const FAULT = "infra/scripts/fault.mjs";
const store = new ConsumerStore(":memory:");
let proxy: ChildProcess | undefined;
let firehose: { stop(): Promise<void> } | undefined;

/**
 * Run `fault <command> consumer` the way a script would.
 *
 * @param command - `block` or `restore`.
 */
function fault(command: "block" | "restore"): void {
  execFileSync(process.execPath, [FAULT, command, "consumer"]);
}

beforeAll(async () => {
  const health = await fetch(`${env.PDS_URL}/xrpc/_health`).catch(() => null);
  if (health === null || !health.ok) {
    throw new Error(
      `No PDS at ${env.PDS_URL}. Start the local network with \`npm run stack:up\`.`,
    );
  }
  proxy = spawn(process.execPath, [FAULT, "proxy", "consumer"]);
  await once(proxy.stdout!, "data");
  firehose = startFirehose({
    env: { ...env, PDS_URL: "http://127.0.0.1:2584" },
    store,
    allow: (did) => did === env.PUBLISHER_DID,
  });
  // A fresh consumer only sees commits made after it connects; see firehose.test.ts.
  await new Promise((resolve) => setTimeout(resolve, 1000));
});

afterAll(async () => {
  await firehose?.stop();
  store.close();
  proxy?.kill("SIGINT");
});

test("a blocked consumer misses nothing and catches up after restore, while the PDS stays up", async () => {
  const stream = `fault${Date.now().toString(36)}`;
  const session = await login(env);
  const publish = (i: number) =>
    publishEvent(session, {
      stream,
      kind: "release",
      payload: { name: "pkg", version: `1.0.${i}`, checksum: `sha256:${i}` },
      createdAt: new Date().toISOString(),
    });
  const stored = () => store.getEvents(env.PUBLISHER_DID, stream);

  // One event first, so the consumer has a cursor to resume from.
  await publish(1);
  await vi.waitFor(() => expect(stored()).toHaveLength(1), { timeout: 10_000 });

  fault("block");
  for (let i = 2; i <= 4; i += 1) await publish(i);
  await new Promise((resolve) => setTimeout(resolve, 2000));
  expect(stored()).toHaveLength(1);

  fault("restore");
  await vi.waitFor(() => expect(stored()).toHaveLength(4), {
    timeout: 15_000,
  });
  expect(stored().map((e) => e.seq)).toEqual([1, 2, 3, 4]);
  // The publisher wrote straight to the PDS while the consumer was cut off.
  expect((await fetch(`${env.PDS_URL}/xrpc/_health`)).ok).toBe(true);
});

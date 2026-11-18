import { checkCheckpoint } from "@trustlab/auditor";
import { loadLocalEnv, type WitnessCheckpoint } from "@trustlab/contracts";
import { login, publishEvent, type Published } from "@trustlab/publisher";
import { type RunningWitness, startWitness } from "@trustlab/witness";
import { afterAll, beforeAll, expect, test, vi } from "vitest";

// Needs the local AT network: `npm run stack:up`.
const env = loadLocalEnv();
const added: WitnessCheckpoint[] = [];
let witness: RunningWitness | undefined;

beforeAll(async () => {
  const health = await fetch(`${env.PDS_URL}/xrpc/_health`).catch(() => null);
  if (health === null || !health.ok) {
    throw new Error(
      `No PDS at ${env.PDS_URL}. Start the local network with \`npm run stack:up\`.`,
    );
  }
  // ponytail: an array instead of #48's CheckpointStore until it lands.
  witness = startWitness({
    env,
    store: { add: (cp) => (added.push(cp), "stored") },
    allow: (did) => did === env.PUBLISHER_DID,
  });
  // The feed starts at the live tail, so let the socket open before writing.
  await new Promise((resolve) => setTimeout(resolve, 1000));
});

afterAll(async () => {
  await witness?.stop();
  vi.unstubAllGlobals();
});

test("captures one checkpoint per head update, each verifying offline", async () => {
  const stream = `wit${Date.now().toString(36)}`;
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

  const ours = () => added.filter((cp) => cp.stream === stream);
  await vi.waitFor(() => expect(ours()).toHaveLength(5), { timeout: 10_000 });
  expect(ours().map((cp) => [cp.seq, cp.eventCid, cp.commitCid])).toEqual(
    published.map((p) => [p.seq, p.cid, p.commitCid]),
  );

  // Verifying needs only the checkpoint: no PDS, no PLC.
  vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
  for (const cp of ours()) {
    expect(await checkCheckpoint(cp)).toEqual({ valid: true });
  }
});

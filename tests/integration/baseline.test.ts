import { loadLocalEnv } from "@trustlab/contracts";
import {
  baselineClient,
  publishWorkload,
  startBaselineServer,
  verifyHead,
} from "@trustlab/harness";
import {
  login,
  readHead,
  runPublish,
  tamperRewrite,
  tamperTruncate,
} from "@trustlab/publisher";
import { beforeAll, expect, test } from "vitest";

// The S0 baseline against the real AT publisher. Needs the local AT network:
// `npm run stack:up`.
const env = loadLocalEnv();
const TOKEN = "integration-publisher-token";

beforeAll(async () => {
  const health = await fetch(`${env.PDS_URL}/xrpc/_health`).catch(() => null);
  if (health === null || !health.ok) {
    throw new Error(
      `No PDS at ${env.PDS_URL}. Start the local network with \`npm run stack:up\`.`,
    );
  }
});

test("the same workload and tampers give S0 and AT the same event CIDs", async () => {
  const stream = `bs${Date.now().toString(36)}`;
  const session = await login(env);
  const server = await startBaselineServer({ publisherToken: TOKEN });
  try {
    const s0 = baselineClient(server.url, TOKEN);

    // Publishing: the PDS and the baseline give every event the same CID.
    const onAt = await runPublish(
      { stream, count: 5, seed: 23 },
      { session, log: () => {} },
    );
    const onS0 = await publishWorkload(s0, { stream, count: 5, seed: 23 });
    expect(onS0).toEqual(onAt.map(({ seq, cid }) => ({ seq, cid })));

    // A suffix rewrite: the same new CIDs and the same new head.
    const rewrittenAt = await tamperRewrite(session, stream, 3);
    const rewrittenS0 = await s0.rewrite(stream, 3);
    expect(rewrittenS0.events).toEqual(rewrittenAt.events);
    expect(rewrittenS0.head).toEqual(rewrittenAt.head);

    // A truncation: both heads move back to the same event.
    const truncatedAt = await tamperTruncate(session, stream, 2);
    const truncatedS0 = await s0.truncate(stream, 2);
    expect(truncatedS0.head).toEqual(truncatedAt.head);

    // What differs is the proof: S0's head is signed by the configured key.
    const signed = await baselineClient(server.url).head(stream);
    const atHead = await readHead(session, stream);
    expect(signed.head).toEqual({
      stream,
      seq: atHead?.seq,
      eventCid: atHead?.eventCid,
    });
    expect(await verifyHead(server.publicKey, signed)).toBe(true);
  } finally {
    await server.close();
  }
});

import { loadLocalEnv, type Verdict } from "@trustlab/contracts";
import {
  atSource,
  auditStream,
  type BaselineClient,
  baselineClient,
  baselineSource,
  publishWorkload,
  type RunningBaseline,
  startBaselineServer,
} from "@trustlab/harness";
import {
  amendEvent,
  login,
  type PublisherSession,
  runPublish,
  tamperEdit,
  tamperRewrite,
  tamperTruncate,
} from "@trustlab/publisher";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

// A0 against S0 (#84): the same workload and the same tamper on the PDS and
// on the signed HTTP server, audited by a fresh consumer through each source.
// ADR-007 predicts the same verdict and reason on both. Needs the local AT
// network: `npm run stack:up`.
const env = loadLocalEnv();
const TOKEN = "integration-publisher-token";
const SEED = 29;
const WITHDRAWN_AT = "2026-11-27T00:00:00.000Z";

let session: PublisherSession;
let server: RunningBaseline;
let s0: BaselineClient;

beforeAll(async () => {
  const health = await fetch(`${env.PDS_URL}/xrpc/_health`).catch(() => null);
  if (health === null || !health.ok) {
    throw new Error(
      `No PDS at ${env.PDS_URL}. Start the local network with \`npm run stack:up\`.`,
    );
  }
  session = await login(env);
  server = await startBaselineServer({ publisherToken: TOKEN });
  s0 = baselineClient(server.url, TOKEN);
});

afterAll(async () => {
  await server.close();
});

/** One tamper, done the same way on both setups. */
interface Case {
  scenario: string;
  onAt: (stream: string) => Promise<unknown>;
  onS0: (stream: string) => Promise<unknown>;
  /** ADR-007's prediction for A0 and S0. */
  expected: Verdict;
}

const cases: Case[] = [
  {
    scenario: "interior-edit",
    onAt: (stream) => tamperEdit(session, stream, 2),
    onS0: (stream) => s0.edit(stream, 2),
    expected: {
      verdict: "conflict",
      reason: "broken-link",
      evidence: { seq: 3 },
    },
  },
  {
    scenario: "suffix-rewrite",
    onAt: (stream) => tamperRewrite(session, stream, 3),
    onS0: (stream) => s0.rewrite(stream, 3),
    expected: { verdict: "accept", reason: "no-witness" },
  },
  {
    scenario: "truncation",
    onAt: (stream) => tamperTruncate(session, stream, 3),
    onS0: (stream) => s0.truncate(stream, 3),
    expected: { verdict: "accept", reason: "no-witness" },
  },
  {
    scenario: "signed-withdrawal",
    onAt: (stream) =>
      amendEvent(session, {
        stream,
        kind: "withdraw",
        refSeq: 2,
        createdAt: WITHDRAWN_AT,
      }),
    // amendEvent copies the payload of the event it withdraws.
    onS0: async (stream) => {
      const target = (await s0.events(stream))[1];
      if (target === undefined) throw new Error(`${stream} has no seq 2`);
      return s0.append(stream, {
        kind: "withdraw",
        refSeq: 2,
        payload: target.record.payload,
        createdAt: WITHDRAWN_AT,
      });
    },
    expected: { verdict: "accept", reason: "no-witness" },
  },
];

describe("A0 and S0 give the same verdicts", () => {
  test.each(cases)(
    "$scenario",
    async ({ scenario, onAt, onS0, expected }) => {
      const stream = `src${scenario.slice(0, 3)}${Date.now().toString(36)}`;
      await runPublish(
        { stream, count: 5, seed: SEED },
        { session, log: () => {} },
      );
      await publishWorkload(s0, { stream, count: 5, seed: SEED });
      await onAt(stream);
      await onS0(stream);

      const a0 = atSource(env);
      const sZero = baselineSource({
        url: server.url,
        publicKey: server.publicKey,
      });
      // The same chain on both, so the auditor sees the same input.
      const [onPds, onBaseline] = await Promise.all([
        a0.read(stream),
        sZero.read(stream),
      ]);
      const cids = (read: typeof onPds) =>
        read === "unreachable" ? read : read.events.map((event) => event.cid);
      expect(cids(onBaseline)).toEqual(cids(onPds));

      expect(await auditStream(a0, stream)).toEqual(expected);
      expect(await auditStream(sZero, stream)).toEqual(expected);
    },
    30_000,
  );

  test("pds-unreachable", async () => {
    const stopped = await startBaselineServer({ publisherToken: TOKEN });
    const sZero = baselineSource({
      url: stopped.url,
      publicKey: stopped.publicKey,
    });
    await stopped.close();
    // Nothing listens on the stopped server's port, so the PDS is gone too.
    const a0 = atSource({ ...env, PDS_URL: stopped.url });

    const expected = { verdict: "unknown", reason: "pds-unreachable" };
    expect(await auditStream(a0, "releases")).toEqual(expected);
    expect(await auditStream(sZero, "releases")).toEqual(expected);
  });
});

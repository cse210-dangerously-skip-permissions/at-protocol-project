/**
 * Capture one real `#commit` frame for the tampered-commit fixtures (#51, AUD-2).
 *
 * Publishes one seeded event on a fresh stream, reads the raw
 * `subscribeRepos` frame for that commit, and writes it with the publisher's
 * signing key to `packages/auditor/test/fixtures/commit.json`. The test in
 * `packages/auditor/src/commit-fixtures.test.ts` reads that file offline.
 *
 * Run with the stack up: `npx tsx tools/harness/spikes/capture-commit.ts`.
 * Like the other spikes, nothing imports it and it has no unit tests.
 */

import { writeFile } from "node:fs/promises";
import { IdResolver } from "@atproto/identity";
import type { Cid } from "@atproto/lex-data";
import { formatDataKey } from "@atproto/repo";
import { Subscription } from "@atproto/xrpc-server";
import { EVENT_NSID, eventRkey, loadLocalEnv } from "@trustlab/contracts";
import { login, runPublish } from "@trustlab/publisher";

const METHOD = "com.atproto.sync.subscribeRepos";
const OUT = new URL(
  "../../../packages/auditor/test/fixtures/commit.json",
  import.meta.url,
);
const SEED = 51;
const WAIT_MS = 10_000;

/**
 * Turn a decoded frame into JSON: CIDs become strings, bytes become base64.
 *
 * @param value - Any part of the frame.
 * @returns The same value with only JSON types.
 */
function toJson(value: unknown): unknown {
  if (value instanceof Uint8Array) return Buffer.from(value).toString("base64");
  if (Array.isArray(value)) return value.map(toJson);
  if (typeof value === "object" && value !== null) {
    // A CID is the only object in a frame whose toString is its own.
    if ("multihash" in value) return (value as Cid).toString();
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, toJson(v)]),
    );
  }
  return value;
}

/** Publish one event, capture its commit frame, and write the fixture. */
async function main(): Promise<void> {
  const env = loadLocalEnv();
  const session = await login(env);
  const did = session.did;
  const stream = `fix${Date.now().toString(36)}`;
  const path = formatDataKey(EVENT_NSID, eventRkey(stream, 1));

  let frame: Record<string, unknown> | undefined;
  const abort = new AbortController();
  const sub = new Subscription<unknown>({
    service: env.PDS_URL.replace(/^http/, "ws"),
    method: METHOD,
    signal: abort.signal,
    validate: (value) => value,
  });
  const reading = (async () => {
    try {
      for await (const msg of sub) {
        const m = msg as Record<string, unknown>;
        const ops = Array.isArray(m.ops) ? (m.ops as { path?: unknown }[]) : [];
        if (
          m.$type === `${METHOD}#commit` &&
          m.repo === did &&
          ops.some((op) => op.path === path)
        ) {
          frame = m;
          abort.abort();
        }
      }
    } catch (error) {
      if (!abort.signal.aborted) console.error("subscription:", error);
    }
  })();

  // shortcut: the feed starts at the live tail, so wait for the socket to
  // open before publishing; raise this if the capture times out.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await runPublish(
    { stream, count: 1, seed: SEED },
    { session, log: (line) => console.log(line) },
  );
  const timer = setTimeout(() => abort.abort(), WAIT_MS);
  await reading;
  clearTimeout(timer);
  if (frame === undefined) throw new Error("the commit frame never arrived");

  // `$type` is added by Subscription; the message body has no such field.
  const body = { ...frame };
  delete body.$type;
  const signingKey = await new IdResolver({
    plcUrl: env.PLC_URL,
    fetch: globalThis.fetch,
  }).did.resolveAtprotoKey(did);
  await writeFile(
    OUT,
    `${JSON.stringify({ signingKey, commit: toJson(body) }, null, 2)}\n`,
  );
  console.log(`wrote ${OUT.pathname} (${did}, stream ${stream})`);
}

await main();

import { readFile } from "node:fs/promises";
import { parseCid } from "@atproto/lex-data";
import {
  BlockMap,
  blocksToCarFile,
  cborToLex,
  parseDataKey,
  readCarWithRoot,
} from "@atproto/repo";
import { parseCommitAuthenticated } from "@atproto/sync";
import { EVENT_NSID } from "@trustlab/contracts";
import { beforeAll, describe, expect, test } from "vitest";

// The verifier the consumer's firehose runs on every commit (#51, AUD-2).
type Resolver = Parameters<typeof parseCommitAuthenticated>[0];
type Commit = Parameters<typeof parseCommitAuthenticated>[1];

/** `test/fixtures/commit.json`, written by `tools/harness/spikes/capture-commit.ts`. */
interface Fixture {
  signingKey: string;
  commit: Omit<Commit, "commit" | "blocks" | "ops" | "prevData"> & {
    commit: string;
    blocks: string;
    prevData?: string;
    ops: { action: string; path: string; cid: string | null }[];
  };
}

let fixture: Fixture;
let resolver: Resolver;

beforeAll(async () => {
  fixture = JSON.parse(
    await readFile(
      new URL("../test/fixtures/commit.json", import.meta.url),
      "utf8",
    ),
  ) as Fixture;
  // Offline: always answer with the key saved at capture time.
  resolver = {
    did: { resolveAtprotoKey: () => Promise.resolve(fixture.signingKey) },
  } as unknown as Resolver;
});

/**
 * Rebuild the captured `#commit` message from its JSON form.
 *
 * @returns A fresh copy, safe to tamper with.
 */
function original(): Commit {
  const c = fixture.commit;
  return {
    ...c,
    commit: parseCid(c.commit),
    blocks: new Uint8Array(Buffer.from(c.blocks, "base64")),
    ...(c.prevData === undefined ? {} : { prevData: parseCid(c.prevData) }),
    ops: c.ops.map((op) => ({
      ...op,
      cid: op.cid === null ? null : parseCid(op.cid),
    })),
  } as Commit;
}

/**
 * The commit's event op, which every variant below tampers with.
 *
 * @param commit - The commit.
 * @returns The op that creates the event record.
 */
function eventOp(commit: Commit): Commit["ops"][number] {
  const op = commit.ops.find(
    (o) => parseDataKey(o.path).collection === EVENT_NSID,
  );
  if (!op?.cid) throw new Error("fixture has no event create");
  return op;
}

/**
 * Run the verifier on a commit.
 *
 * @param commit - The commit to verify.
 * @returns The verified writes.
 */
function verify(commit: Commit): ReturnType<typeof parseCommitAuthenticated> {
  return parseCommitAuthenticated(resolver, commit);
}

describe("tampered-commit fixtures", () => {
  test("accepts the original capture", async () => {
    const commit = original();
    const writes = await verify(commit);
    expect(writes.map((w) => `${w.collection}/${w.rkey}`)).toEqual(
      commit.ops.map((op) => op.path),
    );
    const event = writes.find((w) => w.collection === EVENT_NSID);
    expect(event?.event === "create" && event.record.seq).toBe(1);
  });

  test("rejects a bad signature", async () => {
    const commit = original();
    const car = await readCarWithRoot(commit.blocks);
    const signed = cborToLex(car.blocks.get(car.root) as Uint8Array) as {
      sig: Uint8Array;
    };
    const sig = Uint8Array.from(signed.sig);
    sig[0] = (sig[0] ?? 0) ^ 1;
    const blocks = new BlockMap(car.blocks);
    blocks.delete(car.root);
    // Re-root so every CID still matches its bytes; only the signature is wrong.
    commit.commit = await blocks.add({ ...signed, sig });
    commit.blocks = await blocksToCarFile(commit.commit, blocks);
    await expect(verify(commit)).rejects.toThrow(/Invalid signature/);
  });

  test("rejects changed record bytes under the same CID", async () => {
    const commit = original();
    const cid = eventOp(commit).cid;
    if (!cid) throw new Error("unreachable");
    const car = await readCarWithRoot(commit.blocks);
    const bytes = Uint8Array.from(car.blocks.get(cid) as Uint8Array);
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
    commit.blocks = await blocksToCarFile(
      car.root,
      new BlockMap(car.blocks).set(cid, bytes),
    );
    await expect(verify(commit)).rejects.toThrow(/Not a valid CID for bytes/);
  });

  test("drops an op whose CID differs from the proof", async () => {
    const commit = original();
    const op = eventOp(commit);
    const other = commit.ops.find((o) => o !== op)?.cid;
    if (!other) throw new Error("fixture needs a second op");
    op.cid = other;
    const writes = await verify(commit);
    // No error: the library silently leaves the op out (ADR-002).
    expect(writes.some((w) => w.collection === EVENT_NSID)).toBe(false);
    expect(writes).toHaveLength(commit.ops.length - 1);
  });

  test("rejects a commit claimed for another DID", async () => {
    const commit = original();
    commit.repo = "did:plc:notthepublisher";
    await expect(verify(commit)).rejects.toThrow(/Invalid repo did/);
  });
});

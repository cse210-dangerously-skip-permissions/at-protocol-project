import { createHash } from "node:crypto";
import { Secp256k1Keypair } from "@atproto/crypto";
import {
  blocksToCarFile,
  cidForRecord,
  concatBytesAsync,
  getFullRepo,
  MemoryBlockstore,
  readCarWithRoot,
  Repo,
  type RecordCreateOp,
  WriteOpAction,
} from "@atproto/repo";
import {
  ContractError,
  EVENT_NSID,
  eventRkey,
  HEAD_NSID,
  headRkey,
} from "@trustlab/contracts";
import { describe, expect, test } from "vitest";
import { fetchSnapshot, SnapshotError, verifySnapshot } from "./snapshot.js";

// A did:plc is 24 base32 characters; the PLC resolver checks the shape.
const DID = "did:plc:abcdefghijklmnopqrstuvwx";
const PDS_URL = "http://pds.example:2583";
const PLC_URL = "http://plc.example:2582";
// A fixed key and rev make every CID below the same on every run.
const REV = "3m5k2aaaaaa22";

/**
 * A secp256k1 key derived from a label, so tests need no random keys.
 *
 * @param label - Any text; the same label gives the same key.
 * @returns The keypair.
 */
function fixedKey(label: string): Promise<Secp256k1Keypair> {
  return Secp256k1Keypair.import(createHash("sha256").update(label).digest());
}

/** A signed repo as `getRepo` would serve it. */
interface Built {
  car: Uint8Array;
  commitCid: string;
  rev: string;
  /** Each record's CID, by `collection/rkey`. */
  cids: Map<string, string>;
}

/**
 * Build a publisher repo, signed in one commit: `count` linked events and a
 * head for each stream, plus any `extra` records.
 *
 * @param opts - The streams and their lengths, the signing key, the repo's
 *   DID, extra records, and an optional change to one event before signing.
 * @returns The repo as CAR bytes, with its commit and record CIDs.
 */
async function buildRepo(opts: {
  streams: Record<string, number>;
  key: Secp256k1Keypair;
  did?: string;
  extra?: RecordCreateOp[];
  editEvent?: (record: RecordCreateOp["record"]) => RecordCreateOp["record"];
}): Promise<Built> {
  const writes: RecordCreateOp[] = [];
  const cids = new Map<string, string>();
  const add = async (
    collection: RecordCreateOp["collection"],
    rkey: RecordCreateOp["rkey"],
    record: RecordCreateOp["record"],
  ) => {
    const cid = (await cidForRecord(record)).toString();
    cids.set(`${collection}/${rkey}`, cid);
    writes.push({ action: WriteOpAction.Create, collection, rkey, record });
    return cid;
  };

  for (const [stream, count] of Object.entries(opts.streams)) {
    let prevEventCid: string | undefined;
    for (let seq = 1; seq <= count; seq += 1) {
      const event = {
        $type: EVENT_NSID,
        stream,
        seq,
        ...(prevEventCid === undefined ? {} : { prevEventCid }),
        kind: "release",
        payload: { name: "pkg", version: `1.0.${seq}`, checksum: "sha256:00" },
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
      };
      const record = opts.editEvent?.(event) ?? event;
      prevEventCid = await add(EVENT_NSID, eventRkey(stream, seq), record);
    }
    if (prevEventCid !== undefined) {
      await add(HEAD_NSID, headRkey(stream), {
        $type: HEAD_NSID,
        stream,
        seq: count,
        eventCid: prevEventCid,
      });
    }
  }
  for (const write of opts.extra ?? []) {
    await add(write.collection, write.rkey, write.record);
  }

  const storage = new MemoryBlockstore();
  const commit = await Repo.formatInitCommit(
    storage,
    opts.did ?? DID,
    opts.key,
    writes,
    REV,
  );
  const repo = await Repo.createFromCommit(storage, commit);
  return {
    car: await concatBytesAsync(getFullRepo(storage, repo.cid)),
    commitCid: repo.cid.toString(),
    rev: repo.commit.rev,
    cids,
  };
}

/**
 * The PLC's DID document for `DID`, naming `key` as its atproto signing key.
 *
 * @param key - The key the document names.
 * @returns The document, as the PLC serves it.
 */
function didDocument(key: Secp256k1Keypair) {
  return {
    "@context": ["https://www.w3.org/ns/did/v1"],
    id: DID,
    alsoKnownAs: ["at://publisher.test"],
    verificationMethod: [
      {
        id: `${DID}#atproto`,
        type: "Multikey",
        controller: DID,
        publicKeyMultibase: key.did().slice("did:key:".length),
      },
    ],
    service: [
      {
        id: "#atproto_pds",
        type: "AtprotoPersonalDataServer",
        serviceEndpoint: PDS_URL,
      },
    ],
  };
}

/**
 * A fake network with one PDS and one PLC. Each answer can be replaced.
 *
 * @param opts - What `getRepo` and the PLC return, or `"down"` to throw.
 * @returns A `fetch` for `fetchSnapshot`, and the URLs it was called with.
 */
function fakeNetwork(opts: {
  repo: Response | "down";
  plc: Response | "down";
}) {
  const requests: string[] = [];
  const fetch: typeof globalThis.fetch = async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    requests.push(url);
    const answer = url.startsWith(PDS_URL) ? opts.repo : opts.plc;
    if (answer === "down") throw new TypeError("fetch failed");
    return answer;
  };
  return { fetch, requests };
}

/**
 * An HTTP response carrying CAR bytes.
 *
 * @param car - The bytes.
 * @returns A 200 response.
 */
function carResponse(car: Uint8Array): Response {
  return new Response(car.slice(), {
    headers: { "content-type": "application/vnd.ipld.car" },
  });
}

describe("verifySnapshot", () => {
  test("returns every event with its CID, and each stream's head", async () => {
    const key = await fixedKey("publisher");
    const built = await buildRepo({ streams: { releases: 3 }, key });

    const snapshot = await verifySnapshot(built.car, DID, key.did());

    expect(snapshot.did).toBe(DID);
    expect(snapshot.rev).toBe(built.rev);
    expect(snapshot.commitCid).toBe(built.commitCid);
    expect(snapshot.events.map((e) => [e.seq, e.cid])).toEqual(
      [1, 2, 3].map((seq) => [
        seq,
        built.cids.get(`${EVENT_NSID}/${eventRkey("releases", seq)}`),
      ]),
    );
    const [first] = snapshot.events;
    expect(first).toMatchObject({
      did: DID,
      stream: "releases",
      seq: 1,
      rkey: eventRkey("releases", 1),
      record: { $type: EVENT_NSID, stream: "releases", seq: 1 },
    });
    expect(snapshot.head).toEqual({
      releases: {
        $type: HEAD_NSID,
        stream: "releases",
        seq: 3,
        eventCid: built.cids.get(`${EVENT_NSID}/${eventRkey("releases", 3)}`),
      },
    });
  });

  test("orders events by stream, then seq, and keeps a head per stream", async () => {
    const key = await fixedKey("publisher");
    const built = await buildRepo({ streams: { zeta: 2, alpha: 12 }, key });

    const snapshot = await verifySnapshot(built.car, DID, key.did());

    expect(snapshot.events.map((e) => `${e.stream}:${e.seq}`)).toEqual([
      ...Array.from({ length: 12 }, (_, i) => `alpha:${i + 1}`),
      "zeta:1",
      "zeta:2",
    ]);
    expect(Object.keys(snapshot.head).sort()).toEqual(["alpha", "zeta"]);
    expect(snapshot.head.alpha?.seq).toBe(12);
  });

  test("leaves out records in other collections", async () => {
    const key = await fixedKey("publisher");
    const built = await buildRepo({
      streams: { releases: 1 },
      key,
      extra: [
        {
          action: WriteOpAction.Create,
          collection: "app.bsky.feed.post",
          rkey: "3m5k2aaaaaa22",
          record: {
            $type: "app.bsky.feed.post",
            text: "hi",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        },
      ],
    });

    const snapshot = await verifySnapshot(built.car, DID, key.did());

    expect(snapshot.events).toHaveLength(1);
    expect(Object.keys(snapshot.head)).toEqual(["releases"]);
  });

  test("returns an empty snapshot for a repo with none of our records", async () => {
    const key = await fixedKey("publisher");
    const built = await buildRepo({ streams: {}, key });

    const snapshot = await verifySnapshot(built.car, DID, key.did());

    expect(snapshot.events).toEqual([]);
    expect(snapshot.head).toEqual({});
    expect(snapshot.commitCid).toBe(built.commitCid);
  });

  test("rejects a CAR with one flipped byte", async () => {
    const key = await fixedKey("publisher");
    const built = await buildRepo({ streams: { releases: 3 }, key });
    const car = built.car.slice();
    const last = car.length - 1;
    car[last] = (car[last] ?? 0) ^ 0x01;

    await expect(verifySnapshot(car, DID, key.did())).rejects.toMatchObject({
      name: "SnapshotError",
      problem: "invalid-repo",
    });
  });

  test("rejects a repo signed by another key", async () => {
    const key = await fixedKey("publisher");
    const other = await fixedKey("someone else");
    const built = await buildRepo({ streams: { releases: 1 }, key: other });

    const rejection = verifySnapshot(built.car, DID, key.did());

    await expect(rejection).rejects.toBeInstanceOf(SnapshotError);
    await expect(rejection).rejects.toThrow(/Invalid signature/);
  });

  test("rejects a repo that belongs to another DID", async () => {
    const key = await fixedKey("publisher");
    const built = await buildRepo({
      streams: { releases: 1 },
      key,
      did: "did:plc:zzzzzzzzzzzzzzzzzzzzzzzz",
    });

    await expect(verifySnapshot(built.car, DID, key.did())).rejects.toThrow(
      /Invalid repo did/,
    );
  });

  test("rejects a CAR with a record block missing", async () => {
    const key = await fixedKey("publisher");
    const built = await buildRepo({ streams: { releases: 2 }, key });
    const { root, blocks } = await readCarWithRoot(built.car);
    const missing = built.cids.get(`${EVENT_NSID}/${eventRkey("releases", 1)}`);
    const cid = blocks.cids().find((c) => c.toString() === missing);
    if (cid === undefined) throw new Error("fixture has no such block");
    blocks.delete(cid);

    await expect(
      verifySnapshot(await blocksToCarFile(root, blocks), DID, key.did()),
    ).rejects.toMatchObject({ problem: "invalid-repo" });
  });

  test("rejects a signed event that breaks the contract", async () => {
    const key = await fixedKey("publisher");
    const built = await buildRepo({
      streams: { releases: 1 },
      key,
      editEvent: (record) => ({ ...record, kind: "rewrite" }),
    });

    await expect(
      verifySnapshot(built.car, DID, key.did()),
    ).rejects.toBeInstanceOf(ContractError);
  });
});

describe("fetchSnapshot", () => {
  test("downloads the repo with getRepo and checks it with the PLC's key", async () => {
    const key = await fixedKey("publisher");
    const built = await buildRepo({ streams: { releases: 5 }, key });
    const net = fakeNetwork({
      repo: carResponse(built.car),
      plc: Response.json(didDocument(key)),
    });

    const snapshot = await fetchSnapshot({
      pdsUrl: PDS_URL,
      plcUrl: PLC_URL,
      did: DID,
      fetch: net.fetch,
    });

    expect(snapshot.events).toHaveLength(5);
    expect(snapshot.commitCid).toBe(built.commitCid);
    expect(net.requests).toContain(
      `${PDS_URL}/xrpc/com.atproto.sync.getRepo?did=${encodeURIComponent(DID)}`,
    );
    expect(net.requests).toContain(`${PLC_URL}/${encodeURIComponent(DID)}`);
  });

  test("rejects a repo the PDS signed with a key the DID document does not name", async () => {
    const key = await fixedKey("publisher");
    const swapped = await fixedKey("pds swapped in its own key");
    const built = await buildRepo({ streams: { releases: 1 }, key: swapped });
    const net = fakeNetwork({
      repo: carResponse(built.car),
      plc: Response.json(didDocument(key)),
    });

    await expect(
      fetchSnapshot({
        pdsUrl: PDS_URL,
        plcUrl: PLC_URL,
        did: DID,
        fetch: net.fetch,
      }),
    ).rejects.toMatchObject({ problem: "invalid-repo" });
  });

  test("reports pds-unreachable when the PDS cannot be reached", async () => {
    const key = await fixedKey("publisher");
    const net = fakeNetwork({
      repo: "down",
      plc: Response.json(didDocument(key)),
    });

    await expect(
      fetchSnapshot({
        pdsUrl: PDS_URL,
        plcUrl: PLC_URL,
        did: DID,
        fetch: net.fetch,
      }),
    ).rejects.toMatchObject({ problem: "pds-unreachable" });
  });

  test("reports pds-unreachable when getRepo returns an error", async () => {
    const key = await fixedKey("publisher");
    const net = fakeNetwork({
      repo: Response.json(
        { error: "RepoNotFound", message: "Could not find repo" },
        { status: 400 },
      ),
      plc: Response.json(didDocument(key)),
    });

    await expect(
      fetchSnapshot({
        pdsUrl: PDS_URL,
        plcUrl: PLC_URL,
        did: DID,
        fetch: net.fetch,
      }),
    ).rejects.toThrow(/getRepo returned 400/);
  });

  test("reports did-unresolved when the PLC has no such DID", async () => {
    const key = await fixedKey("publisher");
    const built = await buildRepo({ streams: { releases: 1 }, key });
    const net = fakeNetwork({
      repo: carResponse(built.car),
      plc: new Response("not found", { status: 404 }),
    });

    await expect(
      fetchSnapshot({
        pdsUrl: PDS_URL,
        plcUrl: PLC_URL,
        did: DID,
        fetch: net.fetch,
      }),
    ).rejects.toMatchObject({ problem: "did-unresolved" });
  });

  test("reports did-unresolved when the PLC cannot be reached", async () => {
    const key = await fixedKey("publisher");
    const built = await buildRepo({ streams: { releases: 1 }, key });
    const net = fakeNetwork({ repo: carResponse(built.car), plc: "down" });

    await expect(
      fetchSnapshot({
        pdsUrl: PDS_URL,
        plcUrl: PLC_URL,
        did: DID,
        fetch: net.fetch,
      }),
    ).rejects.toMatchObject({ problem: "did-unresolved" });
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseCheckpointsResponse,
  type WitnessCheckpoint,
} from "@trustlab/contracts";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { CheckpointStore } from "./store.js";

const DID = "did:plc:publisher";
const STREAM = "releases";
const CID = "bafyreie5737gdxlw5i64vzichcalba3z2v5n6icifviwxc4b5mmd6iurgy";

/**
 * Build a checkpoint for `seq`. `commit` names the commit, so two calls
 * with the same seq and different `commit` model a rewritten head.
 */
function checkpoint(seq: number, commit = `c${seq}`): WitnessCheckpoint {
  return {
    did: DID,
    stream: STREAM,
    seq,
    eventCid: CID,
    headCid: CID,
    commitCid: `${CID}-${commit}`,
    rev: `rev-${commit}`,
    proofCar: "OqJlcm9vdHM=",
    signingKey: "did:key:zQ3shXjHeiBuRCKmM36cuYnm7YEMzhGnCmCyW92sRJ9pribSF",
    observedAt: `2026-11-19T18:00:0${seq}.000Z`,
  };
}

let dir: string;
let dbPath: string;
let store: CheckpointStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "witness-store-"));
  dbPath = join(dir, "witness.sqlite");
  store = new CheckpointStore(dbPath);
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("CheckpointStore", () => {
  test("starts empty", () => {
    expect(store.list(DID, STREAM)).toEqual([]);
    expect(store.latest(DID, STREAM)).toBeNull();
  });

  test("round-trips every field", () => {
    const cp = checkpoint(1);
    expect(store.add(cp)).toBe("stored");
    expect(store.list(DID, STREAM)).toEqual([cp]);
    expect(store.latest(DID, STREAM)).toEqual(cp);
  });

  test("adding the same checkpoint twice returns duplicate and keeps the first", () => {
    const first = checkpoint(1);
    expect(store.add(first)).toBe("stored");
    expect(
      store.add({ ...first, observedAt: "2026-11-20T00:00:00.000Z" }),
    ).toBe("duplicate");
    expect(store.list(DID, STREAM)).toEqual([first]);
  });

  test("keeps two different commits at one seq", () => {
    expect(store.add(checkpoint(2, "original"))).toBe("stored");
    expect(store.add(checkpoint(2, "rewrite"))).toBe("stored");
    expect(store.list(DID, STREAM).map((cp) => cp.commitCid)).toEqual([
      `${CID}-rewrite`,
      `${CID}-original`,
    ]);
  });

  test("lists newest first", () => {
    for (const seq of [1, 2, 3]) {
      store.add(checkpoint(seq));
    }
    expect(store.list(DID, STREAM).map((cp) => cp.seq)).toEqual([3, 2, 1]);
    expect(store.latest(DID, STREAM)?.seq).toBe(3);
  });

  test("orders by when it was seen, so a rollback is the latest", () => {
    store.add(checkpoint(5));
    store.add(checkpoint(3, "rollback"));
    expect(store.latest(DID, STREAM)?.commitCid).toBe(`${CID}-rollback`);
    expect(store.list(DID, STREAM).map((cp) => cp.seq)).toEqual([3, 5]);
  });

  test("keeps DIDs and streams apart", () => {
    store.add(checkpoint(1));
    store.add({ ...checkpoint(1), did: "did:plc:other" });
    store.add({ ...checkpoint(1), stream: "other" });
    expect(store.list(DID, STREAM)).toHaveLength(1);
    expect(store.list(DID, "missing")).toEqual([]);
    expect(store.latest("did:plc:missing", STREAM)).toBeNull();
  });

  test("keeps checkpoints across a reopen", () => {
    store.add(checkpoint(1));
    store.add(checkpoint(2));
    store.close();
    store = new CheckpointStore(dbPath);
    expect(store.list(DID, STREAM).map((cp) => cp.seq)).toEqual([2, 1]);
    expect(store.add(checkpoint(2))).toBe("duplicate");
  });

  test("rejects a seq below 1", () => {
    expect(() => store.add(checkpoint(0))).toThrow();
    expect(store.list(DID, STREAM)).toEqual([]);
  });

  test("list output passes the CheckpointsResponse validator", () => {
    store.add(checkpoint(1));
    store.add(checkpoint(2));
    const response = { checkpoints: store.list(DID, STREAM) };
    expect(parseCheckpointsResponse(response)).toBe(response);
  });
});

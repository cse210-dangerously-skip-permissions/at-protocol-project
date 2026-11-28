import * as auditor from "@trustlab/auditor";
import { DidResolver } from "@atproto/identity";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { auditAll, auditStream, witnessClient } from "./audit.js";
import { ConsumerStore } from "./store.js";

const did = "did:example:publisher";
const stream = "release";
let store: ConsumerStore;
beforeEach(() => {
  store = new ConsumerStore(":memory:");
});
const url = "http://witness.test";
afterEach(() => {
  store.close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("reads only the requested checkpoints and treats invalid or unavailable evidence as unknown", async () => {
  const request = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", request);
  const witness = witnessClient(url, "http://plc.test");
  for (const [response, verdict, reason] of [
    [Response.json({ checkpoints: [] }), "accept", "no-witness"],
    [Response.json({}), "unknown", "bad-evidence"],
    [new Response("{"), "unknown", "bad-evidence"],
    [new Response(null, { status: 503 }), "unknown", "witness-unreachable"],
  ] as const) {
    request.mockResolvedValueOnce(response);
    expect(await auditStream(store, did, stream, witness)).toEqual({
      verdict,
      reason,
    });
    expect(store.latestVerdicts()[0]).toMatchObject({
      did,
      stream,
      verifiedAsOf: null,
      verdict: { verdict, reason },
    });
  }
  expect(String(request.mock.calls[0]?.[0])).toBe(
    url + "/checkpoints?did=did%3Aexample%3Apublisher&stream=release",
  );
});

const cp = {
  did,
  stream,
  seq: 1,
  eventCid: "cid",
  headCid: "head",
  commitCid: "commit",
  rev: "rev",
  proofCar: "car",
  signingKey: "untrusted",
  observedAt: "then",
};

test("shares one key lookup across proofs and resolves again after failure or rotation", async () => {
  const resolved = vi
    .spyOn(DidResolver.prototype, "resolveAtprotoKey")
    .mockResolvedValue("resolved-key");
  const offline = vi
    .spyOn(auditor, "verifyCheckpoint")
    .mockResolvedValue(false);
  const next = { ...cp, seq: 2, eventCid: "next-cid" };
  vi.stubGlobal("fetch", async () =>
    Response.json({ checkpoints: [cp, next] }),
  );
  const client = witnessClient(url, "http://plc.test");
  resolved.mockRejectedValueOnce(new Error("PLC unavailable"));
  expect((await auditStream(store, did, stream, client)).reason).toBe(
    "bad-evidence",
  );
  expect(resolved).toHaveBeenCalledTimes(1);
  expect(offline).not.toHaveBeenCalled();

  await auditStream(store, did, stream, client);
  expect(resolved).toHaveBeenCalledTimes(2);
  expect(offline).toHaveBeenCalledTimes(2);
  for (const checkpoint of [cp, next]) {
    expect(offline).toHaveBeenCalledWith({
      ...checkpoint,
      signingKey: "resolved-key",
    });
  }
  resolved.mockResolvedValue("rotated-key");
  await auditStream(store, did, stream, client);
  expect(resolved).toHaveBeenCalledTimes(3);
  expect(offline).toHaveBeenCalledWith({ ...next, signingKey: "rotated-key" });
});

test("verification binds even empty streams to the requested DID and stream", async () => {
  const verify = vi.fn().mockResolvedValue(true);
  const checkpoints = vi.fn().mockResolvedValue([cp]);
  await auditStream(store, did, stream);
  await auditAll(store, { checkpoints, verify });
  expect(store.latestVerdicts()[0]?.verdict.reason).toBe("truncated");
  checkpoints.mockResolvedValue([{ ...cp, did: "did:example:other" }]);
  expect(
    (await auditStream(store, did, stream, { checkpoints, verify })).reason,
  ).toBe("bad-evidence");
  expect(verify).toHaveBeenCalledTimes(1);
});

test("rechecks the chain when a rebuild advances the revision during a witness request", async () => {
  const checkpoints = vi
    .fn()
    .mockImplementationOnce(async () => {
      store.replaceRepo(did, "b", [
        { did, stream, seq: 2, rkey: "e", cid: "cid", record: { seq: 2 } },
      ]);
      return [];
    })
    .mockResolvedValue([]);
  expect(
    await auditStream(store, did, stream, { checkpoints, verify: vi.fn() }),
  ).toMatchObject({ verdict: "conflict", reason: "bad-genesis" });
  expect(store.latestVerdicts()[0]?.verdict.reason).toBe("bad-genesis");
});

import { describe, expect, test } from "vitest";
import type { WitnessCheckpoint } from "./types.js";
import {
  ContractError,
  parseCheckpointsResponse,
  parseEventRecord,
  parseHeadRecord,
  parseWitnessCheckpoint,
} from "./validate.js";

const CID = "bafyreidfayvfuwqa7qlnopdjiqrxzs6blmoeu4rujcjtnci5beludirz2a";

const first = {
  $type: "dev.trustlab.event",
  stream: "releases",
  seq: 1,
  kind: "release",
  payload: { name: "left-pad", version: "1.0.0", checksum: "sha256:aa" },
  createdAt: "2026-11-11T18:00:00.000Z",
};
const second = { ...first, seq: 2, prevEventCid: CID };
const withdrawal = { ...second, seq: 3, kind: "withdraw", refSeq: 2 };

describe("parseEventRecord", () => {
  test.each([
    ["the first event", first, "releases-000000000001"],
    ["a later event", second, "releases-000000000002"],
    ["a withdrawal", withdrawal, "releases-000000000003"],
    ["a correction", { ...withdrawal, kind: "correct" }, undefined],
  ])("accepts %s", (_name, record, rkey) => {
    expect(parseEventRecord(record, rkey)).toBe(record);
  });

  test.each([
    ["a missing $type", { ...first, $type: undefined }, "$type"],
    [
      "a missing payload field",
      { ...first, payload: { name: "x" } },
      "version",
    ],
    ["seq 0", { ...first, seq: 0 }, "seq"],
    ["a fractional seq", { ...first, seq: 1.5 }, "seq"],
    ["a seq too long for the key", { ...second, seq: 1e12 }, "out of range"],
    ["a bad stream name", { ...first, stream: "my-stream" }, "stream name"],
    ["an unknown kind", { ...first, kind: "retract" }, "unknown kind"],
    ["a link on seq 1", { ...first, prevEventCid: CID }, "seq 1"],
    ["no link after seq 1", { ...first, seq: 2 }, "prevEventCid"],
    ["a link that is not a CID", { ...second, prevEventCid: "abc" }, "cid"],
    ["a release with refSeq", { ...second, refSeq: 1 }, "refSeq"],
    [
      "a withdrawal without refSeq",
      { ...withdrawal, refSeq: undefined },
      "refSeq",
    ],
    ["a withdrawal of a later event", { ...withdrawal, refSeq: 3 }, "refSeq"],
    ["a bad date", { ...first, createdAt: "yesterday" }, "createdAt"],
    ["something that is not an object", "event", "event record"],
  ])("rejects %s", (_name, record, message) => {
    expect(() => parseEventRecord(record)).toThrow(ContractError);
    expect(() => parseEventRecord(record)).toThrow(message);
  });

  test("rejects a record stored under the wrong key", () => {
    expect(() => parseEventRecord(second, "releases-000000000003")).toThrow(
      "does not match",
    );
    expect(() => parseEventRecord(second, "builds-000000000002")).toThrow(
      ContractError,
    );
  });
});

describe("parseHeadRecord", () => {
  const head = {
    $type: "dev.trustlab.head",
    stream: "releases",
    seq: 2,
    eventCid: CID,
  };

  test("accepts a head, with or without its key", () => {
    expect(parseHeadRecord(head)).toBe(head);
    expect(parseHeadRecord(head, "head-releases")).toBe(head);
  });

  test.each([
    ["a missing eventCid", { ...head, eventCid: undefined }, "eventCid"],
    ["an eventCid that is not a CID", { ...head, eventCid: "abc" }, "cid"],
    ["seq 0", { ...head, seq: 0 }, "seq"],
    ["a seq too long for the key", { ...head, seq: 1e12 }, "out of range"],
    ["a bad stream name", { ...head, stream: "Releases" }, "stream name"],
  ])("rejects %s", (_name, record, message) => {
    expect(() => parseHeadRecord(record)).toThrow(ContractError);
    expect(() => parseHeadRecord(record)).toThrow(message);
  });

  test("rejects a head stored under the wrong key", () => {
    expect(() => parseHeadRecord(head, "head-builds")).toThrow(
      "does not match",
    );
  });
});

describe("witness checkpoints", () => {
  const checkpoint: WitnessCheckpoint = {
    did: "did:plc:yke7faifuyp4lwaz7s3bg5ks",
    stream: "releases",
    seq: 2,
    eventCid: CID,
    headCid: CID,
    commitCid: CID,
    rev: "3m4abcdefgh2x",
    proofCar: "OqJlcm9vdHM=",
    signingKey: "did:key:zQ3shXjHeiBuRCKmM36cuYnm7YEMzhGnCmCyW92sRJ9pribSF",
    observedAt: "2026-11-11T18:00:01.000Z",
  };

  test("accepts a checkpoint and a response", () => {
    expect(parseWitnessCheckpoint(checkpoint)).toBe(checkpoint);
    const response = { checkpoints: [checkpoint, checkpoint] };
    expect(parseCheckpointsResponse(response)).toBe(response);
    expect(parseCheckpointsResponse({ checkpoints: [] }).checkpoints).toEqual(
      [],
    );
  });

  test.each([
    ["null", null, "not an object"],
    ["a missing proof", { ...checkpoint, proofCar: undefined }, "proofCar"],
    ["an empty signing key", { ...checkpoint, signingKey: "" }, "signingKey"],
    ["a string seq", { ...checkpoint, seq: "2" }, "seq"],
    ["seq 0", { ...checkpoint, seq: 0 }, "seq"],
    ["a bad stream name", { ...checkpoint, stream: "a-b" }, "stream name"],
  ])("rejects %s", (_name, value, message) => {
    expect(() => parseWitnessCheckpoint(value)).toThrow(ContractError);
    expect(() => parseWitnessCheckpoint(value)).toThrow(message);
  });

  test.each([
    ["null", null],
    ["a bare array", [checkpoint]],
    ["one malformed checkpoint", { checkpoints: [checkpoint, { did: "x" }] }],
  ])("rejects a response that is %s", (_name, value) => {
    expect(() => parseCheckpointsResponse(value)).toThrow(ContractError);
  });
});

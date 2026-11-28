import {
  EVENT_NSID,
  eventRkey,
  HEAD_NSID,
  type EventRecord,
  type HeadRecord,
  type StoredEvent,
  type WitnessCheckpoint,
} from "@trustlab/contracts";
import { describe, expect, test, vi } from "vitest";
import { compareWithWitness } from "./witness.js";

const DID = "did:plc:publisher";
const STREAM = "releases";
const SUBJECT = { did: DID, stream: STREAM };

/**
 * A stored event linked to `cid-<seq - 1>`, with the CID `cid-<seq>` unless
 * `cid` says otherwise.
 *
 * @param seq - Event position.
 * @param cid - The event's CID.
 * @param prev - The CID it links to.
 * @returns The event.
 */
function event(
  seq: number,
  cid = `cid-${seq}`,
  prev = `cid-${seq - 1}`,
): StoredEvent {
  const record: EventRecord = {
    $type: EVENT_NSID,
    stream: STREAM,
    seq,
    ...(seq === 1 ? {} : { prevEventCid: prev }),
    kind: "release",
    payload: { name: "pkg", version: `1.0.${seq}`, checksum: `sha256:${seq}` },
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
  };
  return {
    did: DID,
    stream: STREAM,
    seq,
    rkey: eventRkey(STREAM, seq),
    cid,
    record,
  };
}

/**
 * A valid chain `cid-1` to `cid-<length>`.
 *
 * @param length - How many events.
 * @returns The events, lowest seq first.
 */
function chain(length: number): StoredEvent[] {
  return Array.from({ length }, (_unused, index) => event(index + 1));
}

/**
 * The chain after a suffix rewrite from `from`: valid links, new CIDs.
 *
 * @param length - How many events.
 * @param from - The first rewritten seq.
 * @returns The events, lowest seq first.
 */
function rewritten(length: number, from: number): StoredEvent[] {
  const cid = (seq: number) => (seq < from ? `cid-${seq}` : `new-${seq}`);
  return Array.from({ length }, (_unused, index) =>
    event(index + 1, cid(index + 1), cid(index)),
  );
}

/**
 * A checkpoint of the head at `seq`. The proof is not real: tests pass a
 * stub `verify`.
 *
 * @param seq - The witnessed seq.
 * @param change - Fields to override.
 * @returns The checkpoint.
 */
function checkpoint(
  seq: number,
  change: Partial<WitnessCheckpoint> = {},
): WitnessCheckpoint {
  return {
    did: DID,
    stream: STREAM,
    seq,
    eventCid: `cid-${seq}`,
    headCid: `head-${seq}`,
    commitCid: `commit-${seq}`,
    rev: `rev-${seq}`,
    proofCar: "",
    signingKey: "did:key:zStub",
    observedAt: new Date(Date.UTC(2026, 0, 1, 0, 1, seq)).toISOString(),
    ...change,
  };
}

/** Checkpoints of every head from 1 to `to`, newest first as the witness lists them. */
function seen(to: number): WitnessCheckpoint[] {
  return Array.from({ length: to }, (_unused, index) => checkpoint(to - index));
}

const valid = async () => true;

describe("compareWithWitness", () => {
  test("accepts a chain that extends every checkpoint", async () => {
    expect(await compareWithWitness(SUBJECT, chain(5), seen(5), valid)).toEqual(
      {
        verdict: "accept",
        reason: "extends-witness",
      },
    );
    // A signed withdrawal is a new event after the witnessed head.
    expect(await compareWithWitness(SUBJECT, chain(6), seen(5), valid)).toEqual(
      {
        verdict: "accept",
        reason: "extends-witness",
      },
    );
  });

  test("gives a chain-only accept with no checkpoints", async () => {
    const verify = vi.fn(valid);
    expect(await compareWithWitness(SUBJECT, chain(3), [], verify)).toEqual({
      verdict: "accept",
      reason: "no-witness",
    });
    expect(verify).not.toHaveBeenCalled();
  });

  test("reports a rewrite at the first witnessed seq that changed", async () => {
    expect(
      await compareWithWitness(SUBJECT, rewritten(5, 3), seen(5), valid),
    ).toEqual({
      verdict: "conflict",
      reason: "rewritten",
      evidence: { seq: 3, witnessedCid: "cid-3", currentCid: "new-3" },
    });
  });

  test("reports a head below a witnessed seq as truncated", async () => {
    expect(await compareWithWitness(SUBJECT, chain(3), seen(5), valid)).toEqual(
      {
        verdict: "conflict",
        reason: "truncated",
        evidence: { seq: 4, witnessedCid: "cid-4" },
      },
    );
    // Deleting every event is a truncation too.
    expect(await compareWithWitness(SUBJECT, [], seen(2), valid)).toEqual({
      verdict: "conflict",
      reason: "truncated",
      evidence: { seq: 1, witnessedCid: "cid-1" },
    });
  });

  test("catches a rewrite the newest checkpoint already saw", async () => {
    // The witness saw 1-5, then the rewritten head at 5. The newest checkpoint
    // matches the current chain; the older ones do not.
    const checkpoints = [checkpoint(5, { eventCid: "new-5" }), ...seen(5)];
    expect(
      await compareWithWitness(SUBJECT, rewritten(5, 4), checkpoints, valid),
    ).toMatchObject({
      verdict: "conflict",
      reason: "rewritten",
      evidence: { seq: 4 },
    });
  });

  test("gives the same verdict for any input order", async () => {
    const events = rewritten(6, 2);
    const checkpoints = [...seen(6), checkpoint(6, { eventCid: "new-6" })];
    const expected = await compareWithWitness(
      SUBJECT,
      events,
      checkpoints,
      valid,
    );
    expect(expected).toMatchObject({
      reason: "rewritten",
      evidence: { seq: 2 },
    });
    expect(
      await compareWithWitness(
        SUBJECT,
        [...events].reverse(),
        [...checkpoints].reverse(),
        valid,
      ),
    ).toEqual(expected);
  });

  test("returns the chain's own conflict unchanged, without the witness", async () => {
    const broken = chain(4);
    broken[2] = event(3, "cid-3", "someone-else");
    const verify = vi.fn(valid);
    expect(await compareWithWitness(SUBJECT, broken, seen(4), verify)).toEqual({
      verdict: "conflict",
      reason: "broken-link",
      evidence: { seq: 3 },
    });
    // Rule 1 comes before rule 2: an unreachable witness doesn't hide it.
    expect(
      await compareWithWitness(SUBJECT, broken, "unreachable", verify),
    ).toEqual({
      verdict: "conflict",
      reason: "broken-link",
      evidence: { seq: 3 },
    });
    expect(verify).not.toHaveBeenCalled();
  });

  test("checks the head record when one is passed", async () => {
    const head: HeadRecord = {
      $type: HEAD_NSID,
      stream: STREAM,
      seq: 2,
      eventCid: "cid-2",
    };
    expect(
      await compareWithWitness(SUBJECT, chain(3), [], valid, head),
    ).toEqual({
      verdict: "conflict",
      reason: "head-mismatch",
      evidence: { seq: 2 },
    });
    expect(
      await compareWithWitness(SUBJECT, chain(2), seen(2), valid, head),
    ).toEqual({
      verdict: "accept",
      reason: "extends-witness",
    });
  });

  test("is unknown when the PDS or the witness can't be read", async () => {
    expect(
      await compareWithWitness(SUBJECT, "unreachable", seen(2), valid),
    ).toEqual({
      verdict: "unknown",
      reason: "pds-unreachable",
    });
    expect(
      await compareWithWitness(SUBJECT, chain(2), "unreachable", valid),
    ).toEqual({
      verdict: "unknown",
      reason: "witness-unreachable",
    });
  });

  test("never turns a checkpoint that fails verification into a conflict", async () => {
    // A forged checkpoint claims a higher head and another CID at seq 2.
    const forged = [checkpoint(9), checkpoint(2, { eventCid: "forged" })];
    const verify = async (cp: WitnessCheckpoint) =>
      cp.seq !== 9 && cp.eventCid !== "forged";
    expect(
      await compareWithWitness(
        SUBJECT,
        chain(3),
        [...seen(3), ...forged],
        verify,
      ),
    ).toEqual({
      verdict: "unknown",
      reason: "bad-evidence",
      evidence: { seq: 2, witnessedCid: "forged" },
    });
  });

  test("reports a verified conflict even when another checkpoint is bad", async () => {
    const verify = async (cp: WitnessCheckpoint) => cp.seq !== 1;
    expect(
      await compareWithWitness(SUBJECT, chain(2), seen(4), verify),
    ).toMatchObject({
      verdict: "conflict",
      reason: "truncated",
      evidence: { seq: 3 },
    });
  });

  test("treats a verifier that throws as a failed check", async () => {
    const verify = async () => {
      throw new Error("plc down");
    };
    expect(
      await compareWithWitness(SUBJECT, chain(2), seen(2), verify),
    ).toEqual({
      verdict: "unknown",
      reason: "bad-evidence",
      evidence: { seq: 1, witnessedCid: "cid-1" },
    });
  });

  test("won't compare against a verified checkpoint from another stream", async () => {
    // A witness answers with a real, signed head from a longer stream.
    const other = checkpoint(7, { stream: "other" });
    expect(await compareWithWitness(SUBJECT, chain(3), [other], valid)).toEqual(
      {
        verdict: "unknown",
        reason: "bad-evidence",
        evidence: { seq: 7, witnessedCid: "cid-7" },
      },
    );
    const otherDid = checkpoint(7, { did: "did:plc:someone" });
    expect(
      await compareWithWitness(SUBJECT, chain(3), [otherDid], valid),
    ).toMatchObject({ reason: "bad-evidence" });
  });

  test("checks the DID and stream on an empty chain too", async () => {
    // A signed checkpoint for the requested stream: everything was deleted.
    expect(
      await compareWithWitness(SUBJECT, [], [checkpoint(2)], valid),
    ).toEqual({
      verdict: "conflict",
      reason: "truncated",
      evidence: { seq: 2, witnessedCid: "cid-2" },
    });
    // A signed checkpoint for another stream of the same publisher.
    const other = checkpoint(2, { stream: "other" });
    expect(await compareWithWitness(SUBJECT, [], [other], valid)).toEqual({
      verdict: "unknown",
      reason: "bad-evidence",
      evidence: { seq: 2, witnessedCid: "cid-2" },
    });
  });

  test("treats checkpoints as bad evidence when there is no verifier", async () => {
    // With a verifier this would be `truncated`. Without one, nothing is
    // checked, so it can't be a conflict.
    expect(await compareWithWitness(SUBJECT, chain(3), seen(5))).toEqual({
      verdict: "unknown",
      reason: "bad-evidence",
      evidence: { seq: 1, witnessedCid: "cid-1" },
    });
    // The chain-only path needs no verifier.
    expect(await compareWithWitness(SUBJECT, chain(3), [])).toEqual({
      verdict: "accept",
      reason: "no-witness",
    });
  });

  test("throws for an event from another DID or stream than the subject", async () => {
    const stranger = { ...event(1), stream: "other" };
    await expect(
      compareWithWitness(SUBJECT, [stranger], [], valid),
    ).rejects.toThrow("other");
  });
});

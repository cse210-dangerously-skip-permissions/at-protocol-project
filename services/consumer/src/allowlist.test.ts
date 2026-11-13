import type { LocalEnv } from "@trustlab/contracts";
import { describe, expect, test } from "vitest";
import { allowlistFromEnv, makeAllowlist } from "./allowlist.js";

const PUBLISHER = "did:plc:publisher";
const OTHER = "did:plc:other";
const STRANGER = "did:plc:stranger";

const ENV: LocalEnv = {
  PDS_URL: "http://localhost:2583",
  PLC_URL: "http://localhost:2582",
  PUBLISHER_DID: PUBLISHER,
  PUBLISHER_HANDLE: "publisher.test",
  PUBLISHER_PASSWORD: "publisher-password",
  WITNESS_DID: "did:plc:witness",
  WITNESS_HANDLE: "witness.test",
  WITNESS_PASSWORD: "witness-password",
};

describe("makeAllowlist", () => {
  test("allows every listed DID", () => {
    const allowlist = makeAllowlist([PUBLISHER, OTHER]);
    expect(allowlist.allow(PUBLISHER)).toBe(true);
    expect(allowlist.allow(OTHER)).toBe(true);
    expect(allowlist.dropped()).toBe(0);
  });

  test("drops a DID that is not listed", () => {
    const allowlist = makeAllowlist([PUBLISHER]);
    expect(allowlist.allow(STRANGER)).toBe(false);
  });

  test("counts each dropped call, including repeats of the same DID", () => {
    const allowlist = makeAllowlist([PUBLISHER]);
    allowlist.allow(STRANGER);
    allowlist.allow(PUBLISHER);
    allowlist.allow(STRANGER);
    allowlist.allow(OTHER);
    expect(allowlist.dropped()).toBe(3);
  });

  test("matches DIDs exactly", () => {
    const allowlist = makeAllowlist([PUBLISHER]);
    expect(allowlist.allow(PUBLISHER.toUpperCase())).toBe(false);
    expect(allowlist.allow(` ${PUBLISHER}`)).toBe(false);
    expect(allowlist.allow("")).toBe(false);
  });

  test("an empty list drops everything", () => {
    const allowlist = makeAllowlist([]);
    expect(allowlist.allow(PUBLISHER)).toBe(false);
    expect(allowlist.allow(STRANGER)).toBe(false);
    expect(allowlist.dropped()).toBe(2);
  });

  test("is not changed by later edits to the input array", () => {
    const dids = [PUBLISHER];
    const allowlist = makeAllowlist(dids);
    dids.push(STRANGER);
    expect(allowlist.allow(STRANGER)).toBe(false);
  });

  test("keeps a separate count for each allowlist", () => {
    const first = makeAllowlist([PUBLISHER]);
    const second = makeAllowlist([PUBLISHER]);
    first.allow(STRANGER);
    expect(first.dropped()).toBe(1);
    expect(second.dropped()).toBe(0);
  });
});

describe("allowlistFromEnv", () => {
  test("allows the publisher from .env.local", () => {
    expect(allowlistFromEnv(ENV).allow(PUBLISHER)).toBe(true);
  });

  test("drops every other DID, including the witness account", () => {
    const allowlist = allowlistFromEnv(ENV);
    expect(allowlist.allow(ENV.WITNESS_DID)).toBe(false);
    expect(allowlist.allow(STRANGER)).toBe(false);
    expect(allowlist.dropped()).toBe(2);
  });
});

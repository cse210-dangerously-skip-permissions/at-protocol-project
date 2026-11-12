import { createHash } from "node:crypto";
import { type AtpAgent, XRPCError } from "@atproto/api";
import {
  EVENT_NSID,
  type EventRecord,
  HEAD_NSID,
  type HeadRecord,
} from "@trustlab/contracts";
import type { PublisherSession } from "./publisher.js";

// Test support: an in-memory repo, so publisher tests need no PDS.

/**
 * A real CIDv1 (raw, sha-256) for some text, so records pass the Lexicon's
 * `cid` format check.
 */
export function cidOf(text: string): string {
  const digest = createHash("sha256").update(text).digest();
  const bytes = Buffer.concat([Buffer.from([0x01, 0x55, 0x12, 0x20]), digest]);
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = "";
  for (const byte of bytes) bits += byte.toString(2).padStart(8, "0");
  let out = "b";
  for (let i = 0; i < bits.length; i += 5) {
    out += alphabet[parseInt(bits.slice(i, i + 5).padEnd(5, "0"), 2)];
  }
  return out;
}

interface WriteParams {
  repo: string;
  collection: string;
  rkey: string;
  record: Record<string, unknown>;
}

/** An in-memory stand-in for the three repo calls the publisher makes. */
export class FakeRepo {
  readonly records = new Map<string, { cid: string; value: unknown }>();
  readonly calls: string[] = [];
  returnCommit = true;
  #rev = 0;

  getRecord = async (params: Omit<WriteParams, "record">) => {
    const stored = this.records.get(`${params.collection}/${params.rkey}`);
    if (stored === undefined) {
      throw new XRPCError(400, "RecordNotFound", "Could not locate record");
    }
    return { data: { uri: "at://x", cid: stored.cid, value: stored.value } };
  };

  createRecord = async (params: WriteParams) => {
    const key = `${params.collection}/${params.rkey}`;
    if (this.records.has(key)) {
      throw new XRPCError(400, "InvalidRequest", "Record already exists");
    }
    return this.#write("create", params);
  };

  putRecord = async (params: WriteParams) => this.#write("put", params);

  #write(kind: string, params: WriteParams) {
    this.calls.push(`${kind} ${params.collection}/${params.rkey}`);
    const cid = cidOf(JSON.stringify(params.record));
    this.records.set(`${params.collection}/${params.rkey}`, {
      cid,
      value: params.record,
    });
    this.#rev += 1;
    const commit = {
      cid: cidOf(`commit-${this.#rev}`),
      rev: `rev-${this.#rev}`,
    };
    return {
      data: { uri: "at://x", cid, ...(this.returnCommit ? { commit } : {}) },
    };
  }

  event(rkey: string): { cid: string; value: EventRecord } {
    return this.records.get(`${EVENT_NSID}/${rkey}`) as {
      cid: string;
      value: EventRecord;
    };
  }

  head(stream: string): HeadRecord {
    return this.records.get(`${HEAD_NSID}/head-${stream}`)?.value as HeadRecord;
  }
}

/**
 * A publisher session backed by a fake repo.
 *
 * @param repo - The fake repo to write to.
 * @param did - DID of the session.
 * @returns A session usable with `publishEvent` and `readHead`.
 */
export function fakeSession(
  repo: FakeRepo,
  did = "did:plc:publisher",
): PublisherSession {
  return { did, agent: { com: { atproto: { repo } } } as unknown as AtpAgent };
}

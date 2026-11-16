import { createHash } from "node:crypto";
import { type AtpAgent, XRPCError } from "@atproto/api";
import {
  EVENT_NSID,
  type EventRecord,
  HEAD_NSID,
  type HeadRecord,
} from "@trustlab/contracts";
import { type PublisherSession, recordCid } from "./publisher.js";

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

interface RecordParams {
  repo: string;
  collection: string;
  rkey: string;
}

interface BatchWrite {
  $type: string;
  collection: string;
  rkey: string;
  value: Record<string, unknown>;
}

interface BatchParams {
  repo: string;
  swapCommit?: string;
  writes: BatchWrite[];
}

/** An in-memory stand-in for the repo and sync calls the publisher makes. */
export class FakeRepo {
  readonly records = new Map<string, { cid: string; value: unknown }>();
  readonly calls: string[] = [];
  returnCommit = true;
  #rev = 0;

  /** CID of the latest commit. A repo starts with one, as an account does. */
  get commitCid(): string {
    return cidOf(`commit-${this.#rev}`);
  }

  getRecord = async (params: RecordParams) => {
    const stored = this.records.get(`${params.collection}/${params.rkey}`);
    if (stored === undefined) {
      throw new XRPCError(400, "RecordNotFound", "Could not locate record");
    }
    return { data: { uri: "at://x", cid: stored.cid, value: stored.value } };
  };

  getLatestCommit = async () => ({
    data: { cid: this.commitCid, rev: `rev-${this.#rev}` },
  });

  /** All writes land in one commit, or none do. */
  applyWrites = async (params: BatchParams) => {
    const cids = await Promise.all(
      params.writes.map((write) => recordCid(write.value)),
    );
    // No await from here on: the check and the commit are one step, as on
    // the PDS.
    if (
      params.swapCommit !== undefined &&
      params.swapCommit !== this.commitCid
    ) {
      throw new XRPCError(400, "InvalidSwap", "Commit was at another CID");
    }
    for (const write of params.writes) {
      const exists = this.records.has(`${write.collection}/${write.rkey}`);
      if (write.$type.endsWith("#create") && exists) {
        throw new XRPCError(400, "InvalidRequest", "Record already exists");
      }
      if (write.$type.endsWith("#update") && !exists) {
        throw new XRPCError(400, "InvalidRequest", "Record does not exist");
      }
    }

    const results = params.writes.map((write, index) => {
      const kind = write.$type.split("#")[1] as string;
      const cid = cids[index] as string;
      this.calls.push(`${kind} ${write.collection}/${write.rkey}`);
      this.records.set(`${write.collection}/${write.rkey}`, {
        cid,
        value: write.value,
      });
      return { $type: `${write.$type}Result`, uri: "at://x", cid };
    });
    this.#rev += 1;
    const commit = { cid: this.commitCid, rev: `rev-${this.#rev}` };
    return { data: { results, ...(this.returnCommit ? { commit } : {}) } };
  };

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
  const sync = { getLatestCommit: repo.getLatestCommit };
  return {
    did,
    agent: { com: { atproto: { repo, sync } } } as unknown as AtpAgent,
  };
}

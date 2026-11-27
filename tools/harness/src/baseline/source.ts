import {
  eventRkey,
  HEAD_NSID,
  type HeadRecord,
  type StoredEvent,
} from "@trustlab/contracts";
import type { StreamRead, StreamSource } from "../source.js";
import { baselineClient, BaselineRequestError } from "./client.js";
import { type SignedHead, verifyHead } from "./head.js";
import type { BaselineEvent } from "./store.js";

/** How many times `read` tries for a consistent view before giving up. */
const READ_ATTEMPTS = 3;

/** Thrown when the baseline server serves something the key didn't sign. */
export class BaselineSourceError extends Error {
  /** @param message - What failed. */
  constructor(message: string) {
    super(message);
    this.name = "BaselineSourceError";
  }
}

/** Where a consumer reads S0 from. */
export interface BaselineSourceOptions {
  /** The server's base URL, configured by hand. */
  url: string;
  /** The server's public key as a `did:key`, configured by hand. */
  publicKey: string;
  /** Sends the requests. Defaults to the global `fetch`. */
  fetch?: typeof globalThis.fetch;
}

/**
 * Read streams from the S0 signed HTTP server (#83), the way a fresh consumer
 * bootstraps there: from a configured URL and public key, with no DID.
 *
 * `read` returns the events and the head as `StoredEvent`s and a
 * `HeadRecord`, the shapes the AT source returns, so the auditor runs
 * unchanged. Each event's `did` is the public key, which is all that names
 * the publisher on S0.
 *
 * The head must be signed by the configured key, or `read` throws, as AT's
 * snapshot does for a bad commit signature. The events and the head come
 * from separate requests, so `read` fetches the events again after the head
 * and retries if they changed: one read never mixes two states of the
 * stream, as one AT commit wouldn't.
 *
 * A request that fails to connect, or any error status other than the 404
 * for a stream with no head yet, is `"unreachable"`, as any `getRepo`
 * failure is on AT.
 *
 * @param opts - The URL and key, and an optional `fetch`.
 * @returns The source.
 */
export function baselineSource(opts: BaselineSourceOptions): StreamSource {
  // Only a failed connection is "unreachable". The client also throws
  // TypeError for a malformed answer, which must not be mistaken for one.
  const unreachable = new WeakSet<object>();
  const client = baselineClient(opts.url, undefined, async (input, init) => {
    try {
      return await (opts.fetch ?? globalThis.fetch)(input, init);
    } catch (error) {
      if (typeof error === "object" && error !== null) unreachable.add(error);
      throw error;
    }
  });

  /**
   * Read a stream's signed head.
   *
   * @param stream - The stream name.
   * @returns The head, or `undefined` before the stream's first event.
   */
  async function readHead(stream: string): Promise<SignedHead | undefined> {
    try {
      return await client.head(stream);
    } catch (error) {
      if (error instanceof BaselineRequestError && error.status === 404) {
        return undefined;
      }
      throw error;
    }
  }

  /**
   * Read the events, the head, and the events again.
   *
   * @param stream - The stream name.
   * @returns The stream if nothing changed in between, `"changed"` if it did.
   */
  async function readOnce(
    stream: string,
  ): Promise<{ events: BaselineEvent[]; head?: SignedHead } | "changed"> {
    const before = await client.events(stream);
    const head = await readHead(stream);
    const after = await client.events(stream);
    // Every write that moves the head also changes an event, so unchanged
    // events on both sides mean the head belongs to them.
    if (!sameEvents(before, after)) return "changed";
    return head === undefined ? { events: after } : { events: after, head };
  }

  return {
    did: opts.publicKey,
    async read(stream): Promise<StreamRead | "unreachable"> {
      for (let attempt = 1; attempt <= READ_ATTEMPTS; attempt += 1) {
        let read: Awaited<ReturnType<typeof readOnce>>;
        try {
          read = await readOnce(stream);
        } catch (error) {
          if (
            error instanceof BaselineRequestError ||
            (typeof error === "object" &&
              error !== null &&
              unreachable.has(error))
          ) {
            return "unreachable";
          }
          throw error;
        }
        if (read === "changed") continue;

        const events = read.events.map((event) =>
          toStoredEvent(opts.publicKey, stream, event),
        );
        if (read.head === undefined) return { events };
        if (!(await verifyHead(opts.publicKey, read.head))) {
          throw new BaselineSourceError(
            `the head of ${stream} is not signed by ${opts.publicKey}`,
          );
        }
        return { events, head: toHeadRecord(read.head) };
      }
      throw new BaselineSourceError(
        `${stream} changed during each of ${READ_ATTEMPTS} reads`,
      );
    },
  };
}

/**
 * Whether two reads of a stream hold the same events.
 *
 * @param left - One read.
 * @param right - The other.
 * @returns True if they have the same seqs and CIDs.
 */
function sameEvents(
  left: readonly BaselineEvent[],
  right: readonly BaselineEvent[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (event, index) =>
        event.seq === right[index]?.seq && event.cid === right[index]?.cid,
    )
  );
}

/**
 * Turn a baseline event into the shape the consumer's view holds.
 *
 * @param did - The publisher's public key, standing in for a DID.
 * @param stream - The stream name.
 * @param event - The event from the server.
 * @returns The stored event.
 */
function toStoredEvent(
  did: string,
  stream: string,
  event: BaselineEvent,
): StoredEvent {
  return {
    did,
    stream,
    seq: event.seq,
    rkey: eventRkey(stream, event.seq),
    cid: event.cid,
    record: event.record,
  };
}

/**
 * Turn a verified signed head into a head record.
 *
 * @param signed - The head and its signature.
 * @returns The head record.
 */
function toHeadRecord(signed: SignedHead): HeadRecord {
  return {
    $type: HEAD_NSID,
    stream: signed.head.stream,
    seq: signed.head.seq,
    eventCid: signed.head.eventCid,
  };
}

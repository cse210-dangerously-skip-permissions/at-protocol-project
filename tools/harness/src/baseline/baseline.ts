import type { Secp256k1Keypair } from "@atproto/crypto";
import {
  EVENT_NSID,
  type EventRecord,
  eventRkey,
  isSeq,
  isStreamName,
  parseEventRecord,
} from "@trustlab/contracts";
import { recordCid, withChangedPayload } from "@trustlab/publisher";
import { type SignedHead, signHead } from "./head.js";
import type { BaselineEvent, BaselineStore } from "./store.js";

// S0: the signed-server baseline the AT setup is compared against (ADR-007).
// It keeps the same event records, seq rule, and `prevEventCid` links as the
// AT publisher (ADR-004), and computes CIDs the same way, so the same
// workload gives the same CIDs. What differs is what gets signed: here the
// server signs the head, where on AT the PDS signs the repo commit.

/** A request the baseline cannot serve, with the HTTP status to answer. */
export class BaselineError extends Error {
  /**
   * @param status - HTTP status: 400 for bad input, 404 for something missing.
   * @param message - What is wrong.
   */
  constructor(
    readonly status: 400 | 404,
    message: string,
  ) {
    super(message);
    this.name = "BaselineError";
  }
}

/** What a tamper operation changed, like `Tampered` from the AT tools. */
export interface BaselineTampered {
  /** The events written, lowest seq first, with their new CIDs. */
  events: { seq: number; cid: string }[];
  /** The head written, or `undefined` if the head was left alone. */
  head?: { seq: number; eventCid: string };
}

/**
 * The baseline's operations: append, read, and the three tamper operations
 * that mirror the AT tamper tools (#65).
 *
 * Writes run one at a time, and each is one store transaction, so appends
 * never reuse a seq and a tamper is never seen halfway, as with one AT commit.
 */
export class Baseline {
  readonly #store: BaselineStore;
  readonly #keypair: Secp256k1Keypair;
  #queue: Promise<unknown> = Promise.resolve();

  /**
   * @param store - Where events and heads are kept.
   * @param keypair - The key that signs every head.
   */
  constructor(store: BaselineStore, keypair: Secp256k1Keypair) {
    this.#store = store;
    this.#keypair = keypair;
  }

  /** The public key consumers are configured with, as a `did:key`. */
  get publicKey(): string {
    return this.#keypair.did();
  }

  /**
   * Read a stream's events in seq order.
   *
   * @param stream - Stream name.
   * @returns Every event with its CID. Empty for an unknown stream.
   */
  events(stream: string): BaselineEvent[] {
    assertStream(stream);
    return this.#store.events(stream);
  }

  /**
   * Read a stream's signed head.
   *
   * @param stream - Stream name.
   * @returns The head and the server's signature over it.
   * @throws BaselineError 404 if the stream has no events.
   */
  head(stream: string): SignedHead {
    assertStream(stream);
    const head = this.#store.head(stream);
    if (head === null) {
      throw new BaselineError(404, `${stream} has no events`);
    }
    return head;
  }

  /**
   * Append the next event: the server picks the seq and the link, as
   * `publishEvent` does on AT, and signs the new head.
   *
   * @param stream - Stream name.
   * @param input - `kind`, `payload`, `createdAt`, and `refSeq` when needed,
   *   as received. They are checked against the event contract.
   * @returns The seq and CID the event got.
   * @throws BaselineError 400 if the result would break the event contract.
   */
  append(
    stream: string,
    input: unknown,
  ): Promise<{ seq: number; cid: string }> {
    return this.#serial(async () => {
      assertStream(stream);
      const body = (
        typeof input === "object" && input !== null ? input : {}
      ) as Record<string, unknown>;
      const head = this.#store.head(stream)?.head;
      const seq = head === undefined ? 1 : head.seq + 1;
      let record: EventRecord;
      try {
        record = parseEventRecord(
          {
            $type: EVENT_NSID,
            stream,
            seq,
            ...(head === undefined ? {} : { prevEventCid: head.eventCid }),
            kind: body.kind,
            ...(body.refSeq === undefined ? {} : { refSeq: body.refSeq }),
            payload: body.payload,
            createdAt: body.createdAt,
          },
          eventRkey(stream, seq),
        );
      } catch (error) {
        throw new BaselineError(
          400,
          error instanceof Error ? error.message : String(error),
        );
      }
      const cid = await recordCid(record);
      this.#store.write(stream, {
        put: [{ seq, cid, record }],
        head: await signHead(this.#keypair, { stream, seq, eventCid: cid }),
      });
      return { seq, cid };
    });
  }

  /**
   * Edit one event in place, as `tamperEdit` does: the payload changes, so
   * the event gets a new CID, and nothing else is touched.
   *
   * @param stream - Stream name.
   * @param seq - The seq of the event to edit.
   * @returns The edited event's new CID.
   * @throws BaselineError 404 if the stream has no event at that seq.
   */
  edit(stream: string, seq: number): Promise<BaselineTampered> {
    return this.#serial(async () => {
      const events = this.#eventsFrom(stream, seq);
      const record = withChangedPayload((events[0] as BaselineEvent).record);
      const cid = await recordCid(record);
      this.#store.write(stream, { put: [{ seq, cid, record }] });
      return { events: [{ seq, cid }] };
    });
  }

  /**
   * Rewrite history from one seq to the head, as `tamperRewrite` does: each
   * event gets a changed payload, each one after the first links to the
   * rewritten event before it, and the head is re-signed at the last one.
   *
   * @param stream - Stream name.
   * @param from - The first seq to rewrite.
   * @returns The new CID of every rewritten event, and the new head.
   * @throws BaselineError 404 if the stream has no event at `from`.
   */
  rewrite(stream: string, from: number): Promise<BaselineTampered> {
    return this.#serial(async () => {
      const put: BaselineEvent[] = [];
      let prevCid: string | undefined;
      for (const event of this.#eventsFrom(stream, from)) {
        const changed = withChangedPayload(event.record);
        const record: EventRecord =
          prevCid === undefined
            ? changed
            : { ...changed, prevEventCid: prevCid };
        prevCid = await recordCid(record);
        put.push({ seq: event.seq, cid: prevCid, record });
      }
      const last = put[put.length - 1] as BaselineEvent;
      const head = { seq: last.seq, eventCid: last.cid };
      this.#store.write(stream, {
        put,
        head: await signHead(this.#keypair, { stream, ...head }),
      });
      return { events: put.map(({ seq, cid }) => ({ seq, cid })), head };
    });
  }

  /**
   * Truncate a stream, as `tamperTruncate` does: delete every event after
   * `to` and re-sign the head at `to`.
   *
   * @param stream - Stream name.
   * @param to - The seq of the last event to keep. Must be below the head.
   * @returns The new head. `events` is empty.
   * @throws BaselineError 404 if the stream has no event at `to`, 400 if
   *   `to` is the head already.
   */
  truncate(stream: string, to: number): Promise<BaselineTampered> {
    return this.#serial(async () => {
      const events = this.#eventsFrom(stream, to);
      if (events.length === 1) {
        throw new BaselineError(
          400,
          `truncate needs a seq below the head (${to}), got ${to}`,
        );
      }
      const head = { seq: to, eventCid: (events[0] as BaselineEvent).cid };
      this.#store.write(stream, {
        deleteAfter: to,
        head: await signHead(this.#keypair, { stream, ...head }),
      });
      return { events: [], head };
    });
  }

  /**
   * Read a stream's events from one seq to the head.
   *
   * @param stream - Stream name.
   * @param seq - The first seq wanted.
   * @returns The events from `seq` on. Never empty.
   * @throws BaselineError 400 for a bad stream name or seq, 404 if the
   *   stream has no event at `seq`.
   */
  #eventsFrom(stream: string, seq: number): BaselineEvent[] {
    assertStream(stream);
    if (!isSeq(seq)) throw new BaselineError(400, `bad seq ${seq}`);
    const events = this.#store.events(stream).filter((e) => e.seq >= seq);
    if (events[0]?.seq !== seq) {
      throw new BaselineError(404, `${stream} has no event at seq ${seq}`);
    }
    return events;
  }

  /**
   * Run a write after every earlier one has finished.
   *
   * @param write - The write to run.
   * @returns What the write returned.
   */
  #serial<T>(write: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(write);
    this.#queue = result.catch(() => undefined);
    return result;
  }
}

/**
 * Reject a stream name the event contract does not allow.
 *
 * @param stream - The name from the request.
 * @throws BaselineError 400 if it is not a stream name.
 */
function assertStream(stream: string): void {
  if (!isStreamName(stream)) {
    throw new BaselineError(400, `bad stream name ${JSON.stringify(stream)}`);
  }
}

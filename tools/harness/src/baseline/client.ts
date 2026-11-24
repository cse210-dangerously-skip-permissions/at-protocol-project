import {
  type EventKind,
  eventRkey,
  parseEventRecord,
  type Payload,
} from "@trustlab/contracts";
import { makeWorkload, workloadCreatedAt } from "@trustlab/publisher";
import type { BaselineTampered } from "./baseline.js";
import { parseSignedHead, type SignedHead } from "./head.js";
import type { BaselineEvent } from "./store.js";

/** What to append next on a stream. The server picks the seq and the link. */
export interface BaselineAppend {
  kind: EventKind;
  payload: Payload;
  /** For `correct` and `withdraw`: the seq of the event this one refers to. */
  refSeq?: number;
  /** ISO 8601 time for the event. */
  createdAt: string;
}

/** Thrown when the baseline server answers with an error status. */
export class BaselineRequestError extends Error {
  /**
   * @param status - The HTTP status the server answered.
   * @param message - The server's error message.
   */
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(`baseline server answered ${status}: ${message}`);
    this.name = "BaselineRequestError";
  }
}

/** Calls to one baseline server. */
export interface BaselineClient {
  /** Read a stream's events, checked against the event contract. */
  events(stream: string): Promise<BaselineEvent[]>;
  /** Read a stream's signed head. The signature is not checked here. */
  head(stream: string): Promise<SignedHead>;
  /** Append the next event. Needs the publisher token. */
  append(
    stream: string,
    event: BaselineAppend,
  ): Promise<{ seq: number; cid: string }>;
  /** Tamper: change the event at `seq` in place. */
  edit(stream: string, seq: number): Promise<BaselineTampered>;
  /** Tamper: rewrite from `from` to the head, with valid links. */
  rewrite(stream: string, from: number): Promise<BaselineTampered>;
  /** Tamper: delete every event after `to` and move the head back. */
  truncate(stream: string, to: number): Promise<BaselineTampered>;
}

/**
 * Make a client for a baseline server.
 *
 * @param url - The server's base URL.
 * @param publisherToken - The publisher token, for appends and tampers.
 *   Readers leave it out.
 * @returns The client.
 */
export function baselineClient(
  url: string,
  publisherToken?: string,
): BaselineClient {
  /**
   * Send one request and parse the JSON answer.
   *
   * @param method - HTTP method.
   * @param path - Path under the base URL.
   * @param body - JSON body, if any.
   * @returns The parsed response body.
   */
  async function call(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const response = await fetch(`${url}${path}`, {
      method,
      headers: {
        ...(publisherToken === undefined
          ? {}
          : { authorization: `Bearer ${publisherToken}` }),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const answer = (await response.json()) as unknown;
    if (!response.ok) {
      const message = (answer as { error?: unknown } | null)?.error;
      throw new BaselineRequestError(
        response.status,
        typeof message === "string" ? message : "unknown error",
      );
    }
    return answer;
  }

  const events = (stream: string) => `/streams/${stream}/events`;

  return {
    async events(stream) {
      const answer = (await call("GET", events(stream))) as {
        events?: unknown;
      } | null;
      if (!Array.isArray(answer?.events)) {
        throw new TypeError("invalid events response");
      }
      return (answer.events as Partial<BaselineEvent>[]).map((event, index) => {
        if (typeof event?.cid !== "string" || event.seq !== index + 1) {
          throw new TypeError(`invalid event at position ${index + 1}`);
        }
        return {
          seq: event.seq,
          cid: event.cid,
          record: parseEventRecord(event.record, eventRkey(stream, event.seq)),
        };
      });
    },
    async head(stream) {
      return parseSignedHead(await call("GET", `/streams/${stream}/head`));
    },
    async append(stream, event) {
      return (await call("POST", events(stream), event)) as {
        seq: number;
        cid: string;
      };
    },
    async edit(stream, seq) {
      return (await call("PUT", `${events(stream)}/${seq}`, {
        mode: "edit",
      })) as BaselineTampered;
    },
    async rewrite(stream, from) {
      return (await call("PUT", `${events(stream)}/${from}`, {
        mode: "rewrite",
      })) as BaselineTampered;
    },
    async truncate(stream, to) {
      return (await call(
        "DELETE",
        `${events(stream)}/${to + 1}`,
      )) as BaselineTampered;
    },
  };
}

/**
 * Publish the next `count` events of the seeded workload to a baseline
 * server, as `runPublish` does on AT: the event at seq n depends only on the
 * seed and n, so both setups hold the same records with the same CIDs.
 *
 * @param client - A client with the publisher token.
 * @param args - Stream, how many more events, and the workload seed.
 * @returns The seq and CID of each event published, in order.
 */
export async function publishWorkload(
  client: BaselineClient,
  args: { stream: string; count: number; seed: number },
): Promise<{ seq: number; cid: string }[]> {
  const start = (await client.events(args.stream)).length;
  // The payload at seq n is entry n - 1 of the workload, whatever the count.
  const payloads = makeWorkload(args.seed, start + args.count).slice(start);
  const published: { seq: number; cid: string }[] = [];
  for (const [index, payload] of payloads.entries()) {
    published.push(
      await client.append(args.stream, {
        kind: "release",
        payload,
        createdAt: workloadCreatedAt(args.seed, start + index + 1),
      }),
    );
  }
  return published;
}

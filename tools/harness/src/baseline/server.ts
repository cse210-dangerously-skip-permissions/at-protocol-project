import { timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { Secp256k1Keypair } from "@atproto/crypto";
import { Baseline, BaselineError } from "./baseline.js";
import { BaselineStore } from "./store.js";

/** The largest request body the server reads. */
const MAX_BODY_BYTES = 64 * 1024;

/** What `startBaselineServer` needs. */
export interface BaselineServerOptions {
  /**
   * The secret the publisher sends as `Authorization: Bearer <token>`.
   * Appending and tampering need it; reading does not. Must not be empty.
   */
  publisherToken: string;
  /** Database file path. Defaults to `:memory:`. */
  dbPath?: string;
  /** Port to listen on. Defaults to 0, which picks a free one. */
  port?: number;
  /** Address to listen on. Defaults to `127.0.0.1`. */
  host?: string;
  /** The key that signs heads. Defaults to a new one. */
  keypair?: Secp256k1Keypair;
}

/** A running baseline server. */
export interface RunningBaseline {
  /** Base URL, such as `http://127.0.0.1:41234`. */
  url: string;
  /**
   * The server's public key as a `did:key`. It is not served over HTTP: a
   * consumer has to be configured with it, and that manual step is what the
   * DID-based AT setup is compared against.
   */
  publicKey: string;
  /** Stop listening and close the database. Safe to call more than once. */
  close(): Promise<void>;
}

/**
 * Start the S0 baseline server (#83).
 *
 * | Route | Does |
 * | --- | --- |
 * | `GET /streams/:stream/events` | every event with its CID, in seq order |
 * | `GET /streams/:stream/head` | `{ head: { stream, seq, eventCid }, sig }` |
 * | `POST /streams/:stream/events` | append `{ kind, payload, createdAt, refSeq? }` |
 * | `PUT /streams/:stream/events/:seq` | tamper: `{ mode: "edit" }` (default) or `{ mode: "rewrite" }` |
 * | `DELETE /streams/:stream/events/:seq` | tamper: delete that event and every later one |
 *
 * `POST`, `PUT`, and `DELETE` need the publisher token.
 *
 * @param options - The publisher token, and optionally the database, the
 *   address, and the signing key.
 * @returns The server's URL and public key, and a function to stop it.
 * @throws RangeError if the publisher token is empty, which would let
 *   anyone write.
 */
export async function startBaselineServer(
  options: BaselineServerOptions,
): Promise<RunningBaseline> {
  if (options.publisherToken === "") {
    throw new RangeError("publisherToken must not be empty");
  }
  const store = new BaselineStore(options.dbPath ?? ":memory:");
  const keypair = options.keypair ?? (await Secp256k1Keypair.create());
  const baseline = new Baseline(store, keypair);
  const token = Buffer.from(options.publisherToken);

  const server = createServer((req, res) => {
    handle(baseline, token, req)
      .then((reply) => send(res, reply.status, reply.body))
      .catch((error: unknown) => {
        if (error instanceof BaselineError) {
          send(res, error.status, { error: error.message });
        } else if (error instanceof HttpError) {
          send(res, error.status, { error: error.message });
        } else {
          send(res, 500, { error: "internal error" });
        }
      });
  });
  const host = options.host ?? "127.0.0.1";
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, resolve);
  });
  const { port } = server.address() as AddressInfo;

  let closed: Promise<void> | undefined;
  return {
    url: `http://${host}:${port}`,
    publicKey: baseline.publicKey,
    // Closing twice returns the first call's promise. The store is closed
    // only after the last queued write, so none lands on a closed database.
    close: () =>
      (closed ??= (async () => {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        });
        await baseline.drain().catch(() => undefined);
        store.close();
      })()),
  };
}

/** A request the HTTP layer refuses before it reaches the baseline. */
class HttpError extends Error {
  /**
   * @param status - The HTTP status to answer.
   * @param message - What is wrong.
   */
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Route one request.
 *
 * @param baseline - The baseline's operations.
 * @param token - The publisher token, as bytes.
 * @param req - The request.
 * @returns The status and JSON body to answer.
 */
async function handle(
  baseline: Baseline,
  token: Buffer,
  req: IncomingMessage,
): Promise<{ status: number; body: unknown }> {
  const path = new URL(req.url ?? "/", "http://baseline").pathname;
  const [root, stream, resource, seqText, ...extra] = path
    .split("/")
    .slice(1)
    .map(decodeURIComponent);
  if (root !== "streams" || stream === undefined || extra.length > 0) {
    throw new HttpError(404, "not found");
  }
  const method = req.method ?? "GET";

  if (resource === "head" && seqText === undefined) {
    if (method !== "GET") throw new HttpError(405, "method not allowed");
    return { status: 200, body: baseline.head(stream) };
  }
  if (resource !== "events") throw new HttpError(404, "not found");

  if (seqText === undefined) {
    if (method === "GET") {
      return { status: 200, body: { events: baseline.events(stream) } };
    }
    if (method !== "POST") throw new HttpError(405, "method not allowed");
    authorize(token, req);
    return {
      status: 201,
      body: await baseline.append(stream, await readJson(req)),
    };
  }

  if (!/^\d+$/.test(seqText)) throw new HttpError(400, "seq must be a number");
  const seq = Number(seqText);
  if (method === "PUT") {
    authorize(token, req);
    const body = (await readJson(req)) as { mode?: unknown } | null;
    const mode = body?.mode ?? "edit";
    if (mode !== "edit" && mode !== "rewrite") {
      throw new HttpError(400, 'mode must be "edit" or "rewrite"');
    }
    return {
      status: 200,
      body: await (mode === "edit"
        ? baseline.edit(stream, seq)
        : baseline.rewrite(stream, seq)),
    };
  }
  if (method === "DELETE") {
    authorize(token, req);
    // Deleting seq N and everything after it keeps the events up to N - 1.
    if (seq < 2) throw new HttpError(400, "the first event cannot be deleted");
    return { status: 200, body: await baseline.truncate(stream, seq - 1) };
  }
  throw new HttpError(405, "method not allowed");
}

/**
 * Check the publisher token on a write.
 *
 * @param token - The expected token, as bytes.
 * @param req - The request.
 * @throws HttpError 401 if the token is missing or wrong.
 */
function authorize(token: Buffer, req: IncomingMessage): void {
  // An empty token never authorizes, whatever the server was started with.
  const given = Buffer.from(
    /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "",
  );
  if (
    given.length === 0 ||
    given.length !== token.length ||
    !timingSafeEqual(given, token)
  ) {
    throw new HttpError(401, "publisher token required");
  }
}

/**
 * Read a JSON request body. An empty body is `null`.
 *
 * @param req - The request.
 * @returns The parsed body.
 * @throws HttpError 413 if the body is too large, 400 if it is not JSON.
 */
async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "body too large");
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new HttpError(400, "body must be JSON");
  }
}

/**
 * Send a JSON response.
 *
 * @param res - The response.
 * @param status - The HTTP status.
 * @param body - The body to serialize.
 */
function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

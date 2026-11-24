import { IdResolver } from "@atproto/identity";
import {
  type BlockMap,
  cborToLexRecord,
  def,
  type Leaf,
  MemoryBlockstore,
  MST,
  readCarWithRoot,
  verifyRepo,
} from "@atproto/repo";
import {
  EVENT_NSID,
  HEAD_NSID,
  type HeadRecord,
  parseEventRecord,
  parseHeadRecord,
  type StoredEvent,
} from "@trustlab/contracts";

/** A publisher's repo at one signed commit, reduced to our records. */
export interface Snapshot {
  /** DID of the publisher's repo. */
  did: string;
  /** Repo revision of the commit. */
  rev: string;
  /** CID of the signed commit. */
  commitCid: string;
  /** Every event record, ordered by stream, then seq. */
  events: StoredEvent[];
  /** Each stream's head record, by stream name. */
  head: Record<string, HeadRecord>;
}

/** Where to fetch a snapshot from. */
export interface FetchSnapshotOptions {
  /** The PDS that hosts the repo, such as `http://localhost:2583`. */
  pdsUrl: string;
  /** The PLC directory that holds the DID document. */
  plcUrl: string;
  /** DID of the publisher's repo. */
  did: string;
  /**
   * Used for both the PDS and the PLC. Defaults to the global `fetch`, which
   * reaches the local network, unlike `@atproto/identity`'s default.
   */
  fetch?: typeof globalThis.fetch;
  /**
   * How long the PDS has to send the whole repo, in milliseconds. Defaults
   * to 30 seconds. The PLC has its own limit: `IdResolver` gives up after 3.
   */
  timeoutMs?: number;
  /** The largest repo the PDS may send, in bytes. Defaults to 64 MiB. */
  maxBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
/** How much of an error response to read, for the message. */
const ERROR_BODY_BYTES = 1024;

/** Which step of fetching a snapshot failed. */
export type SnapshotProblem =
  /**
   * The PDS could not be reached, `getRepo` returned an error, or the repo
   * did not arrive in time or was too large.
   */
  | "pds-unreachable"
  /** The PLC could not be reached, or gave no DID document or key. */
  | "did-unresolved"
  /**
   * The repo failed verification: a bad block, DID, or signature, a missing
   * or malformed record, or MST keys that repeat or are out of order.
   */
  | "invalid-repo";

/** Thrown when a snapshot cannot be fetched or does not verify. */
export class SnapshotError extends Error {
  readonly problem: SnapshotProblem;

  /**
   * @param problem - Which step failed.
   * @param message - What happened.
   * @param cause - The underlying error, if any.
   */
  constructor(problem: SnapshotProblem, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "SnapshotError";
    this.problem = problem;
  }
}

/**
 * Download a publisher's repo with `com.atproto.sync.getRepo` and verify it
 * against the signing key in the publisher's DID document.
 *
 * The key comes from the PLC, never from the PDS that served the repo, so a
 * PDS cannot pass off a repo it signed itself (ADR-003).
 *
 * @param opts - The PDS, the PLC, the DID, and an optional `fetch`.
 * @returns The verified snapshot.
 * @throws SnapshotError if the PDS or PLC fails, or the repo does not verify.
 * @throws ContractError if a signed record in our collections breaks the contract.
 */
export async function fetchSnapshot(
  opts: FetchSnapshotOptions,
): Promise<Snapshot> {
  const fetch = opts.fetch ?? globalThis.fetch;
  const car = await downloadRepo(fetch, {
    pdsUrl: opts.pdsUrl,
    did: opts.did,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBytes: opts.maxBytes ?? DEFAULT_MAX_BYTES,
  });
  const signingKey = await resolveSigningKey(fetch, opts.plcUrl, opts.did);
  return verifySnapshot(car, opts.did, signingKey);
}

/**
 * Verify a repo CAR offline and extract our records from it.
 *
 * `verifyRepo` checks every block against its CID, that the commit is for
 * `did` and signed by `signingKey`, and that every record block is present.
 * It does not check that the MST's keys are sorted and unique, so this
 * function walks the tree and does: with a key twice, a full walk and a key
 * lookup (which proofs use) would return different records for the same
 * signed commit. Records outside `dev.trustlab.event` and `dev.trustlab.head`
 * are left out; ours are checked against the contract.
 *
 * @param car - The repo, as `getRepo` returns it.
 * @param did - The DID the repo must belong to.
 * @param signingKey - The key the commit must be signed with, as a `did:key`.
 * @returns The snapshot.
 * @throws SnapshotError with `did-unresolved` if `did` or `signingKey` is
 *   missing, or `invalid-repo` if the repo does not verify.
 * @throws ContractError if a signed record in our collections breaks the contract.
 */
export async function verifySnapshot(
  car: Uint8Array,
  did: string,
  signingKey: string,
): Promise<Snapshot> {
  // `verifyRepo` silently skips the DID or signature check when given
  // undefined, which a JavaScript caller can pass despite the types.
  if (!isNonEmptyString(did) || !isNonEmptyString(signingKey)) {
    throw new SnapshotError(
      "did-unresolved",
      "verifySnapshot needs the repo's DID and signing key",
    );
  }

  let blocks: BlockMap;
  let commit: Awaited<ReturnType<typeof verifyRepo>>["commit"];
  let leaves: Leaf[];
  try {
    const parsed = await readCarWithRoot(car);
    blocks = parsed.blocks;
    ({ commit } = await verifyRepo(blocks, parsed.root, did, signingKey));
    const storage = new MemoryBlockstore(blocks);
    const { data } = await storage.readObj(parsed.root, def.commit);
    leaves = await MST.load(storage, data).leaves();
  } catch (error) {
    throw new SnapshotError(
      "invalid-repo",
      `the repo for ${did} does not verify: ${message(error)}`,
      error,
    );
  }

  const events: StoredEvent[] = [];
  // No prototype, so a stream named `constructor` is not already present.
  const head: Record<string, HeadRecord> = Object.create(null);
  let previousKey: string | undefined;
  for (const leaf of leaves) {
    // Lookups compare keys the same way, so after this check a lookup finds
    // exactly the record the walk does.
    if (previousKey !== undefined && leaf.key <= previousKey) {
      throw new SnapshotError(
        "invalid-repo",
        `the repo for ${did} has MST keys that repeat or are out of order: ${leaf.key} after ${previousKey}`,
      );
    }
    previousKey = leaf.key;

    const slash = leaf.key.indexOf("/");
    const collection = leaf.key.slice(0, slash);
    const rkey = leaf.key.slice(slash + 1);
    if (collection !== EVENT_NSID && collection !== HEAD_NSID) continue;

    // verifyRepo fails if a record block is missing, so this is a guard.
    const bytes = blocks.get(leaf.value);
    if (bytes === undefined) {
      throw new SnapshotError(
        "invalid-repo",
        `the repo for ${did} has no block for ${leaf.key}`,
      );
    }
    let value: unknown;
    try {
      value = cborToLexRecord(bytes);
    } catch (error) {
      throw new SnapshotError(
        "invalid-repo",
        `the repo for ${did} holds ${leaf.key}, which is not a record: ${message(error)}`,
        error,
      );
    }
    // The walk is in key order, checked above. An event's key is
    // `<stream>-<12-digit seq>`, and `-` sorts before every character a
    // stream name can hold, so events come out by stream, then seq.
    if (collection === EVENT_NSID) {
      const record = parseEventRecord(value, rkey);
      events.push({
        did,
        stream: record.stream,
        seq: record.seq,
        rkey,
        cid: leaf.value.toString(),
        record,
      });
    } else {
      const record = parseHeadRecord(value, rkey);
      head[record.stream] = record;
    }
  }
  return {
    did,
    rev: commit.rev,
    commitCid: commit.cid.toString(),
    events,
    head,
  };
}

/**
 * Fetch a repo's CAR from its PDS.
 *
 * The PDS is the party we do not trust, so the whole download has a deadline
 * and a size limit: one that stalls or sends without end cannot hang the
 * caller or run it out of memory.
 *
 * @param fetch - The fetch to use.
 * @param opts - The PDS, the repo, the deadline, and the size limit.
 * @returns The CAR bytes.
 * @throws SnapshotError with `pds-unreachable`.
 */
async function downloadRepo(
  fetch: typeof globalThis.fetch,
  opts: { pdsUrl: string; did: string; timeoutMs: number; maxBytes: number },
): Promise<Uint8Array> {
  const { pdsUrl, did } = opts;
  const signal = AbortSignal.timeout(opts.timeoutMs);
  try {
    const url = new URL("/xrpc/com.atproto.sync.getRepo", pdsUrl);
    url.searchParams.set("did", did);
    const response = await fetch(url, { signal });
    if (!response.ok) {
      const body = await readBody(response, ERROR_BODY_BYTES, signal).then(
        (bytes) => new TextDecoder().decode(bytes),
        () => "",
      );
      throw new SnapshotError(
        "pds-unreachable",
        `getRepo returned ${response.status} for ${did}: ${body.slice(0, 200)}`,
      );
    }
    return await readBody(response, opts.maxBytes, signal);
  } catch (error) {
    if (error instanceof SnapshotError) throw error;
    throw new SnapshotError(
      "pds-unreachable",
      `could not download the repo for ${did} from ${pdsUrl}: ${message(error)}`,
      error,
    );
  }
}

/**
 * Read a response body, giving up when `signal` aborts or the body passes
 * `maxBytes`.
 *
 * @param response - The response.
 * @param maxBytes - The most bytes to accept.
 * @param signal - Aborts the read.
 * @returns The body.
 * @throws SnapshotError with `pds-unreachable` if the body is too large.
 * @throws The abort reason, or the stream's own error.
 */
async function readBody(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  signal.throwIfAborted();
  const reader = response.body?.getReader();
  if (reader === undefined) return new Uint8Array();
  // A fetch ends its own body on abort, but a body that is not tied to the
  // signal would keep `read` waiting, so cancel the reader too.
  const cancel = () => void reader.cancel(signal.reason).catch(() => {});
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new SnapshotError(
          "pds-unreachable",
          `the PDS sent more than ${maxBytes} bytes`,
        );
      }
      chunks.push(value);
    }
    // A cancelled read ends as if the body were complete.
    signal.throwIfAborted();
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return body;
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

/**
 * Resolve a DID's atproto signing key on the PLC.
 *
 * @param fetch - The fetch to use.
 * @param plcUrl - The PLC directory.
 * @param did - The DID.
 * @returns The key, as a `did:key`.
 * @throws SnapshotError with `did-unresolved`.
 */
async function resolveSigningKey(
  fetch: typeof globalThis.fetch,
  plcUrl: string,
  did: string,
): Promise<string> {
  // No cache: recovery should check against the key the PLC holds now.
  const resolver = new IdResolver({ plcUrl, fetch });
  try {
    return await resolver.did.resolveAtprotoKey(did);
  } catch (error) {
    throw new SnapshotError(
      "did-unresolved",
      `could not resolve the signing key of ${did} on ${plcUrl}: ${message(error)}`,
      error,
    );
  }
}

/**
 * Whether a value is a string with at least one character.
 *
 * @param value - Anything.
 * @returns `true` for a non-empty string.
 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

/**
 * The message of an error, or the value as text.
 *
 * @param error - Anything thrown.
 * @returns Its message.
 */
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

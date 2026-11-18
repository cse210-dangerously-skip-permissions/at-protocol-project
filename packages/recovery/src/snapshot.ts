import { IdResolver } from "@atproto/identity";
import { cborToLexRecord, verifyRepoCar } from "@atproto/repo";
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
}

/** Which step of fetching a snapshot failed. */
export type SnapshotProblem =
  /** The PDS could not be reached, or `getRepo` returned an error. */
  | "pds-unreachable"
  /** The PLC could not be reached, or gave no DID document or key. */
  | "did-unresolved"
  /** The repo failed verification: a bad block, DID, or signature. */
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
  const car = await downloadRepo(fetch, opts.pdsUrl, opts.did);
  const signingKey = await resolveSigningKey(fetch, opts.plcUrl, opts.did);
  return verifySnapshot(car, opts.did, signingKey);
}

/**
 * Verify a repo CAR offline and extract our records from it.
 *
 * `verifyRepoCar` checks every block against its CID, that the commit is for
 * `did` and signed by `signingKey`, and that every record block is present.
 * Records outside `dev.trustlab.event` and `dev.trustlab.head` are left out;
 * ours are checked against the contract.
 *
 * @param car - The repo, as `getRepo` returns it.
 * @param did - The DID the repo must belong to.
 * @param signingKey - The key the commit must be signed with, as a `did:key`.
 * @returns The snapshot.
 * @throws SnapshotError with `invalid-repo` if the repo does not verify.
 * @throws ContractError if a signed record in our collections breaks the contract.
 */
export async function verifySnapshot(
  car: Uint8Array,
  did: string,
  signingKey: string,
): Promise<Snapshot> {
  let verified: Awaited<ReturnType<typeof verifyRepoCar>>;
  try {
    verified = await verifyRepoCar(car, did, signingKey);
  } catch (error) {
    throw new SnapshotError(
      "invalid-repo",
      `the repo for ${did} does not verify: ${message(error)}`,
      error,
    );
  }
  const { creates, commit } = verified;

  const events: StoredEvent[] = [];
  const head: Record<string, HeadRecord> = {};
  // `creates` is in MST key order. An event's key is `<stream>-<12-digit seq>`,
  // and `-` sorts before every character a stream name can hold, so the
  // events come out ordered by stream, then seq, with no sort.
  for (const create of creates) {
    if (create.collection !== EVENT_NSID && create.collection !== HEAD_NSID) {
      continue;
    }
    // verifyRepoCar fails if a record block is missing, so this is a guard.
    const bytes = commit.newBlocks.get(create.cid);
    if (bytes === undefined) {
      throw new SnapshotError(
        "invalid-repo",
        `the repo for ${did} has no block for ${create.collection}/${create.rkey}`,
      );
    }
    const value = cborToLexRecord(bytes);
    if (create.collection === EVENT_NSID) {
      const record = parseEventRecord(value, create.rkey);
      events.push({
        did,
        stream: record.stream,
        seq: record.seq,
        rkey: create.rkey,
        cid: create.cid.toString(),
        record,
      });
    } else {
      const record = parseHeadRecord(value, create.rkey);
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
 * @param fetch - The fetch to use.
 * @param pdsUrl - The PDS.
 * @param did - The repo.
 * @returns The CAR bytes.
 * @throws SnapshotError with `pds-unreachable`.
 */
async function downloadRepo(
  fetch: typeof globalThis.fetch,
  pdsUrl: string,
  did: string,
): Promise<Uint8Array> {
  const url = new URL("/xrpc/com.atproto.sync.getRepo", pdsUrl);
  url.searchParams.set("did", did);
  let response: Response;
  try {
    response = await fetch(url);
  } catch (error) {
    throw new SnapshotError(
      "pds-unreachable",
      `could not reach ${pdsUrl}: ${message(error)}`,
      error,
    );
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new SnapshotError(
      "pds-unreachable",
      `getRepo returned ${response.status} for ${did}: ${body.slice(0, 200)}`,
    );
  }
  return new Uint8Array(await response.arrayBuffer());
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
 * The message of an error, or the value as text.
 *
 * @param error - Anything thrown.
 * @returns Its message.
 */
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

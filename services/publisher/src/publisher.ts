import { AtpAgent, XRPCError } from "@atproto/api";
import { cidForRecord } from "@atproto/repo";
import {
  EVENT_NSID,
  type EventKind,
  type EventRecord,
  eventRkey,
  HEAD_NSID,
  type HeadRecord,
  headRkey,
  type LocalEnv,
  parseEventRecord,
  parseHeadRecord,
  type Payload,
} from "@trustlab/contracts";

/** A logged-in publisher: its DID and the agent that writes to its repo. */
export interface PublisherSession {
  /** DID of the publisher's repo. */
  did: string;
  /** Authenticated agent for the publisher's PDS. */
  agent: AtpAgent;
}

/** What to publish next on a stream. The library picks the seq and the link. */
export interface PublishInput {
  /** Stream name, such as `releases`. */
  stream: string;
  kind: EventKind;
  payload: Payload;
  /** For `correct` and `withdraw`: the seq of the event this one refers to. */
  refSeq?: number;
  /**
   * ISO 8601 time for the event, or a function that gives it from the seq
   * the event gets. Required, so no caller falls back to the clock without
   * meaning to: runs that must repeat pass a time derived from the seq.
   */
  createdAt: string | ((seq: number) => string);
}

/** The result of publishing one event. */
export interface Published {
  /** The seq the event got. */
  seq: number;
  /** The event's record key. */
  rkey: string;
  /** CID of the event record. The next event links to it. */
  cid: string;
  /** CID of the commit that created the event record. */
  commitCid: string;
  /** Repo revision of that commit. */
  rev: string;
}

/**
 * Log in to the local PDS as the seeded publisher account.
 *
 * @param env - The variables from `.env.local`.
 * @returns A session for `publishEvent` and `readHead`.
 * @throws Error if the PDS logs in a different account than `PUBLISHER_DID`.
 */
export async function login(env: LocalEnv): Promise<PublisherSession> {
  const agent = new AtpAgent({ service: env.PDS_URL });
  await agent.login({
    identifier: env.PUBLISHER_DID,
    password: env.PUBLISHER_PASSWORD,
  });
  const did = agent.assertDid;
  if (did !== env.PUBLISHER_DID) {
    throw new Error(`logged in as ${did}, expected ${env.PUBLISHER_DID}`);
  }
  return { did, agent };
}

/**
 * Read a stream's head record from the publisher's repo.
 *
 * @param session - The publisher session.
 * @param stream - Stream name.
 * @returns The head, or `null` if the stream has no events yet.
 * @throws ContractError if the stored head breaks the contract.
 */
export async function readHead(
  session: PublisherSession,
  stream: string,
): Promise<HeadRecord | null> {
  const rkey = headRkey(stream);
  try {
    const response = await session.agent.com.atproto.repo.getRecord({
      repo: session.did,
      collection: HEAD_NSID,
      rkey,
    });
    return parseHeadRecord(response.data.value, rkey);
  } catch (error) {
    if (error instanceof XRPCError && error.error === "RecordNotFound") {
      return null;
    }
    throw error;
  }
}

/** How many times `publishEvent` tries before giving up on a busy repo. */
const MAX_ATTEMPTS = 10;

/**
 * Wait a random time before retrying, longer after each lost attempt.
 *
 * Without this a writer that publishes back to back wins every race, since
 * the loser's read and write always span one of the winner's commits.
 *
 * @param attempt - The attempt that just lost, starting at 1.
 */
function backOff(attempt: number): Promise<void> {
  const ceiling = Math.min(10 * 2 ** attempt, 1000);
  return new Promise((resolve) => {
    setTimeout(resolve, Math.random() * ceiling);
  });
}

/** Thrown when every attempt lost the race to another writer. */
export class PublishConflictError extends Error {
  /**
   * @param stream - The stream that could not be published to.
   * @param attempts - How many attempts were made.
   */
  constructor(stream: string, attempts: number) {
    super(
      `could not publish to ${stream}: the repo changed during each of ${attempts} attempts`,
    );
    this.name = "PublishConflictError";
  }
}

/**
 * Compute the CID the PDS gives a record, without writing it.
 *
 * @param record - A JSON record with no blobs or CID links.
 * @returns The record's CID as a string.
 */
export async function recordCid(record: object): Promise<string> {
  const cid = await cidForRecord(record as Parameters<typeof cidForRecord>[0]);
  return cid.toString();
}

/**
 * Tell whether an error is the PDS refusing a stale `swapCommit`.
 *
 * @param error - The error from `applyWrites`.
 * @returns `true` if another commit landed first.
 */
function isInvalidSwap(error: unknown): boolean {
  return error instanceof XRPCError && error.error === "InvalidSwap";
}

/**
 * Publish the next event on a stream and move the head to it, in one commit.
 *
 * Reads the repo's latest commit and the head, then sends the event and the
 * new head in one `applyWrites` guarded by `swapCommit`. If another commit
 * landed in between, the PDS refuses the batch and this waits a moment, reads
 * again, and retries, so concurrent publishers never reuse or skip a seq. Both records
 * are checked against the contract before they are sent, since the PDS does
 * not know our Lexicons.
 *
 * If the request fails for another reason, the response may have been lost
 * after the PDS committed. The head is read again: if it is at this seq with
 * this event's CID the write succeeded and is not sent twice. In that case
 * `commitCid` and `rev` are the repo's latest commit at the time of the
 * re-read, which is a later commit if another write landed since.
 *
 * @param session - The publisher session.
 * @param input - Stream, kind, and payload of the event.
 * @returns The seq, record key, and CID of the event, and its commit.
 * @throws ContractError if the input would make an invalid event.
 * @throws PublishConflictError if the repo kept changing under every attempt.
 */
export async function publishEvent(
  session: PublisherSession,
  input: PublishInput,
): Promise<Published> {
  const { repo, sync } = session.agent.com.atproto;
  const headKey = headRkey(input.stream);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    // The commit is read before the head: a commit that lands after this
    // line makes the swap fail, so a stale head is never written over.
    const latest = await sync.getLatestCommit({ did: session.did });
    const head = await readHead(session, input.stream);
    const seq = head === null ? 1 : head.seq + 1;
    const rkey = eventRkey(input.stream, seq);

    const event: EventRecord = parseEventRecord(
      {
        $type: EVENT_NSID,
        stream: input.stream,
        seq,
        ...(head === null ? {} : { prevEventCid: head.eventCid }),
        kind: input.kind,
        ...(input.refSeq === undefined ? {} : { refSeq: input.refSeq }),
        payload: input.payload,
        createdAt:
          typeof input.createdAt === "function"
            ? input.createdAt(seq)
            : input.createdAt,
      },
      rkey,
    );
    // The head names the event's CID, so it is computed before the write.
    const cid = await recordCid(event);
    const nextHead: HeadRecord = parseHeadRecord(
      { $type: HEAD_NSID, stream: input.stream, seq, eventCid: cid },
      headKey,
    );

    let data;
    try {
      const response = await repo.applyWrites({
        repo: session.did,
        swapCommit: latest.data.cid,
        writes: [
          {
            $type: "com.atproto.repo.applyWrites#create",
            collection: EVENT_NSID,
            rkey,
            value: { ...event },
          },
          {
            $type:
              head === null
                ? "com.atproto.repo.applyWrites#create"
                : "com.atproto.repo.applyWrites#update",
            collection: HEAD_NSID,
            rkey: headKey,
            value: { ...nextHead },
          },
        ],
      });
      data = response.data;
    } catch (error) {
      if (isInvalidSwap(error)) {
        if (attempt < MAX_ATTEMPTS) await backOff(attempt);
        continue;
      }
      const after = await readHead(session, input.stream).catch(() => null);
      if (after?.seq !== seq || after.eventCid !== cid) throw error;
      const commit = await sync.getLatestCommit({ did: session.did });
      return {
        seq,
        rkey,
        cid,
        commitCid: commit.data.cid,
        rev: commit.data.rev,
      };
    }

    const written = data.results?.[0];
    if (written === undefined || !("cid" in written) || written.cid !== cid) {
      throw new Error(
        `the PDS stored ${rkey} with a different CID than the head names (${cid})`,
      );
    }
    if (data.commit === undefined) {
      throw new Error(`the PDS returned no commit for ${rkey}`);
    }
    return {
      seq,
      rkey,
      cid,
      commitCid: data.commit.cid,
      rev: data.commit.rev,
    };
  }
  throw new PublishConflictError(input.stream, MAX_ATTEMPTS);
}

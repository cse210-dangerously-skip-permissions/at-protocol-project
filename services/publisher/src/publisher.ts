import { AtpAgent, XRPCError } from "@atproto/api";
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

/**
 * Publish the next event on a stream, then move the head to it.
 *
 * Reads the head, writes the event at the next seq with a link to the
 * previous event, then writes the head. Both records are checked against the
 * contract before they are sent, since the PDS does not know our Lexicons.
 *
 * The two writes are separate commits. If the process dies between them the
 * head stays one behind, and #63 makes them atomic. Do not call this
 * concurrently for one stream.
 *
 * @param session - The publisher session.
 * @param input - Stream, kind, and payload of the event.
 * @returns The seq, record key, and CID of the event, and its commit.
 * @throws ContractError if the input would make an invalid event.
 */
export async function publishEvent(
  session: PublisherSession,
  input: PublishInput,
): Promise<Published> {
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
      createdAt: new Date().toISOString(),
    },
    rkey,
  );

  const repo = session.agent.com.atproto.repo;
  const created = await repo.createRecord({
    repo: session.did,
    collection: EVENT_NSID,
    rkey,
    record: { ...event },
  });
  const { cid, commit } = created.data;
  if (commit === undefined) {
    throw new Error(`the PDS returned no commit for ${rkey}`);
  }

  const headKey = headRkey(input.stream);
  const nextHead: HeadRecord = parseHeadRecord(
    { $type: HEAD_NSID, stream: input.stream, seq, eventCid: cid },
    headKey,
  );
  await repo.putRecord({
    repo: session.did,
    collection: HEAD_NSID,
    rkey: headKey,
    record: { ...nextHead },
  });

  return { seq, rkey, cid, commitCid: commit.cid, rev: commit.rev };
}

import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { XRPCError } from "@atproto/api";
import {
  EVENT_NSID,
  type EventRecord,
  eventRkey,
  HEAD_NSID,
  type HeadRecord,
  headRkey,
  isStreamName,
  loadLocalEnv,
  parseEventRecord,
  parseHeadRecord,
} from "@trustlab/contracts";
import { publisherLog } from "./log.js";
import { integerOption } from "./args.js";
import {
  login,
  type PublisherSession,
  readHead,
  recordCid,
} from "./publisher.js";

// Tools that break the event contract on purpose, for experiments. Every
// write here is a legal PDS write by the account owner: the PDS does not
// stop it, so only the chain and the witness can catch it.
//
// Each tool sends one `applyWrites`, so a tamper is one commit: a consumer
// on the firehose sees the stream before it or after it, never halfway. The
// call is guarded by `swapCommit`, so a publish that lands while the tool is
// reading makes it fail with nothing written.

/**
 * The most writes one tamper may make: what the PDS takes in one
 * `applyWrites`. The S0 baseline applies the same limit (#83).
 */
export const MAX_TAMPER_WRITES = 200;

/** What a tamper tool changed. */
export interface Tampered {
  /** The events the tool wrote, lowest seq first, with their new CIDs. */
  events: { seq: number; cid: string }[];
  /** The head the tool wrote, or `undefined` if it left the head alone. */
  head?: { seq: number; eventCid: string };
  /** CID of the commit that carried every write. */
  commitCid: string;
  /** Repo revision of that commit. */
  rev: string;
}

/** Thrown when the repo changed while a tool was reading. Nothing was written. */
export class TamperConflictError extends Error {
  /** @param stream - The stream the tool was working on. */
  constructor(stream: string) {
    super(
      `the repo changed while tampering with ${stream}; nothing was written, run it again`,
    );
    this.name = "TamperConflictError";
  }
}

/** One record change inside a tamper's commit. */
type TamperWrite =
  | {
      op: "update";
      collection: string;
      rkey: string;
      value: EventRecord | HeadRecord;
      cid: string;
    }
  | { op: "delete"; collection: string; rkey: string };

/** A write that stores a record, with the CID it will get. */
type UpdateWrite = Extract<TamperWrite, { op: "update" }>;

/**
 * Read the repo's latest commit, then the head, and check that a seq is
 * inside the stream.
 *
 * The commit is read first: anything that lands after it makes the tool's
 * write fail its `swapCommit`, so the tool never acts on a stale head.
 *
 * @param session - The publisher session.
 * @param stream - Stream name.
 * @param seq - The seq a tool was asked to work from.
 * @param belowHead - Whether the seq must be below the head, not just in it.
 * @returns The commit to swap against and the head's seq.
 * @throws RangeError if the stream is empty or the seq is out of range.
 */
async function openStream(
  session: PublisherSession,
  stream: string,
  seq: number,
  belowHead = false,
): Promise<{ swapCommit: string; headSeq: number }> {
  // Checks the stream name and the seq before the first request.
  eventRkey(stream, seq);
  const latest = await session.agent.com.atproto.sync.getLatestCommit({
    did: session.did,
  });
  const head = await readHead(session, stream);
  if (head === null) {
    throw new RangeError(`${stream} has no events to tamper with`);
  }
  if (belowHead && seq >= head.seq) {
    throw new RangeError(
      `truncate needs a seq below the head (${head.seq}), got ${seq}`,
    );
  }
  if (seq > head.seq) {
    throw new RangeError(
      `seq ${seq} is out of range: ${stream} has ${head.seq} events`,
    );
  }
  return { swapCommit: latest.data.cid, headSeq: head.seq };
}

/**
 * Read an event that a tamper tool is about to touch, with its stored CID.
 *
 * @param session - The publisher session.
 * @param stream - Stream name.
 * @param seq - The event's seq.
 * @returns The stored event and its CID.
 * @throws RangeError if the stream has no event at that seq.
 * @throws ContractError if the stored record breaks the contract.
 */
async function requireEvent(
  session: PublisherSession,
  stream: string,
  seq: number,
): Promise<{ event: EventRecord; cid: string }> {
  const rkey = eventRkey(stream, seq);
  let data;
  try {
    const response = await session.agent.com.atproto.repo.getRecord({
      repo: session.did,
      collection: EVENT_NSID,
      rkey,
    });
    data = response.data;
  } catch (error) {
    if (error instanceof XRPCError && error.error === "RecordNotFound") {
      throw new RangeError(`${stream} has no event at seq ${seq}`);
    }
    throw error;
  }
  const event = parseEventRecord(data.value, rkey);
  return { event, cid: data.cid ?? (await recordCid(event)) };
}

/**
 * Give an event a payload that differs from the one it has.
 *
 * The new checksum is a hash of the old one, so it has the same length
 * however many times an event is tampered with.
 *
 * @param event - The stored event.
 * @returns A copy with a changed checksum.
 */
export function withChangedPayload(event: EventRecord): EventRecord {
  const digest = createHash("sha256")
    .update(event.payload.checksum)
    .digest("hex");
  return {
    ...event,
    payload: { ...event.payload, checksum: `tampered:${digest}` },
  };
}

/**
 * Build the write that stores an event at its own key.
 *
 * @param event - The record to store.
 * @returns An update with the CID the record will get.
 * @throws ContractError if the record breaks the contract.
 */
async function eventWrite(event: EventRecord): Promise<UpdateWrite> {
  const rkey = eventRkey(event.stream, event.seq);
  const value = parseEventRecord(event, rkey);
  return {
    op: "update",
    collection: EVENT_NSID,
    rkey,
    value,
    cid: await recordCid(value),
  };
}

/**
 * Build the write that points a stream's head at an event.
 *
 * @param stream - Stream name.
 * @param seq - The seq the head should name.
 * @param eventCid - CID of the event at that seq.
 * @returns An update with the CID the head record will get.
 */
async function headWrite(
  stream: string,
  seq: number,
  eventCid: string,
): Promise<UpdateWrite> {
  const rkey = headRkey(stream);
  const value = parseHeadRecord(
    { $type: HEAD_NSID, stream, seq, eventCid },
    rkey,
  );
  return {
    op: "update",
    collection: HEAD_NSID,
    rkey,
    value,
    cid: await recordCid(value),
  };
}

/**
 * Send a tool's writes as one commit, guarded by `swapCommit`.
 *
 * @param session - The publisher session.
 * @param stream - Stream name, for error messages.
 * @param swapCommit - The commit the tool read before anything else.
 * @param writes - Every record change the tool makes.
 * @returns The commit that carried the writes.
 * @throws RangeError if there are more writes than one `applyWrites` takes.
 * @throws TamperConflictError if another commit landed since `swapCommit`.
 */
async function commitWrites(
  session: PublisherSession,
  stream: string,
  swapCommit: string,
  writes: TamperWrite[],
): Promise<{ commitCid: string; rev: string }> {
  if (writes.length > MAX_TAMPER_WRITES) {
    throw new RangeError(
      `this needs ${writes.length} writes, and one commit takes at most ${MAX_TAMPER_WRITES}`,
    );
  }
  let data;
  try {
    const response = await session.agent.com.atproto.repo.applyWrites({
      repo: session.did,
      swapCommit,
      writes: writes.map((write) =>
        write.op === "update"
          ? {
              $type: "com.atproto.repo.applyWrites#update" as const,
              collection: write.collection,
              rkey: write.rkey,
              value: { ...write.value },
            }
          : {
              $type: "com.atproto.repo.applyWrites#delete" as const,
              collection: write.collection,
              rkey: write.rkey,
            },
      ),
    });
    data = response.data;
  } catch (error) {
    if (error instanceof XRPCError && error.error === "InvalidSwap") {
      throw new TamperConflictError(stream);
    }
    throw error;
  }

  writes.forEach((write, index) => {
    if (write.op !== "update") return;
    const result = data.results?.[index];
    if (
      result === undefined ||
      !("cid" in result) ||
      result.cid !== write.cid
    ) {
      throw new Error(
        `the PDS stored ${write.rkey} with a different CID than expected (${write.cid})`,
      );
    }
  });
  if (data.commit === undefined) {
    throw new Error(`the PDS returned no commit for the tamper on ${stream}`);
  }
  return { commitCid: data.commit.cid, rev: data.commit.rev };
}

/**
 * Edit one event in place: overwrite its record with a changed payload.
 *
 * Nothing else is touched, so the event gets a new CID and the next event's
 * `prevEventCid` (or the head, for the last event) no longer matches it.
 *
 * @param session - The publisher session.
 * @param stream - Stream name.
 * @param seq - The seq of the event to edit.
 * @returns The edited event's new CID and the commit.
 * @throws RangeError if the stream has no event at that seq.
 * @throws TamperConflictError if the repo changed while the tool was reading.
 */
export async function tamperEdit(
  session: PublisherSession,
  stream: string,
  seq: number,
): Promise<Tampered> {
  const { swapCommit } = await openStream(session, stream, seq);
  const { event } = await requireEvent(session, stream, seq);
  const write = await eventWrite(withChangedPayload(event));
  const commit = await commitWrites(session, stream, swapCommit, [write]);
  return { events: [{ seq, cid: write.cid }], ...commit };
}

/**
 * Rewrite history from one seq to the head, in one commit: each event gets a
 * changed payload, each event after the first links to the rewritten event
 * before it, and the head is moved to the last one.
 *
 * The event at `from` keeps its link to the untouched event before it, so
 * the result is a valid chain on its own. Only someone who saw the old CIDs,
 * such as a witness, can tell it was rewritten.
 *
 * @param session - The publisher session.
 * @param stream - Stream name.
 * @param from - The first seq to rewrite.
 * @returns The new CID of every rewritten event, the new head, and the commit.
 * @throws RangeError if an event in the range is missing, or the range is
 *   too long for one commit.
 * @throws TamperConflictError if the repo changed while the tool was reading.
 */
export async function tamperRewrite(
  session: PublisherSession,
  stream: string,
  from: number,
): Promise<Tampered> {
  const { swapCommit, headSeq } = await openStream(session, stream, from);
  const writes: TamperWrite[] = [];
  const events: Tampered["events"] = [];
  let prevCid: string | undefined;
  for (let seq = from; seq <= headSeq; seq += 1) {
    const { event } = await requireEvent(session, stream, seq);
    const rewritten = withChangedPayload(event);
    const write = await eventWrite(
      prevCid === undefined
        ? rewritten
        : { ...rewritten, prevEventCid: prevCid },
    );
    prevCid = write.cid;
    writes.push(write);
    events.push({ seq, cid: prevCid });
  }
  // openStream checked from <= headSeq, so the loop ran at least once.
  const eventCid = prevCid as string;
  writes.push(await headWrite(stream, headSeq, eventCid));
  const commit = await commitWrites(session, stream, swapCommit, writes);
  return { events, head: { seq: headSeq, eventCid }, ...commit };
}

/**
 * Truncate a stream in one commit: delete every event after `to` and move
 * the head back to `to`.
 *
 * @param session - The publisher session.
 * @param stream - Stream name.
 * @param to - The seq of the last event to keep. Must be below the head.
 * @returns The new head and the commit. `events` is empty.
 * @throws RangeError if `to` is not below the head's seq, the stream has no
 *   event at `to`, or there are too many events to delete in one commit.
 * @throws TamperConflictError if the repo changed while the tool was reading.
 */
export async function tamperTruncate(
  session: PublisherSession,
  stream: string,
  to: number,
): Promise<Tampered> {
  const { swapCommit, headSeq } = await openStream(session, stream, to, true);
  const kept = await requireEvent(session, stream, to);
  const writes: TamperWrite[] = [];
  for (let seq = to + 1; seq <= headSeq; seq += 1) {
    writes.push({
      op: "delete",
      collection: EVENT_NSID,
      rkey: eventRkey(stream, seq),
    });
  }
  writes.push(await headWrite(stream, to, kept.cid));
  const commit = await commitWrites(session, stream, swapCommit, writes);
  return { events: [], head: { seq: to, eventCid: kept.cid }, ...commit };
}

const USAGE = `Usage: tamper edit     --stream <name> --seq <n>
       tamper rewrite  --stream <name> --from <n>
       tamper truncate --stream <name> --to <n>

Break the event contract on purpose, for experiments.

  edit      Change the event at --seq in place
  rewrite   Replace the events from --from to the head, with valid links
  truncate  Delete the events after --to and move the head back

Each tool is one commit. It fails, writing nothing, if the repo changes
while it runs.
  --help    Show this text`;

/** A parsed `tamper` command. */
export type TamperArgs =
  | { tool: "edit"; stream: string; seq: number }
  | { tool: "rewrite"; stream: string; from: number }
  | { tool: "truncate"; stream: string; to: number };

/** Optional overrides for `runTamper`, used by tests and the harness. */
export interface TamperOptions {
  /** An existing session. Defaults to logging in with `.env.local`. */
  session?: PublisherSession;
  /** Where the result line goes. Defaults to structured output on stdout. */
  log?: (line: string) => void;
}

/** The seq option each tool takes. */
const SEQ_OPTION = { edit: "seq", rewrite: "from", truncate: "to" } as const;

/**
 * Parse `tamper` command-line arguments.
 *
 * @param argv - The arguments after `tamper`.
 * @returns The command, or `null` when `--help` was asked for.
 * @throws RangeError if the tool is unknown, an option is missing or not a
 *   whole number, or an option belongs to another tool.
 */
export function parseTamperArgs(argv: readonly string[]): TamperArgs | null {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      stream: { type: "string" },
      seq: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help) return null;
  const [tool, ...extra] = positionals;
  if (extra.length > 0) {
    throw new RangeError(`unexpected argument ${JSON.stringify(extra[0])}`);
  }
  if (tool !== "edit" && tool !== "rewrite" && tool !== "truncate") {
    throw new RangeError("tamper needs one of: edit, rewrite, truncate");
  }
  if (values.stream === undefined) {
    throw new RangeError("--stream is required");
  }
  const stream = values.stream;
  for (const option of ["seq", "from", "to"] as const) {
    if (option !== SEQ_OPTION[tool] && values[option] !== undefined) {
      throw new RangeError(
        `${tool} takes --${SEQ_OPTION[tool]}, not --${option}`,
      );
    }
  }
  switch (tool) {
    case "edit":
      return { tool, stream, seq: integerOption("seq", values.seq) };
    case "rewrite":
      return { tool, stream, from: integerOption("from", values.from) };
    case "truncate":
      return { tool, stream, to: integerOption("to", values.to) };
  }
}

/**
 * Run one tamper tool and print what it wrote: one line per rewritten event
 * with its new CID, or the head's new position for truncate.
 *
 * @param args - The tool, the stream, and the seq it works from.
 * @param options - A session and a log function, when not using the defaults.
 * @returns What the tool changed, so a caller can compare CIDs across runs.
 * @throws RangeError if the stream name or seq is invalid, before logging in.
 */
export async function runTamper(
  args: TamperArgs,
  options: TamperOptions = {},
): Promise<Tampered> {
  if (!isStreamName(args.stream)) {
    throw new RangeError(`bad stream name ${JSON.stringify(args.stream)}`);
  }
  const seq =
    args.tool === "edit"
      ? args.seq
      : args.tool === "rewrite"
        ? args.from
        : args.to;
  // Checks the seq before logging in, so a bad one fails the same way
  // whether or not the PDS is up.
  eventRkey(args.stream, seq);
  const log = options.log ?? publisherLog;
  const session = options.session ?? (await login(loadLocalEnv()));

  let result: Tampered;
  switch (args.tool) {
    case "edit":
      result = await tamperEdit(session, args.stream, seq);
      break;
    case "rewrite":
      result = await tamperRewrite(session, args.stream, seq);
      break;
    case "truncate":
      result = await tamperTruncate(session, args.stream, seq);
      break;
  }
  for (const event of result.events) {
    log(
      `tampered ${args.stream} ${args.tool} seq=${event.seq} cid=${event.cid}`,
    );
  }
  if (args.tool === "truncate" && result.head !== undefined) {
    log(
      `tampered ${args.stream} truncate to=${result.head.seq} cid=${result.head.eventCid}`,
    );
  }
  return result;
}

/**
 * Run the `tamper` command.
 *
 * @param argv - The arguments after `tamper`.
 * @param options - A session and a log function, when not using the defaults.
 * @returns The exit code: 0 on success, 2 for bad arguments, 1 otherwise.
 */
export async function tamperMain(
  argv: readonly string[],
  options: TamperOptions = {},
): Promise<number> {
  let args: TamperArgs | null;
  try {
    args = parseTamperArgs(argv);
  } catch (error) {
    publisherLog(error, console.error);
    publisherLog(USAGE, console.error);
    return 2;
  }
  if (args === null) {
    (options.log ?? console.log)(USAGE);
    return 0;
  }
  try {
    await runTamper(args, options);
    return 0;
  } catch (error) {
    publisherLog(error, console.error);
    return error instanceof RangeError ? 2 : 1;
  }
}

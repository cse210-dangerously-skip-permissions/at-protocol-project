import { parseArgs } from "node:util";
import {
  EVENT_NSID,
  type EventRecord,
  eventRkey,
  HEAD_NSID,
  headRkey,
  isStreamName,
  loadLocalEnv,
  parseEventRecord,
  parseHeadRecord,
} from "@trustlab/contracts";
import { readEvent } from "./amend.js";
import { integerOption } from "./args.js";
import { login, type PublisherSession, readHead } from "./publisher.js";

// Tools that break the event contract on purpose, for experiments. Every
// write here is a legal PDS write by the account owner: the PDS does not
// stop it, so only the chain and the witness can catch it.

/**
 * Read an event that a tamper tool is about to touch.
 *
 * @param session - The publisher session.
 * @param stream - Stream name.
 * @param seq - The event's seq.
 * @returns The stored event.
 * @throws RangeError if the stream has no event at that seq.
 */
async function requireEvent(
  session: PublisherSession,
  stream: string,
  seq: number,
): Promise<EventRecord> {
  const event = await readEvent(session, stream, seq);
  if (event === null) {
    throw new RangeError(`${stream} has no event at seq ${seq}`);
  }
  return event;
}

/**
 * Read the head seq and check that a seq is inside the stream.
 *
 * @param session - The publisher session.
 * @param stream - Stream name.
 * @param seq - The seq a tool was asked to start from.
 * @param highest - The largest seq allowed, as an offset from the head.
 * @returns The head's seq.
 * @throws RangeError if the stream is empty or the seq is out of range.
 */
async function headSeqFor(
  session: PublisherSession,
  stream: string,
  seq: number,
  highest: 0 | -1,
): Promise<number> {
  // Checks the stream name and the seq before anything touches the network.
  eventRkey(stream, seq);
  const head = await readHead(session, stream);
  if (head === null) {
    throw new RangeError(`${stream} has no events to tamper with`);
  }
  if (seq > head.seq + highest) {
    throw new RangeError(
      `seq ${seq} is out of range: ${stream} has ${head.seq} events`,
    );
  }
  return head.seq;
}

/**
 * Give an event a payload that differs from the one it has.
 *
 * @param event - The stored event.
 * @returns A copy with a changed checksum.
 */
function withChangedPayload(event: EventRecord): EventRecord {
  return {
    ...event,
    payload: {
      ...event.payload,
      checksum: `tampered:${event.payload.checksum}`,
    },
  };
}

/**
 * Overwrite one event record in place.
 *
 * @param session - The publisher session.
 * @param event - The record to store at its own key.
 * @returns The CID the PDS gave the new record.
 */
async function putEvent(
  session: PublisherSession,
  event: EventRecord,
): Promise<string> {
  const rkey = eventRkey(event.stream, event.seq);
  const response = await session.agent.com.atproto.repo.putRecord({
    repo: session.did,
    collection: EVENT_NSID,
    rkey,
    record: { ...parseEventRecord(event, rkey) },
  });
  return response.data.cid;
}

/**
 * Point a stream's head at an event.
 *
 * @param session - The publisher session.
 * @param stream - Stream name.
 * @param seq - The seq the head should name.
 * @param eventCid - CID of the event at that seq.
 */
async function putHead(
  session: PublisherSession,
  stream: string,
  seq: number,
  eventCid: string,
): Promise<void> {
  const rkey = headRkey(stream);
  await session.agent.com.atproto.repo.putRecord({
    repo: session.did,
    collection: HEAD_NSID,
    rkey,
    record: {
      ...parseHeadRecord({ $type: HEAD_NSID, stream, seq, eventCid }, rkey),
    },
  });
}

/**
 * Edit one event in place: `putRecord` on its key with a changed payload.
 *
 * Nothing else is touched, so the event gets a new CID and the next event's
 * `prevEventCid` (or the head, for the last event) no longer matches it.
 *
 * @param session - The publisher session.
 * @param stream - Stream name.
 * @param seq - The seq of the event to edit.
 * @throws RangeError if the stream has no event at that seq.
 */
export async function tamperEdit(
  session: PublisherSession,
  stream: string,
  seq: number,
): Promise<void> {
  await headSeqFor(session, stream, seq, 0);
  const event = await requireEvent(session, stream, seq);
  await putEvent(session, withChangedPayload(event));
}

/**
 * Rewrite history from one seq to the head: each event gets a changed
 * payload and a link to the rewritten event before it, then the head is
 * moved to the last one.
 *
 * The result is a valid chain on its own. Only someone who saw the old CIDs,
 * such as a witness, can tell it was rewritten.
 *
 * @param session - The publisher session.
 * @param stream - Stream name.
 * @param from - The first seq to rewrite.
 * @throws RangeError if the stream has no event at `from`.
 */
export async function tamperRewrite(
  session: PublisherSession,
  stream: string,
  from: number,
): Promise<void> {
  const headSeq = await headSeqFor(session, stream, from, 0);
  // Read everything first, so a missing event stops the tool before it
  // writes anything.
  const events: EventRecord[] = [];
  for (let seq = from; seq <= headSeq; seq += 1) {
    events.push(await requireEvent(session, stream, seq));
  }

  let prevCid: string | undefined;
  for (const event of events) {
    const rewritten = withChangedPayload(event);
    // The first rewritten event keeps its link to the untouched event
    // before it.
    prevCid = await putEvent(
      session,
      prevCid === undefined
        ? rewritten
        : { ...rewritten, prevEventCid: prevCid },
    );
  }
  if (prevCid !== undefined) await putHead(session, stream, headSeq, prevCid);
}

/**
 * Truncate a stream: delete every event after `to`, then move the head back
 * to `to`.
 *
 * @param session - The publisher session.
 * @param stream - Stream name.
 * @param to - The seq of the last event to keep. Must be below the head.
 * @throws RangeError if `to` is not below the head's seq.
 */
export async function tamperTruncate(
  session: PublisherSession,
  stream: string,
  to: number,
): Promise<void> {
  const headSeq = await headSeqFor(session, stream, to, -1);
  const repo = session.agent.com.atproto.repo;
  const kept = await repo.getRecord({
    repo: session.did,
    collection: EVENT_NSID,
    rkey: eventRkey(stream, to),
  });
  if (kept.data.cid === undefined) {
    throw new Error(`the PDS returned no CID for ${eventRkey(stream, to)}`);
  }

  for (let seq = to + 1; seq <= headSeq; seq += 1) {
    await repo.deleteRecord({
      repo: session.did,
      collection: EVENT_NSID,
      rkey: eventRkey(stream, seq),
    });
  }
  await putHead(session, stream, to, kept.data.cid);
}

const USAGE = `Usage: tamper edit     --stream <name> --seq <n>
       tamper rewrite  --stream <name> --from <n>
       tamper truncate --stream <name> --to <n>

Break the event contract on purpose, for experiments.

  edit      Change the event at --seq in place
  rewrite   Replace the events from --from to the head, with valid links
  truncate  Delete the events after --to and move the head back
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
  /** Where the result line goes. Defaults to `console.log`. */
  log?: (line: string) => void;
}

/**
 * Parse `tamper` command-line arguments.
 *
 * @param argv - The arguments after `tamper`.
 * @returns The command, or `null` when `--help` was asked for.
 * @throws RangeError if the tool is unknown or an option is missing or not
 *   a whole number.
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
 * Run one tamper tool and print a line saying what it did.
 *
 * @param args - The tool, the stream, and the seq it works from.
 * @param options - A session and a log function, when not using the defaults.
 */
export async function runTamper(
  args: TamperArgs,
  options: TamperOptions = {},
): Promise<void> {
  if (!isStreamName(args.stream)) {
    throw new RangeError(`bad stream name ${JSON.stringify(args.stream)}`);
  }
  const log = options.log ?? ((line: string) => console.log(line));
  const session = options.session ?? (await login(loadLocalEnv()));

  switch (args.tool) {
    case "edit":
      await tamperEdit(session, args.stream, args.seq);
      log(`tampered ${args.stream} edit seq=${args.seq}`);
      break;
    case "rewrite":
      await tamperRewrite(session, args.stream, args.from);
      log(`tampered ${args.stream} rewrite from=${args.from}`);
      break;
    case "truncate":
      await tamperTruncate(session, args.stream, args.to);
      log(`tampered ${args.stream} truncate to=${args.to}`);
      break;
  }
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
  const log = options.log ?? ((line: string) => console.log(line));
  let args: TamperArgs | null;
  try {
    args = parseTamperArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(USAGE);
    return 2;
  }
  if (args === null) {
    log(USAGE);
    return 0;
  }
  try {
    await runTamper(args, options);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return error instanceof RangeError ? 2 : 1;
  }
}

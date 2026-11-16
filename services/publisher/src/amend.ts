import { parseArgs } from "node:util";
import { XRPCError } from "@atproto/api";
import {
  EVENT_NSID,
  type EventRecord,
  eventRkey,
  isStreamName,
  loadLocalEnv,
  parseEventRecord,
  type Payload,
} from "@trustlab/contracts";
import { integerOption } from "./args.js";
import {
  login,
  publishEvent,
  type Published,
  type PublisherSession,
} from "./publisher.js";
import { workloadCreatedAt } from "./workload.js";

/** The two ways to amend an earlier event. Both append a new event. */
export type AmendKind = "correct" | "withdraw";

/** What to amend on a stream. */
export interface AmendInput {
  /** Stream name, such as `releases`. */
  stream: string;
  kind: AmendKind;
  /** The seq of the event being corrected or withdrawn. */
  refSeq: number;
  /**
   * Payload fields to change. The rest are copied from the event at
   * `refSeq`, so a withdrawal names the release it withdraws.
   */
  changes?: Partial<Payload>;
  /** ISO 8601 time, or a function that gives it from the new event's seq. */
  createdAt: string | ((seq: number) => string);
}

/**
 * Read one event record from the publisher's repo.
 *
 * @param session - The publisher session.
 * @param stream - Stream name.
 * @param seq - The event's seq.
 * @returns The event, or `null` if the stream has no event at that seq.
 * @throws ContractError if the stored record breaks the contract.
 */
export async function readEvent(
  session: PublisherSession,
  stream: string,
  seq: number,
): Promise<EventRecord | null> {
  const rkey = eventRkey(stream, seq);
  try {
    const response = await session.agent.com.atproto.repo.getRecord({
      repo: session.did,
      collection: EVENT_NSID,
      rkey,
    });
    return parseEventRecord(response.data.value, rkey);
  } catch (error) {
    if (error instanceof XRPCError && error.error === "RecordNotFound") {
      return null;
    }
    throw error;
  }
}

/**
 * Correct or withdraw an earlier event by appending a new event that refers
 * to it. The earlier event is read but never written.
 *
 * @param session - The publisher session.
 * @param input - Stream, kind, the seq referred to, and any payload changes.
 * @returns The seq, record key, and CID of the new event, and its commit.
 * @throws RangeError if the stream has no event at `refSeq`.
 * @throws ContractError if the new event would break the contract.
 */
export async function amendEvent(
  session: PublisherSession,
  input: AmendInput,
): Promise<Published> {
  const target = await readEvent(session, input.stream, input.refSeq);
  if (target === null) {
    throw new RangeError(
      `${input.stream} has no event at seq ${input.refSeq} to ${input.kind}`,
    );
  }
  // The contract check inside publishEvent rejects a refSeq that is not
  // lower than the new seq.
  return publishEvent(session, {
    stream: input.stream,
    kind: input.kind,
    refSeq: input.refSeq,
    payload: { ...target.payload, ...input.changes },
    createdAt: input.createdAt,
  });
}

const USAGE = `Usage: correct  --stream <name> --seq <n> --seed <n> [--version <v>] [--checksum <c>]
       withdraw --stream <name> --seq <n> --seed <n>

Append an event that corrects or withdraws the event at --seq. The earlier
event is never changed.

  --stream    Stream name, such as releases
  --seq       The seq of the event to correct or withdraw
  --seed      Workload seed, used for the new event's createdAt
  --version   correct only: the corrected version
  --checksum  correct only: the corrected checksum
  --help      Show this text`;

/** What `runAmend` needs. */
export interface AmendArgs {
  kind: AmendKind;
  /** Stream name, such as `releases`. */
  stream: string;
  /** The seq of the event to correct or withdraw. */
  seq: number;
  /** Workload seed, so the new event's time comes from its seq, not the clock. */
  seed: number;
  /** Payload fields a correction changes. */
  changes?: Partial<Payload>;
}

/** Optional overrides for `runAmend`, used by tests and the harness. */
export interface AmendOptions {
  /** An existing session. Defaults to logging in with `.env.local`. */
  session?: PublisherSession;
  /** Where the result line goes. Defaults to `console.log`. */
  log?: (line: string) => void;
}

/**
 * Tell whether a command name is `correct` or `withdraw`.
 *
 * @param command - The first command-line argument.
 * @returns `true` for an amend command.
 */
export function isAmendKind(command: string | undefined): command is AmendKind {
  return command === "correct" || command === "withdraw";
}

/**
 * Parse `correct` or `withdraw` command-line arguments.
 *
 * @param kind - Which command was given.
 * @param argv - The arguments after the command name.
 * @returns The arguments, or `null` when `--help` was asked for.
 * @throws RangeError if an option is missing, not a whole number, or does
 *   not fit the command.
 */
export function parseAmendArgs(
  kind: AmendKind,
  argv: readonly string[],
): AmendArgs | null {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      stream: { type: "string" },
      seq: { type: "string" },
      seed: { type: "string" },
      version: { type: "string" },
      checksum: { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help) return null;
  if (values.stream === undefined) {
    throw new RangeError("--stream is required");
  }
  const changes: Partial<Payload> = {
    ...(values.version === undefined ? {} : { version: values.version }),
    ...(values.checksum === undefined ? {} : { checksum: values.checksum }),
  };
  const changed = Object.keys(changes).length > 0;
  if (kind === "withdraw" && changed) {
    throw new RangeError("withdraw takes no --version or --checksum");
  }
  if (kind === "correct" && !changed) {
    throw new RangeError("correct needs --version or --checksum");
  }
  return {
    kind,
    stream: values.stream,
    seq: integerOption("seq", values.seq),
    seed: integerOption("seed", values.seed),
    ...(changed ? { changes } : {}),
  };
}

/**
 * Correct or withdraw one event and print a line for the new event.
 *
 * @param args - Kind, stream, the seq referred to, seed, and any changes.
 * @param options - A session and a log function, when not using the defaults.
 * @returns The new event.
 */
export async function runAmend(
  args: AmendArgs,
  options: AmendOptions = {},
): Promise<Published> {
  if (!isStreamName(args.stream)) {
    throw new RangeError(`bad stream name ${JSON.stringify(args.stream)}`);
  }
  // Checks the seq before anything touches the network.
  eventRkey(args.stream, args.seq);
  const log = options.log ?? ((line: string) => console.log(line));
  const session = options.session ?? (await login(loadLocalEnv()));

  const event = await amendEvent(session, {
    stream: args.stream,
    kind: args.kind,
    refSeq: args.seq,
    ...(args.changes === undefined ? {} : { changes: args.changes }),
    createdAt: (seq) => workloadCreatedAt(args.seed, seq),
  });
  log(
    `published ${args.stream} seq=${event.seq} cid=${event.cid} kind=${args.kind} refSeq=${args.seq}`,
  );
  return event;
}

/**
 * Run the `correct` or `withdraw` command.
 *
 * @param kind - Which command was given.
 * @param argv - The arguments after the command name.
 * @param options - A session and a log function, when not using the defaults.
 * @returns The exit code: 0 on success, 2 for bad arguments, 1 otherwise.
 */
export async function amendMain(
  kind: AmendKind,
  argv: readonly string[],
  options: AmendOptions = {},
): Promise<number> {
  const log = options.log ?? ((line: string) => console.log(line));
  let args: AmendArgs | null;
  try {
    args = parseAmendArgs(kind, argv);
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
    await runAmend(args, options);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return error instanceof RangeError ? 2 : 1;
  }
}

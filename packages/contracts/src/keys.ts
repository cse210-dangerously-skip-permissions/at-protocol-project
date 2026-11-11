/** Collection (NSID) of event records. Defined in `lexicons/dev/trustlab/event.json`. */
export const EVENT_NSID = "dev.trustlab.event";

/** Collection (NSID) of stream-head records. Defined in `lexicons/dev/trustlab/head.json`. */
export const HEAD_NSID = "dev.trustlab.head";

/** Highest seq an event record key can hold: twelve digits. */
export const MAX_SEQ = 999_999_999_999;

const STREAM_PATTERN = /^[a-z][a-z0-9]{0,31}$/;
const EVENT_RKEY_PATTERN = /^([a-z][a-z0-9]{0,31})-(\d{12})$/;
const HEAD_RKEY_PATTERN = /^head-([a-z][a-z0-9]{0,31})$/;

/**
 * Whether a string is a valid stream name: a lowercase letter, then up to 31
 * lowercase letters and digits. No hyphen, so a record key splits back into
 * stream and seq.
 *
 * @param stream - The candidate name.
 * @returns True for a valid stream name.
 */
export function isStreamName(stream: string): boolean {
  return STREAM_PATTERN.test(stream);
}

/**
 * Whether a number is a valid seq: an integer from 1 to `MAX_SEQ`.
 *
 * @param seq - The candidate seq.
 * @returns True for a valid seq.
 */
export function isSeq(seq: number): boolean {
  return Number.isSafeInteger(seq) && seq >= 1 && seq <= MAX_SEQ;
}

/**
 * The record key of an event, such as `releases-000000000042`.
 *
 * @param stream - The stream name.
 * @param seq - The event's position in the stream, from 1.
 * @returns The record key.
 */
export function eventRkey(stream: string, seq: number): string {
  assertStream(stream);
  if (!isSeq(seq)) {
    throw new RangeError(`seq must be an integer from 1 to ${MAX_SEQ}: ${seq}`);
  }
  return `${stream}-${String(seq).padStart(12, "0")}`;
}

/**
 * The record key of a stream's head, such as `head-releases`.
 *
 * @param stream - The stream name.
 * @returns The record key.
 */
export function headRkey(stream: string): string {
  assertStream(stream);
  return `head-${stream}`;
}

/**
 * Split an event record key into its stream and seq.
 *
 * @param rkey - A record key from the event collection.
 * @returns The stream and seq, or `null` if the key is not an event key.
 */
export function parseEventRkey(
  rkey: string,
): { stream: string; seq: number } | null {
  const match = EVENT_RKEY_PATTERN.exec(rkey);
  if (!match) return null;
  const seq = Number(match[2]);
  return seq >= 1 ? { stream: match[1] as string, seq } : null;
}

/**
 * Read the stream name out of a head record key.
 *
 * @param rkey - A record key from the head collection.
 * @returns The stream name, or `null` if the key is not a head key.
 */
export function parseHeadRkey(rkey: string): string | null {
  return HEAD_RKEY_PATTERN.exec(rkey)?.[1] ?? null;
}

/**
 * Throw unless a string is a valid stream name.
 *
 * @param stream - The candidate name.
 */
function assertStream(stream: string): void {
  if (!isStreamName(stream)) {
    throw new RangeError(
      `stream must be a lowercase letter followed by up to 31 lowercase letters or digits: ${JSON.stringify(stream)}`,
    );
  }
}

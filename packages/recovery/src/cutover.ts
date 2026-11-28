/**
 * A verified firehose commit held back while a rebuild runs: the fields of
 * the consumer's `VerifiedCommit` that the cutover reads. The type is
 * structural so this package does not import the consumer.
 */
export interface BufferedCommit {
  /** Firehose sequence number of the commit. */
  cursor: number;
  /** DID of the repo the commit belongs to. */
  did: string;
  /** Repo revision after the commit. */
  rev: string;
  /** The events the commit created. May be empty. */
  events: readonly { stream: string; seq: number; cid: string }[];
}

/**
 * Pick the buffered commits that still need applying after a rebuild.
 *
 * During a cutover the consumer subscribes first and buffers, rebuilds the
 * view from a snapshot at `snapshotRev`, then applies what this returns
 * before going live (#71). Pure: no I/O, and the input is not changed.
 *
 * - A commit at or below `snapshotRev` is already in the snapshot and is
 *   dropped. Revs are TIDs, which sort as strings.
 * - A commit delivered twice (the same cursor) is kept once.
 * - From the commits that remain, an event the view already holds with the
 *   same CID is removed, as is one an earlier kept commit carries with the
 *   same CID. The commit itself stays, even with no events left, because
 *   applying it still moves the cursor and the rev forward.
 * - An event whose CID differs from the one held is kept. Applying it is a
 *   conflict, and that is for the store to report, not for this to hide.
 *
 * Every buffered commit must belong to the repo that was rebuilt, since
 * `snapshotRev` is that repo's rev.
 *
 * @param buffered - Commits received while the rebuild ran, in any order.
 * @param snapshotRev - The rev of the snapshot the view was rebuilt from.
 * @param have - The CID the view holds for a DID, stream, and seq, or `null`.
 * @returns The commits to apply, lowest cursor first.
 */
export function drainBuffer<C extends BufferedCommit>(
  buffered: readonly C[],
  snapshotRev: string,
  have: (did: string, stream: string, seq: number) => string | null,
): C[] {
  const newer = buffered
    .filter((commit) => commit.rev > snapshotRev)
    .sort((a, b) => a.cursor - b.cursor);

  const cursors = new Set<number>();
  // CIDs of events in commits already kept, by DID, stream, and seq.
  const kept = new Map<string, string>();
  const result: C[] = [];
  for (const commit of newer) {
    if (cursors.has(commit.cursor)) continue;
    cursors.add(commit.cursor);

    const events = commit.events.filter((event) => {
      const key = JSON.stringify([commit.did, event.stream, event.seq]);
      const held = kept.get(key) ?? have(commit.did, event.stream, event.seq);
      kept.set(key, event.cid);
      return held !== event.cid;
    });
    result.push(
      events.length === commit.events.length
        ? commit
        : // Same commit with fewer events; every other field is untouched.
          ({ ...commit, events } as C),
    );
  }
  return result;
}

import type { LocalEnv } from "@trustlab/contracts";

/** Decides which repo DIDs to process, and counts the ones it turns away. */
export interface Allowlist {
  /**
   * Check one DID. Call it before processing anything from that repo.
   *
   * @param did - The DID of the repo the data came from.
   * @returns True if the DID is listed. Otherwise false, and the drop is counted.
   */
  allow(did: string): boolean;
  /**
   * @returns How many `allow` calls returned false so far.
   */
  dropped(): number;
}

/**
 * Make an allowlist of trusted publisher DIDs. DIDs match exactly, and an
 * empty list allows nothing. Later changes to `dids` have no effect.
 *
 * @param dids - The DIDs to allow.
 * @returns The allowlist, with its drop count at zero.
 */
export function makeAllowlist(dids: readonly string[]): Allowlist {
  const allowed = new Set(dids);
  let dropped = 0;
  return {
    allow(did) {
      if (allowed.has(did)) return true;
      dropped += 1;
      return false;
    },
    dropped: () => dropped,
  };
}

/**
 * Make the allowlist for the local network: the seeded publisher from
 * `.env.local`, and nothing else.
 *
 * @param env - The variables from `loadLocalEnv()`.
 * @returns An allowlist of `PUBLISHER_DID`.
 */
export function allowlistFromEnv(env: LocalEnv): Allowlist {
  return makeAllowlist([env.PUBLISHER_DID]);
}

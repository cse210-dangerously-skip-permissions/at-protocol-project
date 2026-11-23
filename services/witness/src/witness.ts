import { inspect } from "node:util";
import { IdResolver, MemoryCache } from "@atproto/identity";
import { Subscription } from "@atproto/xrpc-server";
import { checkCheckpoint } from "@trustlab/auditor";
import {
  log,
  type LocalEnv,
  type WitnessCheckpoint,
} from "@trustlab/contracts";
import { type HeadCommit, readHeadCommit, toCheckpoint } from "./capture.js";

/** Where checkpoints go. #48's `CheckpointStore` fits this. */
export interface WitnessStore {
  /** Save a checkpoint. Never replaces an existing one. */
  add(cp: WitnessCheckpoint): "stored" | "duplicate";
}

/** What `startWitness` needs. */
export interface WitnessOptions {
  /** The variables from `.env.local`: where the PDS and PLC are. */
  env: LocalEnv;
  /** Where verified checkpoints are saved. */
  store: WitnessStore;
  /** Which publisher DIDs to watch. */
  allow: (did: string) => boolean;
}

/** A running witness. */
export interface RunningWitness {
  /** Close the connection and wait for the frame in progress. */
  stop(): Promise<void>;
}

/**
 * Watch the PDS for head updates and save a verified checkpoint for each.
 *
 * Reads raw `subscribeRepos` frames with `Subscription`, not `@atproto/sync`,
 * which silently drops ops whose proof fails (ADR-002). Each head write from
 * an allowed DID becomes a checkpoint with a trimmed proof, checked with
 * `checkCheckpoint` against the key in the publisher's DID document. If the
 * check fails, the key is fetched again in case it rotated, and the check
 * runs once more. A checkpoint that still fails is logged and not saved.
 *
 * Every checkpoint that passes is saved, including ones with a lower seq than
 * before: an older head is evidence of a rollback.
 *
 * @param opts - Environment, store, and allowlist.
 * @returns A handle to stop the witness.
 */
export function startWitness(opts: WitnessOptions): RunningWitness {
  const { env, store, allow } = opts;
  // Same setup as the consumer: plain fetch so the local PLC is reachable,
  // and a cache so each head doesn't cost a PLC request.
  const idResolver = new IdResolver({
    plcUrl: env.PLC_URL,
    fetch: globalThis.fetch,
    didCache: new MemoryCache(),
  });
  const abort = new AbortController();
  const sub = new Subscription<unknown>({
    service: env.PDS_URL.replace(/^http/, "ws"),
    method: "com.atproto.sync.subscribeRepos",
    signal: abort.signal,
    // readHeadCommit checks the frames we use.
    validate: (value) => value,
  });

  /**
   * Check one head write and save it if it verifies.
   *
   * @param commit - The commit frame.
   * @param head - One of its heads.
   */
  async function capture(
    commit: HeadCommit,
    head: HeadCommit["heads"][number],
  ): Promise<void> {
    const keys = idResolver.did;
    let cp = await toCheckpoint(
      commit,
      head,
      await keys.resolveAtprotoKey(commit.repo),
    );
    let check = await checkCheckpoint(cp);
    if (!check.valid) {
      // The cached key may be stale if the publisher rotated it.
      cp = {
        ...cp,
        signingKey: await keys.resolveAtprotoKey(commit.repo, true),
      };
      check = await checkCheckpoint(cp);
    }
    if (!check.valid) throw new Error(check.problem);
    const result = store.add(cp);
    log(
      "witness",
      `witness: ${result} did=${cp.did} stream=${cp.stream} seq=${cp.seq} rev=${cp.rev}`,
      console.log,
    );
  }

  const reading = (async () => {
    try {
      for await (const msg of sub) {
        let commit: HeadCommit | null;
        try {
          commit = readHeadCommit(msg, allow);
        } catch (error) {
          log(
            "witness",
            `witness: skipped frame: ${inspect(error)}`,
            console.error,
          );
          continue;
        }
        if (commit === null) continue;
        for (const head of commit.heads) {
          try {
            await capture(commit, head);
          } catch (error) {
            log(
              "witness",
              `witness: not stored did=${commit.repo} rev=${commit.rev} stream=${head.stream}: ${inspect(error)}`,
              console.error,
            );
          }
        }
      }
    } catch (error) {
      if (!abort.signal.aborted)
        log(
          "witness",
          `witness: subscription: ${inspect(error)}`,
          console.error,
        );
    }
  })();

  return {
    async stop() {
      abort.abort();
      await reading;
    },
  };
}

import { inspect } from "node:util";
import { IdResolver, MemoryCache } from "@atproto/identity";
import { type CommitEvt, type Event, Firehose } from "@atproto/sync";
import {
  ContractError,
  log,
  EVENT_NSID,
  HEAD_NSID,
  type LocalEnv,
  parseEventRecord,
  parseEventRkey,
  parseHeadRecord,
  parseHeadRkey,
} from "@trustlab/contracts";
import { auditAll, type WitnessClient } from "./audit.js";
import type { CommitEvent, ConsumerStore, VerifiedCommit } from "./store.js";

/** Keep contract failures as audit evidence without trusting the rejected payload. */
function validatedRecord<T>(parse: () => T): T | null {
  try {
    return parse();
  } catch (error) {
    if (error instanceof ContractError) return null;
    throw error;
  }
}

/** What `startFirehose` needs. */
export interface FirehoseOptions {
  /** The variables from `.env.local`: where the PDS and PLC are. */
  env: LocalEnv;
  /** Where verified commits are saved, and where the cursor resumes from. */
  store: ConsumerStore;
  /** Which repo DIDs to keep. Everything else is dropped and counted. */
  allow: (did: string) => boolean;
  /** Optional source of witness checkpoints. */
  witness?: WitnessClient;
  /** Called after each commit is saved. */
  onCommit?: (commit: VerifiedCommit) => void;
}

/** A running subscription. */
export interface RunningFirehose {
  /** Close the connection and wait for the commit in progress to be saved. */
  stop(): Promise<void>;
}

/**
 * Subscribe to the PDS's `subscribeRepos` feed and save each verified commit.
 *
 * `@atproto/sync` checks every commit's signature and record proofs against
 * the key in the publisher's DID document (resolved on the local PLC) before
 * our code sees it; a commit that fails is reported and never saved. Only our
 * collections and allowed DIDs are kept. The feed resumes from the store's
 * cursor, so a restart picks up where the last run stopped.
 *
 * The original event view retains creates. Audits apply verified head writes,
 * event updates and deletions to reconstruct each stream’s current chain.
 *
 * @param opts - Environment, store, allowlist, and an optional callback.
 * @returns A handle to stop the subscription.
 */
export function startFirehose(opts: FirehoseOptions): RunningFirehose {
  const { env, store, allow, onCommit } = opts;
  let dropped = 0;
  let writes: CommitEvt[] = [];
  let queue = auditAll(store, opts.witness).catch((error: unknown) => {
    log("consumer", `startup audit failed: ${inspect(error)}`, console.error);
  });

  const firehose = new Firehose({
    service: env.PDS_URL.replace(/^http/, "ws"),
    // The library's default fetch refuses http, localhost, and custom ports
    // (SSRF protection), which is exactly where the local PLC lives.
    // ponytail: plain fetch is fine on the local network; a consumer that
    // resolves DIDs on the public network (REC-4) should keep the safe default.
    // The cache saves a PLC request per commit. A stale key still works: the
    // library refetches it when verification fails.
    idResolver: new IdResolver({
      plcUrl: env.PLC_URL,
      fetch: globalThis.fetch,
      didCache: new MemoryCache(),
    }),
    filterCollections: [EVENT_NSID, HEAD_NSID],
    // `.test` handles don't resolve through DNS; we only need commits.
    excludeIdentity: true,
    excludeAccount: true,
    // A runner gets one call per commit with all of its writes, so a commit
    // is saved whole. The library doesn't wait for it, so we queue them to
    // keep commits in feed order.
    runner: {
      getCursor: () => store.getCheckpoint().cursor ?? undefined,
      trackEvent: (did, seq, handler) => {
        queue = queue
          .then(async () => {
            writes = [];
            await handler();
            await saveCommit(did, seq, writes);
          })
          .catch((error: unknown) => {
            log(
              "consumer",
              `firehose: commit seq=${seq} not saved: ${inspect(error)}`,
              console.error,
            );
          });
        return queue;
      },
    },
    handleEvent: (evt: Event) => {
      if (evt.event === "sync") {
        // A #sync means our copy of this repo may be stale. REC-7 rebuilds.
        log(
          "consumer",
          `firehose: #sync for ${evt.did} at rev ${evt.rev}`,
          console.warn,
        );
        return;
      }
      if (
        evt.event === "create" ||
        evt.event === "update" ||
        evt.event === "delete"
      ) {
        writes.push(evt);
      }
    },
    onError: (error) => {
      // The library wraps the real reason (bad signature, unknown DID, ...)
      // in `cause`, so print the whole chain.
      log("consumer", `firehose: ${inspect(error)}`, console.error);
    },
  });

  /**
   * Turn one commit's verified writes into a `VerifiedCommit` and save it.
   *
   * @param did - The repo the commit belongs to.
   * @param seq - The commit's firehose sequence number.
   * @param commitWrites - The commit's writes to our collections.
   */
  async function saveCommit(
    did: string,
    seq: number,
    commitWrites: CommitEvt[],
  ): Promise<void> {
    const [first] = commitWrites;
    if (first === undefined) return;
    if (!allow(did)) {
      dropped += 1;
      log(
        "consumer",
        `dropped  did=${did} seq=${seq} (not allowlisted, ${dropped} dropped)`,
        console.log,
      );
      return;
    }

    const events: CommitEvent[] = [];
    const changes: NonNullable<VerifiedCommit["changes"]>[number][] = [];
    const heads: NonNullable<VerifiedCommit["heads"]>[number][] = [];
    for (const write of commitWrites) {
      const cid = write.event === "delete" ? "-" : write.cid.toString();
      log(
        "consumer",
        `verified ${write.event} did=${did} rkey=${write.rkey} cid=${cid} rev=${write.rev}`,
        console.log,
      );
      if (write.collection === HEAD_NSID) {
        const stream = parseHeadRkey(write.rkey);
        if (stream === null) continue;
        const record =
          write.event === "delete"
            ? null
            : (validatedRecord(() =>
                parseHeadRecord(write.record, write.rkey),
              ) ?? "invalid");
        heads.push({ stream, record });
      } else if (write.collection === EVENT_NSID) {
        const key = parseEventRkey(write.rkey);
        if (!key) continue;
        const record =
          write.event === "delete"
            ? null
            : validatedRecord(() => parseEventRecord(write.record, write.rkey));
        const event = { ...key, rkey: write.rkey, cid, record };
        if (write.event === "create" && record !== null) events.push(event);
        else
          changes.push({
            ...event,
            cid: write.event === "delete" ? null : cid,
          });
      }
    }

    const commit: VerifiedCommit = {
      cursor: seq,
      did,
      rev: first.rev,
      events,
      changes,
      heads,
    };
    if (store.applyCommit(commit)) {
      await auditAll(store, opts.witness, did).catch((error: unknown) => {
        log(
          "consumer",
          `audit failed for saved commit seq=${seq}: ${inspect(error)}`,
          console.error,
        );
      });
      onCommit?.(commit);
    }
  }

  // Runs until stop(); it reconnects on its own and reports errors to onError.
  void firehose.start();

  return {
    async stop() {
      await firehose.destroy();
      await queue;
    },
  };
}

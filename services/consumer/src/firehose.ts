import { IdResolver } from "@atproto/identity";
import { type CommitEvt, type Event, Firehose } from "@atproto/sync";
import {
  EVENT_NSID,
  HEAD_NSID,
  type LocalEnv,
  parseEventRecord,
} from "@trustlab/contracts";
import type { CommitEvent, ConsumerStore, VerifiedCommit } from "./store.js";

/** What `startFirehose` needs. */
export interface FirehoseOptions {
  /** The variables from `.env.local`: where the PDS and PLC are. */
  env: LocalEnv;
  /** Where verified commits are saved, and where the cursor resumes from. */
  store: ConsumerStore;
  /** Which repo DIDs to keep. Everything else is dropped and counted. */
  allow: (did: string) => boolean;
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
 * Only event creates go into the view. Updates and deletes are logged, and
 * #67 decides what to do with them.
 *
 * @param opts - Environment, store, allowlist, and an optional callback.
 * @returns A handle to stop the subscription.
 */
export function startFirehose(opts: FirehoseOptions): RunningFirehose {
  const { env, store, allow, onCommit } = opts;
  let dropped = 0;
  let writes: CommitEvt[] = [];
  let queue = Promise.resolve();

  const firehose = new Firehose({
    service: env.PDS_URL.replace(/^http/, "ws"),
    // The library's default fetch refuses http, localhost, and custom ports
    // (SSRF protection), which is exactly where the local PLC lives.
    // ponytail: plain fetch is fine on the local network; a consumer that
    // resolves DIDs on the public network (REC-4) should keep the safe default.
    idResolver: new IdResolver({
      plcUrl: env.PLC_URL,
      fetch: globalThis.fetch,
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
            saveCommit(did, seq, writes);
          })
          .catch((error: unknown) => {
            console.error(`firehose: commit seq=${seq} not saved:`, error);
          });
        return queue;
      },
    },
    handleEvent: (evt: Event) => {
      if (evt.event === "sync") {
        // A #sync means our copy of this repo may be stale. REC-7 rebuilds.
        console.warn(`firehose: #sync for ${evt.did} at rev ${evt.rev}`);
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
      console.error("firehose:", error);
    },
  });

  /**
   * Turn one commit's verified writes into a `VerifiedCommit` and save it.
   *
   * @param did - The repo the commit belongs to.
   * @param seq - The commit's firehose sequence number.
   * @param commitWrites - The commit's writes to our collections.
   */
  function saveCommit(
    did: string,
    seq: number,
    commitWrites: CommitEvt[],
  ): void {
    const [first] = commitWrites;
    if (first === undefined) return;
    if (!allow(did)) {
      dropped += 1;
      console.log(
        `dropped  did=${did} seq=${seq} (not allowlisted, ${dropped} dropped)`,
      );
      return;
    }

    const events: CommitEvent[] = [];
    for (const write of commitWrites) {
      const cid = write.event === "delete" ? "-" : write.cid.toString();
      console.log(
        `verified ${write.event} did=${did} rkey=${write.rkey} cid=${cid} rev=${write.rev}`,
      );
      if (write.event === "create" && write.collection === EVENT_NSID) {
        // Verified means the publisher signed it, not that it follows our
        // contract, so check the record before it goes in the view.
        const record = parseEventRecord(write.record, write.rkey);
        events.push({
          stream: record.stream,
          seq: record.seq,
          rkey: write.rkey,
          cid,
          record,
        });
      }
    }

    const commit: VerifiedCommit = {
      cursor: seq,
      did,
      rev: first.rev,
      events,
    };
    if (store.applyCommit(commit)) onCommit?.(commit);
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

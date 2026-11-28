import { inspect } from "node:util";
import { type LocalEnv, log } from "@trustlab/contracts";
import { fetchSnapshot, planRebuild } from "@trustlab/recovery";
import {
  type FirehoseOptions,
  type RunningFirehose,
  startFirehose,
} from "./firehose.js";
import type { ConsumerStore } from "./store.js";

/**
 * Replace the publisher's view with a verified snapshot of its repo.
 *
 * @param env - Where the PDS and PLC are, and the publisher's DID.
 * @param store - The view to replace.
 * @returns Resolves once the view matches the snapshot.
 * @throws SnapshotError if the repo can't be fetched or doesn't verify.
 */
export async function rebuildFromSnapshot(
  env: LocalEnv,
  store: ConsumerStore,
): Promise<void> {
  const snapshot = await fetchSnapshot({
    pdsUrl: env.PDS_URL,
    plcUrl: env.PLC_URL,
    did: env.PUBLISHER_DID,
  });
  const plan = planRebuild(snapshot);
  const applied = store.replaceRepo(snapshot.did, snapshot.rev, plan.events);
  log(
    "consumer",
    `rebuilt did=${snapshot.did} rev=${snapshot.rev} events=${applied} gaps=${plan.gaps.length}`,
    console.log,
  );
}

/**
 * Start the consumer so it catches up on its own after downtime.
 *
 * - No checkpoint (first run, or `--fresh`): rebuild the view from a
 *   snapshot, then follow the firehose from now.
 * - A checkpoint: resume the firehose from its cursor, which replays what
 *   was missed.
 * - The PDS rejects the cursor as being in the future (after `stack:reset`):
 *   forget it, rebuild from a snapshot, and the library reconnects from now.
 *
 * Events published between the snapshot and the firehose start can be
 * missed; #71 buffers the live feed during the rebuild to close that window.
 *
 * ponytail: a cursor older than the PDS keeps is not caught. The PDS answers
 * with an `OutdatedCursor` #info frame, which `@atproto/sync` drops without
 * telling us, then streams from its oldest event. Detecting it needs the raw
 * frames, as the witness reads them.
 *
 * Only the publisher in `.env.local` is rebuilt, which is also all
 * `allowlistFromEnv` allows.
 *
 * @param opts - Environment, store, allowlist, and an optional callback.
 * @returns A handle to stop the subscription.
 * @throws SnapshotError if a needed startup rebuild fails.
 */
export async function startConsumer(
  opts: Omit<FirehoseOptions, "onCursorRejected">,
): Promise<RunningFirehose> {
  const { env, store } = opts;
  if (store.getCheckpoint().cursor === null) {
    await rebuildFromSnapshot(env, store);
  }
  return startFirehose({
    ...opts,
    onCursorRejected: () => {
      store.resetCursor();
      rebuildFromSnapshot(env, store).catch((error: unknown) => {
        log("consumer", `rebuild failed: ${inspect(error)}`, console.error);
      });
    },
  });
}

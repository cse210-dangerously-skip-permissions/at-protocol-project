export const packageName = "@trustlab/consumer";

export {
  allowlistFromEnv,
  makeAllowlist,
  type Allowlist,
} from "./allowlist.js";
export {
  type FirehoseOptions,
  type RunningFirehose,
  startFirehose,
} from "./firehose.js";
export {
  ConsumerStore,
  EventConflictError,
  type CommitEvent,
  type VerifiedCommit,
} from "./store.js";

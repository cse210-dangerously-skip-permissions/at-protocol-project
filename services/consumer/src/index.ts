export const packageName = "@trustlab/consumer";

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

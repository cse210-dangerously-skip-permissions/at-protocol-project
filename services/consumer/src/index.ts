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
  readLatestVerdicts,
  DEFAULT_DB,
  EventConflictError,
  type CommitEvent,
  type VerifiedCommit,
} from "./store.js";

export { auditStream, witnessClient, type WitnessClient } from "./audit.js";

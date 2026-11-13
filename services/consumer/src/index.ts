export const packageName = "@trustlab/consumer";

export {
  allowlistFromEnv,
  makeAllowlist,
  type Allowlist,
} from "./allowlist.js";

export {
  ConsumerStore,
  EventConflictError,
  type CommitEvent,
  type VerifiedCommit,
} from "./store.js";

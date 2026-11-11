export const packageName = "@trustlab/consumer";

export {
  ConsumerStore,
  EventConflictError,
  type CommitEvent,
  type ConsumerCheckpoint,
  type StoredEvent,
  type VerifiedCommit,
} from "./store.js";

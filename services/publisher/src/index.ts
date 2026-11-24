export const packageName = "@trustlab/publisher";

export {
  login,
  publishEvent,
  PublishConflictError,
  readHead,
  recordCid,
  type PublisherSession,
  type PublishInput,
  type Published,
} from "./publisher.js";
export {
  main as runPublisherCli,
  runPublish,
  type PublishArgs,
  type PublishOptions,
} from "./cli.js";
export { makeWorkload, workloadCreatedAt } from "./workload.js";
export {
  amendEvent,
  readEvent,
  runAmend,
  type AmendArgs,
  type AmendInput,
  type AmendKind,
  type AmendOptions,
} from "./amend.js";
export {
  MAX_TAMPER_WRITES,
  runTamper,
  TamperConflictError,
  tamperEdit,
  tamperRewrite,
  tamperTruncate,
  withChangedPayload,
  type TamperArgs,
  type Tampered,
  type TamperOptions,
} from "./tamper.js";

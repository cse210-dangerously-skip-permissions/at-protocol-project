export const packageName = "@trustlab/publisher";

export {
  login,
  publishEvent,
  PublishConflictError,
  readHead,
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
  runTamper,
  TamperConflictError,
  tamperEdit,
  tamperRewrite,
  tamperTruncate,
  type TamperArgs,
  type Tampered,
  type TamperOptions,
} from "./tamper.js";

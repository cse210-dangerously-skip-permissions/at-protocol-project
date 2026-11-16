export const packageName = "@trustlab/publisher";

export {
  login,
  publishEvent,
  readHead,
  type PublisherSession,
  type PublishInput,
  type Published,
} from "./publisher.js";
export { runPublish, type PublishArgs, type PublishOptions } from "./cli.js";
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
  tamperEdit,
  tamperRewrite,
  tamperTruncate,
  type TamperArgs,
  type TamperOptions,
} from "./tamper.js";

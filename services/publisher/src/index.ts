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

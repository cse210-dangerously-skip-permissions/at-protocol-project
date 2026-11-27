export const packageName = "@trustlab/auditor";

export { validateChain } from "./chain.js";
export {
  type CheckpointCheck,
  checkCheckpoint,
  verifyCheckpoint,
} from "./checkpoint.js";
export { type CheckpointVerifier, compareWithWitness } from "./witness.js";

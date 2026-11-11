import { expect, test } from "vitest";
import * as contracts from "./index.js";

test("exports the contract from one entry point", () => {
  expect(contracts.packageName).toBe("@trustlab/contracts");
  expect(contracts.EVENT_NSID).toBe("dev.trustlab.event");
  expect(contracts.HEAD_NSID).toBe("dev.trustlab.head");
  expect(contracts.parseEventRecord).toBeTypeOf("function");
  expect(contracts.loadLocalEnv).toBeTypeOf("function");
});

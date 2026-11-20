import { parseArgs } from "node:util";
import { isConfig, runScenario } from "./runner.js";

try {
  const { values } = parseArgs({
    options: {
      scenario: { type: "string" },
      runs: { type: "string", default: "1" },
      config: { type: "string", default: "A0" },
    },
  });
  if (!values.scenario) throw new Error("--scenario is required");
  if (!isConfig(values.config))
    throw new Error("--config must be A0, A1, S0 or S1");
  const rows = await runScenario(values.scenario, {
    runs: Number(values.runs),
    config: values.config,
  });
  console.log(
    `Recorded ${rows.length} run(s) for ${values.scenario} in results/.`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

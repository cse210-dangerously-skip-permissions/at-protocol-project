import { defineConfig } from "vitest/config";

const sourceRoots = "{packages,services,tools}/*/src";

export default defineConfig({
  test: {
    include: [`${sourceRoots}/**/*.test.ts`, "infra/scripts/**/*.test.mjs"],
    coverage: {
      provider: "v8",
      // Package code only. The infra scripts are tooling, and their network
      // steps are tested against the running stack by `npm run stack:check`.
      include: [`${sourceRoots}/**/*.ts`],
      reporter: ["text", "json-summary"],
    },
  },
});

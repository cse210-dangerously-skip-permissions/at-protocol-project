import { defineConfig } from "vitest/config";

const sourceRoots = "{packages,services,tools}/*/src";

export default defineConfig({
  test: {
    include: [`${sourceRoots}/**/*.test.ts`],
    coverage: {
      provider: "v8",
      include: [`${sourceRoots}/**/*.ts`],
      reporter: ["text", "json-summary"],
    },
  },
});

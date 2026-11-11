import { defineConfig } from "vitest/config";

const sourceRoots = "{packages,services,tools}/*/src";

// `node:sqlite` needs this flag on Node 22.5 to 22.12. Later versions
// accept it and ignore it.
const sqliteFlag = "--experimental-sqlite";

export default defineConfig({
  test: {
    execArgv: [sqliteFlag],
    include: [`${sourceRoots}/**/*.test.ts`],
    coverage: {
      provider: "v8",
      include: [`${sourceRoots}/**/*.ts`],
      reporter: ["text", "json-summary"],
    },
  },
});

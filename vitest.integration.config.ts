import { defineConfig } from "vitest/config";

// Integration tests run against the local AT network (`npm run stack:up`),
// so they stay out of `npm test`. Run them with `npm run test:integration`.
export default defineConfig({
  test: {
    // `node:sqlite` needs this flag on Node 22.5 to 22.12, as in vitest.config.ts.
    execArgv: ["--experimental-sqlite"],
    include: ["tests/integration/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});

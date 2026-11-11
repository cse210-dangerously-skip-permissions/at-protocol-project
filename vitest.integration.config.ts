import { defineConfig } from "vitest/config";

// Integration tests run against the local AT network (`npm run stack:up`),
// so they stay out of `npm test`. Run them with `npm run test:integration`.
export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});

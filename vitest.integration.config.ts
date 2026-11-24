import { defineConfig } from "vitest/config";

// Integration tests run against the local AT network (`npm run stack:up`),
// so they stay out of `npm test`. Run them with `npm run test:integration`.
export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    // Every file writes to the one seeded publisher repo. A tamper refuses
    // to run if another commit lands while it reads (#142), so the files
    // run one at a time.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});

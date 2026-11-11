import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig([
  globalIgnores(["**/dist/", "coverage/", "test-results/"]),
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    rules: {
      eqeqeq: "error",
      "no-console": "error",
    },
  },
  {
    // CONTRIBUTING.md: the server, tests, and tooling may log.
    files: [
      "services/**",
      "tools/**",
      "scripts/**",
      "infra/**",
      "e2e/**",
      "**/*.test.ts",
    ],
    rules: {
      "no-console": "off",
    },
  },
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: { console: "readonly", process: "readonly" },
    },
  },
  {
    // Plain Node scripts for the local AT network.
    files: ["infra/**/*.mjs"],
    languageOptions: {
      globals: {
        AbortSignal: "readonly",
        Buffer: "readonly",
        console: "readonly",
        fetch: "readonly",
        process: "readonly",
        setTimeout: "readonly",
        URL: "readonly",
        WebSocket: "readonly",
      },
    },
  },
]);

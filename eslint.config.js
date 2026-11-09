import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig([
  globalIgnores(["**/dist/", "coverage/"]),
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
    files: ["services/**", "tools/**", "scripts/**", "**/*.test.ts"],
    rules: {
      "no-console": "off",
    },
  },
]);

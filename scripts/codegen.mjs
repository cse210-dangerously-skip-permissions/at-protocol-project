// Generate TypeScript types and runtime validators from lexicons/ with
// @atproto/lex-cli, into packages/contracts/src/generated/.
//
//   npm run codegen         write the generated files
//   npm run codegen:check   exit 1 if the committed files differ from a fresh run
//
// The tool always writes into a temporary directory first, so both modes see
// exactly the same output. Its server stub (index.ts) is dropped: we only use
// the record types and validators, not an XRPC server.
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const lexiconDir = join(root, "lexicons");
const outDir = join(root, "packages/contracts/src/generated");
const keep = ["lexicons.ts", "util.ts", "types"];
const check = process.argv.includes("--check");

/**
 * List every file under a directory, relative to it, sorted.
 *
 * @param {string} dir
 * @returns {string[]}
 */
function listFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)))
    .sort();
}

const lexicons = listFiles(lexiconDir)
  .filter((file) => file.endsWith(".json") && file !== "package.json")
  .map((file) => join(lexiconDir, file));

const require = createRequire(import.meta.url);
const lexBin = join(
  dirname(require.resolve("@atproto/lex-cli")),
  "..",
  "bin.js",
);

const tmp = mkdtempSync(join(tmpdir(), "trustlab-codegen-"));
try {
  const run = spawnSync(
    process.execPath,
    [lexBin, "gen-server", "--yes", tmp, ...lexicons],
    { encoding: "utf8" },
  );
  if (run.status !== 0) {
    console.error(run.stdout, run.stderr);
    console.error("lex gen-server failed");
    process.exit(1);
  }
  const fresh = join(tmp, "fresh");
  for (const name of keep) {
    cpSync(join(tmp, name), join(fresh, name), { recursive: true });
  }

  if (check) {
    const want = listFiles(fresh);
    const have = listFiles(outDir);
    const stale = [...new Set([...want, ...have])].filter(
      (file) =>
        !want.includes(file) ||
        !have.includes(file) ||
        readFileSync(join(fresh, file), "utf8") !==
          readFileSync(join(outDir, file), "utf8"),
    );
    if (stale.length > 0) {
      console.error(
        `${relative(root, outDir)} is out of date with lexicons/:\n` +
          stale.map((file) => `  ${file}`).join("\n") +
          "\nRun `npm run codegen` and commit the result.",
      );
      process.exit(1);
    }
    console.log(`${relative(root, outDir)} matches lexicons/.`);
  } else {
    rmSync(outDir, { recursive: true, force: true });
    cpSync(fresh, outDir, { recursive: true });
    console.log(
      `Generated ${relative(root, outDir)} from ${lexicons.length} Lexicons.`,
    );
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

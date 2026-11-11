/**
 * Start, stop, reset, and check the local AT network in infra/compose.yaml.
 *
 * Usage: node infra/scripts/stack.mjs <up|check|seed|down|reset|logs>
 * The root package.json runs each command as `npm run stack:<command>`.
 */
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runChecks } from "./checks.mjs";
import { createEnvFile, readEnvValue } from "./env.mjs";
import { seed as seedAccounts } from "./seed.mjs";

const infraDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const composeFile = join(infraDir, "compose.yaml");
const envFile = join(infraDir, ".env");
const localEnvFile = join(infraDir, "..", ".env.local");

// The commands.

/**
 * `npm run stack:up`: create the secrets file if it is missing, start every
 * container, wait until all are healthy, run the checks, then seed the
 * test accounts.
 *
 * @returns {Promise<number>} The exit code.
 */
async function up() {
  if (createEnvFile(envFile)) {
    console.log(`Created ${envFile} with new secrets.`);
  }
  console.log(
    "Starting the local AT network. The first run builds the PLC image, which takes a few minutes.",
  );
  const code = compose(["up", "--detach", "--wait", "--wait-timeout", "900"]);
  if (code !== 0) {
    console.error(
      "The stack did not become healthy. See `npm run stack:logs`.",
    );
    return code;
  }
  const checked = await check();
  return checked === 0 ? seed() : checked;
}

/**
 * `npm run stack:check`: run the end-to-end checks in checks.mjs against the
 * running network.
 *
 * @returns {Promise<number>} The exit code.
 */
function check() {
  return runChecks({
    adminPassword: readEnvValue(envFile, "PDS_ADMIN_PASSWORD"),
  });
}

/**
 * `npm run stack:seed`: make sure the seed accounts exist and write
 * .env.local at the repo root.
 *
 * @returns {Promise<number>} The exit code.
 */
function seed() {
  return seedAccounts({ envPath: localEnvFile });
}

/**
 * `npm run stack:down`: stop and remove the containers, keeping the data.
 *
 * @returns {number} The exit code.
 */
function down() {
  return compose(["down"]);
}

/**
 * `npm run stack:reset`: stop and remove the containers and delete the data
 * volumes, for a clean start.
 *
 * @returns {number} The exit code.
 */
function reset() {
  return compose(["down", "--volumes"]);
}

/**
 * `npm run stack:logs`: follow the containers' logs.
 *
 * @returns {number} The exit code.
 */
function logs() {
  return compose(["logs", "--follow", "--tail", "100"]);
}

// Running docker compose and the command line.

/**
 * Run `docker compose` against infra/compose.yaml, passing its output through.
 *
 * @param {string[]} args - Arguments after `docker compose -f <file>`.
 * @returns {number} The exit code.
 */
function compose(args) {
  const result = spawnSync("docker", ["compose", "-f", composeFile, ...args], {
    stdio: "inherit",
  });
  if (result.error) {
    console.error(
      result.error.code === "ENOENT"
        ? "Docker is not installed or not on your PATH. Install Docker Desktop (macOS, Windows) or Docker Engine with the Compose plugin (Linux)."
        : `Could not run docker: ${result.error.message}`,
    );
    return 1;
  }
  return result.status ?? 1;
}

/**
 * Whether a Node.js version can run these scripts. The checks use Node's
 * built-in WebSocket, and the repo needs 22.5 or newer anyway.
 *
 * @param {string} version - A version such as "22.5.0", as in process.versions.node.
 * @returns {boolean} True for 22.5 or newer.
 */
export function isSupportedNode(version) {
  const [major, minor] = version.split(".").map(Number);
  return major > 22 || (major === 22 && minor >= 5);
}

/**
 * Run one command from the command line.
 *
 * @param {string | undefined} name - The command name, such as "up".
 * @returns {Promise<number>} The exit code.
 */
async function main(name) {
  const commands = { up, check, seed, down, reset, logs };
  if (!isSupportedNode(process.versions.node)) {
    console.error(
      `The stack scripts need Node.js 22.5 or newer, like the rest of the repo. This is Node ${process.version}.`,
    );
    return 1;
  }
  const command = Object.hasOwn(commands, name) ? commands[name] : undefined;
  if (!command) {
    console.error(
      `Usage: node infra/scripts/stack.mjs <${Object.keys(commands).join("|")}>`,
    );
    return 2;
  }
  return command();
}

/**
 * Whether this file was started directly with node, rather than imported by a test.
 *
 * @returns {boolean} True when run as a script.
 */
function isRunDirectly() {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isRunDirectly()) {
  process.exitCode = await main(process.argv[2]);
}

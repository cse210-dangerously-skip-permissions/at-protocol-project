/**
 * Seed accounts for the local AT network, run by `npm run stack:seed` and at
 * the end of `npm run stack:up`.
 *
 * seed() makes sure publisher.test and witness.test exist on the local PDS,
 * then writes their DIDs, handles, and passwords to .env.local at the repo
 * root. Services read that file and never hardcode a DID. Running it again
 * changes nothing; after `npm run stack:reset` it creates the accounts anew
 * and replaces the file.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { PDS_URL, PLC_URL, postJson } from "./checks.mjs";

/** The seed accounts. Each role is the prefix of its variables in .env.local. */
export const SEED_ACCOUNTS = [
  { role: "PUBLISHER", handle: "publisher.test" },
  { role: "WITNESS", handle: "witness.test" },
];

/**
 * Make sure every seed account exists, then write .env.local.
 *
 * @param {object} options
 * @param {string} options.envPath - Where .env.local goes.
 * @param {PdsApi} [options.api] - How to reach the PDS; tests pass a fake.
 * @returns {Promise<number>} The exit code: 0 on success, otherwise 1.
 */
export async function seed({ envPath, api = pdsApi }) {
  console.log("Seeding the local AT network:");
  const stored = existsSync(envPath)
    ? parseEnv(readFileSync(envPath, "utf8"))
    : {};
  const values = { PDS_URL, PLC_URL };
  try {
    for (const { role, handle } of SEED_ACCOUNTS) {
      const account = await ensureAccount(
        { handle, password: stored[`${role}_PASSWORD`] },
        api,
      );
      values[`${role}_DID`] = account.did;
      values[`${role}_HANDLE`] = handle;
      values[`${role}_PASSWORD`] = account.password;
      console.log(
        `  ok    ${handle} ${account.created ? "created" : "already exists"} (${account.did})`,
      );
    }
  } catch (error) {
    console.log(`  FAIL  ${error.message}`);
    if (error.message.startsWith("could not connect")) {
      console.log("Is the stack running? Start it with `npm run stack:up`.");
    }
    return 1;
  }
  writeFileSync(envPath, formatEnv(values), { mode: 0o600 });
  console.log(`Wrote ${envPath}.`);
  return 0;
}

/**
 * Log in to a seed account if it exists, otherwise create it.
 *
 * @param {{ handle: string, password: string | undefined }} wanted - The
 *   handle, and the password .env.local holds for it, if any.
 * @param {PdsApi} api - How to reach the PDS.
 * @returns {Promise<{ did: string, password: string, created: boolean }>} The account.
 */
export async function ensureAccount({ handle, password }, api) {
  if (password) {
    try {
      const session = await api.createSession(handle, password);
      return { did: session.did, password, created: false };
    } catch (error) {
      // A refused login means the account is gone (after a reset) or the
      // password is stale. Anything else, such as no connection, is a failure.
      if (!isHttpError(error)) throw error;
    }
  }
  const newPassword = randomBytes(16).toString("hex");
  try {
    const account = await api.createAccount({
      handle,
      email: `${handle.split(".")[0]}@example.com`,
      password: newPassword,
    });
    return { did: account.did, password: newPassword, created: true };
  } catch (error) {
    if (isHttpError(error) && /taken|not available/i.test(error.message)) {
      throw new Error(
        `${handle} exists on the PDS, but .env.local has no working password for it. Run \`npm run stack:reset\`, then \`npm run stack:up\`.`,
        { cause: error },
      );
    }
    throw error;
  }
}

/**
 * Whether an error is the PDS answering with a non-2xx status, as opposed to
 * the PDS not answering at all.
 *
 * @param {Error} error - An error from postJson.
 * @returns {boolean} True for an HTTP error answer.
 */
function isHttpError(error) {
  return error.message.startsWith("HTTP ");
}

/**
 * How seed() reaches the PDS.
 *
 * @typedef {object} PdsApi
 * @property {(identifier: string, password: string) => Promise<{ did: string }>} createSession
 * @property {(account: { handle: string, email: string, password: string }) => Promise<{ did: string }>} createAccount
 */

/** @type {PdsApi} */
const pdsApi = {
  createSession: (identifier, password) =>
    postJson(`${PDS_URL}/xrpc/com.atproto.server.createSession`, {
      identifier,
      password,
    }),
  createAccount: (account) =>
    postJson(`${PDS_URL}/xrpc/com.atproto.server.createAccount`, account),
};

// The .env.local file.

/**
 * Read `NAME=value` lines into an object, skipping comments and blank lines.
 *
 * @param {string} text - The file's contents.
 * @returns {Record<string, string>} The variables.
 */
export function parseEnv(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (match) values[match[1]] = match[2];
  }
  return values;
}

/**
 * Turn variables into the contents of .env.local.
 *
 * @param {Record<string, string>} values - The variables, in the order to write them.
 * @returns {string} The file's contents.
 */
export function formatEnv(values) {
  return [
    "# Local AT network addresses and seed accounts, made by `npm run stack:seed`.",
    "# Git ignores this file. `npm run stack:reset` makes these accounts invalid; seed again after it.",
    ...Object.entries(values).map(([name, value]) => `${name}=${value}`),
    "",
  ].join("\n");
}

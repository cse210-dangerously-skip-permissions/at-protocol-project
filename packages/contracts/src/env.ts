import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { LocalEnv } from "./types.js";

const NAMES = [
  "PDS_URL",
  "PLC_URL",
  "PUBLISHER_DID",
  "PUBLISHER_HANDLE",
  "PUBLISHER_PASSWORD",
  "WITNESS_DID",
  "WITNESS_HANDLE",
  "WITNESS_PASSWORD",
] as const satisfies readonly (keyof LocalEnv)[];

/**
 * Parse the contents of `.env.local`.
 *
 * @param text - The file's contents: `NAME=value` lines, comments, blank lines.
 * @returns Every variable the contract names.
 * @throws Error naming the missing variables, if any.
 */
export function parseLocalEnv(text: string): LocalEnv {
  const found = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (match) found.set(match[1] as string, match[2] as string);
  }
  const missing = NAMES.filter((name) => !found.get(name));
  if (missing.length > 0) {
    throw new Error(
      `.env.local is missing ${missing.join(", ")}. Run \`npm run stack:seed\` to write it again.`,
    );
  }
  return Object.fromEntries(
    NAMES.map((name) => [name, found.get(name)]),
  ) as unknown as LocalEnv;
}

/**
 * Find `.env.local` in a directory or the nearest directory above it.
 *
 * @param from - Where to start looking.
 * @returns The file's path, or `null` if there is none up to the root.
 */
export function findLocalEnv(from: string): string | null {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, ".env.local");
    if (existsSync(candidate)) return candidate;
    if (dirname(dir) === dir) return null;
  }
}

/**
 * Load the local network's addresses and seed accounts from `.env.local`,
 * which `npm run stack:up` and `npm run stack:seed` write at the repo root.
 *
 * @param path - The file to read. Defaults to the nearest `.env.local` at or
 *   above the current directory.
 * @returns The variables.
 * @throws Error if the file is missing or incomplete.
 */
export function loadLocalEnv(path?: string): LocalEnv {
  const file = path ?? findLocalEnv(process.cwd());
  if (file === null || !existsSync(file)) {
    throw new Error(
      "No .env.local found. Start the local network with `npm run stack:up`, which writes it.",
    );
  }
  return parseLocalEnv(readFileSync(file, "utf8"));
}

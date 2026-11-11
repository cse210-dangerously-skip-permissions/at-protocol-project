/**
 * The local AT network's secrets file, infra/.env. Docker Compose reads it to
 * fill in the PDS's secrets, and `npm run stack:up` creates it the first time.
 */
import { createECDH, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

/**
 * Make a random secp256k1 private key, the form the PDS wants for its PLC
 * rotation key.
 *
 * @returns {string} The key as 64 hex characters.
 */
export function k256PrivateKeyHex() {
  for (;;) {
    const key = randomBytes(32);
    try {
      createECDH("secp256k1").setPrivateKey(key);
      return key.toString("hex");
    } catch {
      // Outside the curve's valid range, which almost never happens: draw again.
    }
  }
}

/**
 * Write a secrets file with new values, unless one already exists. Existing
 * accounts depend on these values, so an existing file is never replaced.
 *
 * @param {string} path - Where the file goes, normally infra/.env.
 * @returns {boolean} True if this call created the file.
 */
export function createEnvFile(path) {
  if (existsSync(path)) return false;
  const lines = [
    "# Secrets for the local AT network, made by `npm run stack:up`. Never commit this file.",
    "# If you delete it, also run `npm run stack:reset`: existing accounts depend on these values.",
    `PDS_JWT_SECRET=${randomBytes(32).toString("hex")}`,
    `PDS_ADMIN_PASSWORD=${randomBytes(16).toString("hex")}`,
    `PDS_PLC_ROTATION_KEY_K256_PRIVATE_KEY_HEX=${k256PrivateKeyHex()}`,
    "",
  ];
  writeFileSync(path, lines.join("\n"), { mode: 0o600, flag: "wx" });
  return true;
}

/**
 * Read one variable from a secrets file.
 *
 * @param {string} path - The secrets file.
 * @param {string} name - The variable name.
 * @returns {string | undefined} Its value, or undefined if the file or variable is missing.
 */
export function readEnvValue(path, name) {
  if (!existsSync(path)) return undefined;
  const prefix = `${name}=`;
  const line = readFileSync(path, "utf8")
    .split(/\r?\n/)
    .find((l) => l.startsWith(prefix));
  return line === undefined ? undefined : line.slice(prefix.length);
}

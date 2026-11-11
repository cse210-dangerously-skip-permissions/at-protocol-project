/**
 * End-to-end checks for the running local AT network, run by `npm run stack:check`.
 *
 * runChecks() runs these steps in order and stops at the first one that fails:
 *
 *   1. checkPlcHealth      The PLC directory answers its health check.
 *   2. checkPdsHealth      The PDS answers its health check.
 *   3. checkHandleDomain   The PDS gives out .test handles.
 *   4. createProbeAccount  The PDS creates a throwaway account.
 *   5. checkDidDocument    That account's DID document on the local PLC points at the local PDS.
 *   6. checkFirehose       A record written to the account reaches the PDS firehose.
 *   7. checkGetRepo        getRepo returns the account's repo.
 *
 * Afterwards deleteProbeAccount removes the account, whether or not the steps passed.
 */
import { randomBytes } from "node:crypto";

export const PDS_URL = "http://localhost:2583";
export const PLC_URL = "http://localhost:2582";
export const FIREHOSE_URL =
  "ws://localhost:2583/xrpc/com.atproto.sync.subscribeRepos";
export const HANDLE_DOMAIN = ".test";

const REQUEST_TIMEOUT_MS = 10_000;
const FIREHOSE_TIMEOUT_MS = 5_000;

/**
 * Run every check against the running network and print a line for each.
 *
 * @param {{ adminPassword: string | undefined }} options - The PDS admin
 *   password, used to delete the probe account afterwards.
 * @returns {Promise<number>} 0 if every check passed, otherwise 1.
 */
export async function runChecks({ adminPassword }) {
  console.log("Checking the local AT network:");
  let firehose;
  let probe;
  try {
    pass(await checkPlcHealth());
    pass(await checkPdsHealth());
    pass(await checkHandleDomain());

    // Listen before writing anything, so the new record's commit can't be missed.
    firehose = await openFirehose(FIREHOSE_URL);
    probe = await createProbeAccount();
    pass(`PDS creates an account (${probe.handle}, ${probe.did})`);

    pass(await checkDidDocument(probe));
    pass(await checkFirehose(probe, firehose));
    pass(await checkGetRepo(probe));

    console.log("All checks passed.");
    return 0;
  } catch (error) {
    console.log(`  FAIL  ${error.message}`);
    if (error.message.startsWith("could not connect")) {
      console.log("Is the stack running? Start it with `npm run stack:up`.");
    }
    return 1;
  } finally {
    firehose?.socket.close();
    if (probe) await deleteProbeAccount(probe, adminPassword);
  }
}

/**
 * Print a passed check.
 *
 * @param {string} message - What passed.
 */
function pass(message) {
  console.log(`  ok    ${message}`);
}

// The steps, in the order runChecks() calls them.

/**
 * Step 1: the PLC directory answers its health check.
 *
 * @returns {Promise<string>} What passed.
 */
async function checkPlcHealth() {
  const health = await getJson(`${PLC_URL}/_health`);
  return `PLC directory answers at ${PLC_URL} (version ${health.version})`;
}

/**
 * Step 2: the PDS answers its health check.
 *
 * @returns {Promise<string>} What passed.
 */
async function checkPdsHealth() {
  const health = await getJson(`${PDS_URL}/xrpc/_health`);
  return `PDS answers at ${PDS_URL} (version ${health.version})`;
}

/**
 * Step 3: the PDS gives out .test handles, as compose.yaml configures it.
 *
 * @returns {Promise<string>} What passed.
 */
async function checkHandleDomain() {
  const server = await getJson(
    `${PDS_URL}/xrpc/com.atproto.server.describeServer`,
  );
  const domains = server.availableUserDomains ?? [];
  if (!domains.includes(HANDLE_DOMAIN)) {
    throw new Error(
      `PDS gives out ${JSON.stringify(domains)} handles, not ${HANDLE_DOMAIN}`,
    );
  }
  return `PDS gives out ${HANDLE_DOMAIN} handles (${server.did})`;
}

/**
 * Step 4: create a throwaway account with a random handle.
 *
 * @returns {Promise<{ handle: string, did: string, accessJwt: string }>} The new account.
 */
async function createProbeAccount() {
  const suffix = randomBytes(4).toString("hex");
  const handle = `probe-${suffix}${HANDLE_DOMAIN}`;
  const account = await postJson(
    `${PDS_URL}/xrpc/com.atproto.server.createAccount`,
    {
      handle,
      email: `probe-${suffix}@example.com`,
      password: randomBytes(16).toString("hex"),
    },
  );
  return { handle, did: account.did, accessJwt: account.accessJwt };
}

/**
 * Step 5: the probe account's DID document is on the local PLC and points at
 * the local PDS, so the PDS registered it locally and not on plc.directory.
 *
 * @param {{ did: string }} probe - The probe account.
 * @returns {Promise<string>} What passed.
 */
async function checkDidDocument(probe) {
  const doc = await getJson(`${PLC_URL}/${probe.did}`);
  const endpoint = pdsEndpoint(doc);
  if (endpoint !== PDS_URL) {
    throw new Error(`DID document points at ${endpoint}, not ${PDS_URL}`);
  }
  return "its DID document on the local PLC points at the local PDS";
}

/**
 * Step 6: a record written to the probe account shows up on the firehose.
 *
 * @param {{ did: string, accessJwt: string }} probe - The probe account.
 * @param {{ frames: Buffer[] }} firehose - The firehose, opened before the write.
 * @returns {Promise<string>} What passed.
 */
async function checkFirehose(probe, firehose) {
  const record = await postJson(
    `${PDS_URL}/xrpc/com.atproto.repo.createRecord`,
    {
      repo: probe.did,
      collection: "app.bsky.feed.post",
      record: {
        $type: "app.bsky.feed.post",
        text: "stack check",
        createdAt: new Date().toISOString(),
      },
    },
    { authorization: `Bearer ${probe.accessJwt}` },
  );
  const path = recordPath(record.uri);
  await waitForFrame(firehose.frames, path, FIREHOSE_TIMEOUT_MS);
  return `a new record reaches the firehose (${path})`;
}

/**
 * Step 7: getRepo returns the probe account's repo as a non-empty CAR file.
 *
 * @param {{ did: string }} probe - The probe account.
 * @returns {Promise<string>} What passed.
 */
async function checkGetRepo(probe) {
  const res = await fetchOrExplain(
    `${PDS_URL}/xrpc/com.atproto.sync.getRepo?did=${encodeURIComponent(probe.did)}`,
  );
  const bytes = (await res.arrayBuffer()).byteLength;
  if (!res.ok || bytes === 0) {
    throw new Error(`getRepo returned HTTP ${res.status} with ${bytes} bytes`);
  }
  return `getRepo returns the repo (${bytes} bytes)`;
}

/**
 * Cleanup: delete the probe account with the PDS admin password, so checks
 * leave nothing behind. A failure here is reported but doesn't fail the check.
 *
 * @param {{ did: string }} probe - The probe account.
 * @param {string | undefined} adminPassword - The PDS admin password from infra/.env.
 */
async function deleteProbeAccount(probe, adminPassword) {
  try {
    await postJson(
      `${PDS_URL}/xrpc/com.atproto.admin.deleteAccount`,
      { did: probe.did },
      {
        authorization: `Basic ${Buffer.from(`admin:${adminPassword}`).toString("base64")}`,
      },
    );
  } catch (error) {
    console.log(
      `  note  could not delete the probe account ${probe.did}: ${error.message}`,
    );
  }
}

// Helpers for reading the answers.

/**
 * Find the PDS address in a DID document.
 *
 * @param {{ service?: { id: string, serviceEndpoint: string }[] }} doc - A DID document.
 * @returns {string | undefined} The #atproto_pds service endpoint, if there is one.
 */
export function pdsEndpoint(doc) {
  return doc.service?.find((service) => service.id === "#atproto_pds")
    ?.serviceEndpoint;
}

/**
 * Turn a record's at:// URI into its path in the repo, as commits name it.
 *
 * @param {string} uri - For example at://did:plc:abc/app.bsky.feed.post/3k2a.
 * @returns {string} For example app.bsky.feed.post/3k2a.
 */
export function recordPath(uri) {
  return uri.split("/").slice(-2).join("/");
}

// HTTP and firehose helpers.

/**
 * Fetch a URL with a timeout, turning a refused or failed connection into an
 * error that names the address.
 *
 * @param {string} url - The URL to fetch.
 * @param {RequestInit} [init] - Fetch options.
 * @returns {Promise<Response>} The response, whatever its status.
 */
async function fetchOrExplain(url, init = {}) {
  try {
    return await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(`could not connect to ${new URL(url).origin}`, {
      cause: error,
    });
  }
}

/**
 * GET a URL and parse its JSON body.
 *
 * @param {string} url - The URL to fetch.
 * @returns {Promise<any>} The parsed body, or null when it is empty.
 */
export async function getJson(url) {
  return readJson(url, await fetchOrExplain(url));
}

/**
 * POST a JSON body to a URL and parse the JSON answer.
 *
 * @param {string} url - The URL to post to.
 * @param {unknown} body - The body, sent as JSON.
 * @param {Record<string, string>} [headers] - Extra headers, such as authorization.
 * @returns {Promise<any>} The parsed answer, or null when it is empty.
 */
export async function postJson(url, body, headers = {}) {
  const res = await fetchOrExplain(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return readJson(url, res);
}

/**
 * Read a response's JSON body, failing on any non-2xx status.
 *
 * @param {string} url - The URL, for the error message.
 * @param {Response} res - The response.
 * @returns {Promise<any>} The parsed body, or null when it is empty.
 */
async function readJson(url, res) {
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from ${url}: ${text.slice(0, 200)}`);
  }
  return text ? JSON.parse(text) : null;
}

/**
 * Open the PDS firehose and keep every frame it sends.
 *
 * @param {string} url - The subscribeRepos WebSocket URL.
 * @returns {Promise<{ socket: WebSocket, frames: Buffer[] }>} The open socket and the frames so far.
 */
export function openFirehose(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    const frames = [];
    socket.addEventListener("message", (event) => {
      frames.push(Buffer.from(event.data));
    });
    socket.addEventListener("open", () => resolve({ socket, frames }), {
      once: true,
    });
    socket.addEventListener(
      "error",
      () => reject(new Error(`could not connect to ${url}`)),
      { once: true },
    );
  });
}

/**
 * Wait until a firehose frame contains some text. Frames are CBOR, which
 * stores strings as plain UTF-8, so a record's path appears as-is in the
 * frame for the commit that wrote it.
 *
 * @param {Buffer[]} frames - Frames received so far; more arrive while waiting.
 * @param {string} text - The text to look for.
 * @param {number} timeoutMs - How long to wait.
 */
export async function waitForFrame(frames, text, timeoutMs) {
  const needle = Buffer.from(text);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (frames.some((frame) => frame.includes(needle))) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `no firehose frame mentioned ${text} within ${timeoutMs / 1000}s`,
  );
}

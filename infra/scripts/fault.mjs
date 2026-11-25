/**
 * Cut and restore one service's connection to the PDS while the PDS keeps
 * running and keeps its data.
 *
 * Usage: node infra/scripts/fault.mjs <proxy|block|restore> <service>
 * The root package.json runs it as `npm run fault -- <command> <service>`.
 *
 * `proxy` runs a TCP proxy in front of the PDS until Ctrl+C. Point the
 * service at the proxy's port. `block` drops the proxy's open connections
 * and refuses new ones; `restore` lets them through again.
 */
import { createServer as createHttpServer } from "node:http";
import { connect, createServer } from "node:net";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The PDS port on this machine, as published in infra/compose.yaml. */
const PDS = { host: "127.0.0.1", port: 2583 };

/** Each service's proxy port and the port `block` and `restore` call. */
export const SERVICES = {
  consumer: { port: 2584, controlPort: 2585 },
};

/**
 * Start a TCP proxy to `target` with a control server that blocks and
 * restores it. Both listen on 127.0.0.1 only.
 *
 * @param {{ port: number, controlPort: number, target: { host: string, port: number } }} options
 *   Ports to listen on (0 picks a free one) and where to forward.
 * @returns {Promise<{ port: number, controlPort: number, close: () => Promise<void> }>}
 *   The ports in use, and a function that stops both servers.
 */
export async function startProxy({ port, controlPort, target }) {
  let blocked = false;
  const sockets = new Set();
  const track = (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  };

  const proxy = createServer((client) => {
    if (blocked) {
      client.destroy();
      return;
    }
    const upstream = connect(target);
    track(client);
    track(upstream);
    client.pipe(upstream).pipe(client);
    // Either side failing or closing takes the other with it.
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
  });

  const control = createHttpServer((req, res) => {
    if (req.method !== "POST" || !["/block", "/restore"].includes(req.url)) {
      res.statusCode = 404;
      res.end();
      return;
    }
    blocked = req.url === "/block";
    if (blocked) for (const socket of sockets) socket.destroy();
    res.end(blocked ? "blocked\n" : "restored\n");
  });

  await Promise.all([listen(proxy, port), listen(control, controlPort)]);
  return {
    port: proxy.address().port,
    controlPort: control.address().port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await Promise.all([closeServer(proxy), closeServer(control)]);
    },
  };
}

/**
 * Ask a running proxy to block or restore its connections.
 *
 * @param {number} controlPort - The proxy's control port.
 * @param {"block" | "restore"} action - What to do.
 * @returns {Promise<void>} Resolves once the proxy has done it.
 * @throws If the proxy is not running or refuses the request.
 */
export async function sendControl(controlPort, action) {
  const res = await fetch(`http://127.0.0.1:${controlPort}/${action}`, {
    method: "POST",
  });
  if (!res.ok) throw new Error(`proxy answered ${res.status} to ${action}`);
}

/**
 * Listen on 127.0.0.1.
 *
 * @param {import("node:net").Server} server - The server to start.
 * @param {number} port - The port, or 0 for a free one.
 * @returns {Promise<void>} Resolves once listening.
 */
function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
}

/**
 * Stop a server.
 *
 * @param {import("node:net").Server} server - The server to stop.
 * @returns {Promise<void>} Resolves once it has closed.
 */
function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

/**
 * Run one command from the command line.
 *
 * @param {string | undefined} command - `proxy`, `block`, or `restore`.
 * @param {string | undefined} name - The service, such as `consumer`.
 * @returns {Promise<number>} The exit code.
 */
async function main(command, name) {
  const service = Object.hasOwn(SERVICES, name) ? SERVICES[name] : undefined;
  if (!service || !["proxy", "block", "restore"].includes(command)) {
    console.error(
      `Usage: node infra/scripts/fault.mjs <proxy|block|restore> <${Object.keys(SERVICES).join("|")}>`,
    );
    return 2;
  }

  if (command === "proxy") {
    const proxy = await startProxy({ ...service, target: PDS });
    console.log(
      `Proxying http://127.0.0.1:${proxy.port} to the PDS for ${name}. Stop with Ctrl+C.`,
    );
    await new Promise((resolve) => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
    });
    await proxy.close();
    return 0;
  }

  try {
    await sendControl(service.controlPort, command);
  } catch (error) {
    console.error(
      `Could not ${command} ${name}: ${error.message}. Is \`npm run fault -- proxy ${name}\` running?`,
    );
    return 1;
  }
  console.log(`${name}: ${command === "block" ? "blocked" : "restored"}`);
  return 0;
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
  process.exitCode = await main(process.argv[2], process.argv[3]);
}

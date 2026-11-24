import { connect, createServer } from "node:net";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { sendControl, startProxy } from "./fault.mjs";

/** An echo server standing in for the PDS. */
let pds;
let proxy;

beforeEach(async () => {
  pds = createServer((socket) => socket.pipe(socket));
  await new Promise((resolve) => pds.listen(0, "127.0.0.1", resolve));
  proxy = await startProxy({
    port: 0,
    controlPort: 0,
    target: { host: "127.0.0.1", port: pds.address().port },
  });
});

afterEach(async () => {
  await proxy.close();
  await new Promise((resolve) => pds.close(resolve));
});

/**
 * Connect to the proxy and wait until the socket closes or echoes "ping".
 *
 * @returns {Promise<string>} "ping" if it got through, "closed" if not.
 */
function ping() {
  return new Promise((resolve) => {
    const socket = connect(proxy.port, "127.0.0.1", () => socket.write("ping"));
    socket.on("data", (data) => {
      socket.destroy();
      resolve(data.toString());
    });
    socket.on("error", () => {});
    socket.on("close", () => resolve("closed"));
  });
}

describe("startProxy", () => {
  test("forwards until blocked, refuses while blocked, forwards after restore", async () => {
    expect(await ping()).toBe("ping");
    await sendControl(proxy.controlPort, "block");
    expect(await ping()).toBe("closed");
    await sendControl(proxy.controlPort, "restore");
    expect(await ping()).toBe("ping");
  });

  test("block drops connections that are already open", async () => {
    const socket = connect(proxy.port, "127.0.0.1");
    await new Promise((resolve) => socket.once("connect", resolve));
    const closed = new Promise((resolve) => socket.once("close", resolve));
    await sendControl(proxy.controlPort, "block");
    await closed;
    expect(socket.destroyed).toBe(true);
  });

  test("rejects unknown control requests", async () => {
    await expect(sendControl(proxy.controlPort, "nope")).rejects.toThrow("404");
  });
});

import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  getJson,
  pdsEndpoint,
  postJson,
  recordPath,
  waitForFrame,
} from "./checks.mjs";

describe("pdsEndpoint", () => {
  test("returns the #atproto_pds service endpoint of a DID document", () => {
    const doc = {
      id: "did:plc:abc123",
      service: [
        { id: "#other", type: "Other", serviceEndpoint: "https://other" },
        {
          id: "#atproto_pds",
          type: "AtprotoPersonalDataServer",
          serviceEndpoint: "http://localhost:2583",
        },
      ],
    };

    expect(pdsEndpoint(doc)).toBe("http://localhost:2583");
  });

  test("returns undefined when the document names no PDS", () => {
    expect(pdsEndpoint({ service: [] })).toBeUndefined();
    expect(pdsEndpoint({})).toBeUndefined();
  });
});

describe("recordPath", () => {
  test("keeps the collection and record key of an at:// URI", () => {
    expect(
      recordPath("at://did:plc:abc123/app.bsky.feed.post/3mzyzefiwpc2t"),
    ).toBe("app.bsky.feed.post/3mzyzefiwpc2t");
  });
});

describe("waitForFrame", () => {
  test("resolves once a frame containing the text arrives", async () => {
    const frames = [Buffer.from("an unrelated frame")];
    setTimeout(() => {
      frames.push(Buffer.from("\xa2ops\x81app.bsky.feed.post/3abc\xff"));
    }, 50);

    await expect(
      waitForFrame(frames, "app.bsky.feed.post/3abc", 2_000),
    ).resolves.toBeUndefined();
  });

  test("fails when no frame mentions the text in time", async () => {
    const frames = [Buffer.from("app.bsky.feed.post/3other")];

    await expect(
      waitForFrame(frames, "app.bsky.feed.post/3abc", 300),
    ).rejects.toThrow("no firehose frame mentioned app.bsky.feed.post/3abc");
  });
});

describe("getJson and postJson", () => {
  let server;
  let base;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/json") {
        res.end(JSON.stringify({ version: "1.2.3" }));
      } else if (req.url === "/empty") {
        res.end();
      } else if (req.url === "/echo") {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          res.end(
            JSON.stringify({
              method: req.method,
              contentType: req.headers["content-type"],
              authorization: req.headers.authorization,
              body: JSON.parse(body),
            }),
          );
        });
      } else {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "InvalidRequest" }));
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  test("getJson parses a JSON body", async () => {
    await expect(getJson(`${base}/json`)).resolves.toEqual({
      version: "1.2.3",
    });
  });

  test("getJson returns null for an empty body", async () => {
    await expect(getJson(`${base}/empty`)).resolves.toBeNull();
  });

  test("an error status fails with the status and the body", async () => {
    await expect(getJson(`${base}/missing`)).rejects.toThrow(
      /HTTP 400 from .*\/missing: .*InvalidRequest/,
    );
  });

  test("postJson sends JSON with any extra headers", async () => {
    await expect(
      postJson(`${base}/echo`, { did: "did:plc:abc" }, { authorization: "x" }),
    ).resolves.toEqual({
      method: "POST",
      contentType: "application/json",
      authorization: "x",
      body: { did: "did:plc:abc" },
    });
  });

  test("a refused connection names the address it tried", async () => {
    const closed = createServer();
    await new Promise((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const port = closed.address().port;
    await new Promise((resolve) => closed.close(resolve));

    await expect(getJson(`http://127.0.0.1:${port}/x`)).rejects.toThrow(
      `could not connect to http://127.0.0.1:${port}`,
    );
  });
});

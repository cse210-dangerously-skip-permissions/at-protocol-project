# @trustlab/harness

Experiment harness: runs named scenarios and writes results.

- **Team:** Trust
- **System:** Auditor & Test Harness (AUD)

`spikes/` holds one-off scripts that answer a question against the local stack; [spikes/README.md](spikes/README.md) lists them and their findings.

AI agents: read [AGENTS.md](../../AGENTS.md) first.

## Running a scenario

From the repo root with Docker Compose running:

```sh
npm run harness -- --scenario smoke --runs 2
```

Each repetition deletes the local stack's data volumes, starts the stack, and seeds its accounts. Smoke publishes one deterministic event and records the event count. Its `timingsMs.publish` measures the whole `runPublish` call, including login, the head read, and the write. Scenarios that need to exclude login time can pass an existing session to `runPublish`. Only scenarios that audit a stream return a verdict.

`--runs` defaults to 1 and `--config` to `A0`. The runner passes the selected configuration (`A0`, `A1`, `S0`, or `S1`) and one-based run number to the scenario. To add a scenario, implement `Scenario` and add it to the list in `src/runner.ts`.

Each completed run appends a row to the JSON array in `results/<UTC start date>/<scenario>.json`. Each row includes a unique `runId`. The harness sets `RUN_ID` for each repetition so publisher, consumer, and witness logs can be matched to that row. Run numbers restart at 1 for each invocation. A failed step stops the command with a nonzero exit code and keeps previously completed rows. The runner uses `results/.running` to prevent overlapping resets. If a process is forcibly terminated, remove this empty directory after confirming the runner has stopped.

## Baseline server (S0)

`src/baseline/` is the signed HTTP server the AT setup is compared against (#83). It stores the same event records with the same seq and `prevEventCid` rules as the AT publisher (ADR-004), and computes each CID with the publisher's `recordCid`, so the same seeded workload gives the same CIDs on both. What differs is the proof: the server signs each head with a secp256k1 key, where on AT the PDS signs the repo commit. ADR-007 says what counts as equivalent.

```ts
const server = await startBaselineServer({ publisherToken });
const publisher = baselineClient(server.url, publisherToken);
await publishWorkload(publisher, { stream: "releases", count: 5, seed: 1 });

const reader = baselineClient(server.url);
const signed = await reader.head("releases");
await verifyHead(server.publicKey, signed); // true
```

| Route                                 | Does                                                              |
| ------------------------------------- | ----------------------------------------------------------------- |
| `GET /streams/:stream/events`         | `{ events: [{ seq, cid, record }] }` in seq order                 |
| `GET /streams/:stream/head`           | `{ head: { stream, seq, eventCid }, sig }`; 404 before any event  |
| `POST /streams/:stream/events`        | Append `{ kind, payload, createdAt, refSeq? }`                    |
| `PUT /streams/:stream/events/:seq`    | Tamper: `{ "mode": "edit" }` (default) or `{ "mode": "rewrite" }` |
| `DELETE /streams/:stream/events/:seq` | Tamper: delete that event and every later one                     |

- **Bootstrap.** A consumer is given the URL and `server.publicKey` (a `did:key`). The key is not served over HTTP: configuring it by hand is the step the DID-based AT setup replaces.
- **Signature.** `sig` is the base64 secp256k1 signature over `headBytes(head)`: the UTF-8 JSON of `stream`, `seq`, `eventCid` in that order. `verifyHead(publicKey, signed)` checks it.
- **Publisher only.** `POST`, `PUT`, and `DELETE` need `Authorization: Bearer <publisherToken>`. Reads need nothing. The server refuses to start with an empty token.
- **Tampers mirror #65.** `edit` changes one payload and leaves the head alone. `rewrite` changes every event from `:seq` to the head, relinks them, and re-signs the head. `DELETE` on seq N is `tamper truncate --to N-1`: the head is re-signed at N-1. The payload change is the publisher's `withChangedPayload`, so a tampered event has the same CID on S0 as on AT. A rewrite or truncate that touches more than `MAX_TAMPER_WRITES` (200) records, the head included, is refused with 400, because AT could not make it in one commit.
- **One change at a time.** Writes are queued and each is one SQLite transaction, like one AT commit, so appends never reuse a seq and a reader never sees a tamper halfway. `close()` waits for queued writes and can be called twice.

Storage is `node:sqlite` (`dbPath`, default in memory). `tests/integration/baseline.test.ts` runs the same workload and tampers on the PDS and on S0 and compares the CIDs.

## Sources

A fresh consumer reads a stream through a `StreamSource` (`src/source.ts`, #84), and `auditStream(source, stream, witness?)` runs `compareWithWitness` on what it read. The audit logic never sees which setup the events came from, so the same rules run in all four cells of ADR-007.

```ts
const verdictA0 = await auditStream(atSource(env), "releases");
const verdictS0 = await auditStream(
  baselineSource({ url: server.url, publicKey: server.publicKey }),
  "releases",
);
// A1 and S1 pass the witness's checkpoints and a verifier.
const verdictA1 = await auditStream(atSource(env), "releases", {
  checkpoints,
  verify: pinnedVerifier(didDocKey),
});
```

|                      | `atSource(env)` (A0, A1)                             | `baselineSource({ url, publicKey })` (S0, S1)                 |
| -------------------- | ---------------------------------------------------- | ------------------------------------------------------------- |
| Reads                | A `getRepo` snapshot, planned into events (#43, #44) | `GET .../events` and `GET .../head`                           |
| Checks the publisher | Commit signature against the DID document's key      | Head signature against the configured key                     |
| `did` on each event  | The publisher's DID                                  | The public key, the only name S0 has for the publisher        |
| `"unreachable"`      | The snapshot fails with `pds-unreachable`            | A failed connection, or an error status other than a head 404 |
| Throws               | The repo doesn't verify, or the PLC can't be read    | The head isn't signed by the key, or an answer is malformed   |

S0 serves the events and the head in separate requests, so `baselineSource` reads the events again after the head and retries, up to three times, if they changed. One read never mixes two states of a stream, just as one AT commit can't.

Without `witness`, no witness is queried, as ADR-007 requires for A0 and S0. `tests/integration/source.test.ts` runs the same workload and tamper on the PDS and on S0 and checks that both give ADR-007's verdict for each scenario.

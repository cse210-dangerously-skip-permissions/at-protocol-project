/**
 * Spike for #41 (CNS-4): what `@atproto/sync` exposes for one commit, and
 * whether a commit's blocks alone let a witness verify the head record.
 *
 * Needs the local stack (`npm run stack:up`). Run from the repo root:
 *
 *     npx tsx tools/harness/spikes/sync-fields.ts
 *
 * It writes three commits to a fresh spike stream on the seeded publisher:
 *
 * 1. create event seq 1 and its head, in one `applyWrites` commit;
 * 2. create event seq 2 and update the head, in one commit;
 * 3. delete both events and the head, in one commit, which also cleans up.
 *
 * For each commit it prints what `Firehose` hands to `handleEvent`, what the
 * raw `subscribeRepos` frame carries, and `verifyProofs` on the head record:
 * on the raw CAR, on a CAR rebuilt from the parsed `blocks`, with a wrong
 * CID, and with the witness account's key. It also checks each frame's
 * `since` and `prevData` against the previous signed commit.
 *
 * Every expectation comes from the writes the spike made, not from what
 * arrived, so a dropped op is a failed check. It exits non-zero if any check
 * fails. A spike, not production code: it is not imported or unit tested.
 */
import { IdResolver } from "@atproto/identity";
import { type Cid, parseCid } from "@atproto/lex-data";
import {
  blocksToCarFile,
  cidForRecord,
  def,
  MemoryBlockstore,
  readCarWithRoot,
  verifyProofs,
} from "@atproto/repo";
import type { RecordCidClaim } from "@atproto/repo";
import { Firehose, type CommitEvt, type Event } from "@atproto/sync";
import { Subscription } from "@atproto/xrpc-server";
import {
  EVENT_NSID,
  type EventRecord,
  eventRkey,
  HEAD_NSID,
  type HeadRecord,
  headRkey,
  loadLocalEnv,
  parseEventRecord,
  parseHeadRecord,
} from "@trustlab/contracts";
import { login } from "@trustlab/publisher";

const METHOD = "com.atproto.sync.subscribeRepos";
const WAIT_MS = 15_000;

/** One raw `#commit` frame, reduced to the fields the spike inspects. */
interface RawCommit {
  commit: Cid;
  rev: string;
  since: string | null;
  prevData?: Cid;
  tooBig: boolean;
  blocks: Uint8Array;
  ops: { action: string; path: string; cid: Cid | null; prev?: Cid }[];
  keys: string[];
}

/** What one spike commit should carry, known before it is written. */
interface Planned {
  label: string;
  /** Every op as `collection/rkey`, with its new CID or `null` for a delete. */
  ops: { path: string; cid: string | null }[];
  /** The head's new CID, or `null` when the commit deletes it. */
  headCid: string | null;
  /** An event CID to claim for the head, which must not verify. */
  wrongCid: string | null;
}

/** One named check and whether it passed. */
interface Check {
  name: string;
  ok: boolean;
}

/**
 * Narrow a raw frame to a `#commit` from one repo.
 *
 * @param msg - The frame, with `$type` set by `Subscription`.
 * @param did - The repo to keep.
 * @returns The commit, or `null` for other frames and other repos.
 */
function asRawCommit(msg: unknown, did: string): RawCommit | null {
  if (typeof msg !== "object" || msg === null) return null;
  const m = msg as Record<string, unknown>;
  if (m.$type !== `${METHOD}#commit` || m.repo !== did) return null;
  return { ...(m as unknown as RawCommit), keys: Object.keys(m).sort() };
}

/**
 * Build a validated event record for the spike stream.
 *
 * @param stream - The spike stream.
 * @param seq - The event's seq.
 * @param prevEventCid - CID of the event at `seq - 1`, if any.
 * @returns The record, checked against the contract.
 */
function makeEvent(
  stream: string,
  seq: number,
  prevEventCid?: string,
): EventRecord {
  return parseEventRecord(
    {
      $type: EVENT_NSID,
      stream,
      seq,
      ...(prevEventCid === undefined ? {} : { prevEventCid }),
      kind: "release",
      payload: {
        name: "spike",
        version: `0.0.${seq}`,
        checksum: "sha256:0",
      },
      createdAt: new Date(Date.UTC(2026, 10, 13, 0, 0, seq)).toISOString(),
    },
    eventRkey(stream, seq),
  );
}

/**
 * Copy an event into a plain object, which `cidForRecord` accepts where the
 * `EventRecord` and `Payload` interfaces are not.
 *
 * @param event - The event.
 * @returns The same fields as a plain object.
 */
function asLex(event: EventRecord) {
  return { ...event, payload: { ...event.payload } };
}

/**
 * Build a validated head record.
 *
 * @param stream - The spike stream.
 * @param seq - The seq of the latest event.
 * @param eventCid - Its CID.
 * @returns The record, checked against the contract.
 */
function makeHead(stream: string, seq: number, eventCid: string): HeadRecord {
  return parseHeadRecord(
    { $type: HEAD_NSID, stream, seq, eventCid },
    headRkey(stream),
  );
}

/**
 * Wait until a condition holds or the time runs out.
 *
 * @param done - The condition.
 * @param ms - The most to wait.
 * @returns Whether the condition held in time.
 */
async function waitFor(done: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (!done() && Date.now() < end) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return done();
}

/**
 * Read the signed commit object at the root of a frame's CAR.
 *
 * @param car - The frame's `blocks`.
 * @returns The commit's `rev` and `data` (its MST root), as strings.
 */
async function signedCommit(
  car: Uint8Array,
): Promise<{ rev: string; data: string }> {
  const { root, blocks } = await readCarWithRoot(car);
  const commit = await new MemoryBlockstore(blocks).readObj(root, def.commit);
  return { rev: commit.rev, data: String(commit.data) };
}

/**
 * Run `verifyProofs` and report how it ended, since it fails in two ways:
 * a wrong CID comes back in `unverified`, a wrong key throws.
 *
 * @param car - CAR bytes, or `null` if the commit never arrived.
 * @param claims - The claims to check.
 * @param did - The repo's DID.
 * @param key - The signing key to check against.
 * @returns Counts, the thrown message, or `null` with nothing to check.
 */
async function verify(
  car: Uint8Array | null,
  claims: RecordCidClaim[],
  did: string,
  key: string,
): Promise<
  { verified: number; unverified: number } | { error: string } | null
> {
  if (car === null) return null;
  try {
    const r = await verifyProofs(car, claims, did, key);
    return { verified: r.verified.length, unverified: r.unverified.length };
  } catch (err) {
    return { error: String(err) };
  }
}

/**
 * Publish the three spike commits, print what the firehose carried, and set
 * a non-zero exit code if any check failed.
 *
 * @returns Resolves once the report is printed and both subscriptions closed.
 */
async function main(): Promise<void> {
  const env = loadLocalEnv();
  const session = await login(env);
  const did = session.did;
  const stream = `spike${Date.now().toString(36)}`;
  const service = env.PDS_URL.replace(/^http/, "ws");
  const idResolver = new IdResolver({
    plcUrl: env.PLC_URL,
    fetch: globalThis.fetch,
  });

  const parsed = new Map<string, CommitEvt[]>();
  const others: Event[] = [];
  const firehoseErrors: string[] = [];
  const firehose = new Firehose({
    idResolver,
    service,
    filterCollections: [EVENT_NSID, HEAD_NSID],
    handleEvent: (evt) => {
      if (evt.did !== did) return;
      if ("commit" in evt) {
        const key = String(evt.commit);
        parsed.set(key, [...(parsed.get(key) ?? []), evt]);
      } else {
        others.push(evt);
      }
    },
    onError: (err) => firehoseErrors.push(String(err)),
  });

  const raw = new Map<string, RawCommit>();
  const rawTypes = new Set<string>();
  const abort = new AbortController();
  const sub = new Subscription<unknown>({
    service,
    method: METHOD,
    signal: abort.signal,
    validate: (value) => value,
  });

  void firehose.start();
  const reading = (async () => {
    try {
      for await (const msg of sub) {
        const type = (msg as { $type?: unknown }).$type;
        if (typeof type === "string") rawTypes.add(type);
        const commit = asRawCommit(msg, did);
        if (commit !== null) raw.set(String(commit.commit), commit);
      }
    } catch (err) {
      if (!abort.signal.aborted) console.error("raw subscription error:", err);
    }
  })();

  try {
    // Both subscriptions start at the live tail, so give them time to connect.
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const event1 = makeEvent(stream, 1);
    const cid1 = (await cidForRecord(asLex(event1))).toString();
    const head1 = makeHead(stream, 1, cid1);
    const event2 = makeEvent(stream, 2, cid1);
    const cid2 = (await cidForRecord(asLex(event2))).toString();
    const head2 = makeHead(stream, 2, cid2);
    const headCid1 = (await cidForRecord({ ...head1 })).toString();
    const headCid2 = (await cidForRecord({ ...head2 })).toString();
    const eventPath = (seq: number) =>
      `${EVENT_NSID}/${eventRkey(stream, seq)}`;
    const headPath = `${HEAD_NSID}/${headRkey(stream)}`;

    const plan: Planned[] = [
      {
        label: "1: create event 1 + create head",
        ops: [
          { path: eventPath(1), cid: cid1 },
          { path: headPath, cid: headCid1 },
        ],
        headCid: headCid1,
        wrongCid: cid1,
      },
      {
        label: "2: create event 2 + update head",
        ops: [
          { path: eventPath(2), cid: cid2 },
          { path: headPath, cid: headCid2 },
        ],
        headCid: headCid2,
        wrongCid: cid2,
      },
      {
        label: "3: delete events 1-2 + delete head",
        ops: [
          { path: eventPath(1), cid: null },
          { path: eventPath(2), cid: null },
          { path: headPath, cid: null },
        ],
        headCid: null,
        wrongCid: null,
      },
    ];

    const repo = session.agent.com.atproto.repo;
    const write1 = await repo.applyWrites({
      repo: did,
      writes: [
        {
          $type: "com.atproto.repo.applyWrites#create",
          collection: EVENT_NSID,
          rkey: eventRkey(stream, 1),
          value: { ...event1 },
        },
        {
          $type: "com.atproto.repo.applyWrites#create",
          collection: HEAD_NSID,
          rkey: headRkey(stream),
          value: { ...head1 },
        },
      ],
    });
    const write2 = await repo.applyWrites({
      repo: did,
      writes: [
        {
          $type: "com.atproto.repo.applyWrites#create",
          collection: EVENT_NSID,
          rkey: eventRkey(stream, 2),
          value: { ...event2 },
        },
        {
          $type: "com.atproto.repo.applyWrites#update",
          collection: HEAD_NSID,
          rkey: headRkey(stream),
          value: { ...head2 },
        },
      ],
    });
    const write3 = await repo.applyWrites({
      repo: did,
      writes: [1, 2]
        .map((seq) => ({
          $type: "com.atproto.repo.applyWrites#delete" as const,
          collection: EVENT_NSID,
          rkey: eventRkey(stream, seq),
        }))
        .concat({
          $type: "com.atproto.repo.applyWrites#delete" as const,
          collection: HEAD_NSID,
          rkey: headRkey(stream),
        }),
    });

    const writes = [write1.data, write2.data, write3.data];
    const commits = writes.map((w) => w.commit?.cid ?? "");
    const arrived = await waitFor(
      () =>
        commits.every(
          (c, i) => raw.has(c) && parsed.get(c)?.length === plan[i]?.ops.length,
        ),
      WAIT_MS,
    );

    const key = await idResolver.did.resolveAtprotoKey(did);
    const witnessKey = await idResolver.did.resolveAtprotoKey(env.WITNESS_DID);
    const pdsCids = writes.map((w) =>
      (w.results ?? []).map((r) => ("cid" in r ? r.cid : null)),
    );

    const checks: Check[] = [
      { name: "every op and frame arrived in time", ok: arrived },
      { name: "Firehose reported no errors", ok: firehoseErrors.length === 0 },
      {
        name: "cidForRecord matches the PDS for both events",
        ok: cid1 === pdsCids[0]?.[0] && cid2 === pdsCids[1]?.[0],
      },
    ];

    console.log(
      JSON.stringify(
        {
          did,
          stream,
          signingKey: key,
          witnessKey,
          allArrived: arrived,
          firehoseErrors,
          rawFrameTypesSeen: [...rawTypes].sort(),
          nonCommitEventsForThisDid: others.map((e) => ({
            event: e.event,
            keys: Object.keys(e).sort(),
          })),
        },
        null,
        2,
      ),
    );

    let previous: { rev: string; data: string } | null = null;
    for (const [i, planned] of plan.entries()) {
      const commitCid = commits[i] ?? "";
      const evts = parsed.get(commitCid) ?? [];
      const frame = raw.get(commitCid);
      const first = evts[0];
      const signed =
        frame === undefined ? null : await signedCommit(frame.blocks);

      // Claims come from the plan, so the raw-CAR checks run even when
      // Firehose drops an op.
      const claim = (cid: string | null): RecordCidClaim[] => [
        {
          collection: HEAD_NSID,
          rkey: headRkey(stream),
          cid: cid === null ? null : parseCid(cid),
        },
      ];
      const headClaim = claim(planned.headCid);
      const rebuilt =
        first === undefined
          ? null
          : await blocksToCarFile(first.commit, first.blocks);
      const rawCar = frame?.blocks ?? null;

      const gotOps = evts
        .map((e) => ({
          path: `${e.collection}/${e.rkey}`,
          cid: "cid" in e ? String(e.cid) : null,
        }))
        .sort((a, b) => a.path.localeCompare(b.path));
      const wantOps = [...planned.ops].sort((a, b) =>
        a.path.localeCompare(b.path),
      );

      const results = {
        onRawCar: await verify(rawCar, headClaim, did, key),
        onRebuiltCar: await verify(rebuilt, headClaim, did, key),
        wrongCidOnRawCar:
          planned.wrongCid === null
            ? null
            : await verify(rawCar, claim(planned.wrongCid), did, key),
        wrongKeyOnRawCar: await verify(rawCar, headClaim, did, witnessKey),
      };
      const chain =
        previous === null || frame === undefined
          ? null
          : {
              sinceIsPreviousRev: frame.since === previous.rev,
              prevDataIsPreviousSignedData:
                String(frame.prevData) === previous.data,
            };

      const verified = (r: (typeof results)["onRawCar"]) =>
        r !== null && "verified" in r && r.verified === 1;
      checks.push(
        {
          name: `${planned.label}: Firehose delivered ${wantOps.length} ops`,
          ok: JSON.stringify(gotOps) === JSON.stringify(wantOps),
        },
        {
          name: `${planned.label}: raw frame arrived`,
          ok: frame !== undefined,
        },
        {
          name: `${planned.label}: head verifies on the raw CAR`,
          ok: verified(results.onRawCar),
        },
        {
          name: `${planned.label}: head verifies on the rebuilt CAR`,
          ok: verified(results.onRebuiltCar),
        },
        {
          name: `${planned.label}: wrong key throws`,
          ok:
            results.wrongKeyOnRawCar !== null &&
            "error" in results.wrongKeyOnRawCar &&
            results.wrongKeyOnRawCar.error.includes("Invalid signature"),
        },
      );
      if (planned.wrongCid !== null) {
        const r = results.wrongCidOnRawCar;
        checks.push({
          name: `${planned.label}: wrong CID is unverified`,
          ok: r !== null && "unverified" in r && r.unverified === 1,
        });
      }
      if (previous !== null) {
        checks.push({
          name: `${planned.label}: since and prevData match the previous signed commit`,
          ok:
            chain !== null &&
            chain.sinceIsPreviousRev &&
            chain.prevDataIsPreviousSignedData,
        });
      }

      console.log(
        JSON.stringify(
          {
            commit: planned.label,
            pdsCommit: writes[i]?.commit,
            firehose: {
              opsExpected: wantOps.length,
              opsReceived: evts.length,
              sameBlocksObjectOnEveryOp: evts.every(
                (e) => e.blocks === first?.blocks,
              ),
              ops: evts.map((e) => ({
                event: e.event,
                collection: e.collection,
                rkey: e.rkey,
                cid: "cid" in e ? String(e.cid) : undefined,
                hasRecord: "record" in e,
                keys: Object.keys(e).sort(),
              })),
              seq: first?.seq,
              rev: first?.rev,
              blocks:
                first === undefined
                  ? undefined
                  : {
                      count: first.blocks.size,
                      byteSize: first.blocks.byteSize,
                      rebuiltCarBytes: rebuilt?.length,
                    },
            },
            rawFrame:
              frame === undefined
                ? null
                : {
                    keys: frame.keys,
                    rev: frame.rev,
                    since: frame.since,
                    prevData: frame.prevData ? String(frame.prevData) : null,
                    tooBig: frame.tooBig,
                    carBytes: frame.blocks.length,
                    ops: frame.ops.map((op) => ({
                      action: op.action,
                      path: op.path,
                      cid: op.cid === null ? null : String(op.cid),
                      prev: op.prev === undefined ? undefined : String(op.prev),
                    })),
                  },
            signedCommit: signed,
            chain,
            verifyHeadClaim: results,
          },
          null,
          2,
        ),
      );
      previous = signed;
    }

    const failed = checks.filter((c) => !c.ok);
    for (const c of checks) console.log(`${c.ok ? "ok  " : "FAIL"}  ${c.name}`);
    console.log(
      failed.length === 0
        ? `All ${checks.length} checks passed.`
        : `${failed.length} of ${checks.length} checks failed.`,
    );
    if (failed.length > 0) process.exitCode = 1;
  } finally {
    abort.abort();
    await firehose.destroy();
    await reading;
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});

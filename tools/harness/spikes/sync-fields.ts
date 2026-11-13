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
 * raw `subscribeRepos` frame carries, and the result of `verifyProofs` on the
 * head record, run on the raw CAR bytes and on a CAR rebuilt from the parsed
 * `blocks`. A spike, not production code: it is not imported or unit tested.
 */
import { IdResolver } from "@atproto/identity";
import { blocksToCarFile, cidForRecord, verifyProofs } from "@atproto/repo";
import type { BlockMap, RecordCidClaim } from "@atproto/repo";
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

/** A Cid as both packages see it: all the spike needs is its string form. */
type CidLike = Parameters<BlockMap["get"]>[0];

/** One raw `#commit` frame, reduced to the fields the spike inspects. */
interface RawCommit {
  commit: CidLike;
  rev: string;
  since: string | null;
  prevData?: CidLike;
  tooBig: boolean;
  blocks: Uint8Array;
  ops: { action: string; path: string; cid: CidLike | null; prev?: CidLike }[];
  keys: string[];
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
 * Publish the three spike commits and print what the firehose carried.
 *
 * @returns Resolves once the report is printed.
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
    onError: (err) => console.error("firehose error:", err),
  });
  void firehose.start();

  const raw = new Map<string, RawCommit>();
  const rawTypes = new Set<string>();
  const abort = new AbortController();
  const sub = new Subscription<unknown>({
    service,
    method: METHOD,
    signal: abort.signal,
    validate: (value) => value,
  });
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

  // Both subscriptions start at the live tail, so give them time to connect.
  await new Promise((resolve) => setTimeout(resolve, 1500));

  const repo = session.agent.com.atproto.repo;
  const event1 = makeEvent(stream, 1);
  const cid1 = (await cidForRecord(asLex(event1))).toString();
  const head1 = makeHead(stream, 1, cid1);
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

  const event2 = makeEvent(stream, 2, cid1);
  const cid2 = (await cidForRecord(asLex(event2))).toString();
  const head2 = makeHead(stream, 2, cid2);
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

  const writes = [
    { label: "1: create event 1 + create head", data: write1.data },
    { label: "2: create event 2 + update head", data: write2.data },
    { label: "3: delete events 1-2 + delete head", data: write3.data },
  ];
  const commits = writes.map((w) => w.data.commit?.cid ?? "");
  const arrived = await waitFor(
    () => commits.every((c) => parsed.has(c) && raw.has(c)),
    WAIT_MS,
  );

  const key = await idResolver.did.resolveAtprotoKey(did);
  const headCids = [head1, head2].map(async (head) =>
    (await cidForRecord({ ...head })).toString(),
  );
  const pdsResults = writes.map((w) =>
    (w.data.results ?? []).map((r) => ("cid" in r ? r.cid : null)),
  );

  console.log(
    JSON.stringify(
      {
        did,
        stream,
        signingKey: key,
        allArrived: arrived,
        locallyComputedEventCidsMatchPds: {
          event1: cid1 === pdsResults[0]?.[0],
          event2: cid2 === pdsResults[1]?.[0],
        },
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

  for (const [i, w] of writes.entries()) {
    const commitCid = commits[i] ?? "";
    const evts = parsed.get(commitCid) ?? [];
    const frame = raw.get(commitCid);
    const first = evts[0];
    // Claim the head as the firehose reported it: its new CID, or null for
    // the delete. The wrong claim gives the head an event record's CID.
    const headEvt = evts.find((e) => e.collection === HEAD_NSID);
    const eventEvt = evts.find((e) => e.collection === EVENT_NSID);
    const headClaim: RecordCidClaim[] =
      headEvt === undefined
        ? []
        : [
            {
              collection: HEAD_NSID,
              rkey: headRkey(stream),
              cid: "cid" in headEvt ? headEvt.cid : null,
            },
          ];
    const wrongClaim: RecordCidClaim[] =
      eventEvt !== undefined && "cid" in eventEvt
        ? [{ collection: HEAD_NSID, rkey: headRkey(stream), cid: eventEvt.cid }]
        : [];
    const expectedHeadCid = i < 2 ? await headCids[i] : null;
    const reportedHeadCid =
      headEvt !== undefined && "cid" in headEvt ? String(headEvt.cid) : null;

    const rebuilt =
      first === undefined
        ? null
        : await blocksToCarFile(first.commit, first.blocks);
    const verify = async (car: Uint8Array | null, claims: RecordCidClaim[]) => {
      if (car === null || claims.length === 0) return null;
      try {
        const r = await verifyProofs(car, claims, did, key);
        return { verified: r.verified.length, unverified: r.unverified.length };
      } catch (err) {
        return { error: String(err) };
      }
    };

    console.log(
      JSON.stringify(
        {
          commit: w.label,
          pdsCommit: w.data.commit,
          firehose: {
            eventsForThisCommit: evts.length,
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
            commit: first === undefined ? undefined : String(first.commit),
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
          headCidMatchesLocalCid: reportedHeadCid === expectedHeadCid,
          verifyHeadClaim: {
            onRawCar: await verify(frame?.blocks ?? null, headClaim),
            onRebuiltCar: await verify(rebuilt, headClaim),
            wrongCidOnRawCar: await verify(frame?.blocks ?? null, wrongClaim),
          },
        },
        null,
        2,
      ),
    );
  }

  abort.abort();
  await firehose.destroy();
  await reading;
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});

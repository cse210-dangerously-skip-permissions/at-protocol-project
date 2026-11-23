# Spikes

Short scripts that answer one question against the local stack. They are not imported by anything and have no unit tests. Each one names the issue it answers.

## `capture-commit.ts`: capture a commit for the tampered-commit fixtures (#51, AUD-2)

```
npm run stack:up
npx tsx tools/harness/spikes/capture-commit.ts
```

Publishes one seeded event on a fresh stream and writes that commit's raw `#commit` frame, with the publisher's signing key, to `packages/auditor/test/fixtures/commit.json`. CIDs are strings and bytes are base64. `packages/auditor/src/commit-fixtures.test.ts` reads it offline. Rerun it only to refresh the fixture.

## `capture-head.ts`: capture a provable head (#46, WIT-1)

```
npm run stack:up
npx tsx tools/harness/spikes/capture-head.ts capture [file]
npm run stack:down
npx tsx tools/harness/spikes/capture-head.ts verify [file]
npx tsx tools/harness/spikes/capture-head.ts sizes
```

- `capture` reads raw `subscribeRepos` frames, publishes three seeded events on a fresh stream, and turns each head commit into a `WitnessCheckpoint` whose proof holds only the signed commit, the MST path to the head, and the head record. It writes the checkpoints to `file` (default `wit1-capture.json` in the OS temp directory).
- `verify` replaces `fetch` with one that throws, then runs `checkCheckpoint` from `@trustlab/auditor` on the capture and on tampered copies.
- `sizes` builds signed in-memory repos with the publisher's record layout, from a fixed key and rev, and prints proof bytes and verification time for 10 to 10,000 records. The bytes are the same on every run.

Each command exits non-zero when a check comes out wrong.

### Findings

Run on 2026-11-17 against the local stack (PDS 0.4.5051), with `@atproto/repo` 0.11.5 and `@atproto/xrpc-server` 0.13.11.

1. **A head commit's frame is already the proof.** The raw `#commit` frame's `blocks` is a CAR rooted at the signed commit. It holds the MST nodes on the head's path and the head record, and `verifyProofs` confirms the head from it directly, with no `blocksToCarFile` rebuild. Trimming it to the commit, the path, and the record removed nothing: 1,533 B either way on the publisher's 71-record repo, 1,853 B on a second run at 96 records, and equal in every row below. The live repo holds many streams, so its head paths run longer than the one-stream repos below. After #63 puts the event and the head in one commit, the frame also carries the event record and its path, about 320 B more, which trimming removes.
2. **Offline verification passes for a real capture and fails for each tampered copy.** With the stack stopped:

   | Case                                   | Result  | Why                                               |
   | -------------------------------------- | ------- | ------------------------------------------------- |
   | The capture, trimmed proof             | valid   |                                                   |
   | The capture, whole frame               | valid   |                                                   |
   | An older capture (seq 2 of 3)          | valid   |                                                   |
   | One byte flipped in the head record    | invalid | `readCarWithRoot`: "Not a valid CID for bytes"    |
   | A different head CID in the claim      | invalid | `verifyProofs` returns the claim as `unverified`  |
   | Checked with the witness account's key | invalid | `verifyProofs`: "Invalid signature on commit"     |
   | `seq` one higher than the head record  | invalid | Our check: the head record has a different seq    |
   | The older proof under the newest claim | invalid | Our check: the proof's root is a different commit |

3. **`verifyProofs` alone does not prove a checkpoint.** It proves that `head-<stream>` had `headCid` in a commit signed by the key. It does not compare the CAR's root with `commitCid`, the commit's rev with `rev`, or the head record's contents with `seq` and `eventCid`. Without those checks, a real proof could be paired with a wrong seq or an older commit, as in the last two rows. `verifyCheckpoint` checks all of them.
4. **The library fails in three different ways.** A bad block or a wrong key throws, while a wrong CID returns `unverified` (the same split #124 found for `Firehose`). `verifyCheckpoint` catches every one and returns `false`, and `checkCheckpoint` returns the message.
5. **Proof size grows slowly with repo size, and verification stays at about 2 ms.** From `sizes`, publisher layout (one stream and its head), median of 25 runs of `checkCheckpoint` including the signature check:

   | Records | MST nodes on the head's path | Trimmed proof | `sync.getRecord` proof | Frame, head only | Frame, event + head (#63) | Verify |
   | ------- | ---------------------------- | ------------- | ---------------------- | ---------------- | ------------------------- | ------ |
   | 10      | 3                            | 1,106 B       | 1,106 B                | 1,106 B          | 1,422 B                   | 2.1 ms |
   | 100     | 4                            | 1,477 B       | 1,477 B                | 1,477 B          | 1,818 B                   | 1.6 ms |
   | 1,000   | 8                            | 2,375 B       | 2,375 B                | 2,375 B          | 2,695 B                   | 1.7 ms |
   | 10,000  | 11                           | 2,442 B       | 2,442 B                | 2,442 B          | 2,763 B                   | 1.6 ms |

   "Frame" is the `relevantBlocks` CAR that the PDS sends for the next publish. Base64 in the JSON checkpoint adds a third.

6. **The fallback is the path to use.** `Firehose` silently drops an op whose proof fails (#41, #124), so a witness built on it could miss a checkpoint without knowing. Raw frames from `Subscription` include every head commit, so the witness can verify each one with `verifyCheckpoint` and count the failures. ADR-002 already says the witness must not capture through `sync`.
7. **Which key to trust is the caller's decision.** `verifyCheckpoint` checks against the stored `signingKey`. ADR-003 rule 3 trusts the DID document's key, so the auditor (#80) calls `verifyCheckpoint({ ...cp, signingKey: keyFromDidDocument })`. After a key rotation that fails, and the verdict is `unknown` (#96).

## `sync-fields.ts`: what `@atproto/sync` exposes (#41, CNS-4)

```
npm run stack:up
npx tsx tools/harness/spikes/sync-fields.ts
```

It writes three commits to a fresh spike stream on the seeded publisher, then deletes it: event 1 and its head in one `applyWrites` commit, event 2 and a head update in one commit, and a delete of all three records. For each commit it prints what `Firehose` passes to `handleEvent` and what the raw `subscribeRepos` frame carries. It runs `verifyProofs` on the head record four ways: on the raw CAR, on a CAR rebuilt from `Firehose`'s `blocks`, with a wrong CID, and with the witness account's key. It also checks each frame's `since` and `prevData` against the previous signed commit.

The expected ops and CIDs come from the writes, not from what arrived, so a dropped op fails a check. It prints one line per check and exits non-zero if any fails.

### Findings

Run from 2026-11-13 to 2026-11-18 against the local stack (PDS 0.4.5051), with `@atproto/sync` 0.4.25 and 0.4.26 and `@atproto/repo` 0.11.5. Both `sync` versions gave the same results. Findings 7 and 8 come from reading `Firehose`'s source; the #124 review confirmed them with a generated signed repo.

1. **`Firehose` emits one event per operation, not per commit.** A commit with an event and a head arrives as two `CommitEvt`s. Both carry the commit CID, `rev`, firehose `seq`, and the same `blocks` object. A consumer that applies a commit atomically must group by `commit` itself.
2. **Each event carries the commit CID, `rev`, and the commit's blocks.** `blocks` is a parsed `BlockMap`: the signed commit, the MST nodes on the changed paths, and the new record blocks. For an event plus a head that was 4 to 7 blocks and 0.64 to 0.93 KB (0.86 to 1.25 KB as a CAR) across runs, depending on the shape of the repo's MST.
3. **The blocks alone verify the head.** `verifyProofs(car, [{ collection, rkey, cid }], did, key)` confirmed the head record's CID on every commit, with the key from `IdResolver.did.resolveAtprotoKey` on the local PLC. A delete is proven with `cid: null`.
4. **`verifyProofs` fails in two ways.** A claim with the wrong CID comes back in `unverified`. A check with the wrong key (the witness account's) throws `Invalid signature on commit`. A caller has to handle both. #46 found the same split for checkpoints.
5. **`verifyProofs` takes CAR bytes, not a `BlockMap`.** From a `Firehose` event, rebuild them with `blocksToCarFile(evt.commit, evt.blocks)`. The rebuilt CAR was the same size as the raw frame's `blocks` and verified the same way. The raw frame's `blocks` needs no rebuild.
6. **Not exposed by `CommitEvt`: `since`, `prevData`, and each op's `prev`.** The local PDS sends them: every raw `#commit` frame had `since` and `prevData`, and updates and deletes had `ops[].prev`. Read them from the raw frame with `Subscription` from `@atproto/xrpc-server`. `prevData` is not part of the signed commit, which holds `did`, `version`, `data`, `rev`, `prev`, and `sig`, so on its own it is only what the PDS says. Compare it with the `data` of the previous signed commit: in every run, each frame's `since` was the previous commit's `rev` and its `prevData` was the previous commit's `data`.
7. **`Firehose` drops failures in two different ways.** A commit whose signature fails is retried once with a refreshed key, then dropped whole and reported to `onError` as a `FirehoseParseError`. An op whose CID doesn't match the proof is dropped without any error. Wiring up `onError` catches the first. Only counting the ops we expected and did not get catches the second.
8. **`Firehose` does not check commit order.** It passes `rev` through without comparing it with the previous commit, and never reads `since` or `prevData`. A skipped, repeated, or reordered commit reaches `handleEvent` with no error, and replaying a valid commit delivers it twice. The order check belongs in our code, with the fields from finding 6.
9. **A delete has no `cid` and no `record`.** Its other fields match a create. The raw op has `cid: null` and `prev` set to the deleted record's CID.
10. **No `#sync` event appeared.** Ordinary writes never produce one. Its type in 0.4.25 is `{ seq, time, event: "sync", did, cid, rev, blocks }`, with `blocks` holding just the signed commit.
11. **`cidForRecord` gives the CID the PDS returns.** So the head can name its event before both are written in one commit. #140 now publishes that way (#63).

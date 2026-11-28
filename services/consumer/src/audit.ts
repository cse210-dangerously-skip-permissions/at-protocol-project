import { IdResolver } from "@atproto/identity";
import { compareWithWitness, verifyCheckpoint } from "@trustlab/auditor";
import {
  ContractError,
  parseCheckpointsResponse,
  type Verdict,
  type WitnessCheckpoint,
} from "@trustlab/contracts";
import type { ConsumerStore } from "./store.js";

/** Checkpoints from the configured witness and a verifier rooted in the publisher's DID. */
export interface WitnessClient {
  checkpoints(
    did: string,
    stream: string,
  ): Promise<readonly WitnessCheckpoint[]>;
  verify(checkpoint: WitnessCheckpoint): Promise<boolean>;
}

/** Build a client for GET /checkpoints and resolve signing keys through the configured PLC. */
export function witnessClient(baseUrl: string, plcUrl: string): WitnessClient {
  const endpoint = new URL("/checkpoints", baseUrl);
  const resolver = new IdResolver({ plcUrl, fetch: globalThis.fetch });
  // Checkpoints are verified concurrently. Share only outstanding PLC lookups
  // so later audits can observe a key rotation or retry after a failure.
  const pendingKeys = new Map<string, Promise<string>>();
  return {
    async checkpoints(did, stream) {
      const url = new URL(endpoint);
      url.search = new URLSearchParams({ did, stream }).toString();
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error(`witness HTTP ${response.status}`);
      return parseCheckpointsResponse(await response.json()).checkpoints;
    },
    async verify(cp) {
      let lookup = pendingKeys.get(cp.did);
      if (!lookup) {
        lookup = resolver.did.resolveAtprotoKey(cp.did).finally(() => {
          pendingKeys.delete(cp.did);
        });
        pendingKeys.set(cp.did, lookup);
      }
      return verifyCheckpoint({ ...cp, signingKey: await lookup });
    },
  };
}

/** Check one stream's current chain and optional witness proofs, and persist its verdict. */
export async function auditStream(
  store: ConsumerStore,
  did: string,
  stream: string,
  witness?: WitnessClient,
): Promise<Verdict> {
  const rev = store.auditRev(did);
  const events = store.auditEvents(did, stream);
  const head = store.auditHead(did, stream);
  const invalid = events.find((event) => event.record === null);
  let result: Verdict;
  if (invalid) {
    result = {
      verdict: "conflict",
      reason: "invalid-event",
      evidence: { seq: invalid.seq, currentCid: invalid.cid },
    };
  } else if (head === "invalid") {
    result = { verdict: "conflict", reason: "invalid-head" };
  } else {
    let checkpoints: readonly WitnessCheckpoint[] | "unreachable" = [];
    let malformed = false;
    if (witness) {
      try {
        checkpoints = await witness.checkpoints(did, stream);
      } catch (error) {
        if (error instanceof SyntaxError || error instanceof ContractError)
          malformed = true;
        else checkpoints = "unreachable";
      }
    }
    result = await compareWithWitness(
      { did, stream },
      events,
      checkpoints,
      witness && ((cp) => witness.verify(cp)),
      head,
    );
    if (malformed && result.verdict !== "conflict")
      result = { verdict: "unknown", reason: "bad-evidence" };
  }
  if (store.saveVerdict(did, stream, result, rev)) return result;
  // Another writer advanced this repo during the witness request.
  return auditStream(store, did, stream, witness);
}

/** Audit known streams in order, including previously witnessed streams that are now empty. */
export async function auditAll(
  store: ConsumerStore,
  witness?: WitnessClient,
  publisher?: string,
): Promise<void> {
  for (const { did, stream } of store.auditStreams(publisher))
    await auditStream(store, did, stream, witness);
}

import { type Secp256k1Keypair, verifySignature } from "@atproto/crypto";
import { isSeq, isStreamName } from "@trustlab/contracts";

/** The latest event of a stream on the baseline server. */
export interface BaselineHead {
  stream: string;
  /** The seq of the latest event. */
  seq: number;
  /** CID of the event at that seq. */
  eventCid: string;
}

/** A head and the server's signature over it, as `GET .../head` returns it. */
export interface SignedHead {
  head: BaselineHead;
  /** Base64 secp256k1 signature over `headBytes(head)`. */
  sig: string;
}

/**
 * The bytes the server signs for a head: the UTF-8 JSON of its three fields
 * in a fixed order, so signer and verifier always hash the same thing.
 *
 * @param head - The head.
 * @returns The bytes to sign or verify.
 */
export function headBytes(head: BaselineHead): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      stream: head.stream,
      seq: head.seq,
      eventCid: head.eventCid,
    }),
  );
}

/**
 * Sign a head with the server's key.
 *
 * @param keypair - The server's secp256k1 key.
 * @param head - The head to sign.
 * @returns The head with its signature.
 */
export async function signHead(
  keypair: Secp256k1Keypair,
  head: BaselineHead,
): Promise<SignedHead> {
  const sig = await keypair.sign(headBytes(head));
  return { head, sig: Buffer.from(sig).toString("base64") };
}

/**
 * Check a signed head against the key the consumer was configured with.
 *
 * @param publicKey - The server's public key as a `did:key`.
 * @param signed - The head and signature from the server.
 * @returns `true` if the key signed exactly this head.
 */
export async function verifyHead(
  publicKey: string,
  signed: SignedHead,
): Promise<boolean> {
  try {
    return await verifySignature(
      publicKey,
      headBytes(signed.head),
      new Uint8Array(Buffer.from(signed.sig, "base64")),
    );
  } catch {
    // A malformed key or signature is a failed check, not a crash.
    return false;
  }
}

/**
 * Validate the shape of a signed head read off the network. This does not
 * check the signature; use `verifyHead` for that.
 *
 * @param value - The parsed response body.
 * @returns The same value, typed.
 * @throws TypeError if a field is missing or has the wrong type.
 */
export function parseSignedHead(value: unknown): SignedHead {
  const body = value as Partial<SignedHead> | null;
  const head = body?.head as Partial<BaselineHead> | undefined;
  if (
    typeof body !== "object" ||
    body === null ||
    typeof head !== "object" ||
    head === null ||
    typeof head.stream !== "string" ||
    !isStreamName(head.stream) ||
    typeof head.seq !== "number" ||
    !isSeq(head.seq) ||
    typeof head.eventCid !== "string" ||
    typeof body.sig !== "string"
  ) {
    throw new TypeError("invalid signed head");
  }
  return {
    head: { stream: head.stream, seq: head.seq, eventCid: head.eventCid },
    sig: body.sig,
  };
}

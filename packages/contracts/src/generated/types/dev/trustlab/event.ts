/**
 * GENERATED CODE - DO NOT MODIFY
 */
import { type ValidationResult, BlobRef } from '@atproto/lexicon'
import { CID } from 'multiformats/cid'
import { validate as _validate } from '../../../lexicons.js'
import {
  type $Typed,
  is$typed as _is$typed,
  type OmitKey,
} from '../../../util.js'

const is$typed = _is$typed,
  validate = _validate
const id = 'dev.trustlab.event'

export interface Main {
  $type: 'dev.trustlab.event'
  /** Stream name: a lowercase letter, then lowercase letters and digits. */
  stream: string
  /** Position in the stream. The first event is 1, and each event is one more than the last. */
  seq: number
  /** CID of the event record at seq - 1. Required for every event after the first, and absent on the first. */
  prevEventCid?: string
  /** What the event does. A correction or withdrawal is a new event that points at an earlier one; published events are never edited or deleted. */
  kind: 'release' | 'correct' | 'withdraw' | (string & {})
  /** For kind correct or withdraw: the seq of the earlier event this one corrects or withdraws. */
  refSeq?: number
  payload: Payload
  createdAt: string
  [k: string]: unknown
}

const hashMain = 'main'

export function isMain<V>(v: V) {
  return is$typed(v, id, hashMain)
}

export function validateMain<V>(v: V) {
  return validate<Main & V>(v, id, hashMain, true)
}

export {
  type Main as Record,
  isMain as isRecord,
  validateMain as validateRecord,
}

/** A synthetic software release. */
export interface Payload {
  $type?: 'dev.trustlab.event#payload'
  name: string
  version: string
  checksum: string
}

const hashPayload = 'payload'

export function isPayload<V>(v: V) {
  return is$typed(v, id, hashPayload)
}

export function validatePayload<V>(v: V) {
  return validate<Payload & V>(v, id, hashPayload)
}

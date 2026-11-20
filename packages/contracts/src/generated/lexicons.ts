/**
 * GENERATED CODE - DO NOT MODIFY
 */
import {
  type LexiconDoc,
  Lexicons,
  ValidationError,
  type ValidationResult,
} from '@atproto/lexicon'
import { type $Typed, is$typed, maybe$typed } from './util.js'

export const schemaDict = {
  DevTrustlabEvent: {
    lexicon: 1,
    id: 'dev.trustlab.event',
    defs: {
      main: {
        type: 'record',
        description:
          "One event in a publisher's stream. Events in a stream form a chain: each one after the first names the CID of the one before it. Record key: <stream>-<12-digit seq>, such as releases-000000000042.",
        key: 'any',
        record: {
          type: 'object',
          required: ['stream', 'seq', 'kind', 'payload', 'createdAt'],
          properties: {
            stream: {
              type: 'string',
              description:
                'Stream name: a lowercase letter, then lowercase letters and digits.',
              minLength: 1,
              maxLength: 32,
            },
            seq: {
              type: 'integer',
              description:
                'Position in the stream. The first event is 1, and each event is one more than the last.',
              minimum: 1,
            },
            prevEventCid: {
              type: 'string',
              format: 'cid',
              description:
                'CID of the event record at seq - 1. Required for every event after the first, and absent on the first.',
            },
            kind: {
              type: 'string',
              description:
                'What the event does. A correction or withdrawal is a new event that points at an earlier one; published events are never edited or deleted.',
              knownValues: ['release', 'correct', 'withdraw'],
            },
            refSeq: {
              type: 'integer',
              description:
                'For kind correct or withdraw: the seq of the earlier event this one corrects or withdraws.',
              minimum: 1,
            },
            payload: {
              type: 'ref',
              ref: 'lex:dev.trustlab.event#payload',
            },
            createdAt: {
              type: 'string',
              format: 'datetime',
            },
          },
        },
      },
      payload: {
        type: 'object',
        description: 'A synthetic software release.',
        required: ['name', 'version', 'checksum'],
        properties: {
          name: {
            type: 'string',
            maxLength: 256,
          },
          version: {
            type: 'string',
            maxLength: 64,
          },
          checksum: {
            type: 'string',
            maxLength: 256,
          },
        },
      },
    },
  },
  DevTrustlabHead: {
    lexicon: 1,
    id: 'dev.trustlab.head',
    defs: {
      main: {
        type: 'record',
        description:
          "The latest event in one of a publisher's streams. Updated every time an event is published. Record key: head-<stream>, such as head-releases.",
        key: 'any',
        record: {
          type: 'object',
          required: ['stream', 'seq', 'eventCid'],
          properties: {
            stream: {
              type: 'string',
              minLength: 1,
              maxLength: 32,
            },
            seq: {
              type: 'integer',
              description: 'The seq of the latest event.',
              minimum: 1,
            },
            eventCid: {
              type: 'string',
              format: 'cid',
              description: 'CID of the event record at that seq.',
            },
          },
        },
      },
    },
  },
} as const satisfies Record<string, LexiconDoc>
export const schemas = Object.values(schemaDict) satisfies LexiconDoc[]
export const lexicons: Lexicons = new Lexicons(schemas)

export function validate<T extends { $type: string }>(
  v: unknown,
  id: string,
  hash: string,
  requiredType: true,
): ValidationResult<T>
export function validate<T extends { $type?: string }>(
  v: unknown,
  id: string,
  hash: string,
  requiredType?: false,
): ValidationResult<T>
export function validate(
  v: unknown,
  id: string,
  hash: string,
  requiredType?: boolean,
): ValidationResult {
  return (requiredType ? is$typed : maybe$typed)(v, id, hash)
    ? lexicons.validate(`${id}#${hash}`, v)
    : {
        success: false,
        error: new ValidationError(
          `Must be an object with "${hash === 'main' ? id : `${id}#${hash}`}" $type property`,
        ),
      }
}

export const ids = {
  DevTrustlabEvent: 'dev.trustlab.event',
  DevTrustlabHead: 'dev.trustlab.head',
} as const

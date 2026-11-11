# @trustlab/lexicons

AT Protocol Lexicon definitions for event and stream-head records.

- **Team:** Pipeline
- **System:** Publisher (PUB)

## The records

| Lexicon                                         | Record key                                                 | What it is                               |
| ----------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------- |
| [`dev.trustlab.event`](dev/trustlab/event.json) | `<stream>-<12-digit seq>`, such as `releases-000000000042` | One event in a stream                    |
| [`dev.trustlab.head`](dev/trustlab/head.json)   | `head-<stream>`, such as `head-releases`                   | The latest seq and event CID of a stream |

An example event at seq 2:

```json
{
  "$type": "dev.trustlab.event",
  "stream": "releases",
  "seq": 2,
  "prevEventCid": "bafyreidfayvfuwqa7qlnopdjiqrxzs6blmoeu4rujcjtnci5beludirz2a",
  "kind": "release",
  "payload": {
    "name": "left-pad",
    "version": "1.0.1",
    "checksum": "sha256:9f86d0..."
  },
  "createdAt": "2026-11-11T18:00:00.000Z"
}
```

## Rules a Lexicon can't express

Lexicon checks each field's type. These rules span fields, so `@trustlab/contracts` checks them when a record is read:

- `stream` is a lowercase letter followed by lowercase letters and digits, so the record key splits back into stream and seq.
- The event at seq 1 has no `prevEventCid`. Every later event has one, and it is the CID of the event record at `seq - 1`.
- `kind` `correct` and `withdraw` need a `refSeq` lower than `seq`. `release` has none.
- The record key matches the record's `stream` and `seq`.

`prevEventCid` and `eventCid` are record CIDs: the CID the PDS reports when it writes the record, and the one the firehose and `getRepo` carry.

The namespace `dev.trustlab` stands for the domain `trustlab.dev`, which this team does not own. That is fine on a local network and would have to change before publishing to the public one. ADR-004 records the decision.

## Changing a Lexicon

A change here changes the contract for every team. It needs a review from each team that reads these records, and after the Sprint 2 contract freeze it also needs its own issue.

// The hand-written record types in types.ts are what every team codes
// against. These checks fail `npm run typecheck` if they drift from the types
// `npm run codegen` generates from lexicons/, so a Lexicon change can't land
// without the matching change here. The tests run at compile time; the
// runtime assertions are only there so Vitest sees a test.
import { describe, expect, expectTypeOf, test } from "vitest";
import { schemaDict } from "./generated/lexicons.js";
import type * as LexEvent from "./generated/types/dev/trustlab/event.js";
import type * as LexHead from "./generated/types/dev/trustlab/head.js";
import { EVENT_NSID, HEAD_NSID } from "./keys.js";
import {
  EVENT_KINDS,
  type EventKind,
  type EventRecord,
  type HeadRecord,
  type Payload,
} from "./types.js";

/** A generated record's named fields, without its `[k: string]: unknown`. */
type Fields<T> = {
  [K in keyof T as string extends K ? never : K]: T[K];
};

/** The literal members of a `knownValues` string, without `string & {}`. */
type KnownValues<T> = T extends string ? (string extends T ? never : T) : never;

describe("hand-written types match the generated ones", () => {
  test("EventRecord", () => {
    expectTypeOf<Omit<EventRecord, "kind" | "payload">>().toEqualTypeOf<
      Omit<Fields<LexEvent.Record>, "kind" | "payload">
    >();
    // The Lexicon's kind is an open string (`knownValues`); ours is closed.
    expectTypeOf<EventKind>().toEqualTypeOf<
      KnownValues<LexEvent.Record["kind"]>
    >();
    expectTypeOf<Payload>().toEqualTypeOf<Omit<LexEvent.Payload, "$type">>();
    expect(schemaDict.DevTrustlabEvent.id).toBe(EVENT_NSID);
  });

  test("HeadRecord", () => {
    expectTypeOf<HeadRecord>().toEqualTypeOf<Fields<LexHead.Record>>();
    expect(schemaDict.DevTrustlabHead.id).toBe(HEAD_NSID);
  });

  test("EVENT_KINDS lists the Lexicon's known kinds", () => {
    const known =
      schemaDict.DevTrustlabEvent.defs.main.record.properties.kind.knownValues;
    expect([...EVENT_KINDS].sort()).toEqual([...known].sort());
  });
});

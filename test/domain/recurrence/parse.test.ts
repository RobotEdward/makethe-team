import { describe, expect, it } from "vitest";
import {
  formatRecurrenceRule,
  parseRecurrenceRule,
  RecurrenceError,
} from "../../../src/domain/recurrence/parse.js";

describe("parseRecurrenceRule — accepted", () => {
  it("parses a weekly rule", () => {
    expect(parseRecurrenceRule("FREQ=WEEKLY;INTERVAL=1;BYDAY=TH")).toEqual({
      freq: "WEEKLY",
      interval: 1,
      byday: "TH",
    });
  });

  it("parses a fortnightly rule", () => {
    expect(parseRecurrenceRule("FREQ=WEEKLY;INTERVAL=2;BYDAY=SU")).toEqual({
      freq: "WEEKLY",
      interval: 2,
      byday: "SU",
    });
  });

  it("defaults INTERVAL to 1 when omitted", () => {
    expect(parseRecurrenceRule("FREQ=WEEKLY;BYDAY=MO").interval).toBe(1);
  });

  it("accepts keys in any order", () => {
    expect(parseRecurrenceRule("BYDAY=WE;FREQ=WEEKLY").byday).toBe("WE");
  });
});

describe("parseRecurrenceRule — rejected", () => {
  const rejected: Array<[string, string]> = [
    ["FREQ=DAILY;BYDAY=TH", "an unsupported frequency"],
    ["FREQ=MONTHLY;BYDAY=TH", "monthly"],
    ["BYDAY=TH", "a missing FREQ"],
    ["FREQ=WEEKLY", "a missing BYDAY"],
    ["FREQ=WEEKLY;BYDAY=TH,SA", "more than one weekday"],
    ["FREQ=WEEKLY;BYDAY=XX", "a nonsense weekday"],
    ["FREQ=WEEKLY;BYDAY=2TH", "an ordinal weekday"],
    ["FREQ=WEEKLY;INTERVAL=0;BYDAY=TH", "a zero interval"],
    ["FREQ=WEEKLY;INTERVAL=-1;BYDAY=TH", "a negative interval"],
    ["FREQ=WEEKLY;INTERVAL=1.5;BYDAY=TH", "a fractional interval"],
    ["FREQ=WEEKLY;INTERVAL=99;BYDAY=TH", "an absurd interval"],
    ["FREQ=WEEKLY;COUNT=10;BYDAY=TH", "COUNT"],
    ["FREQ=WEEKLY;UNTIL=20261231T000000Z;BYDAY=TH", "UNTIL"],
    ["FREQ=WEEKLY;BYSETPOS=1;BYDAY=TH", "BYSETPOS"],
    ["FREQ=WEEKLY;FREQ=WEEKLY;BYDAY=TH", "a duplicate key"],
    ["", "an empty string"],
    ["  FREQ=WEEKLY;BYDAY=TH", "leading whitespace"],
    ["FREQ", "a segment with no value"],
    ["=WEEKLY;BYDAY=TH", "a segment with no key"],
    ["RRULE:FREQ=WEEKLY;BYDAY=TH", "an RRULE: prefix"],
  ];

  it.each(rejected)("rejects %s (%s)", (input) => {
    expect(() => parseRecurrenceRule(input)).toThrow(RecurrenceError);
  });

  it("names the offending key in the message", () => {
    expect(() => parseRecurrenceRule("FREQ=WEEKLY;COUNT=10;BYDAY=TH")).toThrow(/COUNT/);
  });
});

describe("parseRecurrenceRule — non-string input", () => {
  // The signature promises `string`, but untyped boundaries such as a value read
  // back from D1 can hand us anything at runtime. The `as unknown as string` casts
  // below exist only to get past the compiler for this test.
  it.each([null, undefined, 123])("rejects %s with RecurrenceError, not a raw TypeError", (input) => {
    expect(() => parseRecurrenceRule(input as unknown as string)).toThrow(RecurrenceError);
  });
});

describe("formatRecurrenceRule", () => {
  it("round trips", () => {
    const input = "FREQ=WEEKLY;INTERVAL=2;BYDAY=SU";
    expect(formatRecurrenceRule(parseRecurrenceRule(input))).toBe(input);
  });

  it("always writes an explicit INTERVAL", () => {
    expect(formatRecurrenceRule(parseRecurrenceRule("FREQ=WEEKLY;BYDAY=MO"))).toBe(
      "FREQ=WEEKLY;INTERVAL=1;BYDAY=MO",
    );
  });
});

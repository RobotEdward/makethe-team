import { describe, expect, it } from "vitest";
import { expandWeekly } from "../../../src/domain/recurrence/expand.js";
import { parseRecurrenceRule } from "../../../src/domain/recurrence/parse.js";
import { toLocalParts } from "../../../src/domain/time/zone.js";

const LONDON = "Europe/London";
const KICKOFF = { hour: 19, minute: 0 };

function isoList(dates: Date[]): string[] {
  return dates.map((d) => d.toISOString());
}

describe("expandWeekly — weekly", () => {
  it("emits every Thursday in the window", () => {
    const result = expandWeekly(
      parseRecurrenceRule("FREQ=WEEKLY;INTERVAL=1;BYDAY=TH"),
      { year: 2026, month: 8, day: 13 },
      KICKOFF,
      LONDON,
      new Date("2026-08-01T00:00:00Z"),
      new Date("2026-09-01T00:00:00Z"),
    );

    expect(isoList(result)).toEqual([
      "2026-08-13T18:00:00.000Z",
      "2026-08-20T18:00:00.000Z",
      "2026-08-27T18:00:00.000Z",
    ]);
  });

  it("skips forward to the first BYDAY on or after the start date", () => {
    // 2026-08-10 is a Monday; the first Thursday on or after it is the 13th.
    const result = expandWeekly(
      parseRecurrenceRule("FREQ=WEEKLY;BYDAY=TH"),
      { year: 2026, month: 8, day: 10 },
      KICKOFF,
      LONDON,
      new Date("2026-08-01T00:00:00Z"),
      new Date("2026-08-20T00:00:00Z"),
    );

    expect(isoList(result)).toEqual(["2026-08-13T18:00:00.000Z"]);
  });

  it("emits nothing before the start date", () => {
    const result = expandWeekly(
      parseRecurrenceRule("FREQ=WEEKLY;BYDAY=TH"),
      { year: 2026, month: 9, day: 1 },
      KICKOFF,
      LONDON,
      new Date("2026-08-01T00:00:00Z"),
      new Date("2026-08-31T00:00:00Z"),
    );

    expect(result).toEqual([]);
  });
});

describe("expandWeekly — fortnightly", () => {
  it("anchors the interval to the start date", () => {
    const result = expandWeekly(
      parseRecurrenceRule("FREQ=WEEKLY;INTERVAL=2;BYDAY=TH"),
      { year: 2026, month: 8, day: 13 },
      KICKOFF,
      LONDON,
      new Date("2026-08-01T00:00:00Z"),
      new Date("2026-09-30T00:00:00Z"),
    );

    expect(isoList(result)).toEqual([
      "2026-08-13T18:00:00.000Z",
      "2026-08-27T18:00:00.000Z",
      "2026-09-10T18:00:00.000Z",
      "2026-09-24T18:00:00.000Z",
    ]);
  });

  it("shifts by a week when the anchor shifts by a week", () => {
    const result = expandWeekly(
      parseRecurrenceRule("FREQ=WEEKLY;INTERVAL=2;BYDAY=TH"),
      { year: 2026, month: 8, day: 20 },
      KICKOFF,
      LONDON,
      new Date("2026-08-01T00:00:00Z"),
      new Date("2026-09-30T00:00:00Z"),
    );

    expect(isoList(result)).toEqual([
      "2026-08-20T18:00:00.000Z",
      "2026-09-03T18:00:00.000Z",
      "2026-09-17T18:00:00.000Z",
    ]);
  });
});

describe("expandWeekly — DST", () => {
  it("holds the local kickoff time across the BST to GMT transition", () => {
    // BST ends Sunday 25 October 2026. A 19:00 local kickoff is 18:00Z before
    // and 19:00Z after. Getting this wrong moves kickoff by an hour.
    const result = expandWeekly(
      parseRecurrenceRule("FREQ=WEEKLY;BYDAY=TH"),
      { year: 2026, month: 10, day: 15 },
      KICKOFF,
      LONDON,
      new Date("2026-10-14T00:00:00Z"),
      new Date("2026-11-06T00:00:00Z"),
    );

    expect(isoList(result)).toEqual([
      "2026-10-15T18:00:00.000Z", // BST
      "2026-10-22T18:00:00.000Z", // BST
      "2026-10-29T19:00:00.000Z", // GMT
      "2026-11-05T19:00:00.000Z", // GMT
    ]);
  });

  it("holds the local kickoff time across the GMT to BST transition", () => {
    // BST begins Sunday 29 March 2026.
    const result = expandWeekly(
      parseRecurrenceRule("FREQ=WEEKLY;BYDAY=TH"),
      { year: 2026, month: 3, day: 19 },
      KICKOFF,
      LONDON,
      new Date("2026-03-18T00:00:00Z"),
      new Date("2026-04-10T00:00:00Z"),
    );

    expect(isoList(result)).toEqual([
      "2026-03-19T19:00:00.000Z", // GMT
      "2026-03-26T19:00:00.000Z", // GMT
      "2026-04-02T18:00:00.000Z", // BST
      "2026-04-09T18:00:00.000Z", // BST
    ]);
  });
});

describe("expandWeekly — zones that are not Europe/London", () => {
  // Every other test in this file runs at 19:00 in Europe/London, which is one
  // northern-hemisphere zone with whole-hour offsets. These cases cover the
  // shapes that behave differently: transitions running the opposite way round
  // the year, a half-hour offset, and a zone that never transitions at all.

  function thursdaysAt19(timeZone: string, start: [number, number, number], from: string, to: string): Date[] {
    return expandWeekly(
      parseRecurrenceRule("FREQ=WEEKLY;BYDAY=TH"),
      { year: start[0], month: start[1], day: start[2] },
      KICKOFF,
      timeZone,
      new Date(from),
      new Date(to),
    );
  }

  function localClocks(dates: Date[], timeZone: string): string[] {
    return dates.map((d) => {
      const parts = toLocalParts(d, timeZone);
      return `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
    });
  }

  it("holds 19:00 local across Australia/Sydney leaving DST (southern autumn)", () => {
    // Sydney runs the opposite way to London: DST *ends* on 5 April 2026,
    // AEDT (UTC+11) becoming AEST (UTC+10), so the UTC instant moves later.
    const sydney = "Australia/Sydney";
    const result = thursdaysAt19(sydney, [2026, 4, 2], "2026-04-01T00:00:00Z", "2026-04-17T00:00:00Z");

    expect(isoList(result)).toEqual([
      "2026-04-02T08:00:00.000Z", // AEDT, UTC+11
      "2026-04-09T09:00:00.000Z", // AEST, UTC+10
      "2026-04-16T09:00:00.000Z", // AEST
    ]);
    expect(localClocks(result, sydney)).toEqual(["19:00", "19:00", "19:00"]);
  });

  it("holds 19:00 local across Australia/Sydney entering DST (southern spring)", () => {
    // DST begins on 4 October 2026, AEST becoming AEDT.
    const sydney = "Australia/Sydney";
    const result = thursdaysAt19(sydney, [2026, 9, 24], "2026-09-23T00:00:00Z", "2026-10-16T00:00:00Z");

    expect(isoList(result)).toEqual([
      "2026-09-24T09:00:00.000Z", // AEST, UTC+10
      "2026-10-01T09:00:00.000Z", // AEST
      "2026-10-08T08:00:00.000Z", // AEDT, UTC+11
      "2026-10-15T08:00:00.000Z", // AEDT
    ]);
    expect(localClocks(result, sydney)).toEqual(["19:00", "19:00", "19:00", "19:00"]);
  });

  it("holds 19:00 local in a half-hour-offset zone", () => {
    // Asia/Kolkata is UTC+05:30 all year. A whole-hour assumption anywhere in
    // the conversion would land these on the hour.
    const kolkata = "Asia/Kolkata";
    const result = thursdaysAt19(kolkata, [2026, 3, 26], "2026-03-25T00:00:00Z", "2026-04-03T00:00:00Z");

    expect(isoList(result)).toEqual([
      "2026-03-26T13:30:00.000Z",
      "2026-04-02T13:30:00.000Z",
    ]);
    expect(localClocks(result, kolkata)).toEqual(["19:00", "19:00"]);
  });

  it("holds 19:00 local in a zone with no DST at all, over a northern transition", () => {
    // Asia/Tokyo is UTC+09 permanently. These dates straddle the weekend on
    // which Europe and North America change their clocks; Tokyo must not move.
    const tokyo = "Asia/Tokyo";
    const result = thursdaysAt19(tokyo, [2026, 10, 22], "2026-10-21T00:00:00Z", "2026-11-06T00:00:00Z");

    expect(isoList(result)).toEqual([
      "2026-10-22T10:00:00.000Z",
      "2026-10-29T10:00:00.000Z",
      "2026-11-05T10:00:00.000Z",
    ]);
    expect(localClocks(result, tokyo)).toEqual(["19:00", "19:00", "19:00"]);
  });
});

describe("expandWeekly — window edges", () => {
  it("includes an occurrence exactly on the from bound", () => {
    const result = expandWeekly(
      parseRecurrenceRule("FREQ=WEEKLY;BYDAY=TH"),
      { year: 2026, month: 8, day: 13 },
      KICKOFF,
      LONDON,
      new Date("2026-08-13T18:00:00Z"),
      new Date("2026-08-14T00:00:00Z"),
    );

    expect(isoList(result)).toEqual(["2026-08-13T18:00:00.000Z"]);
  });

  it("includes an occurrence exactly on the to bound", () => {
    const result = expandWeekly(
      parseRecurrenceRule("FREQ=WEEKLY;BYDAY=TH"),
      { year: 2026, month: 8, day: 13 },
      KICKOFF,
      LONDON,
      new Date("2026-08-01T00:00:00Z"),
      new Date("2026-08-13T18:00:00Z"),
    );

    expect(isoList(result)).toEqual(["2026-08-13T18:00:00.000Z"]);
  });

  it("returns nothing for an inverted window", () => {
    const result = expandWeekly(
      parseRecurrenceRule("FREQ=WEEKLY;BYDAY=TH"),
      { year: 2026, month: 8, day: 13 },
      KICKOFF,
      LONDON,
      new Date("2026-09-01T00:00:00Z"),
      new Date("2026-08-01T00:00:00Z"),
    );

    expect(result).toEqual([]);
  });

  it("stays cheap for a game that started years ago", () => {
    const result = expandWeekly(
      parseRecurrenceRule("FREQ=WEEKLY;BYDAY=TH"),
      { year: 2015, month: 1, day: 1 },
      KICKOFF,
      LONDON,
      new Date("2026-08-01T00:00:00Z"),
      new Date("2026-08-31T00:00:00Z"),
    );

    expect(result).toHaveLength(4);
  });
});

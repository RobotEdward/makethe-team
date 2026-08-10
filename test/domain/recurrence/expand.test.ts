import { describe, expect, it } from "vitest";
import { expandWeekly } from "../../../src/domain/recurrence/expand.js";
import { parseRecurrenceRule } from "../../../src/domain/recurrence/parse.js";

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

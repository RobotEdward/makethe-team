import { describe, expect, it } from "vitest";
import { localWeekday, toLocalParts, toUtc } from "../../../src/domain/time/zone.js";

const LONDON = "Europe/London";

function iso(date: Date): string {
  return date.toISOString();
}

describe("toUtc — Europe/London", () => {
  it("converts a BST wall time (UTC+1)", () => {
    const result = toUtc({ year: 2026, month: 8, day: 13, hour: 19, minute: 0, second: 0 }, LONDON);
    expect(iso(result)).toBe("2026-08-13T18:00:00.000Z");
  });

  it("converts a GMT wall time (UTC+0)", () => {
    const result = toUtc({ year: 2026, month: 1, day: 15, hour: 19, minute: 0, second: 0 }, LONDON);
    expect(iso(result)).toBe("2026-01-15T19:00:00.000Z");
  });

  it("keeps 09:00 local at 09:00 on both sides of the autumn transition", () => {
    const bst = toUtc({ year: 2026, month: 10, day: 21, hour: 9, minute: 0, second: 0 }, LONDON);
    const gmt = toUtc({ year: 2026, month: 10, day: 28, hour: 9, minute: 0, second: 0 }, LONDON);

    expect(iso(bst)).toBe("2026-10-21T08:00:00.000Z");
    expect(iso(gmt)).toBe("2026-10-28T09:00:00.000Z");
  });
});

describe("toUtc — DST edges", () => {
  it("resolves an ambiguous autumn time to the earlier instant", () => {
    // 2026-10-25 01:30 happens twice: 00:30Z (BST) and 01:30Z (GMT).
    const result = toUtc({ year: 2026, month: 10, day: 25, hour: 1, minute: 30, second: 0 }, LONDON);
    expect(iso(result)).toBe("2026-10-25T00:30:00.000Z");
  });

  it("shifts a non-existent spring time forward by the gap", () => {
    // 2026-03-29 01:30 does not exist; clocks jump 01:00 GMT to 02:00 BST.
    const result = toUtc({ year: 2026, month: 3, day: 29, hour: 1, minute: 30, second: 0 }, LONDON);
    expect(iso(result)).toBe("2026-03-29T01:30:00.000Z");
    expect(toLocalParts(result, LONDON).hour).toBe(2);
    expect(toLocalParts(result, LONDON).minute).toBe(30);
  });
});

describe("toUtc — other zones", () => {
  it("handles a negative offset", () => {
    const result = toUtc({ year: 2026, month: 8, day: 13, hour: 19, minute: 0, second: 0 }, "America/New_York");
    expect(iso(result)).toBe("2026-08-13T23:00:00.000Z");
  });

  it("handles a half-hour offset", () => {
    const result = toUtc({ year: 2026, month: 8, day: 13, hour: 19, minute: 0, second: 0 }, "Asia/Kolkata");
    expect(iso(result)).toBe("2026-08-13T13:30:00.000Z");
  });

  it("handles a zone with no DST", () => {
    const summer = toUtc({ year: 2026, month: 7, day: 1, hour: 12, minute: 0, second: 0 }, "UTC");
    expect(iso(summer)).toBe("2026-07-01T12:00:00.000Z");
  });
});

describe("toLocalParts", () => {
  it("renders an instant in the target zone", () => {
    const parts = toLocalParts(new Date("2026-08-13T18:00:00Z"), LONDON);
    expect(parts).toEqual({ year: 2026, month: 8, day: 13, hour: 19, minute: 0, second: 0 });
  });

  it("uses a 24-hour clock with midnight as hour 0", () => {
    const parts = toLocalParts(new Date("2026-01-15T00:30:00Z"), LONDON);
    expect(parts.hour).toBe(0);
  });
});

describe("round trip", () => {
  const cases: Array<[string, number, number, number, number]> = [
    [LONDON, 2026, 8, 13, 19],
    [LONDON, 2026, 1, 15, 19],
    [LONDON, 2026, 12, 25, 11],
    ["America/New_York", 2026, 11, 5, 20],
    ["Asia/Kolkata", 2026, 4, 2, 7],
    ["Australia/Sydney", 2026, 6, 18, 18],
  ];

  it.each(cases)("%s %s-%s-%s %s:00 survives a round trip", (tz, year, month, day, hour) => {
    const instant = toUtc({ year, month, day, hour, minute: 0, second: 0 }, tz);
    expect(toLocalParts(instant, tz)).toEqual({ year, month, day, hour, minute: 0, second: 0 });
  });
});

describe("localWeekday", () => {
  it("reports the weekday in the target zone, not UTC", () => {
    // 2026-08-14T00:30Z is Thursday 13 August at 20:30 in New York.
    const instant = new Date("2026-08-14T00:30:00Z");
    expect(localWeekday(instant, "UTC")).toBe(5); // Friday
    expect(localWeekday(instant, "America/New_York")).toBe(4); // Thursday
  });
});

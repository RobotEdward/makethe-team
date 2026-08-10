import { describe, expect, it } from "vitest";
import { LocalTimeError } from "../../../src/domain/time/local.js";
import { formatterCacheSize, localWeekday, toLocalParts, toUtc } from "../../../src/domain/time/zone.js";

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

describe("formatter cache canonicalisation", () => {
  it("shares one cache entry across case-permuted spellings of the same zone", () => {
    // A zone not referenced elsewhere in this file, so the cache-growth assertion
    // below isn't sensitive to test execution order.
    const spellings = ["Europe/Madrid", "europe/madrid", "EUROPE/MADRID", "eUrOpE/mAdRiD"];
    const instant = new Date("2026-08-13T18:00:00Z");

    const before = formatterCacheSize();
    const results = spellings.map((tz) => toLocalParts(instant, tz));
    const after = formatterCacheSize();

    for (const parts of results) {
      expect(parts).toEqual({ year: 2026, month: 8, day: 13, hour: 20, minute: 0, second: 0 });
    }

    // Every case permutation resolves to the same canonical zone, so the cache
    // should grow by exactly one entry no matter how many spellings were looked up.
    expect(after).toBe(before + 1);
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

describe("invalid time zones", () => {
  const instant = new Date("2026-08-13T18:00:00Z");
  const localParts = { year: 2026, month: 8, day: 13, hour: 19, minute: 0, second: 0 };

  it.each(["Not/A_Zone", ""])("toUtc throws LocalTimeError for %j", (zone) => {
    expect(() => toUtc(localParts, zone)).toThrow(LocalTimeError);
  });

  it.each(["Not/A_Zone", ""])("toLocalParts throws LocalTimeError for %j", (zone) => {
    expect(() => toLocalParts(instant, zone)).toThrow(LocalTimeError);
  });

  it.each([
    ["a plausible but non-existent city", "Europe/Camelot"],
    ["a country name rather than a zone", "France"],
    ["an over-qualified zone path", "Europe/London/Islington"],
    ["whitespace", "  "],
  ])("rejects %s as a time zone", (_description, zone) => {
    // This is the path a user reaches the moment a timezone field appears on a
    // form, so the error has to be the typed domain one, not a raw RangeError.
    expect(() => toLocalParts(instant, zone)).toThrow(LocalTimeError);
    expect(() => toLocalParts(instant, zone)).toThrow(/not a valid IANA time zone/);
  });

  it("does not grow the formatter cache on a failed lookup", () => {
    const before = formatterCacheSize();
    expect(() => toLocalParts(instant, "Not/A_Zone")).toThrow(LocalTimeError);
    expect(() => toUtc(localParts, "")).toThrow(LocalTimeError);
    expect(formatterCacheSize()).toBe(before);
  });
});

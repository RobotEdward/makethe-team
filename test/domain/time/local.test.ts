import { describe, expect, it } from "vitest";
import {
  addDays,
  formatLocalDate,
  LocalTimeError,
  parseLocalDate,
  parseLocalTime,
} from "../../../src/domain/time/local.js";

describe("parseLocalDate", () => {
  it("parses an ISO date", () => {
    expect(parseLocalDate("2026-08-13")).toEqual({ year: 2026, month: 8, day: 13 });
  });

  it.each(["2026-8-13", "13/08/2026", "2026-08-13T19:00", "", "not-a-date", "2026-13-01", "2026-02-30"])(
    "rejects %s",
    (input) => {
      expect(() => parseLocalDate(input)).toThrow(LocalTimeError);
    },
  );
});

describe("parseLocalTime", () => {
  it("parses a 24-hour time", () => {
    expect(parseLocalTime("09:00")).toEqual({ hour: 9, minute: 0 });
    expect(parseLocalTime("19:30")).toEqual({ hour: 19, minute: 30 });
  });

  it.each(["9:00", "19:60", "24:00", "7pm", "", "19:00:00"])("rejects %s", (input) => {
    expect(() => parseLocalTime(input)).toThrow(LocalTimeError);
  });
});

describe("addDays", () => {
  it("crosses a month boundary", () => {
    expect(addDays({ year: 2026, month: 8, day: 31 }, 1)).toEqual({ year: 2026, month: 9, day: 1 });
  });

  it("goes backwards across a year boundary", () => {
    expect(addDays({ year: 2026, month: 1, day: 1 }, -1)).toEqual({ year: 2025, month: 12, day: 31 });
  });

  it("handles a leap day", () => {
    expect(addDays({ year: 2028, month: 2, day: 28 }, 1)).toEqual({ year: 2028, month: 2, day: 29 });
  });
});

describe("formatLocalDate", () => {
  it("zero-pads", () => {
    expect(formatLocalDate({ year: 2026, month: 3, day: 7 })).toBe("2026-03-07");
  });
});

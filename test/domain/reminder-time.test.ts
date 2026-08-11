import { describe, expect, it } from "vitest";
import { reminderInstant } from "../../src/domain/reminder-time.js";

const DEFAULT_GAME = {
  timezone: "Europe/London",
  reminderDaysBefore: 1,
  reminderLocalTime: "09:00",
};

describe("reminderInstant", () => {
  it("reminds at 09:00 BST the day before a 19:00 BST kickoff", () => {
    // Thursday 13 August 2026, 19:00 BST (18:00Z) kicks off.
    const kicksOffAt = new Date("2026-08-13T18:00:00Z");

    const instant = reminderInstant(DEFAULT_GAME, kicksOffAt);

    // Wednesday 12 August 2026, 09:00 BST = 08:00Z.
    expect(instant.toISOString()).toBe("2026-08-12T08:00:00.000Z");
  });

  it("reminds at 09:00 GMT the day before a 19:00 GMT kickoff", () => {
    // Thursday 14 January 2027, 19:00 GMT (19:00Z) kicks off.
    const kicksOffAt = new Date("2027-01-14T19:00:00Z");

    const instant = reminderInstant(DEFAULT_GAME, kicksOffAt);

    // Wednesday 13 January 2027, 09:00 GMT = 09:00Z.
    expect(instant.toISOString()).toBe("2027-01-13T09:00:00.000Z");
  });

  it("crosses the autumn DST boundary: reminds at 09:00 GMT for the fixture the clocks change before", () => {
    // Thursday 29 October 2026, 19:00 GMT (clocks went back on Sunday 25
    // October 2026, so this kickoff is 19:00Z).
    const kicksOffAt = new Date("2026-10-29T19:00:00Z");

    const instant = reminderInstant(DEFAULT_GAME, kicksOffAt);

    // Wednesday 28 October 2026, 09:00 GMT = 09:00Z.
    expect(instant.toISOString()).toBe("2026-10-28T09:00:00.000Z");
  });

  it("the previous week's fixture (still BST) reminds an hour earlier in UTC, same wall-clock time", () => {
    // Thursday 22 October 2026, 19:00 BST (18:00Z) — the week before the
    // clocks change.
    const kicksOffAt = new Date("2026-10-22T18:00:00Z");

    const instant = reminderInstant(DEFAULT_GAME, kicksOffAt);

    // Wednesday 21 October 2026, 09:00 BST = 08:00Z.
    expect(instant.toISOString()).toBe("2026-10-21T08:00:00.000Z");
  });

  it("honours a non-default reminder_days_before", () => {
    const kicksOffAt = new Date("2026-08-13T18:00:00Z");

    const instant = reminderInstant({ ...DEFAULT_GAME, reminderDaysBefore: 2 }, kicksOffAt);

    // Tuesday 11 August 2026, 09:00 BST = 08:00Z.
    expect(instant.toISOString()).toBe("2026-08-11T08:00:00.000Z");
  });

  it("honours a non-default reminder_local_time", () => {
    const kicksOffAt = new Date("2026-08-13T18:00:00Z");

    const instant = reminderInstant({ ...DEFAULT_GAME, reminderLocalTime: "18:30" }, kicksOffAt);

    // Wednesday 12 August 2026, 18:30 BST = 17:30Z.
    expect(instant.toISOString()).toBe("2026-08-12T17:30:00.000Z");
  });
});

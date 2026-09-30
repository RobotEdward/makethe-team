import { describe, expect, it } from "vitest";
import { planSchedule, representativeTimes } from "../../src/domain/invite-schedule.js";

const TZ = "Europe/London";
const WNF = {
  timezone: TZ,
  kickoffTime: "21:00",
  reminderDaysBefore: 1,
  reminderLocalTime: "09:00",
};
const { openAt, kicksOffAt } = representativeTimes(WNF, { year: 2026, month: 9, day: 30 });

const group = (name: string, askAfterHours: number | null, memberCount = 3) => ({
  name,
  askAfterHours,
  memberCount,
});

describe("representativeTimes", () => {
  it("opens the day before at the reminder time, in the game's zone", () => {
    expect(openAt).toEqual(new Date("2026-09-29T08:00:00Z"));
    expect(kicksOffAt).toEqual(new Date("2026-09-30T20:00:00Z"));
  });
});

describe("planSchedule", () => {
  it("lays the groups out end to end, pausing overnight", () => {
    const schedule = planSchedule({
      tiers: [group("Regulars", null), group("Standby 1", 12), group("Everyone else", 6)],
      openAt,
      kicksOffAt,
      timeZone: TZ,
    });

    expect(schedule.asks).toEqual([
      { kind: "opens", name: "Regulars", askAt: new Date("2026-09-29T08:00:00Z") },
      { kind: "timed", name: "Standby 1", askAt: new Date("2026-09-29T20:00:00Z"), pausedOvernight: false, late: false },
      { kind: "timed", name: "Everyone else", askAt: new Date("2026-09-30T09:00:00Z"), pausedOvernight: true, late: false },
    ]);
    expect(schedule.cutoff).toEqual(new Date("2026-09-30T17:00:00Z"));
    expect(schedule.problem).toBeNull();
  });

  it("ripples: a longer head start early on moves every later group", () => {
    const schedule = planSchedule({
      tiers: [group("Regulars", null), group("Standby 1", 20), group("Everyone else", 6)],
      openAt,
      kicksOffAt,
      timeZone: TZ,
    });

    // 09:00 + 20 waking hours = Wed 12:00; + 6 = Wed 18:00, right on the cut-off.
    expect(schedule.asks.map((ask) => ("askAt" in ask ? ask.askAt.toISOString() : ask.kind))).toEqual([
      "2026-09-29T08:00:00.000Z",
      "2026-09-30T11:00:00.000Z",
      "2026-09-30T17:00:00.000Z",
    ]);
    expect(schedule.problem).toBeNull();
  });

  it("names the first group asked too late, and the longest head start that fits", () => {
    const schedule = planSchedule({
      tiers: [group("Regulars", null), group("Standby 1", 20), group("Everyone else", 8)],
      openAt,
      kicksOffAt,
      timeZone: TZ,
    });

    expect(schedule.problem).toEqual({
      name: "Everyone else",
      askAt: new Date("2026-09-30T19:00:00Z"),
      longestThatFits: 6,
    });
  });

  it("leaves a when-needed final group out of the timing", () => {
    const schedule = planSchedule({
      tiers: [group("Regulars", null), group("Everyone else", null)],
      openAt,
      kicksOffAt,
      timeZone: TZ,
    });

    expect(schedule.asks[1]).toEqual({ kind: "when-needed", name: "Everyone else" });
    expect(schedule.problem).toBeNull();
  });

  it("skips a group with nobody in it without spending its head start", () => {
    const schedule = planSchedule({
      tiers: [group("Regulars", null), group("Empty", 30, 0), group("Everyone else", 12)],
      openAt,
      kicksOffAt,
      timeZone: TZ,
    });

    expect(schedule.asks[1]).toEqual({ kind: "empty", name: "Empty" });
    expect(schedule.asks[2]).toMatchObject({ askAt: new Date("2026-09-29T20:00:00Z") });
  });
});

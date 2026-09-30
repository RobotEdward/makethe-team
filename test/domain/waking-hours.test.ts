import { describe, expect, it } from "vitest";
import {
  addWakingHours,
  isWaking,
  latestAskAtOrBefore,
} from "../../src/domain/waking-hours.js";

const TZ = "Europe/London";
// 30 September 2026 is BST (UTC+1), so local = UTC + 1h.
const at = (iso: string): Date => new Date(iso);

describe("isWaking", () => {
  it("is waking from 06:00 up to but not including 23:00 local", () => {
    expect(isWaking(at("2026-09-30T05:00:00Z"), TZ)).toBe(true); // 06:00 BST
    expect(isWaking(at("2026-09-30T21:59:00Z"), TZ)).toBe(true); // 22:59 BST
    expect(isWaking(at("2026-09-30T22:00:00Z"), TZ)).toBe(false); // 23:00 BST
    expect(isWaking(at("2026-09-30T04:59:00Z"), TZ)).toBe(false); // 05:59 BST
  });
});

describe("addWakingHours", () => {
  it("adds straight through when the whole span is waking", () => {
    // 09:00 BST + 12h = 21:00 BST.
    expect(addWakingHours(at("2026-09-29T08:00:00Z"), 12, TZ)).toEqual(at("2026-09-29T20:00:00Z"));
  });

  it("pauses overnight: 21:00 plus six waking hours is 10:00 next day", () => {
    // 21:00→23:00 is two hours, 06:00→10:00 is the other four.
    expect(addWakingHours(at("2026-09-29T20:00:00Z"), 6, TZ)).toEqual(at("2026-09-30T09:00:00Z"));
  });

  it("starts the clock at 06:00 when started during the night", () => {
    // 02:00 BST + 2h = 08:00 BST.
    expect(addWakingHours(at("2026-09-30T01:00:00Z"), 2, TZ)).toEqual(at("2026-09-30T07:00:00Z"));
  });

  it("never lands exactly on 23:00 — that is already night, so it becomes 06:00", () => {
    // 21:00 + 2h = 23:00, which nobody should be asked at.
    expect(addWakingHours(at("2026-09-29T20:00:00Z"), 2, TZ)).toEqual(at("2026-09-30T05:00:00Z"));
  });

  it("counts from the start of the hour, because the sweep asks on the hour", () => {
    // A stamp written a few seconds into the 09:00 sweep must not push a 12h
    // head start to the 22:00 sweep.
    expect(addWakingHours(at("2026-09-29T08:00:04Z"), 12, TZ)).toEqual(at("2026-09-29T20:00:00Z"));
    // A decline at 14:37 counts from 14:00.
    expect(addWakingHours(at("2026-09-29T13:37:00Z"), 3, TZ)).toEqual(at("2026-09-29T16:00:00Z"));
  });

  it("spans several nights for a long head start", () => {
    // 17 waking hours a day: 09:00 + 40h = 23:00 day 1 (14h), 06:00–23:00 day 2 (17h), then 9h → 15:00 day 3.
    expect(addWakingHours(at("2026-09-28T08:00:00Z"), 40, TZ)).toEqual(at("2026-09-30T14:00:00Z"));
  });

  it("stays on local wall-clock hours across the October clock change", () => {
    // 24 Oct 2026 21:00 BST (20:00Z) + 6h → 2h Saturday, 4h Sunday from 06:00 GMT = 10:00 GMT.
    expect(addWakingHours(at("2026-10-24T20:00:00Z"), 6, TZ)).toEqual(at("2026-10-25T10:00:00Z"));
  });
});

describe("latestAskAtOrBefore", () => {
  it("keeps a waking instant, floored to the hour", () => {
    // 18:00 BST kickoff − 3h = 15:00; 15:30 floors to 15:00.
    expect(latestAskAtOrBefore(at("2026-09-30T14:30:00Z"), TZ)).toEqual(at("2026-09-30T14:00:00Z"));
  });

  it("moves a night-time instant back to 22:00, the last waking sweep", () => {
    expect(latestAskAtOrBefore(at("2026-09-30T02:00:00Z"), TZ)).toEqual(at("2026-09-29T21:00:00Z")); // 03:00 BST → 22:00 prev day
    expect(latestAskAtOrBefore(at("2026-09-30T22:30:00Z"), TZ)).toEqual(at("2026-09-30T21:00:00Z")); // 23:30 BST → 22:00 same day
  });
});

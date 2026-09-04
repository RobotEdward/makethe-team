import { describe, expect, it } from "vitest";
import {
  DEFAULT_RESULT_LOCK_HOURS_AFTER,
  isResultLocked,
  resultDeadline,
  resultLockedAt,
  resultWritable,
} from "../../src/domain/result-lock.js";
import type { ResultClaim } from "../../src/domain/result.js";

const KICKOFF = new Date("2026-08-13T18:00:00Z");
/** A 90-minute fixture, so full time is not kickoff and the two cannot be confused. */
const FIXTURE = { kicksOffAt: KICKOFF, durationMinutes: 90 };
const HOURS = DEFAULT_RESULT_LOCK_HOURS_AFTER;
/** 19:30 on the 13th plus 24 hours. */
const DEADLINE = new Date("2026-08-14T19:30:00Z");

function claim(filedAt: Date): ResultClaim {
  return { playerId: "p1", outcome: "a", scoreA: null, scoreB: null, filedAt };
}

describe("resultDeadline", () => {
  it("counts from full time, not from kickoff", () => {
    expect(resultDeadline(FIXTURE, HOURS).toISOString()).toBe("2026-08-14T19:30:00.000Z");
  });

  /**
   * The reason M57 moved the measurement. Under the old fixed window a squad
   * playing for two hours had two fewer hours to argue in than one playing for
   * one, on the same fixed 48 from kickoff.
   */
  it("gives a longer fixture the same window after the whistle", () => {
    const shorter = resultDeadline({ kicksOffAt: KICKOFF, durationMinutes: 60 }, HOURS);
    const longer = resultDeadline({ kicksOffAt: KICKOFF, durationMinutes: 120 }, HOURS);
    expect(longer.getTime() - shorter.getTime()).toBe(60 * 60 * 1000);
  });

  it("is the owner's own window when they have set one", () => {
    expect(resultDeadline(FIXTURE, 168).toISOString()).toBe("2026-08-20T19:30:00.000Z");
  });
});

describe("isResultLocked", () => {
  it("is open right up to the deadline", () => {
    expect(isResultLocked(FIXTURE, HOURS, 2, new Date(DEADLINE.getTime() - 1))).toBe(false);
  });

  it("locks at the deadline exactly", () => {
    expect(isResultLocked(FIXTURE, HOURS, 2, DEADLINE)).toBe(true);
  });

  it("does not lock after the deadline when nobody filed", () => {
    // Nothing to lock, so nothing locks: the form stays open and the first
    // late claim locks on filing. This one line is the whole empty case.
    expect(isResultLocked(FIXTURE, HOURS, 0, new Date(DEADLINE.getTime() + 1))).toBe(false);
  });

  it("is locked the instant a late claim exists", () => {
    expect(isResultLocked(FIXTURE, HOURS, 1, new Date(DEADLINE.getTime() + 1))).toBe(true);
  });

  it("is still open on a longer window that has not run out", () => {
    expect(isResultLocked(FIXTURE, 168, 2, DEADLINE)).toBe(false);
  });
});

describe("resultWritable", () => {
  it("is writable on a played fixture before the deadline", () => {
    expect(resultWritable("played", FIXTURE, HOURS, 1, KICKOFF)).toBe(true);
  });

  it("is writable after the deadline when nothing was filed", () => {
    expect(resultWritable("played", FIXTURE, HOURS, 0, new Date(DEADLINE.getTime() + 1))).toBe(true);
  });

  it("is not writable once locked", () => {
    expect(resultWritable("played", FIXTURE, HOURS, 1, DEADLINE)).toBe(false);
  });

  it("is never writable on any other lifecycle", () => {
    for (const lifecycle of ["scheduled", "open", "cancelled"] as const) {
      expect(resultWritable(lifecycle, FIXTURE, HOURS, 0, DEADLINE)).toBe(false);
    }
  });
});

describe("resultLockedAt", () => {
  it("is the deadline when the claims predate it", () => {
    expect(resultLockedAt(FIXTURE, HOURS, [claim(KICKOFF)])?.getTime()).toBe(DEADLINE.getTime());
  });

  it("is the first claim's own instant when it was filed late", () => {
    const late = new Date(DEADLINE.getTime() + 60_000);
    expect(resultLockedAt(FIXTURE, HOURS, [claim(late)])?.getTime()).toBe(late.getTime());
  });

  it("is null with no claims", () => {
    expect(resultLockedAt(FIXTURE, HOURS, [])).toBeNull();
  });
});

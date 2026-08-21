import { describe, expect, it } from "vitest";
import {
  RESULT_LOCK_WINDOW_MS,
  isResultLocked,
  resultDeadline,
  resultLockedAt,
  resultWritable,
} from "../../src/domain/result-lock.js";
import type { ResultClaim } from "../../src/domain/result.js";

const KICKOFF = new Date("2026-08-13T18:00:00Z");
const DEADLINE = new Date(KICKOFF.getTime() + RESULT_LOCK_WINDOW_MS);

function claim(filedAt: Date): ResultClaim {
  return { playerId: "p1", outcome: "a", scoreA: null, scoreB: null, filedAt };
}

describe("resultDeadline", () => {
  it("is 48 hours after kickoff, not after full time", () => {
    expect(resultDeadline(KICKOFF).toISOString()).toBe("2026-08-15T18:00:00.000Z");
  });
});

describe("isResultLocked", () => {
  it("is open right up to the deadline", () => {
    expect(isResultLocked(KICKOFF, 2, new Date(DEADLINE.getTime() - 1))).toBe(false);
  });

  it("locks at the deadline exactly", () => {
    expect(isResultLocked(KICKOFF, 2, DEADLINE)).toBe(true);
  });

  it("does not lock after the deadline when nobody filed", () => {
    // Nothing to lock, so nothing locks: the form stays open and the first
    // late claim locks on filing. This one line is the whole empty case.
    expect(isResultLocked(KICKOFF, 0, new Date(DEADLINE.getTime() + 1))).toBe(false);
  });

  it("is locked the instant a late claim exists", () => {
    expect(isResultLocked(KICKOFF, 1, new Date(DEADLINE.getTime() + 1))).toBe(true);
  });
});

describe("resultWritable", () => {
  it("is writable on a played fixture before the deadline", () => {
    expect(resultWritable("played", KICKOFF, 1, KICKOFF)).toBe(true);
  });

  it("is writable after the deadline when nothing was filed", () => {
    expect(resultWritable("played", KICKOFF, 0, new Date(DEADLINE.getTime() + 1))).toBe(true);
  });

  it("is not writable once locked", () => {
    expect(resultWritable("played", KICKOFF, 1, DEADLINE)).toBe(false);
  });

  it("is never writable on any other lifecycle", () => {
    for (const lifecycle of ["scheduled", "open", "cancelled"] as const) {
      expect(resultWritable(lifecycle, KICKOFF, 0, DEADLINE)).toBe(false);
    }
  });
});

describe("resultLockedAt", () => {
  it("is the deadline when the claims predate it", () => {
    expect(resultLockedAt(KICKOFF, [claim(KICKOFF)])?.getTime()).toBe(DEADLINE.getTime());
  });

  it("is the first claim's own instant when it was filed late", () => {
    const late = new Date(DEADLINE.getTime() + 60_000);
    expect(resultLockedAt(KICKOFF, [claim(late)])?.getTime()).toBe(late.getTime());
  });

  it("is null with no claims", () => {
    expect(resultLockedAt(KICKOFF, [])).toBeNull();
  });
});

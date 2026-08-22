import { describe, expect, it } from "vitest";
import {
  isMuted,
  MUTE_DURATIONS,
  muteExpiryFor,
  parseMuteDuration,
  type MuteState,
} from "../../src/domain/mute.js";

const now = new Date("2026-09-01T12:00:00.000Z");

function state(mutedAt: Date | null, mutedUntil: Date | null): MuteState {
  return { mutedAt, mutedUntil };
}

describe("isMuted", () => {
  it("is false for a membership that was never muted", () => {
    expect(isMuted(state(null, null), now)).toBe(false);
  });

  it("is true indefinitely when mutedAt is set and mutedUntil is null", () => {
    expect(isMuted(state(new Date("2020-01-01T00:00:00.000Z"), null), now)).toBe(true);
  });

  it("is true while the expiry is still in the future", () => {
    expect(isMuted(state(now, new Date("2026-09-15T12:00:00.000Z")), now)).toBe(true);
  });

  it("is false once the expiry has passed", () => {
    expect(isMuted(state(new Date("2026-08-01T12:00:00.000Z"), new Date("2026-08-29T12:00:00.000Z")), now)).toBe(false);
  });

  it("is false at the exact instant of expiry, so the boundary cannot mute twice", () => {
    expect(isMuted(state(new Date("2026-08-01T12:00:00.000Z"), now), now)).toBe(false);
  });

  it("ignores an expiry with no mutedAt beside it, rather than treating the row as muted", () => {
    // A half-written row must fail closed towards "ask me", never towards silence.
    expect(isMuted(state(null, new Date("2026-09-15T12:00:00.000Z")), now)).toBe(false);
  });
});

describe("mute durations", () => {
  it("offers exactly the four choices the form renders", () => {
    expect(MUTE_DURATIONS.map((d) => d.value)).toEqual(["2w", "4w", "8w", "forever"]);
  });

  it("turns a weeks choice into an instant that many weeks out", () => {
    expect(muteExpiryFor("2w", now)?.toISOString()).toBe("2026-09-15T12:00:00.000Z");
    expect(muteExpiryFor("4w", now)?.toISOString()).toBe("2026-09-29T12:00:00.000Z");
    expect(muteExpiryFor("8w", now)?.toISOString()).toBe("2026-10-27T12:00:00.000Z");
  });

  it("turns the indefinite choice into no expiry at all", () => {
    expect(muteExpiryFor("forever", now)).toBe(null);
  });

  it("accepts only the four values, so a hand-crafted POST cannot invent a duration", () => {
    for (const value of MUTE_DURATIONS.map((d) => d.value)) {
      expect(parseMuteDuration(value)).toBe(value);
    }
    for (const bad of ["", "1w", "100w", "forever ", "FOREVER", undefined]) {
      expect(parseMuteDuration(bad)).toBe(null);
    }
  });
});

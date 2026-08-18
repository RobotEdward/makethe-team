import { describe, expect, it } from "vitest";
import { MAX_BROADCASTS_PER_GAME_PER_DAY, utcDayStart } from "../../src/domain/broadcast-limit.js";

describe("the broadcast day", () => {
  it("caps a game at three sends a day", () => {
    expect(MAX_BROADCASTS_PER_GAME_PER_DAY).toBe(3);
  });

  it("starts the day at UTC midnight, matching the email quota's own day key", () => {
    expect(utcDayStart(new Date("2026-08-18T23:59:59.999Z")).toISOString()).toBe("2026-08-18T00:00:00.000Z");
    expect(utcDayStart(new Date("2026-08-19T00:00:00.000Z")).toISOString()).toBe("2026-08-19T00:00:00.000Z");
  });
});

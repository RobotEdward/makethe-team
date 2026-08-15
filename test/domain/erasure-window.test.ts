import { describe, expect, it } from "vitest";
import { ERASURE_WINDOW_MS, erasureDeadline } from "../../src/domain/erasure-window.js";

describe("erasureDeadline", () => {
  it("is 48 hours after the request", () => {
    const now = new Date("2026-08-15T09:00:00Z");
    expect(erasureDeadline(now).toISOString()).toBe("2026-08-17T09:00:00.000Z");
  });

  it("does not mutate the date it is given", () => {
    const now = new Date("2026-08-15T09:00:00Z");
    erasureDeadline(now);
    expect(now.toISOString()).toBe("2026-08-15T09:00:00.000Z");
  });

  // Fixed hours, not calendar days: the confirmation page promises a precise
  // instant, and a DST boundary between request and deadline must not move it.
  it("is exactly the window, across a DST boundary", () => {
    const before = new Date("2026-10-24T23:00:00Z");
    expect(erasureDeadline(before).getTime() - before.getTime()).toBe(ERASURE_WINDOW_MS);
  });
});

import { describe, expect, it } from "vitest";
import { RECENT_ANSWER_WINDOW_MS, answerOf, reversesRecentAnswer } from "../../src/domain/recent-answer.js";

const NOW = Date.parse("2026-09-08T08:07:14Z");
const at = (msAgo: number) => new Date(NOW - msAgo);

describe("reversesRecentAnswer (M65)", () => {
  it("catches an opposite answer inside the window", () => {
    expect(reversesRecentAnswer({ status: "out", respondedAt: at(10_000), setByPlayerId: null }, "in", NOW)).toBe(true);
    expect(reversesRecentAnswer({ status: "in", respondedAt: at(1_500), setByPlayerId: null }, "out", NOW)).toBe(true);
  });

  it("treats a waitlisted answer as 'in', so an out on top of it is a reversal", () => {
    expect(reversesRecentAnswer({ status: "waitlisted", respondedAt: at(5_000), setByPlayerId: null }, "out", NOW)).toBe(true);
  });

  it("lets the same answer through — a re-tap is not a reversal", () => {
    expect(reversesRecentAnswer({ status: "out", respondedAt: at(1_000), setByPlayerId: null }, "out", NOW)).toBe(false);
    expect(reversesRecentAnswer({ status: "waitlisted", respondedAt: at(1_000), setByPlayerId: null }, "in", NOW)).toBe(false);
  });

  it("lets a change through once the window has passed", () => {
    expect(
      reversesRecentAnswer({ status: "out", respondedAt: at(RECENT_ANSWER_WINDOW_MS), setByPlayerId: null }, "in", NOW),
    ).toBe(false);
    expect(
      reversesRecentAnswer({ status: "out", respondedAt: at(RECENT_ANSWER_WINDOW_MS - 1), setByPlayerId: null }, "in", NOW),
    ).toBe(true);
  });

  it("never guards a first answer", () => {
    expect(reversesRecentAnswer({ status: "pending", respondedAt: null, setByPlayerId: null }, "in", NOW)).toBe(false);
    expect(reversesRecentAnswer({ status: "pending", respondedAt: at(100), setByPlayerId: null }, "out", NOW)).toBe(false);
  });

  it("never guards a reaction to an owner's override (BR-27)", () => {
    expect(reversesRecentAnswer({ status: "out", respondedAt: at(2_000), setByPlayerId: "owner" }, "in", NOW)).toBe(false);
  });

  it("ignores a responded_at in the future — a skewed clock must not lock a player out", () => {
    expect(reversesRecentAnswer({ status: "out", respondedAt: at(-5_000), setByPlayerId: null }, "in", NOW)).toBe(false);
  });
});

describe("answerOf", () => {
  it("maps each stored status to the answer it stands for", () => {
    expect(answerOf("in")).toBe("in");
    expect(answerOf("waitlisted")).toBe("in");
    expect(answerOf("out")).toBe("out");
    expect(answerOf("pending")).toBeNull();
    expect(answerOf("withdrawn")).toBeNull();
  });
});

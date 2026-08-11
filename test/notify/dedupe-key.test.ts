import { describe, expect, it } from "vitest";
import {
  attentionKey,
  cancellationKey,
  promotionKey,
  reminderKey,
  welcomeKey,
} from "../../src/notify/dedupe-key.js";

/**
 * These builders are the entire idempotency guarantee behind the reminder
 * sweep (§2.8) — a typo in one is a duplicate email to a real person. Each
 * test asserts the exact documented string, character for character.
 */
describe("dedupe-key builders", () => {
  it("n1 reminder: n1:<fixture_id>:<player_id>", () => {
    expect(reminderKey("fix-1", "ply-1")).toBe("n1:fix-1:ply-1");
  });

  it("n2 promotion: n2:<fixture_id>:<player_id>:<promoted_at>", () => {
    expect(promotionKey("fix-1", "ply-1", "2026-08-12T09:00:00.000Z")).toBe(
      "n2:fix-1:ply-1:2026-08-12T09:00:00.000Z",
    );
  });

  it("n3 cancellation: n3:<fixture_id>:<player_id>", () => {
    expect(cancellationKey("fix-1", "ply-1")).toBe("n3:fix-1:ply-1");
  });

  it("n4 attention: n4:<fixture_id>:<player_id>", () => {
    expect(attentionKey("fix-1", "ply-1")).toBe("n4:fix-1:ply-1");
  });

  it("n6 welcome: n6:<membership_id>", () => {
    expect(welcomeKey("mem-1")).toBe("n6:mem-1");
  });

  it("n2/n4 asymmetry: two promotions at different timestamps are distinct keys", () => {
    const first = promotionKey("fix-1", "ply-1", "2026-08-12T09:00:00.000Z");
    const second = promotionKey("fix-1", "ply-1", "2026-08-13T09:00:00.000Z");
    expect(first).not.toBe(second);
  });

  it("n2/n4 asymmetry: two attention keys for the same owner and fixture collide", () => {
    const first = attentionKey("fix-1", "ply-1");
    const second = attentionKey("fix-1", "ply-1");
    expect(first).toBe(second);
  });
});

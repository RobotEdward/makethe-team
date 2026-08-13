import { describe, expect, it } from "vitest";
import {
  attentionKey,
  cancellationKey,
  promotionKey,
  reminderKey,
  removalKey,
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

describe("welcomeKey", () => {
  it("includes joinedAt so a rejoin is told again", () => {
    // §2.8 says "rejoining sends again", but UNIQUE (game_id, player_id)
    // forces a rejoin to reuse the membership row — so the membership id
    // alone cannot distinguish the two sends. See spec §4.4.
    const first = welcomeKey("m1", "2026-08-12T10:00:00.000Z");
    const second = welcomeKey("m1", "2026-09-01T10:00:00.000Z");

    expect(first).toBe("n6:m1:2026-08-12T10:00:00.000Z");
    expect(second).not.toBe(first);
  });
});

describe("removalKey", () => {
  it("names the removal, not merely the membership", () => {
    expect(removalKey("m-1", "2026-08-13T12:00:00.000Z")).toBe("n7:m-1:2026-08-13T12:00:00.000Z");
  });

  it("differs across a join → remove → rejoin → remove cycle", () => {
    // UNIQUE (game_id, player_id) forces a rejoin to reuse the membership row,
    // so the id alone is the same string both times and the unique index on
    // `dedupe_key` would silently drop the second removal email. This is the
    // identical trap N-6 hit; `left_at` is the identical fix.
    expect(removalKey("m-1", "2026-08-13T12:00:00.000Z")).not.toBe(
      removalKey("m-1", "2026-09-01T09:00:00.000Z"),
    );
  });
});

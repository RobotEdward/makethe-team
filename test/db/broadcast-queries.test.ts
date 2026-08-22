import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { recordAudit } from "../../src/db/audit.js";
import { countBroadcastsSince, listFixtureRecipients, listGameRecipients } from "../../src/db/broadcast-queries.js";
import { getDb } from "../../src/db/client.js";
import {
  insertFixture,
  insertGame,
  insertMembership,
  insertPlayer,
  insertResponse,
  insertSubscription,
  resetDatabase,
} from "../support/factories.js";

const db = getDb(env.DB);
const now = new Date("2026-08-18T12:00:00Z");

beforeEach(async () => {
  await resetDatabase();
});

describe("listGameRecipients", () => {
  it("returns every active member of the game, and nobody from a different game", async () => {
    const gameId = await insertGame(db);
    const otherGameId = await insertGame(db);
    const playerId = await insertPlayer(db, { name: "Alice", email: "alice@example.com" });
    const otherPlayerId = await insertPlayer(db, { name: "Bob", email: "bob@example.com" });
    await insertMembership(db, gameId, playerId);
    await insertMembership(db, otherGameId, otherPlayerId);

    const recipients = await listGameRecipients(db, gameId, now);

    expect(recipients).toHaveLength(1);
    expect(recipients[0]).toEqual({
      playerId,
      name: "Alice",
      email: "alice@example.com",
      isGuest: false,
      hasDevice: false,
      status: null,
    });
  });

  it("omits a member whose membership is inactive", async () => {
    const gameId = await insertGame(db);
    const activeId = await insertPlayer(db, { name: "Active" });
    const inactiveId = await insertPlayer(db, { name: "Inactive" });
    await insertMembership(db, gameId, activeId);
    await insertMembership(db, gameId, inactiveId, { active: false, leftAt: now });

    const recipients = await listGameRecipients(db, gameId, now);

    expect(recipients.map((r) => r.playerId)).toEqual([activeId]);
  });

  it("omits a member who is auto-declining, and keeps one whose mute has run out (M28)", async () => {
    const gameId = await insertGame(db);
    const askedId = await insertPlayer(db, { name: "Asked" });
    const mutedId = await insertPlayer(db, { name: "Muted" });
    const expiredId = await insertPlayer(db, { name: "Expired" });
    await insertMembership(db, gameId, askedId);
    await insertMembership(db, gameId, mutedId, { mutedAt: new Date("2026-08-01T00:00:00Z"), mutedUntil: null });
    await insertMembership(db, gameId, expiredId, {
      mutedAt: new Date("2026-07-01T00:00:00Z"),
      mutedUntil: new Date("2026-08-01T00:00:00Z"),
    });

    const recipients = await listGameRecipients(db, gameId, now);

    expect(recipients.map((r) => r.playerId).sort()).toEqual([askedId, expiredId].sort());
  });

  it("sets hasDevice true for a player with a push_subscriptions row, without duplicating a two-device player", async () => {
    const gameId = await insertGame(db);
    const noDeviceId = await insertPlayer(db, { name: "No Device" });
    const twoDeviceId = await insertPlayer(db, { name: "Two Devices" });
    await insertMembership(db, gameId, noDeviceId);
    await insertMembership(db, gameId, twoDeviceId);
    await insertSubscription(db, twoDeviceId, "https://push.example.com/device-a");
    await insertSubscription(db, twoDeviceId, "https://push.example.com/device-b");

    const recipients = await listGameRecipients(db, gameId, now);

    expect(recipients.filter((r) => r.playerId === twoDeviceId)).toHaveLength(1);
    expect(recipients.find((r) => r.playerId === twoDeviceId)?.hasDevice).toBe(true);
    expect(recipients.find((r) => r.playerId === noDeviceId)?.hasDevice).toBe(false);
  });
});

describe("listFixtureRecipients", () => {
  it("returns one row per response row on that fixture, carrying the raw status", async () => {
    const gameId = await insertGame(db);
    const fixtureId = await insertFixture(db, gameId);
    const playerId = await insertPlayer(db, { name: "Carol" });
    await insertResponse(db, fixtureId, playerId, { status: "waitlisted" });

    const recipients = await listFixtureRecipients(db, gameId, fixtureId, now);

    expect(recipients).toHaveLength(1);
    expect(recipients[0]).toMatchObject({ playerId, status: "waitlisted" });
  });

  it("omits a muted member from a fixture-scoped audience too (M28)", async () => {
    const gameId = await insertGame(db);
    const fixtureId = await insertFixture(db, gameId);
    const askedId = await insertPlayer(db, { name: "Asked" });
    const mutedId = await insertPlayer(db, { name: "Muted" });
    await insertMembership(db, gameId, askedId);
    await insertMembership(db, gameId, mutedId, { mutedAt: new Date("2026-08-01T00:00:00Z"), mutedUntil: null });
    await insertResponse(db, fixtureId, askedId, { status: "out" });
    await insertResponse(db, fixtureId, mutedId, { status: "out" });

    const recipients = await listFixtureRecipients(db, gameId, fixtureId, now);

    expect(recipients.map((r) => r.playerId)).toEqual([askedId]);
  });

  it("keeps a guest, who has a response row and no membership at all", async () => {
    const gameId = await insertGame(db);
    const fixtureId = await insertFixture(db, gameId);
    const guestId = await insertPlayer(db, { name: "Guest", email: null, isGuest: true });
    await insertResponse(db, fixtureId, guestId, { status: "in" });

    const recipients = await listFixtureRecipients(db, gameId, fixtureId, now);

    expect(recipients.map((r) => r.playerId)).toEqual([guestId]);
  });

  it("sets hasDevice true for a player with a push_subscriptions row, false otherwise, and once for two devices", async () => {
    const gameId = await insertGame(db);
    const fixtureId = await insertFixture(db, gameId);
    const withDeviceId = await insertPlayer(db, { name: "With Device" });
    const withoutDeviceId = await insertPlayer(db, { name: "Without Device" });
    await insertResponse(db, fixtureId, withDeviceId, { status: "in" });
    await insertResponse(db, fixtureId, withoutDeviceId, { status: "in" });
    await insertSubscription(db, withDeviceId, "https://push.example.com/device-a");
    await insertSubscription(db, withDeviceId, "https://push.example.com/device-b");

    const recipients = await listFixtureRecipients(db, gameId, fixtureId, now);

    expect(recipients.filter((r) => r.playerId === withDeviceId)).toHaveLength(1);
    expect(recipients.find((r) => r.playerId === withDeviceId)?.hasDevice).toBe(true);
    expect(recipients.find((r) => r.playerId === withoutDeviceId)?.hasDevice).toBe(false);
  });
});

describe("countBroadcastsSince", () => {
  it("counts only game.broadcast_sent rows for that game at or after the boundary", async () => {
    const gameId = await insertGame(db);
    const otherGameId = await insertGame(db);
    const boundary = new Date("2026-08-18T00:00:00.000Z");

    // Counts: at the boundary exactly, and after it.
    await recordAudit(db, {
      actorPlayerId: null,
      entityType: "game",
      entityId: gameId,
      action: "game.broadcast_sent",
      now: boundary,
    });
    await recordAudit(db, {
      actorPlayerId: null,
      entityType: "game",
      entityId: gameId,
      action: "game.broadcast_sent",
      now: new Date("2026-08-18T10:00:00.000Z"),
    });

    // Excluded: yesterday.
    await recordAudit(db, {
      actorPlayerId: null,
      entityType: "game",
      entityId: gameId,
      action: "game.broadcast_sent",
      now: new Date("2026-08-17T23:59:59.999Z"),
    });
    // Excluded: a different game.
    await recordAudit(db, {
      actorPlayerId: null,
      entityType: "game",
      entityId: otherGameId,
      action: "game.broadcast_sent",
      now: new Date("2026-08-18T10:00:00.000Z"),
    });
    // Excluded: a different action, same game and day.
    await recordAudit(db, {
      actorPlayerId: null,
      entityType: "game",
      entityId: gameId,
      action: "game.broadcast_email_deferred",
      now: new Date("2026-08-18T10:00:00.000Z"),
    });

    const count = await countBroadcastsSince(db, gameId, boundary);

    expect(count).toBe(2);
  });
});

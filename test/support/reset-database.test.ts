import { describe, expect, it } from "vitest";
import {
  account,
  auditLog,
  emailQuota,
  fixtures,
  games,
  memberships,
  notificationLog,
  passkey,
  players,
  responses,
  session,
  user,
  verification,
} from "../../src/db/schema.js";
import { gameRow, resetDatabase, testDb } from "./factories.js";

/**
 * Guards the exact leak class that has already bitten this project once:
 * `resetDatabase()` silently omitting a table, so the next test that writes
 * to it inherits rows from a previous test. Every table `resetDatabase`
 * claims to clear gets a row inserted here (including the five Better Auth
 * tables added in M5 — `passkey` joined the other four in Task 8), then
 * `resetDatabase()` is called once, and each table is asserted empty
 * *individually* so a failure names the table that was missed rather than a
 * generic "something's left over".
 */
describe("resetDatabase", () => {
  it("empties every table it is responsible for", async () => {
    const db = testDb();

    const playerId = crypto.randomUUID();
    await db.insert(players).values({ id: playerId, name: "Reset Test Player", isGuest: true });

    const gameId = crypto.randomUUID();
    await db.insert(games).values(gameRow({ id: gameId }));

    const fixtureId = crypto.randomUUID();
    await db.insert(fixtures).values({
      id: fixtureId,
      gameId,
      kicksOffAt: new Date("2026-08-13T18:00:00Z"),
      minPlayers: 10,
      maxPlayers: 14,
      prefersEvenNumbers: true,
      shortWarningOffsetHours: 12,
      durationMinutes: 60,
    });

    await db.insert(memberships).values({
      id: crypto.randomUUID(),
      gameId,
      playerId,
    });

    await db.insert(responses).values({
      id: crypto.randomUUID(),
      fixtureId,
      playerId,
      source: "web",
    });

    await db.insert(notificationLog).values({
      id: crypto.randomUUID(),
      dedupeKey: crypto.randomUUID(),
      notificationType: "n1",
      playerId,
    });

    await db.insert(auditLog).values({
      id: crypto.randomUUID(),
      entityType: "fixture",
      entityId: fixtureId,
      action: "fixture.cancelled",
    });

    await db.insert(emailQuota).values({ day: "2026-08-11", sentCount: 1 });

    const userId = crypto.randomUUID();
    const now = new Date("2026-08-11T09:00:00Z");
    await db.insert(user).values({
      id: userId,
      name: "Reset Test User",
      email: "reset-test@example.com",
      emailVerified: false,
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(session).values({
      id: crypto.randomUUID(),
      expiresAt: now,
      token: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
      userId,
    });

    await db.insert(account).values({
      id: crypto.randomUUID(),
      accountId: "reset-test-account",
      providerId: "credential",
      userId,
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(verification).values({
      id: crypto.randomUUID(),
      identifier: "reset-test",
      value: "value",
      expiresAt: now,
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(passkey).values({
      id: crypto.randomUUID(),
      userId,
      publicKey: "reset-test-not-a-real-key",
      credentialID: "reset-test-not-a-real-credential",
      counter: 0,
      deviceType: "singleDevice",
      backedUp: false,
      createdAt: now,
    });

    await resetDatabase();

    expect(await db.select().from(players)).toHaveLength(0);
    expect(await db.select().from(games)).toHaveLength(0);
    expect(await db.select().from(fixtures)).toHaveLength(0);
    expect(await db.select().from(memberships)).toHaveLength(0);
    expect(await db.select().from(responses)).toHaveLength(0);
    expect(await db.select().from(notificationLog)).toHaveLength(0);
    expect(await db.select().from(auditLog)).toHaveLength(0);
    expect(await db.select().from(emailQuota)).toHaveLength(0);
    expect(await db.select().from(user)).toHaveLength(0);
    expect(await db.select().from(session)).toHaveLength(0);
    expect(await db.select().from(account)).toHaveLength(0);
    expect(await db.select().from(verification)).toHaveLength(0);
    expect(await db.select().from(passkey)).toHaveLength(0);
  });
});

import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { erasePlayer, ERASED_NAME } from "../../src/domain/erase-player.js";
import {
  account,
  auditLog,
  memberships,
  notificationLog,
  passkey,
  players,
  responses,
  session,
  user,
  verification,
} from "../../src/db/schema.js";
import {
  insertFixture,
  insertGame,
  insertMembership,
  insertPlayer,
  insertResponse,
  resetDatabase,
  testDb,
} from "../support/factories.js";

const NOW = new Date("2026-08-17T09:00:00Z");

/** No open fixtures in these tests, so the callback must never be reached. */
const noWithdraw = async () => {
  throw new Error("withdraw should not have been called");
};

beforeEach(resetDatabase);

describe("erasePlayer", () => {
  it("anonymises the player row and records when", async () => {
    const db = testDb();
    const playerId = await insertPlayer(db, { name: "Edward Cooper", email: "edward@example.test" });

    const result = await erasePlayer({ db, playerId, now: NOW, withdraw: noWithdraw });
    expect(result.kind).toBe("erased");

    const [row] = await db.select().from(players).where(eq(players.id, playerId));
    expect(row?.name).toBe(ERASED_NAME);
    expect(row?.email).toBeNull();
    expect(row?.authUserId).toBeNull();
    expect(row?.emailVerifiedAt).toBeNull();
    expect(row?.erasedAt?.getTime()).toBe(NOW.getTime());
  });

  // The row must survive: `responses`, `audit_log` and `notification_log` all
  // hold foreign keys to it, and a past fixture that was ten-a-side must still
  // read as ten-a-side.
  it("keeps the player row rather than deleting it", async () => {
    const db = testDb();
    const playerId = await insertPlayer(db, { email: "edward@example.test" });

    await erasePlayer({ db, playerId, now: NOW, withdraw: noWithdraw });

    const rows = await db.select().from(players).where(eq(players.id, playerId));
    expect(rows).toHaveLength(1);
  });

  // `src/notify/resend-notifier.ts` stores up to 500 characters of the
  // provider's response body here on a non-2xx, and a provider's validation
  // errors quote the address they rejected. It is the only place in the schema
  // where an email address can appear outside `players.email`.
  it("nulls notification_log.error, which can quote the address", async () => {
    const db = testDb();
    const playerId = await insertPlayer(db, { email: "edward@example.test" });
    await db.insert(notificationLog).values({
      id: crypto.randomUUID(),
      dedupeKey: `test:${playerId}`,
      notificationType: "n1",
      playerId,
      status: "failed",
      error: 'resend batch failed: HTTP 422 {"message":"Invalid `to`: edward@example.test"}',
    });

    await erasePlayer({ db, playerId, now: NOW, withdraw: noWithdraw });

    const [row] = await db.select().from(notificationLog).where(eq(notificationLog.playerId, playerId));
    expect(row).toBeDefined();
    expect(row?.error).toBeNull();
  });

  it("writes one player.erased audit row attributed to the player themselves", async () => {
    const db = testDb();
    const playerId = await insertPlayer(db, { email: "edward@example.test" });

    await erasePlayer({ db, playerId, now: NOW, withdraw: noWithdraw });

    const rows = await db.select().from(auditLog).where(eq(auditLog.entityId, playerId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe("player.erased");
    expect(rows[0]?.entityType).toBe("player");
    expect(rows[0]?.actorPlayerId).toBe(playerId);
  });

  // The check runs before any removal, so a blocked erasure changes nothing at
  // all. Removing the first game and then discovering the second is blocked
  // would leave the person half-erased with no way to finish or undo it.
  it("refuses without touching anything when a game would lose its last organiser", async () => {
    const db = testDb();
    const playerId = await insertPlayer(db, { name: "Edward Cooper", email: "edward@example.test" });
    const soleOwned = await insertGame(db);
    await insertMembership(db, soleOwned, playerId, { role: "owner" });
    const ordinary = await insertGame(db);
    await insertMembership(db, ordinary, playerId, { role: "player" });

    const result = await erasePlayer({ db, playerId, now: NOW, withdraw: noWithdraw });

    expect(result).toEqual({ kind: "blocked", gameIds: [soleOwned] });

    const [row] = await db.select().from(players).where(eq(players.id, playerId));
    expect(row?.name).toBe("Edward Cooper");
    expect(row?.erasedAt).toBeNull();

    // "Nothing has been written" means every membership too, not just the
    // player row and the audit rows keyed to the player: an interleaved
    // implementation that checks-then-removes game by game would deactivate
    // `ordinary`'s membership (writing a `membership.removed` row keyed to
    // the *membership* id, not the player id) before ever reaching the game
    // that blocks it, and a query filtered to `entityId = playerId` alone
    // would not catch that.
    const memberRows = await db
      .select()
      .from(memberships)
      .where(eq(memberships.playerId, playerId));
    expect(memberRows).toHaveLength(2);
    for (const member of memberRows) {
      expect(member.active).toBe(true);
      expect(member.leftAt).toBeNull();
    }
    const allAudit = await db.select().from(auditLog);
    expect(allAudit).toHaveLength(0);
  });

  it("proceeds when the game has another active organiser", async () => {
    const db = testDb();
    const playerId = await insertPlayer(db, { email: "edward@example.test" });
    const coOwnerId = await insertPlayer(db, { email: "nadia@example.test" });
    const gameId = await insertGame(db);
    await insertMembership(db, gameId, playerId, { role: "owner" });
    await insertMembership(db, gameId, coOwnerId, { role: "owner" });

    const result = await erasePlayer({ db, playerId, now: NOW, withdraw: noWithdraw });

    expect(result.kind).toBe("erased");
  });

  it("is idempotent: a second call reports already-erased and writes nothing new", async () => {
    const db = testDb();
    const playerId = await insertPlayer(db, { email: "edward@example.test" });
    await erasePlayer({ db, playerId, now: NOW, withdraw: noWithdraw });

    const again = await erasePlayer({
      db,
      playerId,
      now: new Date("2026-08-18T09:00:00Z"),
      withdraw: noWithdraw,
    });

    expect(again).toEqual({ kind: "already-erased" });
    const [row] = await db.select().from(players).where(eq(players.id, playerId));
    expect(row?.erasedAt?.getTime()).toBe(NOW.getTime());
    const rows = await db.select().from(auditLog).where(eq(auditLog.entityId, playerId));
    expect(rows).toHaveLength(1);
  });

  it("reports not-found for a player id that does not resolve", async () => {
    const db = testDb();
    const result = await erasePlayer({
      db,
      playerId: crypto.randomUUID(),
      now: NOW,
      withdraw: noWithdraw,
    });
    expect(result).toEqual({ kind: "not-found" });
  });

  // The fiddliest part of the whole task: `verification.value` is matched with
  // LIKE, so an unescaped `_` in the address would also match any row whose
  // value differs from the real address at exactly that character — deleting
  // a stranger's pending magic link along with the erased player's own.
  it("does not delete another player's verification row when the address contains an underscore", async () => {
    const db = testDb();
    const playerId = await insertPlayer(db, { email: "a_b@example.test" });
    const now = NOW;

    // The victim: differs from the erased player's address only at the
    // character the unescaped `_` wildcard would match.
    await db.insert(verification).values({
      id: crypto.randomUUID(),
      identifier: "axb@example.test",
      value: JSON.stringify({ email: "axb@example.test" }),
      expiresAt: new Date(now.getTime() + 60_000),
      createdAt: now,
      updatedAt: now,
    });
    // The erased player's own pending link, which must be removed.
    await db.insert(verification).values({
      id: crypto.randomUUID(),
      identifier: "a_b@example.test",
      value: JSON.stringify({ email: "a_b@example.test" }),
      expiresAt: new Date(now.getTime() + 60_000),
      createdAt: now,
      updatedAt: now,
    });

    await erasePlayer({ db, playerId, now: NOW, withdraw: noWithdraw });

    const rows = await db.select().from(verification);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.identifier).toBe("axb@example.test");
  });

  // The branch that never runs for a guest or a never-signed-in player, and
  // is the one place a surviving row is a live way back into a deleted
  // account: a `session` or `passkey` left behind would still authenticate as
  // someone whose player row now says `[erased player]`.
  it("hard-deletes the linked Better Auth user, session, account and passkey", async () => {
    const db = testDb();
    const authUserId = crypto.randomUUID();
    const playerId = await insertPlayer(db, { email: "edward@example.test", authUserId });

    await db.insert(user).values({
      id: authUserId,
      name: "Edward Cooper",
      email: "edward@example.test",
      emailVerified: true,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await db.insert(session).values({
      id: crypto.randomUUID(),
      expiresAt: new Date(NOW.getTime() + 60_000),
      token: crypto.randomUUID(),
      createdAt: NOW,
      updatedAt: NOW,
      userId: authUserId,
    });
    await db.insert(account).values({
      id: crypto.randomUUID(),
      accountId: authUserId,
      providerId: "magic-link",
      userId: authUserId,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await db.insert(passkey).values({
      id: crypto.randomUUID(),
      publicKey: "public-key",
      userId: authUserId,
      credentialID: "credential-id",
      counter: 0,
      deviceType: "singleDevice",
      backedUp: false,
      createdAt: NOW,
    });

    const result = await erasePlayer({ db, playerId, now: NOW, withdraw: noWithdraw });
    expect(result.kind).toBe("erased");

    expect(await db.select().from(user).where(eq(user.id, authUserId))).toHaveLength(0);
    expect(await db.select().from(session).where(eq(session.userId, authUserId))).toHaveLength(0);
    expect(await db.select().from(account).where(eq(account.userId, authUserId))).toHaveLength(0);
    expect(await db.select().from(passkey).where(eq(passkey.userId, authUserId))).toHaveLength(0);
  });

  // The milestone's headline invariant: erasure anonymises the player, but a
  // past fixture must still read as ten-a-side. `responses` is what makes
  // that true, so this proves erasure never touches it.
  it("leaves the player's response rows untouched", async () => {
    const db = testDb();
    const playerId = await insertPlayer(db, { email: "edward@example.test" });
    const gameId = await insertGame(db);
    const fixtureId = await insertFixture(db, gameId);
    await insertResponse(db, fixtureId, playerId, { status: "in" });

    await erasePlayer({ db, playerId, now: NOW, withdraw: noWithdraw });

    const rows = await db.select().from(responses).where(eq(responses.playerId, playerId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("in");
    expect(rows[0]?.fixtureId).toBe(fixtureId);
  });
});

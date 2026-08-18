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
  pushSubscriptions,
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
  insertSubscription,
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

  // The worst thing this feature can do: an orphaned endpoint that still
  // wakes a real phone after that person asked to be erased. §12's headline
  // guarantee, so it gets zero-rows-survive rather than a weaker assertion.
  it("deletes every push subscription belonging to the erased player", async () => {
    const db = testDb();
    const playerId = await insertPlayer(db, { name: "Edward Cooper", email: "edward@example.test" });
    await insertSubscription(db, playerId, "https://push.example.test/device-1");
    await insertSubscription(db, playerId, "https://push.example.test/device-2");

    const result = await erasePlayer({ db, playerId, now: NOW, withdraw: noWithdraw });

    expect(result.kind).toBe("erased");
    expect(await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.playerId, playerId))).toHaveLength(
      0,
    );
  });

  // The pre-check refuses before any write happens at all (see the test
  // below this one), and a subscription is no exception: a blocked erasure
  // must leave the device just as reachable as it was, because nothing has
  // actually been erased.
  it("leaves a device's subscription alone when erasure is blocked at the pre-check", async () => {
    const db = testDb();
    const playerId = await insertPlayer(db, { name: "Edward Cooper", email: "edward@example.test" });
    const soleOwned = await insertGame(db);
    await insertMembership(db, soleOwned, playerId, { role: "owner" });
    await insertSubscription(db, playerId, "https://push.example.test/device-1");

    const result = await erasePlayer({ db, playerId, now: NOW, withdraw: noWithdraw });

    expect(result.kind).toBe("blocked");
    expect(await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.playerId, playerId))).toHaveLength(
      1,
    );
  });

  // The comment at the delete site claims a run that stops half-done still
  // cannot leave a live subscription behind. Nothing above proves that: both
  // tests so far only exercise the happy path and the pre-check refusal, so a
  // future refactor moving the delete into the final `db.batch()` (which the
  // spec's own "same batch" wording invites) would pass every test that
  // exists today and reintroduce exactly the failure mode this task closes.
  // This pins the claim: an open fixture makes `removeMember` call
  // `withdraw`, and a `withdraw` that throws propagates straight out of
  // `erasePlayer` — past the removal loop, past `recordBlocked`, past the
  // final batch — with the subscription delete already having run.
  it("has already deleted the subscription if the removal loop throws before erasure finishes", async () => {
    const db = testDb();
    const playerId = await insertPlayer(db, { name: "Edward Cooper", email: "edward@example.test" });
    const gameId = await insertGame(db);
    // A plain player, not an owner: the sole-organiser pre-check must not
    // block this run before it reaches the removal loop, or `withdraw` is
    // never called and the test proves nothing about the failure path.
    await insertMembership(db, gameId, playerId, { role: "player" });
    await insertFixture(db, gameId, { lifecycle: "open" });
    await insertSubscription(db, playerId, "https://push.example.test/device-1");
    const throwingWithdraw = async (): Promise<never> => {
      throw new Error("Durable Object unreachable");
    };

    await expect(erasePlayer({ db, playerId, now: NOW, withdraw: throwingWithdraw })).rejects.toThrow(
      "Durable Object unreachable",
    );

    expect(await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.playerId, playerId))).toHaveLength(
      0,
    );
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
  it("refuses without touching any membership when a game would lose its last organiser", async () => {
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

    // "Nothing has been erased" means every membership too, not just the
    // player row: an interleaved implementation that checks-then-removes game
    // by game would deactivate `ordinary`'s membership (writing a
    // `membership.removed` row keyed to the *membership* id, not the player
    // id) before ever reaching the game that blocks it, and a query filtered
    // to `entityId = playerId` alone would not catch that.
    const memberRows = await db
      .select()
      .from(memberships)
      .where(eq(memberships.playerId, playerId));
    expect(memberRows).toHaveLength(2);
    for (const member of memberRows) {
      expect(member.active).toBe(true);
      expect(member.leftAt).toBeNull();
    }
    // The refusal itself *is* recorded — that is the whole of §6's second
    // clause, and its absence was the defect the final review found. One row,
    // naming the game, and no `membership.*` row alongside it.
    const allAudit = await db.select().from(auditLog);
    expect(allAudit).toHaveLength(1);
    expect(allAudit[0]?.action).toBe("player.erasure_blocked");
    expect(allAudit[0]?.entityId).toBe(playerId);
    expect(JSON.parse(allAudit[0]?.afterJson ?? "null")).toEqual({ gameIds: [soleOwned] });
    // Nothing has *started*: the pre-check ran before any write, so cancel is
    // still an honest offer and the page must not say otherwise.
    expect(row?.erasureStartedAt).toBeNull();
    expect(row?.erasureBlockedAt?.getTime()).toBe(NOW.getTime());
  });

  /**
   * The sweep runs hourly and a block is cleared only by a handover, which
   * nobody is obliged to perform — so an unconditional insert here is one
   * audit row an hour, forever, into a table nothing prunes.
   */
  it("writes the blocked audit row once, not once per hourly retry", async () => {
    const db = testDb();
    const playerId = await insertPlayer(db, { email: "edward@example.test" });
    const soleOwned = await insertGame(db);
    await insertMembership(db, soleOwned, playerId, { role: "owner" });

    await erasePlayer({ db, playerId, now: NOW, withdraw: noWithdraw });
    const later = new Date(NOW.getTime() + 60 * 60 * 1000);
    const again = await erasePlayer({ db, playerId, now: later, withdraw: noWithdraw });

    expect(again).toEqual({ kind: "blocked", gameIds: [soleOwned] });
    const rows = await db.select().from(auditLog);
    expect(rows).toHaveLength(1);
    // And the marker keeps the *first* transition's instant, so "how long has
    // this been stuck?" remains answerable.
    const [row] = await db.select().from(players).where(eq(players.id, playerId));
    expect(row?.erasureBlockedAt?.getTime()).toBe(NOW.getTime());
  });

  /**
   * The other half of "once per transition": a block that is resolved and then
   * happens again is a second, real event, and must be recorded as one.
   */
  it("records a second block after a run has got past the pre-check", async () => {
    const db = testDb();
    const playerId = await insertPlayer(db, { email: "edward@example.test" });
    const gameId = await insertGame(db);
    await insertMembership(db, gameId, playerId, { role: "owner" });

    // Blocked: the only organiser.
    await erasePlayer({ db, playerId, now: NOW, withdraw: noWithdraw });
    expect(await db.select().from(auditLog)).toHaveLength(1);

    // What a run that gets past the pre-check does to the marker, done
    // directly: reaching that state for real means a handover, a completed
    // erasure, and nothing left to block. Clearing it is the whole mechanism
    // under test — a later block is a new event and must be recorded again.
    await db.update(players).set({ erasureBlockedAt: null }).where(eq(players.id, playerId));

    const later = new Date(NOW.getTime() + 2 * 60 * 60 * 1000);
    await erasePlayer({ db, playerId, now: later, withdraw: noWithdraw });

    const rows = await db.select().from(auditLog);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.action === "player.erasure_blocked")).toBe(true);
  });

  /**
   * Important 1's marker. Everything past the pre-check writes, and none of it
   * can be undone — so the row has to say so before the first removal, not
   * after the last write.
   */
  it("marks execution as started, and keeps the first run's instant on a retry", async () => {
    const db = testDb();
    const playerId = await insertPlayer(db, { email: "edward@example.test" });

    await erasePlayer({ db, playerId, now: NOW, withdraw: noWithdraw });

    const [row] = await db.select().from(players).where(eq(players.id, playerId));
    expect(row?.erasureStartedAt?.getTime()).toBe(NOW.getTime());
    expect(row?.erasedAt?.getTime()).toBe(NOW.getTime());
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

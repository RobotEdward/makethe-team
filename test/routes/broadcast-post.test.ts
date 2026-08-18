import { SELF } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { auditLog, emailQuota, notificationLog, players } from "../../src/db/schema.js";
import { MAX_BROADCASTS_PER_GAME_PER_DAY } from "../../src/domain/broadcast-limit.js";
import { MAX_MESSAGE_LENGTH } from "../../src/domain/broadcast-form.js";
import {
  insertFixture,
  insertGame,
  insertMembership,
  insertPlayer,
  insertResponse,
  resetDatabase,
  testDb,
} from "../support/factories.js";
import { ALLOWED, ORIGIN, signIn } from "../support/sign-in.js";

/**
 * Sending a quick message (M15 spec §2, §7, §8, N-10) — the two `POST`
 * routes behind the compose pages `test/routes/broadcast-get.test.ts`
 * covers. Every case here is about what the *send* does: the audit row that
 * doubles as the daily cap's counter, the recipients actually reached, and
 * the refusals that must preserve what the organiser typed.
 */

/** A form POST with the origin the app requires, matching `test/routes/team-publish.test.ts`. */
function appPost(path: string, fields: Record<string, string>, cookie: string, origin: string = ORIGIN) {
  return SELF.fetch(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin, cookie },
    body: new URLSearchParams(fields),
    redirect: "manual",
  });
}

async function ownerSession(): Promise<{ cookie: string; viewerId: string }> {
  const { cookie } = await signIn();
  const db = testDb();
  const [viewer] = await db.select().from(players).where(eq(players.email, ALLOWED));
  return { cookie, viewerId: viewer!.id };
}

/**
 * Drains whatever `waitUntil` is doing, the same wait `team-publish.test.ts`
 * uses for N-9: polls `notification_log` until at least `atLeast` rows exist
 * and none is still `queued`, or a deadline passes. `atLeast` matters and
 * cannot default to zero — a deferred send deletes its own rows
 * (`applySendResult`), so an empty table is indistinguishable from "nothing
 * has run yet" and from "everything ran and was deferred" unless the caller
 * says which one it expects.
 */
async function settleSend(atLeast: number, timeoutMs = 2000): Promise<void> {
  const db = testDb();
  const deadline = Date.now() + timeoutMs;
  const settled = (rows: Array<{ status: string }>) => rows.length >= atLeast && rows.every((row) => row.status !== "queued");
  let rows = await db.select().from(notificationLog);
  while (!settled(rows) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    rows = await db.select().from(notificationLog);
  }
}

/**
 * Waits a beat for a background `waitUntil` that is expected to produce no
 * lasting `notification_log` row at all — a route-level 422 refusal (nothing
 * ever queued), or a ceiling deferral (queued, then deleted). `settleSend`
 * cannot express either: it polls for rows to *appear*, and both of these
 * leave the table empty throughout, which `settleSend`'s loop would treat as
 * already settled before the background task has even started.
 */
async function pauseForBackground(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 150));
}

/** A game with one organiser and one addressable member, ready to message. */
async function seedGame(ownerPlayerId: string): Promise<{ gameId: string; memberId: string }> {
  const db = testDb();
  const gameId = await insertGame(db);
  await insertMembership(db, gameId, ownerPlayerId, { role: "owner" });
  const memberId = await insertPlayer(db, { name: "Member One" });
  await insertMembership(db, gameId, memberId);
  return { gameId, memberId };
}

/** The same game plus one open fixture with one `in` and one `pending` player. */
async function seedFixture(
  ownerPlayerId: string,
): Promise<{ gameId: string; fixtureId: string; inPlayerId: string; pendingPlayerId: string }> {
  const db = testDb();
  const { gameId } = await seedGame(ownerPlayerId);
  const fixtureId = await insertFixture(db, gameId);

  const inPlayerId = await insertPlayer(db, { name: "Playing Player" });
  await insertMembership(db, gameId, inPlayerId);
  await insertResponse(db, fixtureId, inPlayerId, { status: "in" });

  const pendingPlayerId = await insertPlayer(db, { name: "Pending Player" });
  await insertMembership(db, gameId, pendingPlayerId);
  await insertResponse(db, fixtureId, pendingPlayerId, { status: "pending" });

  return { gameId, fixtureId, inPlayerId, pendingPlayerId };
}

const VALID_FIELDS = { subject: "Change of time", message: "Kick-off has moved to 7:30.", email: "on", push: "on" };

describe("POST /g/:id/f/:fixtureId/message", () => {
  beforeEach(resetDatabase);

  it("redirects, writes one audit row, and emails exactly the `in` players under n10 keys", async () => {
    const { cookie, viewerId } = await ownerSession();
    const { gameId, fixtureId, inPlayerId } = await seedFixture(viewerId);

    const response = await appPost(
      `/g/${gameId}/f/${fixtureId}/message`,
      { ...VALID_FIELDS, audience: "playing" },
      cookie,
    );
    await settleSend(1);

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`/g/${gameId}/f/${fixtureId}`);

    const rows = await testDb().select().from(auditLog).where(eq(auditLog.action, "game.broadcast_sent"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorPlayerId: viewerId, entityType: "game", entityId: gameId });

    const sent = await testDb().select().from(notificationLog);
    expect(sent.map((row) => row.playerId).sort()).toEqual([inPlayerId].sort());
    for (const row of sent) {
      expect(row.dedupeKey).toMatch(/^n10:/);
      expect(row.fixtureId).toBe(fixtureId);
      expect(row.status).toBe("sent");
    }
  });

  it("records the audience, channels, count, fixture id and subject on the audit row — never the message body", async () => {
    const { cookie, viewerId } = await ownerSession();
    const { gameId, fixtureId } = await seedFixture(viewerId);

    await appPost(`/g/${gameId}/f/${fixtureId}/message`, { ...VALID_FIELDS, audience: "playing" }, cookie);
    await settleSend(1);

    const [row] = await testDb().select().from(auditLog).where(eq(auditLog.action, "game.broadcast_sent"));
    const after = JSON.parse(row!.afterJson!) as {
      audience: string;
      channels: { email: boolean; push: boolean };
      recipientCount: number;
      fixtureId: string | null;
      subject: string;
    };
    expect(after).toEqual({
      audience: "playing",
      channels: { email: true, push: true },
      recipientCount: 1,
      fixtureId,
      subject: "Change of time",
    });
    expect(row!.afterJson).not.toContain("Kick-off has moved");
  });

  it("neither channel checked refuses at 422, keeping the typed subject and message on the page", async () => {
    const { cookie, viewerId } = await ownerSession();
    const { gameId, fixtureId } = await seedFixture(viewerId);

    const response = await appPost(
      `/g/${gameId}/f/${fixtureId}/message`,
      { subject: "Heads up", message: "Bring bibs please.", audience: "playing" },
      cookie,
    );
    const body = await response.text();
    await pauseForBackground();

    expect(response.status).toBe(422);
    expect(body).toContain("Heads up");
    expect(body).toContain("Bring bibs please.");
    expect(await testDb().select().from(notificationLog)).toEqual([]);
    expect(await testDb().select().from(auditLog).where(eq(auditLog.action, "game.broadcast_sent"))).toEqual([]);
  });

  it("an over-long message refuses at 422 and sends nothing", async () => {
    const { cookie, viewerId } = await ownerSession();
    const { gameId, fixtureId } = await seedFixture(viewerId);

    const response = await appPost(
      `/g/${gameId}/f/${fixtureId}/message`,
      { ...VALID_FIELDS, audience: "playing", message: "x".repeat(MAX_MESSAGE_LENGTH + 1) },
      cookie,
    );
    await pauseForBackground();

    expect(response.status).toBe(422);
    expect(await testDb().select().from(notificationLog)).toEqual([]);
    expect(await testDb().select().from(auditLog).where(eq(auditLog.action, "game.broadcast_sent"))).toEqual([]);
  });

  it("caps at three a day: the third succeeds, the fourth is refused with the cap named", async () => {
    const { cookie, viewerId } = await ownerSession();
    const { gameId, fixtureId } = await seedFixture(viewerId);

    for (let i = 0; i < MAX_BROADCASTS_PER_GAME_PER_DAY; i++) {
      const response = await appPost(
        `/g/${gameId}/f/${fixtureId}/message`,
        { ...VALID_FIELDS, audience: "playing" },
        cookie,
      );
      expect(response.status, `send ${i + 1} of ${MAX_BROADCASTS_PER_GAME_PER_DAY}`).toBe(303);
      await settleSend(i + 1);
    }

    const fourth = await appPost(
      `/g/${gameId}/f/${fixtureId}/message`,
      { ...VALID_FIELDS, audience: "playing" },
      cookie,
    );
    const body = await fourth.text();
    await pauseForBackground();

    expect(fourth.status).toBe(422);
    expect(body).toMatch(new RegExp(`${MAX_BROADCASTS_PER_GAME_PER_DAY}`));
    const rows = await testDb().select().from(auditLog).where(eq(auditLog.action, "game.broadcast_sent"));
    expect(rows).toHaveLength(MAX_BROADCASTS_PER_GAME_PER_DAY);
  });

  it("does not count yesterday's audit rows toward today's cap", async () => {
    const { cookie, viewerId } = await ownerSession();
    const { gameId, fixtureId } = await seedFixture(viewerId);
    const db = testDb();

    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    for (let i = 0; i < MAX_BROADCASTS_PER_GAME_PER_DAY; i++) {
      await db.insert(auditLog).values({
        id: crypto.randomUUID(),
        actorPlayerId: viewerId,
        entityType: "game",
        entityId: gameId,
        action: "game.broadcast_sent",
        afterJson: JSON.stringify({
          audience: "playing",
          channels: { email: true, push: true },
          recipientCount: 1,
          fixtureId,
          subject: "Yesterday's message",
        }),
        createdAt: yesterday,
      });
    }

    const response = await appPost(
      `/g/${gameId}/f/${fixtureId}/message`,
      { ...VALID_FIELDS, audience: "playing" },
      cookie,
    );
    await settleSend(1);

    expect(response.status).toBe(303);
    // Three seeded yesterday, plus the one just sent: the cap did not see
    // yesterday's rows, so today's send was not refused.
    const rows = await db.select().from(auditLog).where(eq(auditLog.action, "game.broadcast_sent"));
    expect(rows).toHaveLength(MAX_BROADCASTS_PER_GAME_PER_DAY + 1);
  });

  it("404s for a non-organiser, sending nothing and writing no audit row", async () => {
    const { cookie, viewerId } = await ownerSession();
    const db = testDb();
    const strangerOwner = await insertPlayer(db, { name: "Someone Else" });
    const { gameId, fixtureId } = await seedFixture(strangerOwner);
    await insertMembership(db, gameId, viewerId);

    const response = await appPost(
      `/g/${gameId}/f/${fixtureId}/message`,
      { ...VALID_FIELDS, audience: "playing" },
      cookie,
    );
    await pauseForBackground();

    expect(response.status).toBe(404);
    expect(await testDb().select().from(notificationLog)).toEqual([]);
    expect(await testDb().select().from(auditLog).where(eq(auditLog.action, "game.broadcast_sent"))).toEqual([]);
  });

  it("404s for a fixture belonging to another game", async () => {
    const { cookie, viewerId } = await ownerSession();
    const { gameId } = await seedFixture(viewerId);
    const other = await seedFixture(viewerId);

    const response = await appPost(
      `/g/${gameId}/f/${other.fixtureId}/message`,
      { ...VALID_FIELDS, audience: "playing" },
      cookie,
    );

    expect(response.status).toBe(404);
  });

  it("writes the audit row even when the send itself fails to deliver, because it is the counter", async () => {
    const { cookie, viewerId } = await ownerSession();
    const { gameId, fixtureId } = await seedFixture(viewerId);
    const db = testDb();
    // The global daily email ceiling (TR-31), pre-filled so every email leg
    // of this send is refused by `QuotaNotifier` — the send fails to deliver
    // on the one channel asked for, entirely independently of whether the
    // audit row (this game's rate-limit counter) was written.
    const today = new Date(Date.now()).toISOString().slice(0, 10);
    await db
      .insert(emailQuota)
      .values({ day: today, sentCount: 50 })
      .onConflictDoUpdate({ target: emailQuota.day, set: { sentCount: 50 } });

    const response = await appPost(
      `/g/${gameId}/f/${fixtureId}/message`,
      { subject: "Ceiling test", message: "This will not deliver.", email: "on", audience: "playing" },
      cookie,
    );
    // A ceiling refusal deletes the row it queued, so the table ends up
    // empty either way — the same reason `settleSend` cannot be used here.
    await pauseForBackground();

    expect(response.status).toBe(303);
    // The ceiling refusal deletes its `notification_log` row (`applySendResult`).
    expect(await testDb().select().from(notificationLog)).toEqual([]);
    // But the counter stands — it was written before the send was ever attempted.
    const rows = await testDb().select().from(auditLog).where(eq(auditLog.action, "game.broadcast_sent"));
    expect(rows).toHaveLength(1);
  });
});

describe("POST /g/:id/message", () => {
  beforeEach(resetDatabase);

  it("writes an audit row with a null fixture id and sends to the whole squad with a null fixture_id", async () => {
    const { cookie, viewerId } = await ownerSession();
    const { gameId, memberId } = await seedGame(viewerId);

    const response = await appPost(`/g/${gameId}/message`, VALID_FIELDS, cookie);
    await settleSend(2);

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`/g/${gameId}`);

    const [row] = await testDb().select().from(auditLog).where(eq(auditLog.action, "game.broadcast_sent"));
    const after = JSON.parse(row!.afterJson!) as { fixtureId: string | null; audience: string };
    expect(after.fixtureId).toBeNull();
    expect(after.audience).toBe("everyone");

    const sent = await testDb().select().from(notificationLog);
    // Owner (with an email from sign-in) plus the one addressable member.
    expect(sent.map((r) => r.playerId).sort()).toEqual([memberId, viewerId].sort());
    for (const r of sent) expect(r.fixtureId).toBeNull();
  });

  it("404s for a signed-in stranger, sending nothing", async () => {
    const { cookie } = await ownerSession();
    const db = testDb();
    const otherOwner = await insertPlayer(db);
    const gameId = await insertGame(db);
    await insertMembership(db, gameId, otherOwner, { role: "owner" });

    const response = await appPost(`/g/${gameId}/message`, VALID_FIELDS, cookie);
    await pauseForBackground();

    expect(response.status).toBe(404);
    expect(await testDb().select().from(notificationLog)).toEqual([]);
    expect(await testDb().select().from(auditLog).where(eq(auditLog.action, "game.broadcast_sent"))).toEqual([]);
  });

  it("403s a cross-origin submission before touching anything", async () => {
    const { cookie, viewerId } = await ownerSession();
    const { gameId } = await seedGame(viewerId);

    const response = await appPost(`/g/${gameId}/message`, VALID_FIELDS, cookie, "https://evil.example");

    expect(response.status).toBe(403);
    expect(await testDb().select().from(auditLog).where(eq(auditLog.action, "game.broadcast_sent"))).toEqual([]);
  });
});

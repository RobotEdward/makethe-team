import { SELF, env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { auditLog, notificationLog, players } from "../../src/db/schema.js";
import { MAX_BROADCASTS_PER_GAME_PER_DAY } from "../../src/domain/broadcast-limit.js";
import { MAX_MESSAGE_LENGTH } from "../../src/domain/broadcast-form.js";
import {
  fillEmailQuota,
  insertFixture,
  insertGame,
  insertMembership,
  insertPlayer,
  insertResponse,
  insertSubscription,
  resetDatabase,
  setAdminSwitch,
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
 * Waits for `backgroundSend`'s ceiling-deferral write — the
 * `game.broadcast_email_deferred` audit row `recordCeilingDeferral` writes
 * once `sendBroadcast` has returned and `applySendResult` has already
 * deleted every ceiling-refused `notification_log` row. Polling for *this*
 * row, rather than sleeping a fixed amount, is what makes "nothing was
 * sent" checks that follow non-vacuous: a fixed sleep can expire before a
 * slow (or buggy, row-leaking) background task finishes, and the assertion
 * would then pass on an empty table for the wrong reason. The timeout is
 * only a backstop against a background task that never finishes at all.
 */
async function settleDeferral(atLeast: number, timeoutMs = 2000): Promise<void> {
  const db = testDb();
  const deadline = Date.now() + timeoutMs;
  const read = () => db.select().from(auditLog).where(eq(auditLog.action, "game.broadcast_email_deferred"));
  let rows = await read();
  while (rows.length < atLeast && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    rows = await read();
  }
}

/**
 * Polls for `backgroundSend`'s own `catch` having logged, rather than
 * sleeping a fixed amount and hoping — the same reasoning as `settleDeferral`.
 * `spy` is a `console.error` mock the caller installs; `match` identifies the
 * one call this test is waiting for among any other `console.error` traffic.
 */
async function settleLoggedError(spy: { mock: { calls: unknown[][] } }, match: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const seen = () => spy.mock.calls.some((call) => typeof call[0] === "string" && call[0].includes(match));
  while (!seen() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
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
    const location = response.headers.get("location")!;
    expect(location.split("?")[0]).toBe(`/g/${gameId}/f/${fixtureId}`);
    expect(location).toMatch(/\?sent=\d+&via=(email|push|both)$/);

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

  it("refuses an email broadcast the administrator has switched off, even though the box was never rendered (TR-18)", async () => {
    const { cookie, viewerId } = await ownerSession();
    const { gameId, fixtureId } = await seedFixture(viewerId);
    await setAdminSwitch(testDb(), "n10", "email", false);

    const response = await appPost(
      `/g/${gameId}/f/${fixtureId}/message`,
      { ...VALID_FIELDS, audience: "playing" },
      cookie,
    );

    expect(response.status).toBe(404);
    expect(await testDb().select().from(notificationLog)).toEqual([]);
    expect(await testDb().select().from(auditLog).where(eq(auditLog.action, "game.broadcast_sent"))).toEqual([]);
  });

  it("still sends a push-only broadcast when email is switched off", async () => {
    const { cookie, viewerId } = await ownerSession();
    const { gameId, fixtureId, inPlayerId } = await seedFixture(viewerId);
    await insertSubscription(testDb(), inPlayerId, "https://push.example.com/in-player");
    await setAdminSwitch(testDb(), "n10", "email", false);

    const response = await appPost(
      `/g/${gameId}/f/${fixtureId}/message`,
      { subject: "Change of time", message: "Kick-off has moved to 7:30.", push: "on", audience: "playing" },
      cookie,
    );
    await settleSend(1);

    expect(response.status).toBe(303);
    const sent = await testDb().select().from(notificationLog);
    expect(sent.map((row) => row.channel)).toEqual(["push"]);
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

    // No `waitUntil` is ever registered on this path — `parseBroadcastForm`
    // fails before `recordAudit`/the send — so nothing here is racing a
    // background task and no wait is needed.
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

    // No `waitUntil` is registered on a form-validation refusal — see the
    // previous test.
    expect(response.status).toBe(422);
    expect(await testDb().select().from(notificationLog)).toEqual([]);
    expect(await testDb().select().from(auditLog).where(eq(auditLog.action, "game.broadcast_sent"))).toEqual([]);
  });

  it("a zero-recipient audience refuses at 422, keeping what was typed, writing no audit row and sending nothing", async () => {
    const { cookie, viewerId } = await ownerSession();
    const { gameId, fixtureId } = await seedFixture(viewerId);

    // "waitlisted" has nobody in `seedFixture` — one `in`, one `pending` —
    // so this is the same zero-recipient shape the compose page showed at
    // 390px/1280px with the default (empty) audience. Spelled exactly as
    // `BROADCAST_AUDIENCES` spells it: a value the parser does not recognise
    // would be refused as a *form* error instead, and this case would never
    // reach the check it is named for.
    const response = await appPost(
      `/g/${gameId}/f/${fixtureId}/message`,
      { ...VALID_FIELDS, audience: "waitlisted" },
      cookie,
    );
    const body = await response.text();

    // No `waitUntil` is registered here either: the check runs before
    // `recordAudit`/the send, so — like the form-validation refusals above —
    // nothing here is racing a background task.
    expect(response.status).toBe(422);
    expect(body).toContain("Change of time");
    expect(body).toContain("Kick-off has moved to 7:30.");
    expect(await testDb().select().from(notificationLog)).toEqual([]);
    expect(await testDb().select().from(auditLog).where(eq(auditLog.action, "game.broadcast_sent"))).toEqual([]);
  });

  it("a zero-recipient refusal does not spend a daily send: three waitlist attempts still leave all three sends available", async () => {
    const { cookie, viewerId } = await ownerSession();
    const { gameId, fixtureId } = await seedFixture(viewerId);

    for (let i = 0; i < MAX_BROADCASTS_PER_GAME_PER_DAY + 1; i++) {
      const response = await appPost(
        `/g/${gameId}/f/${fixtureId}/message`,
        { ...VALID_FIELDS, audience: "waitlisted" },
        cookie,
      );
      expect(response.status).toBe(422);
    }

    const succeeds = await appPost(
      `/g/${gameId}/f/${fixtureId}/message`,
      { ...VALID_FIELDS, audience: "playing" },
      cookie,
    );
    await settleSend(1);

    expect(succeeds.status).toBe(303);
    const rows = await testDb().select().from(auditLog).where(eq(auditLog.action, "game.broadcast_sent"));
    expect(rows).toHaveLength(1);
  });

  it("a push-only send to an audience where nobody has a device is refused, spending no send and writing no audit row", async () => {
    const { cookie, viewerId } = await ownerSession();
    const { gameId, fixtureId } = await seedFixture(viewerId);

    // `seedFixture`'s players all have an email and no registered device, so
    // the audience is not empty — an audience-only check passes here, spends
    // one of the three daily sends and delivers nothing (spec §5).
    const response = await appPost(
      `/g/${gameId}/f/${fixtureId}/message`,
      { subject: "Change of time", message: "Kick-off has moved to 7:30.", push: "on", audience: "playing" },
      cookie,
    );
    const body = await response.text();

    expect(response.status).toBe(422);
    expect(body).toContain("Change of time");
    expect(body).toContain("Kick-off has moved to 7:30.");
    expect(body).toContain("registered for push");
    expect(await testDb().select().from(notificationLog)).toEqual([]);
    expect(await testDb().select().from(auditLog).where(eq(auditLog.action, "game.broadcast_sent"))).toEqual([]);

    // The refusal came before the cap's counter, so all three sends remain.
    const after = await appPost(`/g/${gameId}/f/${fixtureId}/message`, { ...VALID_FIELDS, audience: "playing" }, cookie);
    await settleSend(1);
    expect(after.status).toBe(303);
  });

  it("an email-only send to an audience whose every member is device-only is refused", async () => {
    const { cookie, viewerId } = await ownerSession();
    const { gameId, fixtureId } = await seedFixture(viewerId);
    const db = testDb();

    // One waitlisted player, no address, one registered device: reachable by
    // push, and by nothing else.
    const deviceOnly = await insertPlayer(db, { name: "Device Only", email: null });
    await insertMembership(db, gameId, deviceOnly);
    await insertResponse(db, fixtureId, deviceOnly, { status: "waitlisted" });
    await insertSubscription(db, deviceOnly, "https://push.example/device-only");

    const response = await appPost(
      `/g/${gameId}/f/${fixtureId}/message`,
      { subject: "Change of time", message: "Kick-off has moved to 7:30.", email: "on", audience: "waitlisted" },
      cookie,
    );
    const body = await response.text();

    expect(response.status).toBe(422);
    expect(body).toContain("an email address");
    expect(await testDb().select().from(notificationLog)).toEqual([]);
    expect(await testDb().select().from(auditLog).where(eq(auditLog.action, "game.broadcast_sent"))).toEqual([]);
  });

  it("a push-only send to an audience that does have a device goes through", async () => {
    const { cookie, viewerId } = await ownerSession();
    const { gameId, fixtureId } = await seedFixture(viewerId);
    const db = testDb();

    const withDevice = await insertPlayer(db, { name: "Has Device" });
    await insertMembership(db, gameId, withDevice);
    await insertResponse(db, fixtureId, withDevice, { status: "waitlisted" });
    await insertSubscription(db, withDevice, "https://push.example/has-device");

    const response = await appPost(
      `/g/${gameId}/f/${fixtureId}/message`,
      { subject: "Change of time", message: "Kick-off has moved to 7:30.", push: "on", audience: "waitlisted" },
      cookie,
    );

    expect(response.status).toBe(303);
    const [row] = await testDb().select().from(auditLog).where(eq(auditLog.action, "game.broadcast_sent"));
    const after = JSON.parse(row!.afterJson!) as { channels: { email: boolean; push: boolean }; recipientCount: number };
    expect(after.channels).toEqual({ email: false, push: true });
    // The one waitlisted player with a device — not the fixture's other
    // responders, who are on no ticked channel.
    expect(after.recipientCount).toBe(1);
    await settleSend(1);
  });

  it("refuses a forged audience=everyone rather than sending game-wide from a fixture page", async () => {
    const { cookie, viewerId } = await ownerSession();
    const { gameId, fixtureId } = await seedFixture(viewerId);
    const db = testDb();
    // Somebody in the squad who answered nothing on this fixture: the person
    // a game-wide send would reach and a fixture-scoped one must not.
    const nonResponder = await insertPlayer(db, { name: "No Response" });
    await insertMembership(db, gameId, nonResponder);

    const response = await appPost(
      `/g/${gameId}/f/${fixtureId}/message`,
      { ...VALID_FIELDS, audience: "everyone" },
      cookie,
    );
    const body = await response.text();

    // `everyone` resolves from `memberships` and `sendBroadcast` nulls the
    // fixture out for it, so honouring it here would send to the whole game
    // while the audit row recorded a fixture-derived count.
    expect(response.status).toBe(422);
    expect(body).toContain("Change of time");
    expect(body).toContain("Kick-off has moved to 7:30.");
    expect(body).toContain("Pick who this message goes to.");
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

    // The cap refusal, like the form-validation refusal, returns before
    // `recordAudit`/`waitUntil` ever run — nothing to wait for.
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

    // The 404 fires before the handler ever reads the form — no background
    // task is registered.
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

  it("writes the audit row before the redirect, before the send is even attempted — and it survives a failed delivery (TR-31 ceiling)", async () => {
    const { cookie, viewerId } = await ownerSession();
    const { gameId, fixtureId } = await seedFixture(viewerId);
    const db = testDb();
    // The global daily email ceiling (TR-31), pre-filled so every email leg
    // of this send is refused by `QuotaNotifier` — the send fails to deliver
    // on the one channel asked for, entirely independently of whether the
    // audit row (this game's rate-limit counter) was written.
    const today = new Date(Date.now()).toISOString().slice(0, 10);
    await fillEmailQuota(db, today);

    const response = await appPost(
      `/g/${gameId}/f/${fixtureId}/message`,
      { subject: "Ceiling test", message: "This will not deliver.", email: "on", audience: "playing" },
      cookie,
    );

    // Read straight after the response, before any wait: the route awaits
    // `recordAudit` itself, ahead of `c.executionCtx.waitUntil`, so the row
    // must already exist here. An implementation that instead wrote it from
    // *inside* the `waitUntil` continuation would still pass every other
    // assertion in this file — `sendBroadcast` returns normally on a
    // ceiling refusal rather than throwing — so this is the one check that
    // actually binds "written before the send", not merely "not removed by
    // a failed send".
    expect(response.status).toBe(303);
    const rows = await testDb().select().from(auditLog).where(eq(auditLog.action, "game.broadcast_sent"));
    expect(rows).toHaveLength(1);

    // Now wait for the background continuation to actually finish — proven
    // by its own durable record, `game.broadcast_email_deferred` — rather
    // than a fixed sleep.
    await settleDeferral(1);

    // The ceiling refusal deletes its `notification_log` row (`applySendResult`).
    expect(await testDb().select().from(notificationLog)).toEqual([]);
    // The counter itself is untouched by the failed delivery.
    expect(await testDb().select().from(auditLog).where(eq(auditLog.action, "game.broadcast_sent"))).toHaveLength(1);
  });

  it("names the broadcast and the deferred players on the durable ceiling record (TR-31, N-10)", async () => {
    const { cookie, viewerId } = await ownerSession();
    const { gameId, fixtureId, inPlayerId } = await seedFixture(viewerId);
    const db = testDb();
    const today = new Date(Date.now()).toISOString().slice(0, 10);
    await fillEmailQuota(db, today);

    await appPost(
      `/g/${gameId}/f/${fixtureId}/message`,
      { subject: "Ceiling test", message: "This will not deliver.", email: "on", audience: "playing" },
      cookie,
    );
    await settleDeferral(1);

    const [deferral] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "game.broadcast_email_deferred"));
    // A game entity id, not a fixture — this caller has no single fixture
    // for a game-scoped send, so `recordCeilingDeferral`'s widened
    // `entityType`/`entityId` is what makes this call possible at all.
    expect(deferral).toMatchObject({ actorPlayerId: null, entityType: "game", entityId: gameId });
    const after = JSON.parse(deferral!.afterJson!) as {
      notificationType: string;
      playerIds: string[];
      broadcastId: string;
    };
    expect(after.notificationType).toBe("n10");
    expect(after.playerIds).toEqual([inPlayerId]);
    // `entityId` names the game, not the message — `broadcastId` is what
    // says *which* broadcast this deferral belongs to.
    expect(after.broadcastId).toEqual(expect.any(String));
  });

  it("logs and does not crash when the background send itself throws", async () => {
    const { cookie, viewerId } = await ownerSession();
    const { gameId, fixtureId } = await seedFixture(viewerId);
    // `signLeaveToken` throws synchronously on an unusable secret
    // (`isUsableSecret`, `src/domain/token.ts`) — the one call in
    // `sendBroadcast`'s recipient loop that is not already wrapped in its
    // own `try`/`catch`, so this reaches `backgroundSend`'s own `catch`
    // rather than one of `sendBroadcast`'s internal ones.
    const previousSecret = env.RESPONSE_TOKEN_SECRET;
    env.RESPONSE_TOKEN_SECRET = "";
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await appPost(
        `/g/${gameId}/f/${fixtureId}/message`,
        { ...VALID_FIELDS, audience: "playing" },
        cookie,
      );
      await settleLoggedError(errorSpy, `on game ${gameId} failed:`);

      expect(response.status).toBe(303);
      // The audit row — the counter — was written before the throw could
      // happen at all.
      expect(
        await testDb().select().from(auditLog).where(eq(auditLog.action, "game.broadcast_sent")),
      ).toHaveLength(1);
      // Nothing was queued: the throw happens before `insertQueuedLogRows`.
      expect(await testDb().select().from(notificationLog)).toEqual([]);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(`on game ${gameId} failed:`));
    } finally {
      env.RESPONSE_TOKEN_SECRET = previousSecret;
      errorSpy.mockRestore();
    }
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
    const location = response.headers.get("location")!;
    expect(location.split("?")[0]).toBe(`/g/${gameId}`);
    expect(location).toMatch(/\?sent=\d+&via=(email|push|both)$/);

    const [row] = await testDb().select().from(auditLog).where(eq(auditLog.action, "game.broadcast_sent"));
    const after = JSON.parse(row!.afterJson!) as { fixtureId: string | null; audience: string };
    expect(after.fixtureId).toBeNull();
    expect(after.audience).toBe("everyone");

    const sent = await testDb().select().from(notificationLog);
    // Owner (with an email from sign-in) plus the one addressable member.
    expect(sent.map((r) => r.playerId).sort()).toEqual([memberId, viewerId].sort());
    for (const r of sent) expect(r.fixtureId).toBeNull();
  });

  it("counts only who the ticked channels reach on the audit row, not the whole audience", async () => {
    const { cookie, viewerId } = await ownerSession();
    const { gameId, memberId } = await seedGame(viewerId);
    const db = testDb();

    // A third member reachable by push alone: in the squad, and in no email.
    const deviceOnly = await insertPlayer(db, { name: "Device Only", email: null });
    await insertMembership(db, gameId, deviceOnly);
    await insertSubscription(db, deviceOnly, "https://push.example/device-only");

    const response = await appPost(
      `/g/${gameId}/message`,
      { subject: "Change of time", message: "Kick-off has moved to 7:30.", email: "on" },
      cookie,
    );
    await settleSend(2);

    expect(response.status).toBe(303);
    const [row] = await testDb().select().from(auditLog).where(eq(auditLog.action, "game.broadcast_sent"));
    const after = JSON.parse(row!.afterJson!) as { recipientCount: number };
    // The owner and the ordinary member, both with addresses — three people
    // are in this squad, and the third is on no channel this send uses.
    expect(after.recipientCount).toBe(2);
    const sent = await testDb().select().from(notificationLog);
    expect(sent.map((r) => r.playerId).sort()).toEqual([memberId, viewerId].sort());
  });

  it("404s for a signed-in stranger, sending nothing", async () => {
    const { cookie } = await ownerSession();
    const db = testDb();
    const otherOwner = await insertPlayer(db);
    const gameId = await insertGame(db);
    await insertMembership(db, gameId, otherOwner, { role: "owner" });

    const response = await appPost(`/g/${gameId}/message`, VALID_FIELDS, cookie);

    // No `waitUntil` is registered on a 404 — nothing to wait for.
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

import { SELF, env } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { auditLog, emailQuota, fixtures, games, notificationLog, players, responses } from "../../src/db/schema.js";
import type { Lifecycle } from "../../src/domain/lifecycle.js";
import { openFixture } from "../../src/domain/open-fixture.js";
import { insertGame, insertMembership, insertPlayer, resetDatabase, testDb } from "../support/factories.js";
import { ALLOWED, ORIGIN, signIn } from "../support/sign-in.js";
import { kickoffIn } from "../support/clock.js";

/**
 * Publishing a team pick (BR-35 §4) — the act that sets `teams_published_at`,
 * files the `fixture.teams_published` audit row and sends N-9 to the squad.
 *
 * The complement of `test/routes/team-picker.test.ts`, which proves the save
 * route tells *nobody*. Everything in this file is about the moment that
 * changes, so every test here either asserts an email exists or asserts,
 * deliberately, that none does.
 */

/** A form POST with the origin the app requires, matching `test/routes/team-picker.test.ts`. */
function appPost(path: string, fields: Record<string, string>, cookie: string, origin: string = ORIGIN) {
  return SELF.fetch(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin, cookie },
    body: new URLSearchParams(fields),
    redirect: "manual",
  });
}

const NOW = new Date("2026-08-13T09:00:00Z");

/**
 * Drains the N-9 `waitUntil` so it cannot land after the next test's
 * `resetDatabase()` — the same race `test/routes/owner-fixture.test.ts`
 * documents on its own `settleNotifications`.
 */
async function settleNotifications(atLeast: number, timeoutMs = 3000): Promise<Array<typeof notificationLog.$inferSelect>> {
  const db = testDb();
  const deadline = Date.now() + timeoutMs;
  const settled = (rows: Array<{ status: string }>) =>
    rows.length >= atLeast && rows.every((row) => row.status !== "queued");

  let rows = await db.select().from(notificationLog);
  while (!settled(rows) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    rows = await db.select().from(notificationLog);
  }
  return rows;
}

/**
 * The `waitUntil` equivalent of `settleNotifications` for the one outcome that
 * leaves *no* `notification_log` row behind: a ceiling deferral deletes its
 * row and writes an `audit_log` row instead, so that is what there is to wait
 * for.
 */
async function settleDeferrals(atLeast: number, timeoutMs = 3000): Promise<Array<typeof auditLog.$inferSelect>> {
  const db = testDb();
  const deadline = Date.now() + timeoutMs;
  const read = () => db.select().from(auditLog).where(eq(auditLog.action, "fixture.teams_email_deferred"));

  let rows = await read();
  while (rows.length < atLeast && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    rows = await read();
  }
  return rows;
}

/**
 * Waits a beat and then asserts nothing was sent.
 *
 * A refusal that *did* wrongly send would do it inside `waitUntil`, i.e. after
 * the response this test already has in hand, so asserting an empty table
 * immediately would pass whether the guard worked or not. The wait is what
 * gives a wrong implementation time to fail.
 */
async function expectNothingSent(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(await testDb().select().from(notificationLog)).toEqual([]);
}

async function ownerSession(): Promise<{ cookie: string; viewerId: string }> {
  const { cookie } = await signIn();
  const db = testDb();
  const [viewer] = await db.select().from(players).where(eq(players.email, ALLOWED));
  return { cookie, viewerId: viewer!.id };
}

interface Seed {
  gameId: string;
  fixtureId: string;
  ada: string;
  bram: string;
  /** A guest on the fixture: `in`, pickable, and never emailed (BR-32). */
  guest: string;
}

/**
 * A game owned by `ownerPlayerId` with an open fixture: two members with
 * addresses and one guest, all three `in` and all three needing a side before
 * this fixture can be published.
 *
 * Built by driving the app's own capacity object rather than writing
 * `responses` rows by hand, so the world these tests load is one the app could
 * have produced — the guest in particular is a real `addGuest` guest, with the
 * `is_guest` flag and absent address that BR-32 turns on.
 */
async function seedPublishableFixture(ownerPlayerId: string): Promise<Seed> {
  const db = testDb();
  const gameId = await insertGame(db, { maxPlayers: 6, teamAName: "Bibs", teamBName: "Skins" });
  await insertMembership(db, gameId, ownerPlayerId, { role: "owner" });

  const ada = await insertPlayer(db, { name: "Ada Lovelace" });
  const bram = await insertPlayer(db, { name: "Bram Stoker" });
  for (const playerId of [ada, bram]) await insertMembership(db, gameId, playerId);

  const fixtureId = crypto.randomUUID();
  await db.insert(fixtures).values({
    id: fixtureId,
    gameId,
    kicksOffAt: kickoffIn(24 * 7),
    minPlayers: 1,
    maxPlayers: 6,
    prefersEvenNumbers: true,
    shortWarningOffsetHours: 12,
    durationMinutes: 60,
  });
  await openFixture(db, fixtureId, NOW);

  for (const playerId of [ada, bram]) {
    await env.FIXTURE_CAPACITY.getByName(fixtureId).setResponse({
      playerId,
      intent: "in",
      actorPlayerId: null,
      source: "token",
      whenFull: "waitlist",
      now: NOW.getTime(),
    });
  }

  const added = await env.FIXTURE_CAPACITY.getByName(fixtureId).addGuest({
    name: "Gus Guest",
    actorPlayerId: ownerPlayerId,
    whenFull: "refuse",
    now: NOW.getTime(),
  });
  if (added.kind !== "added") throw new Error(`guest not added: ${JSON.stringify(added)}`);

  return { gameId, fixtureId, ada, bram, guest: added.playerId };
}

/** Saves a complete pick through the app's own save route, exactly as the picker would. */
function savePick(seed: Seed, cookie: string, sides: Record<string, string>) {
  return appPost(`/g/${seed.gameId}/f/${seed.fixtureId}/teams`, sides, cookie);
}

function publish(seed: Seed, cookie: string, origin: string = ORIGIN) {
  return appPost(`/g/${seed.gameId}/f/${seed.fixtureId}/teams/publish`, {}, cookie, origin);
}

async function publishedAt(fixtureId: string): Promise<Date | null> {
  const [row] = await testDb().select().from(fixtures).where(eq(fixtures.id, fixtureId));
  return row?.teamsPublishedAt ?? null;
}

function setLifecycle(fixtureId: string, lifecycle: Lifecycle) {
  return testDb().update(fixtures).set({ lifecycle }).where(eq(fixtures.id, fixtureId));
}

/** A complete pick: both members and the guest placed. */
function completePick(seed: Seed): Record<string, string> {
  return { [seed.ada]: "a", [seed.bram]: "b", [seed.guest]: "a" };
}

describe("POST /g/:id/f/:fixtureId/teams/publish", () => {
  beforeEach(resetDatabase);

  it("stamps the fixture and writes one audit row naming the actor and the pick", async () => {
    const { cookie, viewerId } = await ownerSession();
    const seed = await seedPublishableFixture(viewerId);
    await savePick(seed, cookie, completePick(seed));

    const response = await publish(seed, cookie);
    await settleNotifications(2);

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`/g/${seed.gameId}/f/${seed.fixtureId}`);
    expect(await publishedAt(seed.fixtureId)).toBeInstanceOf(Date);

    const rows = await testDb().select().from(auditLog).where(eq(auditLog.action, "fixture.teams_published"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorPlayerId: viewerId, entityType: "fixture", entityId: seed.fixtureId });
    expect(JSON.parse(rows[0]!.afterJson!)).toEqual({
      teams: { [seed.ada]: "a", [seed.bram]: "b", [seed.guest]: "a" },
    });
  });

  it("emails every `in` player with an address, and never the guest (BR-32)", async () => {
    const { cookie, viewerId } = await ownerSession();
    const seed = await seedPublishableFixture(viewerId);
    await savePick(seed, cookie, completePick(seed));

    await publish(seed, cookie);
    const rows = await settleNotifications(2);

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.playerId).sort()).toEqual([seed.ada, seed.bram].sort());
    for (const row of rows) {
      expect(row).toMatchObject({ notificationType: "n9", fixtureId: seed.fixtureId, status: "sent" });
    }
  });

  it("refuses a partial pick, naming everyone still to be picked, and tells nobody", async () => {
    const { cookie, viewerId } = await ownerSession();
    const seed = await seedPublishableFixture(viewerId);
    // Ada is placed; Bram and the guest are left on "Not picked yet" — the
    // state the save route deliberately allows.
    await savePick(seed, cookie, { [seed.ada]: "a", [seed.bram]: "", [seed.guest]: "" });

    const response = await publish(seed, cookie);
    const body = await response.text();

    expect(response.status).toBe(422);
    // The page itself, with the names in the refusal — never a bare error
    // page, and never a count the organiser has to translate back into people.
    // Asserted on the whole sentence, because every one of these names also
    // appears in the squad list above it: a substring match on "Bram Stoker"
    // alone would pass with no refusal message on the page at all.
    // `(guest)` included: the refusal is read against the picker rows below
    // it, which label the same person "Gus Guest (guest)".
    expect(body).toContain("Still to pick: Bram Stoker, Gus Guest (guest).");
    expect(body).toContain("Save teams");
    expect(await publishedAt(seed.fixtureId)).toBeNull();
    await expectNothingSent();
  });

  it("refuses a fixture nobody has picked at all", async () => {
    const { cookie, viewerId } = await ownerSession();
    const seed = await seedPublishableFixture(viewerId);

    const response = await publish(seed, cookie);

    expect(response.status).toBe(422);
    expect(await publishedAt(seed.fixtureId)).toBeNull();
    await expectNothingSent();
  });

  it("sends a second round after a re-save, under different dedupe keys", async () => {
    const { cookie, viewerId } = await ownerSession();
    const seed = await seedPublishableFixture(viewerId);
    await savePick(seed, cookie, completePick(seed));

    await publish(seed, cookie);
    await settleNotifications(2);
    const first = await publishedAt(seed.fixtureId);

    // The organiser swaps the two sides over and publishes again. This must
    // genuinely re-send: the squad is holding an email describing teams that
    // have since changed.
    //
    // The wait is not padding. `teamsKey` is built from the publish instant at
    // millisecond resolution, so two publishes landing inside one millisecond
    // would mint identical keys, the unique index on `dedupe_key` would
    // swallow the second round, and this test would fail on its own length
    // assertion for a reason that has nothing to do with the behaviour under
    // test. Sleeping forces the wall clock past a millisecond boundary, and
    // the assertion below pins that it actually moved — so a future change
    // that makes the two instants collide fails *there*, naming the cause,
    // rather than intermittently here.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await savePick(seed, cookie, { [seed.ada]: "b", [seed.bram]: "a", [seed.guest]: "b" });
    await publish(seed, cookie);
    const rows = await settleNotifications(4);
    const second = await publishedAt(seed.fixtureId);

    expect(second!.getTime()).toBeGreaterThan(first!.getTime());
    expect(rows).toHaveLength(4);
    const adasKeys = rows.filter((row) => row.playerId === seed.ada).map((row) => row.dedupeKey);
    expect(adasKeys).toHaveLength(2);
    // The publish instant is part of the key (`teamsKey`), so a second publish
    // is a second key rather than being swallowed by the unique index.
    expect(adasKeys[0]).not.toBe(adasKeys[1]);
  });

  it("refuses a fixture nobody is in, rather than announcing teams to nobody", async () => {
    const { cookie, viewerId } = await ownerSession();
    const seed = await seedPublishableFixture(viewerId);
    await savePick(seed, cookie, completePick(seed));
    // Everyone drops out after the pick was made. `unassignedIn` is now empty
    // — there is nobody left to be unassigned — so a guard phrased only as
    // "nobody is missing a side" would let this through, stamp the fixture,
    // email nobody, and leave the page asserting the squad had been told.
    for (const playerId of [seed.ada, seed.bram, seed.guest]) {
      await env.FIXTURE_CAPACITY.getByName(seed.fixtureId).setResponse({
        playerId,
        intent: "out",
        actorPlayerId: null,
        source: "token",
        whenFull: "waitlist",
        now: NOW.getTime(),
      });
    }

    const response = await publish(seed, cookie);

    expect(response.status).toBe(422);
    expect(await publishedAt(seed.fixtureId)).toBeNull();
    await expectNothingSent();
  });

  it("records an audit row naming everyone the daily send ceiling stopped being told (TR-31)", async () => {
    // `MAX_EMAILS_PER_DAY` is "50" (wrangler.jsonc); pre-filling today's quota
    // to the ceiling makes QuotaNotifier refuse every N-9 this publish would
    // send. The refusal deletes each `notification_log` row so a retry stays
    // possible — but nothing retries a publish, and the organiser has already
    // been redirected to a page that now offers "Publish again", asserting the
    // squad was told. This row is the only durable record that they were not.
    const { cookie, viewerId } = await ownerSession();
    const seed = await seedPublishableFixture(viewerId);
    await savePick(seed, cookie, completePick(seed));
    const db = testDb();
    // Upserted, not inserted: signing in above already sent a magic link, so
    // today's quota row exists by the time this test gets here.
    const today = new Date(Date.now()).toISOString().slice(0, 10);
    await db
      .insert(emailQuota)
      .values({ day: today, sentCount: 50 })
      .onConflictDoUpdate({ target: emailQuota.day, set: { sentCount: 50 } });

    const response = await publish(seed, cookie);
    const deferrals = await settleDeferrals(1);

    // The publish itself still stands: the teams *are* picked and published,
    // it is only the telling that failed.
    expect(response.status).toBe(303);
    expect(await publishedAt(seed.fixtureId)).toBeInstanceOf(Date);
    // Deleted, exactly as `applySendResult` does everywhere else — the
    // retryability asymmetry is unchanged.
    expect(await db.select().from(notificationLog)).toEqual([]);

    expect(deferrals).toHaveLength(1);
    expect(deferrals[0]).toMatchObject({ entityId: seed.fixtureId, actorPlayerId: null });
    const after = JSON.parse(deferrals[0]!.afterJson!) as { notificationType: string; playerIds: string[] };
    expect(after.notificationType).toBe("n9");
    // The guest is not in it: BR-32 never had an address to refuse.
    expect(after.playerIds.sort()).toEqual([seed.ada, seed.bram].sort());
  });

  it("writes no deferral row when every teams email went out", async () => {
    const { cookie, viewerId } = await ownerSession();
    const seed = await seedPublishableFixture(viewerId);
    await savePick(seed, cookie, completePick(seed));

    await publish(seed, cookie);
    await settleNotifications(2);

    const deferrals = await testDb()
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "fixture.teams_email_deferred"));
    expect(deferrals).toEqual([]);
  });

  it.each(["scheduled", "played", "cancelled"] as const)("refuses a %s fixture", async (lifecycle) => {
    const { cookie, viewerId } = await ownerSession();
    const seed = await seedPublishableFixture(viewerId);
    await savePick(seed, cookie, completePick(seed));
    await setLifecycle(seed.fixtureId, lifecycle);

    const response = await publish(seed, cookie);

    expect(response.status).toBe(422);
    expect(await response.text()).toContain("isn&#39;t taking changes any more");
    expect(await publishedAt(seed.fixtureId)).toBeNull();
    await expectNothingSent();
  });

  it("404s for a signed-in player who is not an organiser of the game", async () => {
    const { cookie, viewerId } = await ownerSession();
    const db = testDb();
    const strangerOwner = await insertPlayer(db, { name: "Someone Else" });
    const seed = await seedPublishableFixture(strangerOwner);
    // A real member of this game, just not an organiser of it — 404, not 403,
    // and not the partial-pick page, which would confirm the fixture exists
    // and count its squad for them (TR-18).
    await insertMembership(db, seed.gameId, viewerId);

    const response = await publish(seed, cookie);

    expect(response.status).toBe(404);
    expect(await publishedAt(seed.fixtureId)).toBeNull();
    await expectNothingSent();
  });

  it("403s a cross-origin submission before touching anything", async () => {
    const { cookie, viewerId } = await ownerSession();
    const seed = await seedPublishableFixture(viewerId);
    await savePick(seed, cookie, completePick(seed));

    const response = await publish(seed, cookie, "https://evil.example");

    expect(response.status).toBe(403);
    expect(await publishedAt(seed.fixtureId)).toBeNull();
    await expectNothingSent();
  });

  it("redirects an anonymous visitor to sign in", async () => {
    const owner = await insertPlayer(testDb());
    const seed = await seedPublishableFixture(owner);

    const response = await publish(seed, "");

    expect(response.status).toBe(302);
    expect(await publishedAt(seed.fixtureId)).toBeNull();
    await expectNothingSent();
  });

  it("leaves everyone's status and the fixture's counts untouched", async () => {
    const { cookie, viewerId } = await ownerSession();
    const seed = await seedPublishableFixture(viewerId);
    await savePick(seed, cookie, completePick(seed));
    const db = testDb();
    const [before] = await db.select().from(fixtures).where(eq(fixtures.id, seed.fixtureId));

    await publish(seed, cookie);
    await settleNotifications(2);

    // Publishing announces a pick. It must never move anybody in or out.
    const rows = await db.select().from(responses).where(eq(responses.fixtureId, seed.fixtureId));
    expect(rows.filter((row) => row.status === "in")).toHaveLength(3);
    const [after] = await db.select().from(fixtures).where(eq(fixtures.id, seed.fixtureId));
    expect(after).toMatchObject({ inCount: before!.inCount, waitlistCount: before!.waitlistCount });
  });
});

describe("the publish control on GET /g/:id/f/:fixtureId", () => {
  beforeEach(resetDatabase);

  async function page(seed: Seed, cookie: string): Promise<string> {
    return (await SELF.fetch(`${ORIGIN}/g/${seed.gameId}/f/${seed.fixtureId}`, { headers: { cookie } })).text();
  }

  it("offers nothing to publish before anyone has been picked", async () => {
    const { cookie, viewerId } = await ownerSession();
    const seed = await seedPublishableFixture(viewerId);

    const html = await page(seed, cookie);

    expect(html).toContain("Save teams");
    expect(html).not.toContain("/teams/publish");
  });

  it("offers Publish once a pick has been started", async () => {
    const { cookie, viewerId } = await ownerSession();
    const seed = await seedPublishableFixture(viewerId);
    await savePick(seed, cookie, { [seed.ada]: "a" });

    const html = await page(seed, cookie);

    expect(html).toContain(`action="/g/${seed.gameId}/f/${seed.fixtureId}/teams/publish"`);
  });

  it("asks whether to send again once the squad has moved under a published pick", async () => {
    const { cookie, viewerId } = await ownerSession();
    const seed = await seedPublishableFixture(viewerId);
    await savePick(seed, cookie, completePick(seed));
    await publish(seed, cookie);
    await settleNotifications(2);

    // Bram drops out after the teams went out: he still carries a side, which
    // is the only evidence the announced teams no longer match who is playing
    // (`src/domain/teams.ts`).
    await env.FIXTURE_CAPACITY.getByName(seed.fixtureId).setResponse({
      playerId: seed.bram,
      intent: "out",
      actorPlayerId: null,
      source: "token",
      whenFull: "waitlist",
      now: NOW.getTime(),
    });

    const html = await page(seed, cookie);

    expect(html).toContain("last sent out");
    expect(html).toContain("Publish again");
    // The dropped-out player keeps his `team` until the organiser's next save
    // clears it, but he is not `in`, so he is not offered a side any more.
    const [row] = await testDb()
      .select()
      .from(responses)
      .where(and(eq(responses.fixtureId, seed.fixtureId), eq(responses.playerId, seed.bram)));
    expect(row?.team).toBe("b");
  });

  /**
   * The arc the final M9 review walked by hand, end to end, and the one the
   * old single-column design got wrong: the prompt latched on permanently
   * because nothing could ever clear a departed player's side, so the page
   * said the teams had changed since they were last sent out *immediately
   * after they were sent out*, describing exactly the squad that had been
   * sent, for the life of the fixture.
   */
  it("stops asking once the organiser has re-picked and re-published", async () => {
    const { cookie, viewerId } = await ownerSession();
    const seed = await seedPublishableFixture(viewerId);

    await savePick(seed, cookie, completePick(seed));
    await publish(seed, cookie);
    await settleNotifications(2);

    // Ada answers "Can't make it" after the teams went out.
    await env.FIXTURE_CAPACITY.getByName(seed.fixtureId).setResponse({
      playerId: seed.ada,
      intent: "out",
      actorPlayerId: null,
      source: "token",
      whenFull: "waitlist",
      now: NOW.getTime(),
    });
    expect(await page(seed, cookie), "the churn must surface while it is unacknowledged").toContain("last sent out");

    // The organiser re-picks what is left and sends it round again. Ada is not
    // in this body — the picker no longer renders her.
    await savePick(seed, cookie, { [seed.bram]: "b", [seed.guest]: "a" });
    const republished = await publish(seed, cookie);
    expect(republished.status).toBe(303);

    const html = await page(seed, cookie);

    expect(html, "the squad now holds exactly what is picked").not.toContain("last sent out");
    expect(html).not.toContain("Worth another look");
    // Still distinguishable from a fixture nobody ever published.
    expect(html).toContain("Publish again");
    expect(html).not.toMatch(/<button[^>]*type="submit">Publish teams<\/button>/);
  });

  it("asks again when the organiser changes a published pick and saves it", async () => {
    // The mirror image, and the one the "the button is itself the prompt"
    // mitigation could not cover: saving used to clear `teams_published_at`,
    // so this page came back with no prompt and a button reading "Publish
    // teams" — identical to a fixture nobody had ever published, while
    // everyone playing held the previous email.
    const { cookie, viewerId } = await ownerSession();
    const seed = await seedPublishableFixture(viewerId);
    await savePick(seed, cookie, completePick(seed));
    await publish(seed, cookie);
    await settleNotifications(2);

    // Two players swap sides. Nobody's status changes, so neither staleness
    // condition fires — only the save instant knows.
    await savePick(seed, cookie, { [seed.ada]: "b", [seed.bram]: "a", [seed.guest]: "a" });

    const html = await page(seed, cookie);

    expect(html).toContain("last sent out");
    expect(html).toContain("Publish again");
  });

  it("says nothing about sending again on a pick that has only ever been saved", async () => {
    // `announcementOutstanding` is false whenever nothing was announced: there
    // is no email out there for a saved pick to contradict.
    const { cookie, viewerId } = await ownerSession();
    const seed = await seedPublishableFixture(viewerId);
    await savePick(seed, cookie, completePick(seed));

    const html = await page(seed, cookie);

    expect(html).not.toContain("last sent out");
    expect(html).toMatch(/<button[^>]*type="submit">Publish teams<\/button>/);
  });

  /**
   * Publishing is the act this file is about, and it must not depend on
   * script. M9 Task 7 put the picker's drag-and-drop enhancement on this
   * page, so "no script at all" stopped being true — but the publish form is
   * a form of its own, below the picker's and never inside it, and the claim
   * that matters is that it is still there and still pressable once every
   * script block is deleted. (`test/routes/team-picker.test.ts` checks the
   * other half: that the one block shipped is a bare, enumerated tag.)
   */
  it("keeps the publish control usable with every script removed", async () => {
    const { cookie, viewerId } = await ownerSession();
    const seed = await seedPublishableFixture(viewerId);
    await savePick(seed, cookie, completePick(seed));

    const withoutScript = (await page(seed, cookie)).replace(/<script[\s\S]*?<\/script>/g, "");

    expect(withoutScript, "removing the scripts must remove all script").not.toContain("<script");
    expect(withoutScript).not.toMatch(/\son[a-z]+\s*=/i);
    expect(withoutScript).not.toMatch(/javascript:/i);
    // The publish form itself, read out of the reduced page: its own `action`,
    // a real POST, and a submit button.
    expect(withoutScript).toContain(`action="/g/${seed.gameId}/f/${seed.fixtureId}/teams/publish"`);
    expect(withoutScript).toMatch(/<button[^>]*type="submit">Publish teams<\/button>/);
  });
});

/**
 * N-9's switch (M26). Publishing is two things — the teams becoming visible,
 * and the squad being told — and only the second is optional.
 */
describe("publishing with the teams email switched off", () => {
  beforeEach(resetDatabase);

  it("publishes the teams and emails nobody", async () => {
    const { cookie, viewerId } = await ownerSession();
    const seed = await seedPublishableFixture(viewerId);
    await testDb()
      .update(games)
      .set({ teamsPublishedEmailEnabled: false })
      .where(eq(games.id, seed.gameId));
    await savePick(seed, cookie, completePick(seed));

    const response = await publish(seed, cookie);
    expect(response.status).toBe(303);
    // The publish itself still happened: players can see their side.
    expect(await publishedAt(seed.fixtureId)).toBeInstanceOf(Date);

    // No `waitUntil` was scheduled, so there is nothing to settle — the wait
    // is here to give a send that *should not* exist time to appear.
    const rows = await settleNotifications(0);
    expect(rows).toHaveLength(0);
  });

  it("says on the fixture page that publishing sends nothing", async () => {
    const { cookie, viewerId } = await ownerSession();
    const seed = await seedPublishableFixture(viewerId);
    await savePick(seed, cookie, completePick(seed));

    const page = () =>
      SELF.fetch(`${ORIGIN}/g/${seed.gameId}/f/${seed.fixtureId}`, { headers: { cookie } }).then((r) => r.text());

    const withEmail = await page();
    expect(withEmail).not.toContain("Email is off for this game");

    await testDb()
      .update(games)
      .set({ teamsPublishedEmailEnabled: false })
      .where(eq(games.id, seed.gameId));

    const withoutEmail = await page();
    expect(withoutEmail).toContain("Email is off for this game");
  });
});

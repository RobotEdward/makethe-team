import { SELF, env } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { auditLog, fixtures, notificationLog, players, responses } from "../../src/db/schema.js";
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
    expect(body).toContain("Still to pick: Bram Stoker, Gus Guest.");
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
    // The organiser swaps the two sides over and publishes again. This must
    // genuinely re-send: the squad is holding an email describing teams that
    // have since changed.
    await savePick(seed, cookie, { [seed.ada]: "b", [seed.bram]: "a", [seed.guest]: "b" });
    await publish(seed, cookie);
    const rows = await settleNotifications(4);

    expect(rows).toHaveLength(4);
    const adasKeys = rows.filter((row) => row.playerId === seed.ada).map((row) => row.dedupeKey);
    expect(adasKeys).toHaveLength(2);
    // The publish instant is part of the key (`teamsKey`), so a second publish
    // is a second key rather than being swallowed by the unique index.
    expect(adasKeys[0]).not.toBe(adasKeys[1]);
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
    // The dropped-out player keeps his `team` on purpose, but he is not `in`,
    // so he is not offered a side any more.
    const [row] = await testDb()
      .select()
      .from(responses)
      .where(and(eq(responses.fixtureId, seed.fixtureId), eq(responses.playerId, seed.bram)));
    expect(row?.team).toBe("b");
  });

  it("carries no script and no inline handler", async () => {
    const { cookie, viewerId } = await ownerSession();
    const seed = await seedPublishableFixture(viewerId);
    await savePick(seed, cookie, completePick(seed));

    const html = await page(seed, cookie);

    expect(html).not.toContain("<script");
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
  });
});

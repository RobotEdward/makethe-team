import { SELF, env } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { auditLog, fixtures, players, responses } from "../../src/db/schema.js";
import type { Lifecycle } from "../../src/domain/lifecycle.js";
import { openFixture } from "../../src/domain/open-fixture.js";
import { SCRIPT_BLOCKS } from "../../src/views/scripts.js";
import { insertGame, insertMembership, insertPlayer, resetDatabase, testDb } from "../support/factories.js";
import { ALLOWED, ORIGIN, signIn } from "../support/sign-in.js";
import { kickoffIn } from "../support/clock.js";

/**
 * The team picker (BR-35 §4): the fragment on the owner's fixture page, and
 * the one POST that saves a pick.
 *
 * Saving is not publishing. Nothing in this suite should produce a
 * notification, and nothing a test here writes may become visible to a
 * player — the publish route is a separate task, and the two are separate
 * precisely because only one of them emails anybody.
 */

/** A form POST with the origin the app requires, matching `test/routes/owner-fixture.test.ts`. */
function appPost(path: string, fields: Record<string, string>, cookie: string, origin: string = ORIGIN) {
  return SELF.fetch(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin, cookie },
    body: new URLSearchParams(fields),
    redirect: "manual",
  });
}

const NOW = new Date("2026-08-13T09:00:00Z");

/** Signs in and returns the signed-in player's own id alongside the cookie. */
async function ownerSession(): Promise<{ cookie: string; viewerId: string }> {
  const { cookie } = await signIn();
  const db = testDb();
  const [viewer] = await db.select().from(players).where(eq(players.email, ALLOWED));
  return { cookie, viewerId: viewer!.id };
}

interface Seed {
  gameId: string;
  fixtureId: string;
  /** The two players who are `in`, and so the only two the picker may offer a side. */
  ada: string;
  bram: string;
  /** A third member, waitlisted behind them — never offered a side (BR-35 §4). */
  waitlisted: string;
}

/**
 * A game owned by `ownerPlayerId` with an open, two-place fixture: two members
 * marked in and a third waitlisted behind them.
 *
 * Built by driving the app's own domain functions and the FixtureCapacity
 * Durable Object rather than writing `responses` rows by hand, so the world
 * these tests load is one the app itself could have produced — and, in
 * particular, so the waitlisted row is genuinely waitlisted rather than a
 * status typed into a fixture file.
 */
async function seedPickableFixture(ownerPlayerId: string): Promise<Seed> {
  const db = testDb();
  const gameId = await insertGame(db, { maxPlayers: 2, teamAName: "Bibs", teamBName: "Skins" });
  await insertMembership(db, gameId, ownerPlayerId, { role: "owner" });

  const ada = await insertPlayer(db, { name: "Ada Lovelace" });
  const bram = await insertPlayer(db, { name: "Bram Stoker" });
  const waitlisted = await insertPlayer(db, { name: "Wendy Waiting" });
  for (const playerId of [ada, bram, waitlisted]) await insertMembership(db, gameId, playerId);

  const fixtureId = crypto.randomUUID();
  await db.insert(fixtures).values({
    id: fixtureId,
    gameId,
    kicksOffAt: kickoffIn(24 * 7),
    minPlayers: 1,
    maxPlayers: 2,
    prefersEvenNumbers: true,
    shortWarningOffsetHours: 12,
    durationMinutes: 60,
  });
  await openFixture(db, fixtureId, NOW);

  // In squad order: the two who answered first take the two places, and the
  // third lands on the waitlist because the fixture is full, not because
  // anything here says so.
  for (const playerId of [ada, bram, waitlisted]) {
    await env.FIXTURE_CAPACITY.getByName(fixtureId).setResponse({
      playerId,
      intent: "in",
      actorPlayerId: null,
      source: "token",
      whenFull: "waitlist",
      now: NOW.getTime(),
    });
  }

  return { gameId, fixtureId, ada, bram, waitlisted };
}

/** The stored side for one player on one fixture. */
async function teamOf(fixtureId: string, playerId: string): Promise<string | null> {
  const [row] = await testDb()
    .select()
    .from(responses)
    .where(and(eq(responses.fixtureId, fixtureId), eq(responses.playerId, playerId)));
  return row?.team ?? null;
}

function setLifecycle(fixtureId: string, lifecycle: Lifecycle) {
  return testDb().update(fixtures).set({ lifecycle }).where(eq(fixtures.id, fixtureId));
}

describe("the team picker on GET /g/:id/f/:fixtureId", () => {
  beforeEach(resetDatabase);

  it("gives every player who is in a radio group named after them", async () => {
    const { cookie, viewerId } = await ownerSession();
    const { gameId, fixtureId, ada, bram } = await seedPickableFixture(viewerId);

    const html = await (await SELF.fetch(`${ORIGIN}/g/${gameId}/f/${fixtureId}`, { headers: { cookie } })).text();

    expect(html).toContain(`action="/g/${gameId}/f/${fixtureId}/teams"`);
    for (const playerId of [ada, bram]) {
      expect(html).toContain(`<input type="radio" name="${playerId}" value="a"`);
      expect(html).toContain(`<input type="radio" name="${playerId}" value="b"`);
      // The third choice is what makes a partial pick expressible, and
      // undoable, without JavaScript.
      expect(html).toContain(`<input type="radio" name="${playerId}" value=""`);
    }
    // The game's own names for the sides, not "Team A"/"Team B".
    expect(html).toContain("Bibs");
    expect(html).toContain("Skins");
  });

  it("does not offer a side to a waitlisted player", async () => {
    const { cookie, viewerId } = await ownerSession();
    const { gameId, fixtureId, waitlisted } = await seedPickableFixture(viewerId);

    const html = await (await SELF.fetch(`${ORIGIN}/g/${gameId}/f/${fixtureId}`, { headers: { cookie } })).text();

    // They are on the page — the squad list shows them — but nothing on it
    // names them as a radio group, because a side they have no place for
    // would be a promise of one.
    expect(html).toContain("Wendy Waiting");
    expect(html).not.toContain(`name="${waitlisted}"`);
  });

  it("marks the side each player is already on", async () => {
    const { cookie, viewerId } = await ownerSession();
    const { gameId, fixtureId, ada } = await seedPickableFixture(viewerId);
    await appPost(`/g/${gameId}/f/${fixtureId}/teams`, { [ada]: "b" }, cookie);

    const html = await (await SELF.fetch(`${ORIGIN}/g/${gameId}/f/${fixtureId}`, { headers: { cookie } })).text();

    expect(html).toContain(`<input type="radio" name="${ada}" value="b" checked>`);
    expect(html).toContain(`<input type="radio" name="${ada}" value="a">`);
  });

  it.each(["scheduled", "played", "cancelled"] as const)(
    "renders no picker on a %s fixture",
    async (lifecycle) => {
      const { cookie, viewerId } = await ownerSession();
      const { gameId, fixtureId } = await seedPickableFixture(viewerId);
      await setLifecycle(fixtureId, lifecycle);

      const html = await (await SELF.fetch(`${ORIGIN}/g/${gameId}/f/${fixtureId}`, { headers: { cookie } })).text();

      expect(html).not.toContain(`/f/${fixtureId}/teams`);
      expect(html).not.toContain("Save teams");
    },
  );

  it("shows a finished fixture's teams read-only", async () => {
    const { cookie, viewerId } = await ownerSession();
    const { gameId, fixtureId, ada, bram } = await seedPickableFixture(viewerId);
    await appPost(`/g/${gameId}/f/${fixtureId}/teams`, { [ada]: "a", [bram]: "b" }, cookie);
    await setLifecycle(fixtureId, "played");

    const html = await (await SELF.fetch(`${ORIGIN}/g/${gameId}/f/${fixtureId}`, { headers: { cookie } })).text();

    expect(html).toContain("Teams");
    expect(html).toContain("Bibs");
    expect(html).not.toContain("Save teams");
  });

  it("shows no teams section at all on a finished fixture nobody picked", async () => {
    const { cookie, viewerId } = await ownerSession();
    const { gameId, fixtureId } = await seedPickableFixture(viewerId);
    await setLifecycle(fixtureId, "cancelled");

    const html = await (await SELF.fetch(`${ORIGIN}/g/${gameId}/f/${fixtureId}`, { headers: { cookie } })).text();

    expect(html).not.toContain("<h2>Teams</h2>");
  });

  /**
   * Was `not.toContain("<script")` until M9 Task 7 added the drag-and-drop
   * enhancement, and this is the replacement rather than a deletion: the
   * property being pinned was never "there is no script" but **"the pick can
   * be made without one"**, which is the same reduction
   * `test/routes/signin.test.ts` performs on the sign-in page.
   *
   * The enumeration in that file cannot stand in for this. It captures the
   * owner fixture page *after* the fixture has been cancelled — deliberately,
   * for the cancel-token pages above it — so the picker is not on it and the
   * script is correctly absent. This is the only test that sees this page in
   * the state that carries the enhancement, so it also has to make the
   * enumeration's other check here: a bare tag whose text is in
   * `SCRIPT_BLOCKS`, because anything else is script the CSP will not hash.
   */
  it("ships one enumerated script, and the whole pick survives its removal", async () => {
    const { cookie, viewerId } = await ownerSession();
    const { gameId, fixtureId, ada, bram } = await seedPickableFixture(viewerId);

    const served = await (await SELF.fetch(`${ORIGIN}/g/${gameId}/f/${fixtureId}`, { headers: { cookie } })).text();

    const scripts = [...served.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)];
    expect(scripts, "the picker page carries exactly the one enhancement").toHaveLength(1);
    // No `src`, no `type`, no `nonce`: only a bare inline tag is covered by a
    // SHA-256 hash of its own text.
    expect(scripts[0]![1], "the script tag must carry no attributes").toBe("");
    expect(
      SCRIPT_BLOCKS as readonly string[],
      "the picker ships script that is not in SCRIPT_BLOCKS, so the CSP will not hash it",
    ).toContain(scripts[0]![2]);

    // What a browser with scripting off is left holding. Behaviour lives only
    // in the blocks — no inline handler, no `javascript:` URL — so deleting
    // them deletes all of it.
    const withoutScript = served.replace(/<script[\s\S]*?<\/script>/g, "");
    expect(withoutScript, "removing the scripts must remove all script").not.toContain("<script");
    expect(withoutScript).not.toMatch(/\son[a-z]+\s*=/i);
    expect(withoutScript).not.toMatch(/javascript:/i);

    // And the pick is still expressible from that reduced page: a radio for
    // every player and every side, plus the Save button they post through.
    for (const playerId of [ada, bram]) {
      for (const value of ["a", "b", ""]) {
        expect(
          withoutScript,
          `${playerId} must still be placeable on "${value || "no side"}" with scripting off`,
        ).toContain(`<input type="radio" name="${playerId}" value="${value}"`);
      }
    }
    expect(withoutScript).toContain("Save teams");
  });
});

describe("POST /g/:id/f/:fixtureId/teams", () => {
  beforeEach(resetDatabase);

  it("saves a side for each named player", async () => {
    const { cookie, viewerId } = await ownerSession();
    const { gameId, fixtureId, ada, bram } = await seedPickableFixture(viewerId);

    const response = await appPost(`/g/${gameId}/f/${fixtureId}/teams`, { [ada]: "a", [bram]: "b" }, cookie);

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`/g/${gameId}/f/${fixtureId}`);
    expect(await teamOf(fixtureId, ada)).toBe("a");
    expect(await teamOf(fixtureId, bram)).toBe("b");
  });

  it("saves a partial pick, leaving the rest unassigned", async () => {
    const { cookie, viewerId } = await ownerSession();
    const { gameId, fixtureId, ada, bram } = await seedPickableFixture(viewerId);

    // Exactly what the browser posts when an organiser has placed one player
    // and left the other on "Not picked yet".
    const response = await appPost(`/g/${gameId}/f/${fixtureId}/teams`, { [ada]: "a", [bram]: "" }, cookie);

    expect(response.status).toBe(303);
    expect(await teamOf(fixtureId, ada)).toBe("a");
    expect(await teamOf(fixtureId, bram)).toBeNull();
  });

  it("clears a side an organiser has changed their mind about", async () => {
    const { cookie, viewerId } = await ownerSession();
    const { gameId, fixtureId, ada } = await seedPickableFixture(viewerId);
    await appPost(`/g/${gameId}/f/${fixtureId}/teams`, { [ada]: "a" }, cookie);

    await appPost(`/g/${gameId}/f/${fixtureId}/teams`, { [ada]: "" }, cookie);

    expect(await teamOf(fixtureId, ada)).toBeNull();
  });

  it("clears teams_published_at, because the pick no longer matches what was announced", async () => {
    const { cookie, viewerId } = await ownerSession();
    const { gameId, fixtureId, ada } = await seedPickableFixture(viewerId);
    const db = testDb();
    await db.update(fixtures).set({ teamsPublishedAt: NOW }).where(eq(fixtures.id, fixtureId));

    await appPost(`/g/${gameId}/f/${fixtureId}/teams`, { [ada]: "a" }, cookie);

    const [row] = await db.select().from(fixtures).where(eq(fixtures.id, fixtureId));
    expect(row?.teamsPublishedAt).toBeNull();
  });

  it("writes exactly one audit row naming the actor and the pick", async () => {
    const { cookie, viewerId } = await ownerSession();
    const { gameId, fixtureId, ada, bram } = await seedPickableFixture(viewerId);

    await appPost(`/g/${gameId}/f/${fixtureId}/teams`, { [ada]: "a", [bram]: "b" }, cookie);

    const rows = await testDb().select().from(auditLog).where(eq(auditLog.action, "fixture.teams_saved"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorPlayerId: viewerId, entityType: "fixture", entityId: fixtureId });
    expect(JSON.parse(rows[0]!.beforeJson!)).toEqual({ teams: { [ada]: null, [bram]: null } });
    expect(JSON.parse(rows[0]!.afterJson!)).toEqual({ teams: { [ada]: "a", [bram]: "b" } });
  });

  it("never publishes anything", async () => {
    const { cookie, viewerId } = await ownerSession();
    const { gameId, fixtureId, ada } = await seedPickableFixture(viewerId);

    await appPost(`/g/${gameId}/f/${fixtureId}/teams`, { [ada]: "a" }, cookie);

    const published = await testDb().select().from(auditLog).where(eq(auditLog.action, "fixture.teams_published"));
    expect(published).toHaveLength(0);
  });

  it("leaves the squad's statuses and the fixture's counts untouched", async () => {
    const { cookie, viewerId } = await ownerSession();
    const { gameId, fixtureId, ada, bram, waitlisted } = await seedPickableFixture(viewerId);
    const db = testDb();
    const [before] = await db.select().from(fixtures).where(eq(fixtures.id, fixtureId));

    await appPost(`/g/${gameId}/f/${fixtureId}/teams`, { [ada]: "a", [bram]: "b" }, cookie);

    // A team assignment must never touch capacity accounting (BR-35): it
    // changes nobody's status and takes nobody's slot.
    const rows = await db.select().from(responses).where(eq(responses.fixtureId, fixtureId));
    expect(rows.find((r) => r.playerId === waitlisted)?.status).toBe("waitlisted");
    expect(rows.filter((r) => r.status === "in")).toHaveLength(2);
    const [after] = await db.select().from(fixtures).where(eq(fixtures.id, fixtureId));
    expect(after).toMatchObject({ inCount: before!.inCount, waitlistCount: before!.waitlistCount });
  });

  it("ignores a key that is not an `in` member of this fixture", async () => {
    const { cookie, viewerId } = await ownerSession();
    const { gameId, fixtureId, ada, bram, waitlisted } = await seedPickableFixture(viewerId);
    const stranger = await insertPlayer(testDb(), { name: "Nobody At All" });

    // The stale form an organiser submits when the squad changed underneath
    // them, plus a waitlisted player and an id belonging to no member of this
    // game at all. Ignored, every one — not a 400 and certainly not a 500.
    const response = await appPost(
      `/g/${gameId}/f/${fixtureId}/teams`,
      { [ada]: "a", [bram]: "b", [waitlisted]: "a", [stranger]: "b", "not-an-id": "a" },
      cookie,
    );

    expect(response.status).toBe(303);
    expect(await teamOf(fixtureId, ada)).toBe("a");
    expect(await teamOf(fixtureId, waitlisted)).toBeNull();
  });

  it("ignores a value that is not a side", async () => {
    const { cookie, viewerId } = await ownerSession();
    const { gameId, fixtureId, ada, bram } = await seedPickableFixture(viewerId);

    const response = await appPost(`/g/${gameId}/f/${fixtureId}/teams`, { [ada]: "c", [bram]: "b" }, cookie);

    expect(response.status).toBe(303);
    expect(await teamOf(fixtureId, ada)).toBeNull();
    expect(await teamOf(fixtureId, bram)).toBe("b");
  });

  it.each(["scheduled", "played", "cancelled"] as const)("refuses a %s fixture", async (lifecycle) => {
    const { cookie, viewerId } = await ownerSession();
    const { gameId, fixtureId, ada } = await seedPickableFixture(viewerId);
    await setLifecycle(fixtureId, lifecycle);

    const response = await appPost(`/g/${gameId}/f/${fixtureId}/teams`, { [ada]: "a" }, cookie);

    expect(response.status).toBe(422);
    expect(await response.text()).toContain("isn&#39;t taking changes any more");
    expect(await teamOf(fixtureId, ada)).toBeNull();
  });

  it("404s for a signed-in player who is not an organiser of the game", async () => {
    const { cookie, viewerId } = await ownerSession();
    const db = testDb();
    const strangerOwner = await insertPlayer(db, { name: "Someone Else" });
    const { gameId, fixtureId, ada } = await seedPickableFixture(strangerOwner);
    // A real member of this game, just not an organiser of it — 404, not 403,
    // so a fixture id cannot be probed for existence (TR-18).
    await insertMembership(db, gameId, viewerId);

    const response = await appPost(`/g/${gameId}/f/${fixtureId}/teams`, { [ada]: "a" }, cookie);

    expect(response.status).toBe(404);
    expect(await teamOf(fixtureId, ada)).toBeNull();
  });

  it("403s a cross-origin submission before touching anything", async () => {
    const { cookie, viewerId } = await ownerSession();
    const { gameId, fixtureId, ada } = await seedPickableFixture(viewerId);

    const response = await appPost(
      `/g/${gameId}/f/${fixtureId}/teams`,
      { [ada]: "a" },
      cookie,
      "https://evil.example",
    );

    expect(response.status).toBe(403);
    expect(await teamOf(fixtureId, ada)).toBeNull();
  });

  it("redirects an anonymous visitor to sign in", async () => {
    const db = testDb();
    const owner = await insertPlayer(db);
    const { gameId, fixtureId, ada } = await seedPickableFixture(owner);

    const response = await appPost(`/g/${gameId}/f/${fixtureId}/teams`, { [ada]: "a" }, "");

    expect(response.status).toBe(302);
    expect(await teamOf(fixtureId, ada)).toBeNull();
  });
});

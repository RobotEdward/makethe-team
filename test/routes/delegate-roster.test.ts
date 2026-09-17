import { SELF, env } from "cloudflare:test";
import { and, eq, ne } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../src/db/client.js";
import { auditLog, fixtures, players, responses } from "../../src/db/schema.js";
import { openFixture } from "../../src/domain/open-fixture.js";
import type { PickerMode } from "../../src/domain/picker.js";
import {
  insertFixture,
  insertGame,
  insertMembership,
  insertPlayer,
  insertResponse,
  insertResultClaim,
  resetDatabase,
} from "../support/factories.js";
import { kickoffIn, NOW } from "../support/clock.js";
import { ALLOWED, ORIGIN, signIn } from "../support/sign-in.js";

/**
 * M66: the player an organiser has handed the pick to can also keep the
 * roster straight on that fixture — mark players in or out, add a guest,
 * remove one — because they are the person pitchside who knows Sam has
 * dropped out and a mate is standing in. The same four acts the organiser
 * has, on the one fixture, for as long as the organiser could do them
 * (including M64's correction window after full time), and not a day longer
 * than the delegation itself.
 *
 * The entitlement boundary — these four routes and no fifth, the delegate
 * and no open-mode member — is `test/routes/picker-entitlement.test.ts`'s.
 * This file is the positive half: what the delegate can do, and where each
 * act lands them afterwards.
 */

const db = getDb(env.DB);
const KICKOFF = kickoffIn(9);

beforeEach(resetDatabase);

async function seed(mode: PickerMode, fixture: { kicksOffAt?: Date; lifecycle?: "open" | "played" } = {}) {
  const { cookie } = await signIn();
  const [viewer] = await db.select().from(players).where(eq(players.email, ALLOWED));
  const viewerId = viewer!.id;

  const gameId = await insertGame(db, { maxPlayers: 2, minPlayers: 1 });
  const ownerId = await insertPlayer(db, { name: "Olive Owner" });
  const otherId = await insertPlayer(db, { name: "Otto Other" });
  await insertMembership(db, gameId, ownerId, { role: "owner" });
  await insertMembership(db, gameId, viewerId);
  await insertMembership(db, gameId, otherId);

  const fixtureId = await insertFixture(db, gameId, {
    kicksOffAt: fixture.kicksOffAt ?? KICKOFF,
    minPlayers: 1,
    maxPlayers: 2,
  });
  await openFixture(db, fixtureId, NOW);
  if (fixture.lifecycle === "played") {
    await db
      .update(fixtures)
      .set({ lifecycle: "played", teamsSavedAt: KICKOFF, teamsPublishedAt: KICKOFF })
      .where(eq(fixtures.id, fixtureId));
  }
  await db
    .update(fixtures)
    .set({
      pickerMode: mode,
      teamPickerPlayerId: mode === "delegate" ? viewerId : null,
      teamPickerSetAt: mode === "delegate" ? NOW : null,
    })
    .where(eq(fixtures.id, fixtureId));

  return { gameId, fixtureId, cookie, viewerId, ownerId, otherId };
}

async function setStatus(fixtureId: string, playerId: string, status: "in" | "out", team: "a" | "b" | null = null) {
  await db
    .update(responses)
    .set({ status, team, respondedAt: NOW })
    .where(and(eq(responses.fixtureId, fixtureId), eq(responses.playerId, playerId)));
  const inCount = (
    await db.select().from(responses).where(and(eq(responses.fixtureId, fixtureId), eq(responses.status, "in")))
  ).length;
  await db.update(fixtures).set({ inCount }).where(eq(fixtures.id, fixtureId));
}

async function statusOf(fixtureId: string, playerId: string) {
  const [row] = await db
    .select()
    .from(responses)
    .where(and(eq(responses.fixtureId, fixtureId), eq(responses.playerId, playerId)));
  return row;
}

function get(path: string, cookie: string) {
  return SELF.fetch(`${ORIGIN}${path}`, { headers: { cookie }, redirect: "manual" });
}

function post(path: string, cookie: string, fields: Record<string, string> = {}) {
  return SELF.fetch(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, cookie },
    body: new URLSearchParams(fields),
    redirect: "manual",
  });
}

describe("a delegate marking players in and out", () => {
  it("marks a player out and comes back to the picker page, not the organiser's", async () => {
    const { gameId, fixtureId, cookie, otherId, viewerId } = await seed("delegate");
    await setStatus(fixtureId, otherId, "in");

    const response = await post(`/g/${gameId}/f/${fixtureId}/response/${otherId}`, cookie, { intent: "out" });

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`/g/${gameId}/f/${fixtureId}/teams`);
    expect((await statusOf(fixtureId, otherId))?.status).toBe("out");

    // The trail names the delegate, not the organiser: it is the only way
    // Otto can find out who answered for him.
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, fixtureId), eq(auditLog.action, "fixture.response_overridden")));
    expect(audit?.actorPlayerId).toBe(viewerId);
  });

  it("marks a player in, including the organiser", async () => {
    const { gameId, fixtureId, cookie, ownerId } = await seed("delegate");

    const response = await post(`/g/${gameId}/f/${fixtureId}/response/${ownerId}`, cookie, { intent: "in" });

    expect(response.status).toBe(303);
    expect((await statusOf(fixtureId, ownerId))?.status).toBe("in");
  });

  it("is asked to confirm going over capacity, on the picker page", async () => {
    const { gameId, fixtureId, cookie, ownerId, otherId, viewerId } = await seed("delegate");
    await setStatus(fixtureId, otherId, "in");
    await setStatus(fixtureId, viewerId, "in");

    const response = await post(`/g/${gameId}/f/${fixtureId}/response/${ownerId}`, cookie, { intent: "in" });

    expect(response.status).toBe(422);
    const html = await response.text();
    expect(html).toContain("Add Olive Owner anyway?");
    expect(html).toContain("The organiser has asked you to pick the teams");
    // The organiser's page, not this one: its "see this as a player" link is
    // the tell.
    expect(html).not.toContain("See this as a player");
    // And the banner's "no" leads back here, not to the fixture page the
    // delegate would be bounced off.
    expect(html).toContain(`href="/g/${gameId}/f/${fixtureId}/teams">No, leave it</a>`);

    const confirmed = await post(`/g/${gameId}/f/${fixtureId}/response/${ownerId}`, cookie, {
      intent: "in",
      override: "1",
    });
    expect(confirmed.status).toBe(303);
    expect((await statusOf(fixtureId, ownerId))?.status).toBe("in");
  });

  it("sends the organiser back to their own fixture page, as before", async () => {
    const { gameId, fixtureId, otherId } = await seed("delegate");
    // Re-sign the allowlisted identity in as the owner of a fresh game: the
    // suite can only ever hold one session, so the organiser case is its own
    // game.
    const { cookie } = await signIn();
    const [viewer] = await db.select().from(players).where(eq(players.email, ALLOWED));
    const ownedGameId = await insertGame(db, { minPlayers: 1 });
    await insertMembership(db, ownedGameId, viewer!.id, { role: "owner" });
    await insertMembership(db, ownedGameId, otherId);
    const ownedFixtureId = await insertFixture(db, ownedGameId, { kicksOffAt: KICKOFF, minPlayers: 1 });
    await openFixture(db, ownedFixtureId, NOW);

    const response = await post(`/g/${ownedGameId}/f/${ownedFixtureId}/response/${otherId}`, cookie, {
      intent: "in",
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`/g/${ownedGameId}/f/${ownedFixtureId}`);
    void gameId;
    void fixtureId;
  });

  it("stops the moment the organiser takes the pick back", async () => {
    const { gameId, fixtureId, cookie, otherId } = await seed("delegate");
    await db
      .update(fixtures)
      .set({ pickerMode: "organiser", teamPickerPlayerId: null, teamPickerSetAt: null })
      .where(eq(fixtures.id, fixtureId));

    const response = await post(`/g/${gameId}/f/${fixtureId}/response/${otherId}`, cookie, { intent: "in" });
    expect(response.status).toBe(404);
  });

  it("never reaches a member of an open-mode fixture", async () => {
    const { gameId, fixtureId, cookie, otherId } = await seed("open");
    const response = await post(`/g/${gameId}/f/${fixtureId}/response/${otherId}`, cookie, { intent: "in" });
    expect(response.status).toBe(404);
  });
});

describe("a delegate adding and removing guests", () => {
  it("gets the add-a-guest page, with its way back to the picker", async () => {
    const { gameId, fixtureId, cookie } = await seed("delegate");
    const response = await get(`/g/${gameId}/f/${fixtureId}/guest/add`, cookie);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("<h1>Add a guest</h1>");
    expect(html).toContain(`href="/g/${gameId}/f/${fixtureId}/teams">Back to the fixture</a>`);
  });

  it("adds a guest and comes back to the picker page", async () => {
    const { gameId, fixtureId, cookie, viewerId } = await seed("delegate");

    const response = await post(`/g/${gameId}/f/${fixtureId}/guest`, cookie, { name: "Gus Guest" });

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`/g/${gameId}/f/${fixtureId}/teams`);
    const rows = await db.select().from(responses).where(eq(responses.fixtureId, fixtureId));
    expect(rows.some((row) => row.status === "in" && row.setByPlayerId === viewerId)).toBe(true);
  });

  it("is asked to confirm a guest that would go over capacity, on the picker page", async () => {
    const { gameId, fixtureId, cookie, otherId, viewerId } = await seed("delegate");
    await setStatus(fixtureId, otherId, "in");
    await setStatus(fixtureId, viewerId, "in");

    const response = await post(`/g/${gameId}/f/${fixtureId}/guest`, cookie, { name: "Gus Guest" });

    expect(response.status).toBe(422);
    const html = await response.text();
    expect(html).toContain("Add Gus Guest anyway?");
    expect(html).not.toContain("See this as a player");
  });

  it("removes a guest and comes back to the picker page", async () => {
    const { gameId, fixtureId, cookie } = await seed("delegate");
    const guestId = await insertPlayer(db, { email: null, isGuest: true, name: "Gus Guest" });
    await insertResponse(db, fixtureId, guestId, { status: "in" });

    const response = await post(`/g/${gameId}/f/${fixtureId}/guest/${guestId}/remove`, cookie);

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`/g/${gameId}/f/${fixtureId}/teams`);
    const [row] = await db.select().from(responses).where(eq(responses.playerId, guestId));
    expect(row?.status).toBe("withdrawn");
  });

  it("never reaches a member of an open-mode fixture", async () => {
    const { gameId, fixtureId, cookie } = await seed("open");
    expect((await get(`/g/${gameId}/f/${fixtureId}/guest/add`, cookie)).status).toBe(404);
    expect((await post(`/g/${gameId}/f/${fixtureId}/guest`, cookie, { name: "Gus Guest" })).status).toBe(404);
  });
});

describe("the picker page carries the roster for a delegate", () => {
  it("lists the whole squad with mark-in/mark-out on every member and a guest link", async () => {
    const { gameId, fixtureId, cookie, otherId, ownerId } = await seed("delegate");
    await setStatus(fixtureId, otherId, "in");
    const guestId = await insertPlayer(db, { email: null, isGuest: true, name: "Gus Guest" });
    await insertResponse(db, fixtureId, guestId, { status: "in" });

    const html = await (await get(`/g/${gameId}/f/${fixtureId}/teams`, cookie)).text();

    expect(html).toContain('<h2 id="squad-heading">Squad</h2>');
    expect(html).toContain(`action="/g/${gameId}/f/${fixtureId}/response/${otherId}"`);
    expect(html).toContain(`action="/g/${gameId}/f/${fixtureId}/response/${ownerId}"`);
    expect(html).toContain(`action="/g/${gameId}/f/${fixtureId}/guest/${guestId}/remove"`);
    expect(html).toContain(`href="/g/${gameId}/f/${fixtureId}/guest/add"`);
    // The invite-order control is the organiser's alone.
    expect(html).not.toContain("Invite now");
  });

  it("shows a member of an open-mode fixture the picker and nothing more", async () => {
    const { gameId, fixtureId, cookie, otherId } = await seed("open");
    await setStatus(fixtureId, otherId, "in");

    const html = await (await get(`/g/${gameId}/f/${fixtureId}/teams`, cookie)).text();

    expect(html).toContain('id="team-picker"');
    expect(html).not.toContain('id="squad-heading"');
    expect(html).not.toContain(`/response/${otherId}`);
    expect(html).not.toContain("/guest/add");
  });
});

describe("a delegate correcting the record after full time (M64 window)", () => {
  const playedYesterday = { kicksOffAt: new Date(NOW.getTime() - 20 * 60 * 60 * 1000), lifecycle: "played" as const };

  it("may mark a player out on a played fixture until the result locks", async () => {
    const { gameId, fixtureId, cookie, otherId } = await seed("delegate", playedYesterday);
    await setStatus(fixtureId, otherId, "in", "a");

    const response = await post(`/g/${gameId}/f/${fixtureId}/response/${otherId}`, cookie, { intent: "out" });

    expect(response.status).toBe(303);
    expect((await statusOf(fixtureId, otherId))?.status).toBe("out");
  });

  it("may save the sides on a played fixture until the result locks", async () => {
    const { gameId, fixtureId, cookie, otherId } = await seed("delegate", playedYesterday);
    await setStatus(fixtureId, otherId, "in", "a");

    const response = await post(`/g/${gameId}/f/${fixtureId}/teams`, cookie, { [otherId]: "b" });

    expect(response.status).toBe(303);
    expect((await statusOf(fixtureId, otherId))?.team).toBe("b");
  });

  it("sees the controls and the correction note on the picker page", async () => {
    const { gameId, fixtureId, cookie, otherId } = await seed("delegate", playedYesterday);
    await setStatus(fixtureId, otherId, "in", "a");

    const html = await (await get(`/g/${gameId}/f/${fixtureId}/teams`, cookie)).text();

    expect(html).toContain("This game has been played. You can still correct who played");
    expect(html).toContain(`action="/g/${gameId}/f/${fixtureId}/response/${otherId}"`);
    expect(html).toContain('id="team-picker"');
    // Nobody left to tell about a game that is over: the same rule the
    // organiser's page holds in test/views/owner-fixture.test.ts.
    expect(html).not.toContain("/teams/publish");
    expect(html).toContain("nothing to announce");
  });

  it("is refused once the result has locked", async () => {
    const lockedLongAgo = { kicksOffAt: new Date("2026-08-13T18:00:00Z"), lifecycle: "played" as const };
    const { gameId, fixtureId, cookie, otherId } = await seed("delegate", lockedLongAgo);
    await setStatus(fixtureId, otherId, "in", "a");
    await insertResultClaim(db, fixtureId, otherId, { filedAt: lockedLongAgo.kicksOffAt });

    const marked = await post(`/g/${gameId}/f/${fixtureId}/response/${otherId}`, cookie, { intent: "out" });
    expect(marked.status).toBe(422);
    expect(await marked.text()).not.toContain("See this as a player");
    expect((await statusOf(fixtureId, otherId))?.status).toBe("in");

    const saved = await post(`/g/${gameId}/f/${fixtureId}/teams`, cookie, { [otherId]: "b" });
    expect(saved.status).toBe(422);
    expect((await statusOf(fixtureId, otherId))?.team).toBe("a");
  });

  it("gives a member of an open-mode fixture no correction window", async () => {
    const { gameId, fixtureId, cookie, otherId } = await seed("open", playedYesterday);
    await setStatus(fixtureId, otherId, "in", "a");

    const saved = await post(`/g/${gameId}/f/${fixtureId}/teams`, cookie, { [otherId]: "b" });
    expect(saved.status).toBe(422);
    expect((await statusOf(fixtureId, otherId))?.team).toBe("a");

    const rows = await db
      .select()
      .from(responses)
      .where(and(eq(responses.fixtureId, fixtureId), ne(responses.status, "withdrawn")));
    expect(rows.length).toBeGreaterThan(0);
  });
});

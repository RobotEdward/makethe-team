import { SELF } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { fixturePotmVotes, players } from "../../src/db/schema.js";
import { putPotmVote } from "../../src/db/potm-queries.js";
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
import { kickoffIn, NOW } from "../support/clock.js";

function appPost(path: string, fields: Record<string, string>, cookie: string) {
  return SELF.fetch(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, cookie },
    body: new URLSearchParams(fields),
    redirect: "manual",
  });
}

function page(path: string, cookie: string) {
  return SELF.fetch(`${ORIGIN}${path}`, { headers: { cookie } });
}

async function viewerSession(): Promise<{ cookie: string; viewerId: string }> {
  const { cookie } = await signIn();
  const [viewer] = await testDb().select().from(players).where(eq(players.email, ALLOWED));
  return { cookie, viewerId: viewer!.id };
}

/**
 * A played fixture in someone else's game with the viewer, Bea, Cal and a
 * guest all `in`. `kickoffIn(-24)` on a 60-minute fixture leaves the default
 * 24-hour window an hour from closing; `-30` has it closed.
 */
async function seed(
  viewerId: string,
  options: { kickoffHours?: number; squadVisibleToPlayers?: boolean } = {},
) {
  const db = testDb();
  const owner = await insertPlayer(db, { name: "Olive Owner" });
  const bea = await insertPlayer(db, { name: "Bea Striker" });
  const cal = await insertPlayer(db, { name: "Cal Keeper" });
  const guest = await insertPlayer(db, { name: "Gus", email: null, isGuest: true });
  const gameId = await insertGame(db, { squadVisibleToPlayers: options.squadVisibleToPlayers ?? true });
  await insertMembership(db, gameId, owner, { role: "owner" });
  for (const id of [viewerId, bea, cal]) await insertMembership(db, gameId, id);
  const fixtureId = await insertFixture(db, gameId, {
    lifecycle: "played",
    kicksOffAt: kickoffIn(options.kickoffHours ?? -24),
  });
  for (const id of [viewerId, bea, cal, guest]) await insertResponse(db, fixtureId, id, { status: "in" });
  return { gameId, fixtureId, owner, bea, cal, guest, path: `/g/${gameId}/f/${fixtureId}` };
}

describe("POST /g/:id/f/:fixtureId/potm (M68)", () => {
  beforeEach(resetDatabase);

  it("records a vote, and a second one changes it in place", async () => {
    const { cookie, viewerId } = await viewerSession();
    const { path, fixtureId, bea, guest } = await seed(viewerId);

    const first = await appPost(`${path}/potm`, { candidateId: bea }, cookie);
    expect(first.status).toBe(303);
    expect(first.headers.get("location")).toBe(path);

    // A guest played, so a guest can be picked.
    expect((await appPost(`${path}/potm`, { candidateId: guest }, cookie)).status).toBe(303);

    const rows = await testDb().select().from(fixturePotmVotes).where(eq(fixturePotmVotes.fixtureId, fixtureId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ voterId: viewerId, candidateId: guest });
  });

  it("refuses a self-vote and a vote for somebody who did not play, with 422", async () => {
    const { cookie, viewerId } = await viewerSession();
    const { path, owner } = await seed(viewerId);

    const self = await appPost(`${path}/potm`, { candidateId: viewerId }, cookie);
    expect(self.status).toBe(422);
    expect(await self.text()).toContain("You can&#39;t vote for yourself.");

    // The organiser is a voter but did not play, so is not on the ballot.
    const absent = await appPost(`${path}/potm`, { candidateId: owner }, cookie);
    expect(absent.status).toBe(422);
    expect(await absent.text()).toContain("Pick somebody who played.");

    const missing = await appPost(`${path}/potm`, {}, cookie);
    expect(missing.status).toBe(422);
    expect(await testDb().select().from(fixturePotmVotes)).toHaveLength(0);
  });

  it("refuses once voting has closed, with 422", async () => {
    const { cookie, viewerId } = await viewerSession();
    const { path, bea } = await seed(viewerId, { kickoffHours: -30 });
    const response = await appPost(`${path}/potm`, { candidateId: bea }, cookie);
    expect(response.status).toBe(422);
    expect(await response.text()).toContain("Voting for player of the match has closed.");
  });

  it("404s a member who did not play, a fixture not yet played, and a game with the squad hidden", async () => {
    const { cookie, viewerId } = await viewerSession();
    const db = testDb();

    const notPlayed = await seed(viewerId);
    const outsider = await insertPlayer(db);
    const benched = await seed(outsider);
    await insertMembership(db, benched.gameId, viewerId);
    expect((await appPost(`${benched.path}/potm`, { candidateId: benched.bea }, cookie)).status).toBe(404);

    const openFixture = await insertFixture(db, notPlayed.gameId, { lifecycle: "open" });
    expect(
      (await appPost(`/g/${notPlayed.gameId}/f/${openFixture}/potm`, { candidateId: notPlayed.bea }, cookie)).status,
    ).toBe(404);

    const hidden = await seed(viewerId, { squadVisibleToPlayers: false });
    expect((await appPost(`${hidden.path}/potm`, { candidateId: hidden.bea }, cookie)).status).toBe(404);
  });
});

describe("the player-of-the-match section on the fixture page (M68)", () => {
  beforeEach(resetDatabase);

  it("offers everyone who played but the viewer, with no counts while open", async () => {
    const { cookie, viewerId } = await viewerSession();
    const { path, bea, cal, fixtureId } = await seed(viewerId);
    await putPotmVote(testDb(), { fixtureId, voterId: cal, candidateId: bea, now: NOW });

    const html = await (await page(path, cookie)).text();
    expect(html).toContain("Who played best?");
    expect(html).toContain(`value="${bea}"`);
    expect(html).toContain("Gus (guest)");
    expect(html).not.toContain(`value="${viewerId}"`);
    expect(html).toContain("Votes are secret until voting closes");
    expect(html).not.toMatch(/\d+ votes?\b/);
  });

  it("says who you voted for once you have", async () => {
    const { cookie, viewerId } = await viewerSession();
    const { path, bea } = await seed(viewerId);
    await appPost(`${path}/potm`, { candidateId: bea }, cookie);
    const html = await (await page(path, cookie)).text();
    expect(html).toContain("You voted for <strong>Bea Striker</strong>.");
    expect(html).toContain("Change my vote");
  });

  it("names the winner once closed, and nobody below two votes", async () => {
    const { cookie, viewerId } = await viewerSession();
    const { path, fixtureId, bea, cal } = await seed(viewerId, { kickoffHours: -30 });
    const db = testDb();

    await putPotmVote(db, { fixtureId, voterId: cal, candidateId: bea, now: NOW });
    const lonely = await (await page(path, cookie)).text();
    expect(lonely).not.toContain("Player of the match");

    await putPotmVote(db, { fixtureId, voterId: viewerId, candidateId: bea, now: NOW });
    const html = await (await page(path, cookie)).text();
    expect(html).toContain("Player of the match");
    expect(html).toContain(`<p class="potm-winner">Bea Striker</p>`);
    expect(html).toContain("2 votes");
    expect(html).not.toContain("Who played best?");
  });

  it("is absent for a game with the squad hidden from players", async () => {
    const { cookie, viewerId } = await viewerSession();
    const { path } = await seed(viewerId, { squadVisibleToPlayers: false });
    expect(await (await page(path, cookie)).text()).not.toContain("Player of the match");
  });
});

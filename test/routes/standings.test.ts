import { SELF, env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { gamePath } from "../../src/auth/paths.js";
import { getDb } from "../../src/db/client.js";
import { games, players } from "../../src/db/schema.js";
import {
  insertFixture,
  insertFixtureResult,
  insertGame,
  insertMembership,
  insertPlayer,
  insertResponse,
  resetDatabase,
} from "../support/factories.js";
import { kickoffIn } from "../support/clock.js";
import { ALLOWED, ORIGIN, signIn } from "../support/sign-in.js";

const db = getDb(env.DB);

async function viewerId(): Promise<string> {
  const [player] = await db.select().from(players).where(eq(players.email, ALLOWED));
  expect(player, "signing in must have created a Player").toBeDefined();
  return player!.id;
}

/**
 * A game the viewer has played one won fixture in, alongside `Bo Nkemelu` who
 * lost it. `owner` decides which of the two game pages the viewer gets.
 */
async function seedPlayedGame(viewer: string, options: { owner?: boolean } = {}) {
  const gameId = await insertGame(db, { name: "Thursday 7-a-side" });
  await insertMembership(db, gameId, viewer, { role: options.owner ? "owner" : "player" });
  const rival = await insertPlayer(db, { email: "bo@example.com", name: "Bo Nkemelu" });
  await insertMembership(db, gameId, rival);

  const fixtureId = await insertFixture(db, gameId, {
    lifecycle: "played",
    kicksOffAt: kickoffIn(-72),
  });
  await insertResponse(db, fixtureId, viewer, { status: "in", team: "a" });
  await insertResponse(db, fixtureId, rival, { status: "in", team: "b" });
  await insertFixtureResult(db, fixtureId, { outcome: "a", scoreA: 4, scoreB: 1 });

  return { gameId, rival };
}

const load = async (gameId: string, cookie: string) =>
  (await SELF.fetch(`${ORIGIN}${gamePath(gameId)}`, { headers: { cookie } })).text();

describe("the standings on a game page", () => {
  beforeEach(resetDatabase);

  it("shows a member the squad's league table", async () => {
    const { cookie } = await signIn();
    const viewer = await viewerId();
    const { gameId } = await seedPlayedGame(viewer);

    const html = await load(gameId, cookie);

    expect(html).toContain("Standings");
    expect(html).toContain("Bo Nkemelu");
    // Three points for the win, none for the defeat.
    expect(html).toContain(`<td class="count">3</td>`);
    expect(html).toContain(`<td class="count">+3</td>`);
  });

  it("shows the organiser the same table on their own game page", async () => {
    const { cookie } = await signIn();
    const viewer = await viewerId();
    const { gameId } = await seedPlayedGame(viewer, { owner: true });

    const html = await load(gameId, cookie);

    expect(html).toContain("Standings");
    expect(html).toContain("Bo Nkemelu");
  });

  it("hides the table from a member whose game hides the squad", async () => {
    const { cookie } = await signIn();
    const viewer = await viewerId();
    const { gameId } = await seedPlayedGame(viewer);
    await db.update(games).set({ squadVisibleToPlayers: false }).where(eq(games.id, gameId));

    const html = await load(gameId, cookie);

    expect(html).toContain("Thursday 7-a-side");
    expect(html).not.toContain("Standings");
    expect(html).not.toContain("Bo Nkemelu");
  });

  it("still shows the organiser the table when the squad is hidden from players", async () => {
    const { cookie } = await signIn();
    const viewer = await viewerId();
    const { gameId } = await seedPlayedGame(viewer, { owner: true });
    await db.update(games).set({ squadVisibleToPlayers: false }).where(eq(games.id, gameId));

    const html = await load(gameId, cookie);

    expect(html).toContain("Standings");
  });

  it("shows no table on a game nobody has played yet", async () => {
    const { cookie } = await signIn();
    const viewer = await viewerId();
    const gameId = await insertGame(db);
    await insertMembership(db, gameId, viewer);

    const html = await load(gameId, cookie);

    expect(html).not.toContain("Standings");
  });

  it("leaves out a member who was not in the played fixture", async () => {
    const { cookie } = await signIn();
    const viewer = await viewerId();
    const { gameId } = await seedPlayedGame(viewer);
    const absent = await insertPlayer(db, { email: "cy@example.com", name: "Cy Absent" });
    await insertMembership(db, gameId, absent);

    const html = await load(gameId, cookie);

    expect(html).toContain("Standings");
    expect(html).not.toContain("Cy Absent");
  });
});

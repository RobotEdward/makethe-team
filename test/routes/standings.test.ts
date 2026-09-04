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

/**
 * The sort a player picks, and the fact that it follows them (M59).
 *
 * The order itself is `sortStandings`' business and tested there; what these
 * cases are for is the round trip — a query string reaching the table, the
 * choice reaching `players.standings_sort`, and a stored value reaching the
 * next page load without a query string on it.
 */
describe("the standings sort", () => {
  beforeEach(resetDatabase);

  const storedSort = async (playerId: string) => {
    const [row] = await db.select().from(players).where(eq(players.id, playerId));
    return row!.standingsSort;
  };

  const loadSorted = async (gameId: string, cookie: string, query: string) =>
    (await SELF.fetch(`${ORIGIN}${gamePath(gameId)}?${query}`, { headers: { cookie } })).text();

  it("sorts the table the way the query string asks", async () => {
    const { cookie } = await signIn();
    const viewer = await viewerId();
    const { gameId } = await seedPlayedGame(viewer);

    const html = await loadSorted(gameId, cookie, "sort=player");

    expect(html).toContain(`aria-sort="ascending"`);
    expect(html).not.toContain(`href="?sort=player"`);
  });

  it("remembers the choice against the player", async () => {
    const { cookie } = await signIn();
    const viewer = await viewerId();
    const { gameId } = await seedPlayedGame(viewer);

    await loadSorted(gameId, cookie, "sort=lost");

    expect(await storedSort(viewer)).toBe("lost");
  });

  it("uses the remembered choice on a later load with no query string at all", async () => {
    const { cookie } = await signIn();
    const viewer = await viewerId();
    const { gameId } = await seedPlayedGame(viewer);
    await db.update(players).set({ standingsSort: "drawn" }).where(eq(players.id, viewer));

    const html = await load(gameId, cookie);

    expect(html).not.toContain(`href="?sort=drawn"`);
    expect(html).toContain(`href="?sort=points"`);
  });

  it("carries the choice to the player's other games, not just the one they set it on", async () => {
    const { cookie } = await signIn();
    const viewer = await viewerId();
    const { gameId } = await seedPlayedGame(viewer);
    // A second squad of their own, with a rival the first one has not got:
    // `players.email` is unique, so the two seeds cannot share Bo.
    const otherGame = await insertGame(db, { name: "Sunday League" });
    await insertMembership(db, otherGame, viewer);
    const otherRival = await insertPlayer(db, { email: "di@example.com", name: "Di Ashworth" });
    await insertMembership(db, otherGame, otherRival);
    const otherFixture = await insertFixture(db, otherGame, {
      lifecycle: "played",
      kicksOffAt: kickoffIn(-96),
    });
    await insertResponse(db, otherFixture, viewer, { status: "in", team: "a" });
    await insertResponse(db, otherFixture, otherRival, { status: "in", team: "b" });
    await insertFixtureResult(db, otherFixture, { outcome: "b", scoreA: 0, scoreB: 2 });

    await loadSorted(gameId, cookie, "sort=won");
    const html = await load(otherGame, cookie);

    expect(html).not.toContain(`href="?sort=won"`);
  });

  it("shows the organiser their own remembered sort on the page they own", async () => {
    const { cookie } = await signIn();
    const viewer = await viewerId();
    const { gameId } = await seedPlayedGame(viewer, { owner: true });

    const html = await loadSorted(gameId, cookie, "sort=played");

    expect(html).not.toContain(`href="?sort=played"`);
    expect(await storedSort(viewer)).toBe("played");
  });

  /**
   * A hand-typed or stale key is an ordinary reading, not an error: the page
   * renders in the league order and nothing is written over what the player
   * last chose deliberately.
   */
  it("ignores a sort key the table does not have", async () => {
    const { cookie } = await signIn();
    const viewer = await viewerId();
    const { gameId } = await seedPlayedGame(viewer);
    await db.update(players).set({ standingsSort: "won" }).where(eq(players.id, viewer));

    const html = await loadSorted(gameId, cookie, "sort=goals-per-90");

    expect(html).toContain("Standings");
    expect(html).not.toContain(`href="?sort=won"`);
    expect(await storedSort(viewer)).toBe("won");
  });

  /**
   * A value no release of this table ever offered, sitting in the column: the
   * page must render in the league order rather than throw on a lookup miss.
   * `test/stored-lookups.test.ts` is the general guard; this is the route.
   */
  it("renders in the league order for a stored key the table no longer has", async () => {
    const { cookie } = await signIn();
    const viewer = await viewerId();
    const { gameId } = await seedPlayedGame(viewer);
    await db.update(players).set({ standingsSort: "form" }).where(eq(players.id, viewer));

    const html = await load(gameId, cookie);

    expect(html).toContain("Standings");
    expect(html).not.toContain(`href="?sort=points"`);
  });

  it("offers no sort links to a member who may not see the table at all", async () => {
    const { cookie } = await signIn();
    const viewer = await viewerId();
    const { gameId } = await seedPlayedGame(viewer);
    await db.update(games).set({ squadVisibleToPlayers: false }).where(eq(games.id, gameId));

    const html = await loadSorted(gameId, cookie, "sort=won");

    // `sort-link` itself is in the stylesheet on every page that loads
    // LEAGUE_CSS, so the assertion has to be about the markup: no heading
    // link, and no table for one to head.
    expect(html).not.toContain(`href="?sort=`);
    expect(html).not.toContain("Standings");
  });
});

import { env } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { DASHBOARD_PATH, SIGN_IN_PATH } from "../../src/auth/paths.js";
import { getDb } from "../../src/db/client.js";
import { fixtures, memberships, players, responses } from "../../src/db/schema.js";
import { openFixture } from "../../src/domain/open-fixture.js";
import { insertGame, resetDatabase } from "../support/factories.js";
import { ALLOWED, ORIGIN, bindings, signIn } from "../support/sign-in.js";

const db = getDb(env.DB);

/**
 * Every kickoff in this file is an explicit, far-future instant.
 *
 * The dashboard route reads the real wall clock (it is the edge of the
 * request), so a fixture seeded relative to "now" would make the derived
 * status flip as the suite ages — and `Date.now()` is frozen between I/O in
 * workerd while the test isolate's clock drifts, so no assertion here may
 * depend on the two agreeing. 2030-06-13 is a Thursday; Europe/London is on
 * BST then, so 18:00Z renders as 19:00 local.
 */
const KICKOFF = new Date("2030-06-13T18:00:00Z");
const KICKOFF_LOCAL = "Thursday 13 June at 19:00";
const EARLIER_KICKOFF = new Date("2030-06-06T18:00:00Z");
const LATER_KICKOFF = new Date("2030-06-20T18:00:00Z");
/** Passed to `openFixture` as its `openedAt`; nothing asserted depends on it. */
const OPENED_AT = new Date("2030-06-01T09:00:00Z");

interface Seeded {
  gameId: string;
  fixtureId: string;
  /** The other squad members, in insertion order. Never includes the viewer. */
  otherPlayerIds: string[];
}

/** The Player the sign-in journey created for `ALLOWED`. */
async function viewerId(): Promise<string> {
  const [player] = await db.select().from(players).where(eq(players.email, ALLOWED));
  expect(player, "signing in must have created a Player").toBeDefined();
  return player!.id;
}

/**
 * A game with an opened fixture, the viewer as a member, and `others` extra
 * squad members. Everything the tests vary goes through `overrides`.
 */
async function seedFixtureFor(
  playerId: string,
  overrides: {
    gameName?: string;
    venueName?: string;
    kicksOffAt?: Date;
    maxPlayers?: number;
    minPlayers?: number;
    /** The viewer's membership. `false` is "they left this game". */
    memberActive?: boolean;
    /** Names of other squad members to add. */
    others?: string[];
    lifecycle?: "open" | "played" | "cancelled";
  } = {},
): Promise<Seeded> {
  const maxPlayers = overrides.maxPlayers ?? 14;
  const gameId = await insertGame(db, {
    name: overrides.gameName ?? "Thursday 7-a-side",
    venueName: overrides.venueName ?? "Oxford Sports Park",
    maxPlayers,
  });

  const fixtureId = crypto.randomUUID();
  await db.insert(fixtures).values({
    id: fixtureId,
    gameId,
    kicksOffAt: overrides.kicksOffAt ?? KICKOFF,
    minPlayers: overrides.minPlayers ?? 1,
    maxPlayers,
    prefersEvenNumbers: true,
    shortWarningOffsetHours: 12,
    durationMinutes: 60,
  });

  await db.insert(memberships).values({ id: crypto.randomUUID(), gameId, playerId, active: true });

  const otherPlayerIds: string[] = [];
  for (const name of overrides.others ?? []) {
    const otherId = crypto.randomUUID();
    await db.insert(players).values({ id: otherId, name, email: `${otherId}@example.com` });
    await db
      .insert(memberships)
      .values({ id: crypto.randomUUID(), gameId, playerId: otherId, active: true });
    otherPlayerIds.push(otherId);
  }

  // Opening the fixture is what mints the `pending` rows — the eligible set is
  // fixed here and nowhere else (BR-1, BR-2).
  await openFixture(db, fixtureId, OPENED_AT);

  // Applied *after* opening, so the viewer still has the response row a real
  // departure would leave behind: leaving a Game does not delete history.
  if (overrides.memberActive === false) {
    await db
      .update(memberships)
      .set({ active: false })
      .where(and(eq(memberships.gameId, gameId), eq(memberships.playerId, playerId)));
  }

  if (overrides.lifecycle && overrides.lifecycle !== "open") {
    await db.update(fixtures).set({ lifecycle: overrides.lifecycle }).where(eq(fixtures.id, fixtureId));
  }

  return { gameId, fixtureId, otherPlayerIds };
}

/** Record a response through the Durable Object — for setting up scenario state. */
async function setResponse(fixtureId: string, playerId: string, intent: "in" | "out") {
  return env.FIXTURE_CAPACITY.getByName(fixtureId).setResponse({
    playerId,
    intent,
    actorPlayerId: null,
    source: "system",
    now: OPENED_AT.getTime(),
  });
}

function get(cookie?: string) {
  return createApp().fetch(
    new Request(`${ORIGIN}${DASHBOARD_PATH}`, { headers: cookie ? { cookie } : {} }),
    bindings(),
  );
}

function post(
  cookie: string | undefined,
  fields: Record<string, string>,
  origin: string | null = ORIGIN,
) {
  return createApp().fetch(
    new Request(`${ORIGIN}${DASHBOARD_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...(cookie ? { cookie } : {}),
        ...(origin ? { origin } : {}),
      },
      body: new URLSearchParams(fields),
    }),
    bindings(),
  );
}

async function responseRow(fixtureId: string, playerId: string) {
  const [row] = await db
    .select()
    .from(responses)
    .where(and(eq(responses.fixtureId, fixtureId), eq(responses.playerId, playerId)));
  return row;
}

async function fixtureRow(fixtureId: string) {
  const [row] = await db.select().from(fixtures).where(eq(fixtures.id, fixtureId));
  return row;
}

beforeEach(async () => {
  await resetDatabase();
});

describe("GET /app", () => {
  it("lists an upcoming fixture with the game, when, where and the viewer's own response", async () => {
    const { cookie } = await signIn();
    const playerId = await viewerId();
    const { fixtureId } = await seedFixtureFor(playerId, {
      gameName: "Tuesday Five",
      venueName: "Marston Astro",
    });
    await setResponse(fixtureId, playerId, "in");

    const response = await get(cookie);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(body).toContain("Tuesday Five");
    expect(body).toContain("Marston Astro");
    // Formatted in the game's own timezone, through `src/domain/time/zone.ts`.
    expect(body).toContain(KICKOFF_LOCAL);
    // The display status from `fixtureView`, and the viewer's own answer.
    expect(body).toMatch(/Open for responses|Confirmed/);
    // `&#39;`, not `'`: M4 widened `escapeHtml` to escape apostrophes, so
    // every rendered page emits the entity. Asserted literally rather than as
    // an either-form regex — a pattern accepting both would pass whether or
    // not the escaping happens, which is the exact defect a review caught in
    // M4's own assertions.
    expect(body).toContain("You&#39;re in");
  });

  it("needs no JavaScript and offers both responses as ordinary form submits", async () => {
    const { cookie } = await signIn();
    const playerId = await viewerId();
    await seedFixtureFor(playerId);

    const body = await (await get(cookie)).text();

    expect(body).not.toContain("<script");
    expect(body).not.toMatch(/type=.?password/i);
    expect(body).toContain('method="post"');
    expect(body).toContain(`action="${DASHBOARD_PATH}"`);
    expect(body).toContain('value="in"');
    expect(body).toContain('value="out"');
  });

  /**
   * The active-membership filter is a security control, not a display filter
   * (TR-18): the middleware established *who* is asking and nothing more, so
   * every membership question is re-asked here.
   */
  it("does not list a fixture for a game the viewer has left", async () => {
    const { cookie } = await signIn();
    const playerId = await viewerId();
    await seedFixtureFor(playerId, { gameName: "Left This One", memberActive: false });

    const body = await (await get(cookie)).text();

    expect(body).not.toContain("Left This One");
  });

  it("does not list a fixture for a game the viewer was never in", async () => {
    const { cookie } = await signIn();
    const playerId = await viewerId();

    // A whole game belonging to someone else, opened with its own squad.
    const strangerId = crypto.randomUUID();
    await db.insert(players).values({ id: strangerId, name: "Stranger", email: "stranger@example.com" });
    await seedFixtureFor(strangerId, { gameName: "Someone Else's Game" });
    // The viewer exists and is signed in, but belongs to nothing.
    expect(await db.select().from(memberships).where(eq(memberships.playerId, playerId))).toHaveLength(0);

    const body = await (await get(cookie)).text();

    expect(body).not.toContain("Someone Else's Game");
  });

  it("orders fixtures by kickoff ascending, across games", async () => {
    const { cookie } = await signIn();
    const playerId = await viewerId();
    await seedFixtureFor(playerId, { gameName: "Later Game", kicksOffAt: LATER_KICKOFF });
    await seedFixtureFor(playerId, { gameName: "Middle Game", kicksOffAt: KICKOFF });
    await seedFixtureFor(playerId, { gameName: "Earlier Game", kicksOffAt: EARLIER_KICKOFF });

    const body = await (await get(cookie)).text();

    expect(body.indexOf("Earlier Game")).toBeGreaterThan(-1);
    expect(body.indexOf("Earlier Game")).toBeLessThan(body.indexOf("Middle Game"));
    expect(body.indexOf("Middle Game")).toBeLessThan(body.indexOf("Later Game"));
  });

  /**
   * BR-25 authorises a cross-fixture view of the viewer's *own* commitments.
   * The squad list belongs to the fixture page; a dashboard is exactly where a
   * "while we're here" roster would creep in.
   */
  it("never shows another squad member's name", async () => {
    const { cookie } = await signIn();
    const playerId = await viewerId();
    const { fixtureId, otherPlayerIds } = await seedFixtureFor(playerId, {
      others: ["Ada Lovelace", "Grace Hopper"],
    });
    await setResponse(fixtureId, otherPlayerIds[0]!, "in");

    const body = await (await get(cookie)).text();

    expect(body).not.toContain("Ada Lovelace");
    expect(body).not.toContain("Grace Hopper");
  });

  it("leaves out fixtures that are already played or cancelled", async () => {
    const { cookie } = await signIn();
    const playerId = await viewerId();
    await seedFixtureFor(playerId, { gameName: "Played Game", lifecycle: "played" });
    await seedFixtureFor(playerId, { gameName: "Cancelled Game", lifecycle: "cancelled" });
    await seedFixtureFor(playerId, { gameName: "Live Game" });

    const body = await (await get(cookie)).text();

    expect(body).toContain("Live Game");
    // No row, therefore no action offered on it (BR-15).
    expect(body).not.toContain("Played Game");
    expect(body).not.toContain("Cancelled Game");
  });

  it("says so plainly when there is nothing coming up", async () => {
    const { cookie } = await signIn();
    await viewerId();

    const response = await get(cookie);

    expect(response.status).toBe(200);
    expect(await response.text()).toMatch(/nothing coming up/i);
  });

  /**
   * The whole of J1 is reachable from nowhere else in the app — no other page
   * links to `/g/new`. Without this, a signed-in player who has never owned a
   * game has no way to discover the feature except by typing the URL.
   */
  it("links to setting up a new game", async () => {
    const { cookie } = await signIn();
    await viewerId();

    const body = await (await get(cookie)).text();

    expect(body).toContain('href="/g/new"');
  });

  it("lists a game the viewer owns, linking to its overview", async () => {
    const { cookie } = await signIn();
    const playerId = await viewerId();
    const gameId = await insertGame(db, { name: "Sunday Kickabout" });
    await db
      .insert(memberships)
      .values({ id: crypto.randomUUID(), gameId, playerId, active: true, role: "owner" });

    const body = await (await get(cookie)).text();

    expect(body).toContain("Sunday Kickabout");
    expect(body).toContain(`href="/g/${gameId}"`);
  });

  /**
   * A player who owns no game must not see an empty "Games you own" section —
   * a heading over nothing reads as a broken page, not an honest empty state.
   * The "Set up a game" link on its own already says what to do next.
   */
  it("shows no owned-games header when the viewer owns nothing", async () => {
    const { cookie } = await signIn();
    await viewerId();

    const body = await (await get(cookie)).text();

    expect(body).not.toContain("Games you own");
  });

  it("does not list a game the viewer belongs to but does not own", async () => {
    const { cookie } = await signIn();
    const playerId = await viewerId();
    const gameId = await insertGame(db, { name: "Someone Else's Game" });
    await db
      .insert(memberships)
      .values({ id: crypto.randomUUID(), gameId, playerId, active: true, role: "player" });

    const body = await (await get(cookie)).text();

    expect(body).not.toContain("Games you own");
  });

  it("redirects an anonymous visitor to sign-in", async () => {
    const response = await get();

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(SIGN_IN_PATH);
  });

  /**
   * The redirect must be the same redirect whether or not the address behind
   * the (absent) session is one this deployment knows — otherwise the page is
   * an enumeration oracle for who has a Player.
   */
  it("answers an anonymous visitor identically whether or not a Player exists", async () => {
    const observable = async (response: Response) => ({
      status: response.status,
      headers: [...response.headers].sort(([a], [b]) => a.localeCompare(b)),
      setCookie: response.headers.getSetCookie(),
      body: await response.text(),
    });

    const nobody = await observable(await get());

    await resetDatabase();
    const playerId = crypto.randomUUID();
    await db.insert(players).values({ id: playerId, name: "Ada", email: ALLOWED });
    await seedFixtureFor(playerId, { gameName: "Ada's Game" });
    const somebody = await observable(await get());

    expect(somebody).toEqual(nobody);
  });

  /**
   * This is the first page behind sign-in that renders a signed-in player's
   * own data (their games, their responses). Without this header a shared or
   * disk cache — a corporate proxy, a browser's back/forward cache on a
   * shared machine — could serve one player's dashboard to the next visitor.
   */
  it("sends Cache-Control: private, no-store on the authenticated page", async () => {
    const { cookie } = await signIn();
    await seedFixtureFor(await viewerId());

    const response = await get(cookie);

    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
});

describe("POST /app", () => {
  it("records a change through the Durable Object with source web", async () => {
    const { cookie } = await signIn();
    const playerId = await viewerId();
    const { fixtureId } = await seedFixtureFor(playerId);

    const response = await post(cookie, { fixtureId, intent: "in" });

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(DASHBOARD_PATH);

    const row = await responseRow(fixtureId, playerId);
    expect(row!.status).toBe("in");
    // The source column exists to tell a web change apart from a token one.
    expect(row!.source).toBe("web");
    // The player set it themselves; this is not an owner override (BR-27).
    expect(row!.setByPlayerId).toBeNull();
    // `in_count` is a cache only the Durable Object ever writes (TR-10), so a
    // direct write from the route could not have produced this.
    expect((await fixtureRow(fixtureId))!.inCount).toBe(1);
  });

  /**
   * The capacity proof. Going "through the object" is only meaningful if the
   * object's decision actually binds, so this makes the change hit a full
   * fixture and asserts the outcome is a waitlist placement — something a
   * direct `UPDATE responses` from the route could never produce.
   */
  it("respects capacity: a change into a full fixture is waitlisted", async () => {
    const { cookie } = await signIn();
    const playerId = await viewerId();
    const { fixtureId, otherPlayerIds } = await seedFixtureFor(playerId, {
      maxPlayers: 1,
      others: ["Ada Lovelace"],
    });
    await setResponse(fixtureId, otherPlayerIds[0]!, "in");
    expect((await fixtureRow(fixtureId))!.inCount).toBe(1);

    const response = await post(cookie, { fixtureId, intent: "in" });
    expect(response.status).toBe(303);

    const row = await responseRow(fixtureId, playerId);
    expect(row!.status).toBe("waitlisted");
    expect(row!.waitlistPosition).toBe(1);
    expect(row!.source).toBe("web");
    // Nobody was let into a full fixture.
    const fixture = await fixtureRow(fixtureId);
    expect(fixture!.inCount).toBe(1);
    expect(fixture!.waitlistCount).toBe(1);

    // And the page tells them, rather than implying they got in.
    const body = await (await get(cookie)).text();
    expect(body).toMatch(/waitlist/i);
  });

  it("records dropping out, freeing the slot", async () => {
    const { cookie } = await signIn();
    const playerId = await viewerId();
    const { fixtureId } = await seedFixtureFor(playerId);
    await setResponse(fixtureId, playerId, "in");
    expect((await fixtureRow(fixtureId))!.inCount).toBe(1);

    const response = await post(cookie, { fixtureId, intent: "out" });

    expect(response.status).toBe(303);
    expect((await responseRow(fixtureId, playerId))!.status).toBe("out");
    expect((await fixtureRow(fixtureId))!.inCount).toBe(0);
  });

  /**
   * BR-15: the page offers no action on a played fixture, and the server
   * refuses one anyway. 404, not 403 — a fixture id must not be probeable for
   * existence (TR-18).
   */
  it("refuses a replayed form against a played fixture", async () => {
    const { cookie } = await signIn();
    const playerId = await viewerId();
    const { fixtureId } = await seedFixtureFor(playerId);
    await setResponse(fixtureId, playerId, "in");
    await db.update(fixtures).set({ lifecycle: "played" }).where(eq(fixtures.id, fixtureId));

    const response = await post(cookie, { fixtureId, intent: "out" });

    expect(response.status).toBe(404);
    expect((await responseRow(fixtureId, playerId))!.status).toBe("in");
    expect((await fixtureRow(fixtureId))!.inCount).toBe(1);
  });

  it("refuses a change to a game the viewer has left", async () => {
    const { cookie } = await signIn();
    const playerId = await viewerId();
    const { fixtureId } = await seedFixtureFor(playerId, { memberActive: false });

    const response = await post(cookie, { fixtureId, intent: "in" });

    expect(response.status).toBe(404);
    expect((await responseRow(fixtureId, playerId))!.status).toBe("pending");
    expect((await fixtureRow(fixtureId))!.inCount).toBe(0);
  });

  it("refuses a change to a fixture in someone else's game", async () => {
    const { cookie } = await signIn();
    await viewerId();
    const strangerId = crypto.randomUUID();
    await db.insert(players).values({ id: strangerId, name: "Stranger", email: "stranger@example.com" });
    const { fixtureId } = await seedFixtureFor(strangerId);

    const response = await post(cookie, { fixtureId, intent: "in" });

    expect(response.status).toBe(404);
    expect((await responseRow(fixtureId, strangerId))!.status).toBe("pending");
  });

  it("refuses a fixture id that does not exist, without saying so", async () => {
    const { cookie } = await signIn();
    await viewerId();

    const response = await post(cookie, { fixtureId: crypto.randomUUID(), intent: "in" });

    expect(response.status).toBe(404);
  });

  it("rejects an intent that is not in or out", async () => {
    const { cookie } = await signIn();
    const playerId = await viewerId();
    const { fixtureId } = await seedFixtureFor(playerId);

    const response = await post(cookie, { fixtureId, intent: "maybe" });

    expect(response.status).toBe(400);
    expect((await responseRow(fixtureId, playerId))!.status).toBe("pending");
  });

  it("sends an anonymous poster to sign-in and writes nothing", async () => {
    await signIn();
    const playerId = await viewerId();
    const { fixtureId } = await seedFixtureFor(playerId);

    const response = await post(undefined, { fixtureId, intent: "in" });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(SIGN_IN_PATH);
    expect((await responseRow(fixtureId, playerId))!.status).toBe("pending");
  });

  it("refuses a cross-site post", async () => {
    const { cookie } = await signIn();
    const playerId = await viewerId();
    const { fixtureId } = await seedFixtureFor(playerId);

    const response = await post(cookie, { fixtureId, intent: "in" }, "https://evil.test");

    expect(response.status).toBe(403);
    expect((await responseRow(fixtureId, playerId))!.status).toBe("pending");
  });
});

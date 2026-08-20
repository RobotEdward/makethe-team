import { SELF, env } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import {
  ACCOUNT_PATH,
  DASHBOARD_PATH,
  ONBOARDING_DISMISS_PATH,
  PASSKEYS_PATH,
  DELETE_ACCOUNT_CANCEL_PATH,
  DELETE_ACCOUNT_PATH,
  SIGN_IN_PATH,
} from "../../src/auth/paths.js";
import { getDb } from "../../src/db/client.js";
import { fixtures, memberships, passkey, players, pushSubscriptions, responses } from "../../src/db/schema.js";
import { openFixture } from "../../src/domain/open-fixture.js";
import { SERVICE_WORKER_JS } from "../../src/views/scripts.js";
import { DASHBOARD_STYLES_CSS, SQUAD_STYLES_CSS } from "../../src/views/styles.js";
import { insertGame, insertMembership, resetDatabase } from "../support/factories.js";
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
    whenFull: "waitlist",
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

    // Every page carries the site-wide service worker registration (M13
    // Task 5); stripped first so this keeps proving nothing *else* needs
    // script.
    expect(body).toContain(`<script>${SERVICE_WORKER_JS}</script>`);
    expect(body.replace(`<script>${SERVICE_WORKER_JS}</script>`, "")).not.toContain("<script");
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
   * The owned-games list was the last browser-default bulleted list in the
   * app: `<ul class="owned-games">` was rendered and `DASHBOARD_STYLES_CSS`
   * carried no rule for it at all, so it shipped with UA discs and indent
   * directly under a column of bordered fixture cards.
   *
   * Two assertions, deliberately. The CSS one names the actual defect — that
   * no rule existed — but still passes if the markup later stops emitting the
   * class; the markup one still passes if the rule is deleted. Each covers
   * the other's blind spot.
   *
   * The needle carries its opening brace: a bare selector needle
   * prefix-matches, which is how a `.w-5` assertion earlier in M12 was
   * silently satisfied by `.w-50`'s rule.
   */
  it("styles the games you own instead of shipping a bulleted list", async () => {
    const { cookie } = await signIn();
    const playerId = await viewerId();
    const gameId = await insertGame(db, { name: "Sunday Kickabout" });
    await db
      .insert(memberships)
      .values({ id: crypto.randomUUID(), gameId, playerId, active: true, role: "owner" });

    const body = await (await get(cookie)).text();

    expect(body).toContain(`<ul class="owned-games">`);
    expect(DASHBOARD_STYLES_CSS).toContain(".owned-games {");
    expect(DASHBOARD_STYLES_CSS).toContain("ul.owned-games > li {");
  });

  /**
   * Scoped `ul.owned-games > li`, never a bare `.owned-games li`. A bare
   * descendant selector is (0,1,1) and beats a chip's own (0,1,0) `.chip`
   * whatever the block order, and this app nests `li` inside `li` — that is
   * exactly how squad rows swallowed chips once already. The same rule bans
   * reaching this markup by widening `ul.squad > li`.
   */
  it("keeps the owned-games row selector off every other list item", () => {
    expect(DASHBOARD_STYLES_CSS).not.toContain(".owned-games li {");
    expect(SQUAD_STYLES_CSS).not.toContain(".squad li {");
    expect(SQUAD_STYLES_CSS).not.toContain("owned-games");
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

  /**
   * J6a's squad removal (`withdrawMember`) clears `memberships.active` and
   * sets `leftAt` — the same shape a game-left test above already drives by
   * hand. This pins the dashboard query's side of that contract rather than
   * assuming it: "should already do this" is exactly how the `connect-src`
   * bug shipped (see `docs/known-issues.md`), so it is asserted, not assumed.
   * Driven through `SELF.fetch` (TR-29) rather than the in-process app the
   * rest of this file uses, so a routing or middleware gap between the two
   * cannot hide behind this assertion.
   */
  it("no longer shows a game the player has been removed from", async () => {
    const { cookie } = await signIn();
    const playerId = await viewerId();
    const gameId = await insertGame(db, { name: "Thursday 7-a-side" });
    await insertMembership(db, gameId, playerId, { active: false, leftAt: OPENED_AT });

    const html = await (await SELF.fetch(`${ORIGIN}${DASHBOARD_PATH}`, { headers: { cookie } })).text();
    expect(html).not.toContain("Thursday 7-a-side");
  });

  /**
   * The member's own game page is reachable from here or from nowhere: a
   * player who owns nothing gets no "Games you own" list, so the fixture
   * card's heading is their only link into it.
   */
  it("links a member who owns nothing to a game they are in", async () => {
    const { cookie } = await signIn();
    const playerId = await viewerId();
    const { gameId } = await seedFixtureFor(playerId, { gameName: "Sunday Kickabout" });

    const html = await (await SELF.fetch(`${ORIGIN}${DASHBOARD_PATH}`, { headers: { cookie } })).text();

    expect(html).not.toContain("Games you own");
    expect(html).toContain(`href="/g/${gameId}"`);
  });

  it("keeps delete and privacy in the footer but drops the passkey nudge and sign-out (M20 B2)", async () => {
    const { cookie } = await signIn();
    await viewerId();

    const html = await (await get(cookie)).text();

    expect(html).toContain("Delete my account and data");
    expect(html).toContain("Privacy");
    expect(html).not.toContain("Sign in faster next time with a passkey");
    // The sign-out form lives on the account page only now (spec decision Q3).
    expect(html).not.toContain('class="signout"');
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

  /**
   * Without this link `/app/delete` exists and nothing reaches it — the same
   * "built but nobody can get to it" failure `renderOwnedGamesSection`'s
   * comment describes, and which happened again at M8.
   */
  it("links to the account page", async () => {
    const { cookie } = await signIn();
    const body = await (
      await SELF.fetch(`${ORIGIN}${DASHBOARD_PATH}`, { headers: { cookie } })
    ).text();
    expect(body).toContain(`href="${ACCOUNT_PATH}"`);
  });

  it("links to deleting my account and data, with no erasure banner when none is pending", async () => {
    const { cookie } = await signIn();
    await viewerId();

    const body = await (await get(cookie)).text();

    expect(body).toContain(`href="${DELETE_ACCOUNT_PATH}"`);
    expect(body).not.toContain(DELETE_ACCOUNT_CANCEL_PATH);
  });

  /**
   * BR-34: a pending erasure must be visible somewhere a person who did *not*
   * request it will actually see it, not only on the page where it was
   * requested. The dashboard is the page a player actually visits.
   */
  it("banners a pending erasure with its date and a cancel form", async () => {
    const { cookie } = await signIn();
    const playerId = await viewerId();
    await db
      .update(players)
      .set({ erasesAt: new Date("2030-06-15T09:00:00Z") })
      .where(eq(players.id, playerId));

    const body = await (await get(cookie)).text();

    // Europe/London, matching `send-erasure-scheduled.ts`'s choice for the
    // same not-scoped-to-a-game message. June is BST, so 09:00Z is 10:00 local.
    expect(body).toContain("Saturday 15 June at 10:00");
    expect(body).toContain(`action="${DELETE_ACCOUNT_CANCEL_PATH}"`);
    expect(body).toContain('method="post"');
    expect(body).toContain("due to be erased on");
  });

  /**
   * §6's third clause, and the defect the final review found: an erasure the
   * sweep refuses stays pending forever, and the banner went on promising a
   * date that had already passed, naming nothing.
   */
  it("banners an overdue erasure as held up, naming and linking the game holding it", async () => {
    const { cookie } = await signIn();
    const playerId = await viewerId();
    const gameId = await insertGame(db, { name: "Sole-Organised Game" });
    await insertMembership(db, gameId, playerId, { role: "owner", active: true });
    await db
      .update(players)
      .set({ erasesAt: new Date(Date.now() - 3_600_000) })
      .where(eq(players.id, playerId));

    const body = await (await get(cookie)).text();

    expect(body).toContain("hasn't happened yet");
    // Past tense, not the plain banner's future-tense promise.
    expect(body).not.toContain("is due to be erased on");
    expect(body).toContain("Sole-Organised Game");
    expect(body).toContain(`href="/g/${gameId}"`);
    // Still cancellable: nothing has been written, so keeping the account is
    // still an honest offer.
    expect(body).toContain(`action="${DELETE_ACCOUNT_CANCEL_PATH}"`);
  });

  /**
   * The half-run case. Squads have already been left and other people
   * promoted into the places given up, so the cancel button must go: pressing
   * it would strand the account out of those squads with nothing left to
   * finish the job.
   */
  it("drops the cancel form from the banner once execution has begun", async () => {
    const { cookie } = await signIn();
    const playerId = await viewerId();
    const past = new Date(Date.now() - 3_600_000);
    await db
      .update(players)
      .set({ erasesAt: past, erasureStartedAt: past })
      .where(eq(players.id, playerId));

    const body = await (await get(cookie)).text();

    expect(body).toContain("already begun");
    expect(body).not.toContain(`action="${DELETE_ACCOUNT_CANCEL_PATH}"`);
  });

  /**
   * M10 §3.4, extended to the dashboard by the whole-branch review's
   * Important 2: a card shows the same "0 spots left" line and the same live
   * "I'm in" button as `/r/:token`, so it owes the viewer the identical
   * warning about what tapping it would do. Mirrors
   * `test/views/fixture.test.ts`'s "full fixture — states what a yes would
   * do, before the tap" — `renderFullWarning` is the same function, called
   * from `renderRow` instead of `renderFixturePage`.
   */
  describe("full fixture — states what a yes would do (M10 §3.4)", () => {
    it("warns a pending viewer that answering yes joins the waitlist", async () => {
      const { cookie } = await signIn();
      const playerId = await viewerId();
      const { fixtureId, otherPlayerIds } = await seedFixtureFor(playerId, {
        maxPlayers: 1,
        others: ["Other Player"],
      });
      await setResponse(fixtureId, otherPlayerIds[0]!, "in");

      const body = await (await get(cookie)).text();

      expect(body).toContain("The squad is full — answering yes puts you 1st on the waitlist.");
    });

    it("does not warn a viewer who is already in", async () => {
      const { cookie } = await signIn();
      const playerId = await viewerId();
      const { fixtureId } = await seedFixtureFor(playerId, { maxPlayers: 1 });
      await setResponse(fixtureId, playerId, "in");

      const body = await (await get(cookie)).text();

      expect(body).not.toContain("on the waitlist.");
    });

    it("says nothing when there is still room", async () => {
      const { cookie } = await signIn();
      const playerId = await viewerId();
      await seedFixtureFor(playerId, { maxPlayers: 14 });

      const body = await (await get(cookie)).text();

      expect(body).not.toContain("The squad is full");
    });
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

describe("POST /app/games/:gameId/leave", () => {
  // Signed in fresh for every test in this block, matching every other
  // describe in this file — the harness supports one real signed-in identity
  // (`ALLOWED`), and `VIEWER_ID` is that identity's own Player id.
  let cookie: string;
  let VIEWER_ID: string;

  beforeEach(async () => {
    ({ cookie } = await signIn());
    VIEWER_ID = await viewerId();
  });

  /** A same-origin form POST, matching `leaveOtherGamePath`'s own route. */
  function appPost(path: string, fields: Record<string, string>) {
    return SELF.fetch(`${ORIGIN}${path}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, cookie },
      body: new URLSearchParams(fields),
      redirect: "manual",
    });
  }

  /** A second game, besides whatever the viewer already has, that the viewer is an ordinary member of. */
  async function seedMembershipForViewer(): Promise<{ gameId: string }> {
    const gameId = await insertGame(db, { name: "Sunday Kickabout" });
    await insertMembership(db, gameId, VIEWER_ID, { role: "player", active: true });
    return { gameId };
  }

  /** A game the viewer holds no membership in at all. */
  async function seedGameWithoutViewer(): Promise<{ gameId: string }> {
    const gameId = await insertGame(db, { name: "Someone Else's Game" });
    return { gameId };
  }

  /** A game where the viewer is the one and only active organiser. */
  async function seedViewerAsSoleOrganiser(): Promise<{ gameId: string }> {
    const gameId = await insertGame(db, { name: "Sole-Organised Game" });
    await insertMembership(db, gameId, VIEWER_ID, { role: "owner", active: true });
    return { gameId };
  }

  it("lets a signed-in player leave another game they are in", async () => {
    const { gameId } = await seedMembershipForViewer();

    const response = await appPost(`/app/games/${gameId}/leave`, {});

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(DASHBOARD_PATH);
    const [membership] = await db.select().from(memberships)
      .where(and(eq(memberships.gameId, gameId), eq(memberships.playerId, VIEWER_ID)));
    expect(membership?.active).toBe(false);
  });

  it("404s when the signed-in player is not in that game", async () => {
    const { gameId } = await seedGameWithoutViewer();

    expect((await appPost(`/app/games/${gameId}/leave`, {})).status).toBe(404);
  });

  it("refuses a sole organiser", async () => {
    const { gameId } = await seedViewerAsSoleOrganiser();

    const response = await appPost(`/app/games/${gameId}/leave`, {});

    expect(response.status).toBe(422);
    const [membership] = await db.select().from(memberships)
      .where(and(eq(memberships.gameId, gameId), eq(memberships.playerId, VIEWER_ID)));
    expect(membership?.active).toBe(true);
  });

  it("refuses a cross-site post", async () => {
    const { gameId } = await seedMembershipForViewer();

    const response = await SELF.fetch(`${ORIGIN}/app/games/${gameId}/leave`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.test", cookie },
      body: new URLSearchParams({}),
      redirect: "manual",
    });

    expect(response.status).toBe(403);
    const [membership] = await db.select().from(memberships)
      .where(and(eq(memberships.gameId, gameId), eq(memberships.playerId, VIEWER_ID)));
    expect(membership?.active).toBe(true);
  });

  it("sends an anonymous poster to sign-in", async () => {
    await signIn();
    const { gameId } = await seedGameWithoutViewer();

    const response = await SELF.fetch(`${ORIGIN}/app/games/${gameId}/leave`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN },
      body: new URLSearchParams({}),
      redirect: "manual",
    });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(SIGN_IN_PATH);
  });
});

/**
 * The "Get set up" onboarding card (M19): shown to a recently signed-in
 * player, each hint vanishing as its task is done, the whole card ending on
 * dismissal or when the fortnight after first sign-in passes.
 *
 * `signIn()` stamps `emailVerifiedAt` at the real wall clock, so a fresh
 * sign-in is always inside the window here; the expiry test moves the stamp
 * into the past by hand.
 */
describe("the onboarding card (M19)", () => {
  async function viewer() {
    const [player] = await db.select().from(players).where(eq(players.email, ALLOWED));
    expect(player).toBeDefined();
    return player!;
  }

  function dismiss(cookie: string | undefined, origin: string | null = ORIGIN) {
    return createApp().fetch(
      new Request(`${ORIGIN}${ONBOARDING_DISMISS_PATH}`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          ...(cookie ? { cookie } : {}),
          ...(origin ? { origin } : {}),
        },
      }),
      bindings(),
    );
  }

  it("shows all three hints to a fresh sign-in, with the dismiss form", async () => {
    const { cookie } = await signIn();

    const body = await (await get(cookie)).text();

    expect(body).toContain("Get set up");
    expect(body).toContain(`<a href="${PASSKEYS_PATH}">Add a passkey to sign in faster</a>`);
    // The install hint carries the class the display-mode media query hides —
    // the class, not just the copy, is the contract with DASHBOARD_STYLES_CSS.
    expect(body).toContain('<li class="hint-install">');
    expect(body).toContain("Install the app on this device");
    expect(body).toContain(`<a href="${ACCOUNT_PATH}">Turn on notifications</a>`);
    expect(body).toContain(`action="${ONBOARDING_DISMISS_PATH}"`);
    expect(DASHBOARD_STYLES_CSS).toContain("(display-mode: standalone)");
    expect(DASHBOARD_STYLES_CSS).toContain(".onboarding li.hint-install { display: none; }");
  });

  it("drops the passkey hint once this identity has a passkey", async () => {
    const { cookie } = await signIn();
    const { authUserId } = await viewer();
    await db.insert(passkey).values({
      id: "pk-1",
      publicKey: "irrelevant",
      userId: authUserId!,
      credentialID: "cred-1",
      counter: 0,
      deviceType: "singleDevice",
      backedUp: false,
    });

    const body = await (await get(cookie)).text();

    expect(body).toContain("Get set up");
    expect(body).not.toContain("Add a passkey to sign in faster");
    expect(body).toContain("Turn on notifications");
  });

  it("drops the notifications hint once any device is subscribed", async () => {
    const { cookie } = await signIn();
    const { id } = await viewer();
    await db.insert(pushSubscriptions).values({
      id: "sub-1",
      playerId: id,
      endpoint: "https://push.example/only-in-tests",
      p256dh: "irrelevant",
      auth: "irrelevant",
    });

    const body = await (await get(cookie)).text();

    expect(body).toContain("Get set up");
    expect(body).toContain("Add a passkey to sign in faster");
    expect(body).not.toContain("Turn on notifications");
  });

  it("is gone after the fortnight window closes", async () => {
    const { cookie } = await signIn();
    const { id } = await viewer();
    await db
      .update(players)
      .set({ emailVerifiedAt: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000) })
      .where(eq(players.id, id));

    const body = await (await get(cookie)).text();

    expect(body).not.toContain("Get set up");
    // The class name alone would match the stylesheet's media-query rule,
    // which ships on every dashboard; the card's markup is the thing absent.
    expect(body).not.toContain('<li class="hint-install">');
  });

  it("dismisses for good: stamps the row, redirects, and never shows again", async () => {
    const { cookie } = await signIn();

    const response = await dismiss(cookie);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(DASHBOARD_PATH);

    const { onboardingDismissedAt } = await viewer();
    expect(onboardingDismissedAt).not.toBeNull();

    const body = await (await get(cookie)).text();
    expect(body).not.toContain("Get set up");
  });

  it("refuses a cross-origin dismissal without stamping anything", async () => {
    const { cookie } = await signIn();

    const response = await dismiss(cookie, "https://evil.example");

    expect(response.status).toBe(403);
    const { onboardingDismissedAt } = await viewer();
    expect(onboardingDismissedAt).toBeNull();
  });

  it("needs a session: a bare request is redirected away, not an error", async () => {
    const response = await dismiss(undefined);
    expect([302, 303]).toContain(response.status);
  });
});

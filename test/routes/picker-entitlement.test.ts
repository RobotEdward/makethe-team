import { SELF, env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { getDb } from "../../src/db/client.js";
import { fixtures, players } from "../../src/db/schema.js";
import { openFixture } from "../../src/domain/open-fixture.js";
import { insertFixture, insertGame, insertMembership, insertPlayer, resetDatabase } from "../support/factories.js";
import { kickoffIn, NOW } from "../support/clock.js";
import { ALLOWED, ORIGIN, signIn } from "../support/sign-in.js";

/**
 * The class guard for M29 (CLAUDE.md, "Working on a milestone", rule 1).
 *
 * Delegated picking is the first capability in this application that is
 * narrower than `owner`. Every other route under `/g/:id` is entitled by
 * `findGameForOwner`, and the whole safety of the feature is that
 * `loadPickerTarget` — the wider loader — is used by exactly three routes and
 * never leaks to a fourth. Nothing in the type system says that, and a future
 * handler copied from its neighbour would inherit the wider loader silently.
 *
 * So this walks Hono's own `app.routes` rather than a hand-kept list, in the
 * shape `test/routes/signin.test.ts` established and for the same reason: the
 * router's record of what it dispatches cannot go stale against the app the
 * way a comment can. Every registered `/g/:id` route must be classified here,
 * and every route classified `owner-only` must answer 404 to a signed-in
 * player who holds the strongest picking rights the feature can grant — the
 * named delegate on an open fixture of that very game.
 *
 * A new route under `/g/:id` fails this test until somebody classifies it.
 * That is the point.
 */

const db = getDb(env.DB);

beforeEach(resetDatabase);

/**
 * Routes under `/g/:id` that are deliberately reachable by somebody who is
 * not the owner, with the reason. A route here is *not* asserted against —
 * this list is the exemption, so each entry has to say why the route is safe
 * for a non-owner to reach.
 */
const NOT_OWNER_ONLY: Readonly<Record<string, string>> = {
  "GET /g/:id":
    "dispatches by role since M25 — an owner gets the game overview, a member " +
    "gets the player game page (src/routes/games.ts).",
  "GET /g/:id/fixtures":
    "the past-fixtures list, opened to players in M27 (src/routes/games.ts).",
  "GET /g/:id/f/:fixtureId":
    "dispatches by role since M25 — owner fixture page or player fixture page.",
  "POST /g/:id/mute": "the player's own auto-decline switch (M28).",
  "POST /g/:id/unmute": "the player's own auto-decline switch (M28).",
  "POST /g/:id/f/:fixtureId/result":
    "BR-37's electorate is players who were in, not owners (M25).",
  "POST /g/:id/f/:fixtureId/result/clear":
    "the same electorate as filing a claim (M25).",
  "GET /g/:id/f/:fixtureId/teams":
    "the picker page itself — M29's whole subject, asserted positively in " +
    "test/routes/picker-delegation.test.ts.",
  "POST /g/:id/f/:fixtureId/teams": "the picker's Save — M29's subject.",
  "POST /g/:id/f/:fixtureId/teams/publish": "the picker's Publish — M29's subject.",
  "POST /g/:id/f/:fixtureId/answer":
    "any active member answers their own fixture from the game page (M52) — " +
    "the same act as POST /app and POST /r/:token, and entitlement is " +
    "re-derived per handler by findActionableFixture inside recordWebAnswer, " +
    "which admits a member and nobody else.",
};

/** A game whose only fixture has been handed to the signed-in player to pick. */
async function seedDelegateOnOpenFixture() {
  const { cookie } = await signIn();
  const [viewer] = await db.select().from(players).where(eq(players.email, ALLOWED));
  const viewerId = viewer!.id;

  const gameId = await insertGame(db, { maxPlayers: 14 });
  const ownerId = await insertPlayer(db, { name: "Owner" });
  await insertMembership(db, gameId, ownerId, { role: "owner" });
  await insertMembership(db, gameId, viewerId);

  const fixtureId = await insertFixture(db, gameId, { kicksOffAt: kickoffIn(9), minPlayers: 1 });
  await openFixture(db, fixtureId, NOW);
  await db
    .update(fixtures)
    .set({ pickerMode: "delegate", teamPickerPlayerId: viewerId, teamPickerSetAt: NOW })
    .where(eq(fixtures.id, fixtureId));

  return { gameId, fixtureId, cookie, viewerId, ownerId };
}

/**
 * Fill a route pattern with the seeded ids. `:playerId` becomes the delegate
 * themselves, which is the harder case: a route that mistakenly let a
 * non-owner through would be letting them act on their *own* membership, the
 * most plausible thing a wrong entitlement check would permit.
 */
function fill(path: string, ids: { gameId: string; fixtureId: string; viewerId: string }): string {
  return path
    .replace(":id", ids.gameId)
    .replace(":fixtureId", ids.fixtureId)
    .replace(":playerId", ids.viewerId);
}

/**
 * Room for the sweep that requests every owner-only `/g/:id` route in one
 * test. Third of its kind: `dashboard.test.ts` and `signin.test.ts` gained the
 * same override on 4 September 2026, and on 5 September this one timed out on
 * a CI runner at 5.2s having passed locally in well under a second, blocking
 * the M62 deploy. Raised on the one test that demonstrably needs it, not
 * globally — the 5s default is what catches a test that has actually hung.
 */
const EVERY_ROUTE_TIMEOUT_MS = 30_000;

describe("the picker capability does not widen any other /g/:id route", () => {
  it("classifies every registered /g/:id route", () => {
    const registered = createApp()
      .routes.filter((route) => !(route.method === "ALL" && route.path.endsWith("/*")))
      .filter((route) => route.path.startsWith("/g/:id"))
      .map((route) => `${route.method} ${route.path}`);

    expect(registered.length).toBeGreaterThan(0);

    // The reverse direction as well: an exemption naming a route that no
    // longer exists would quietly stop meaning anything, and the next route
    // to take that path would inherit the exemption without anyone deciding
    // it should.
    for (const key of Object.keys(NOT_OWNER_ONLY)) {
      expect(registered, `${key} is exempted here but is no longer a registered route`).toContain(key);
    }
  });

  it("refuses the delegate on every owner-only route", async () => {
    const seeded = await seedDelegateOnOpenFixture();

    const ownerOnly = createApp()
      .routes.filter((route) => !(route.method === "ALL" && route.path.endsWith("/*")))
      .filter((route) => route.path.startsWith("/g/:id"))
      .map((route) => ({ method: route.method, path: route.path }))
      .filter((route) => !(`${route.method} ${route.path}` in NOT_OWNER_ONLY));

    expect(ownerOnly.length).toBeGreaterThan(0);

    for (const route of ownerOnly) {
      const response = await SELF.fetch(`${ORIGIN}${fill(route.path, seeded)}`, {
        method: route.method,
        headers: {
          cookie: seeded.cookie,
          origin: ORIGIN,
          ...(route.method === "POST" ? { "content-type": "application/x-www-form-urlencoded" } : {}),
        },
        body: route.method === "POST" ? new URLSearchParams() : undefined,
        redirect: "manual",
      });

      // 404 and never 403 (TR-18): a 403 confirms the resource exists, and
      // these paths carry ids that could otherwise be probed.
      expect(
        response.status,
        `${route.method} ${route.path} let a delegate through — it must answer 404 ` +
          "unless it is classified in NOT_OWNER_ONLY with a reason",
      ).toBe(404);
    }
  }, EVERY_ROUTE_TIMEOUT_MS);
});

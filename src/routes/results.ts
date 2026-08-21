import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Context } from "hono";
import { wrongOrigin } from "../auth/origin.js";
import { fixturePath } from "../auth/paths.js";
import { requirePlayer } from "../auth/session.js";
import { recordAudit } from "../db/audit.js";
import { getDb } from "../db/client.js";
import { findGameForMember, findGameForOwner } from "../db/queries.js";
import {
  deleteResultClaim,
  findResultClaim,
  listResultClaims,
  putResultClaim,
  resultElectorate,
} from "../db/result-queries.js";
import { fixtures } from "../db/schema.js";
import { parseClaim } from "../domain/result.js";
import { resultWritable } from "../domain/result-lock.js";
import type { AppEnv } from "../env.js";
import { renderPlayerFixture } from "./games.js";

export const resultsRoutes = new Hono<AppEnv>();

/**
 * Load the fixture named by `:id`/`:fixtureId` for whichever entitlement the
 * caller holds — owner or ordinary member — or `null` for neither.
 *
 * Tries `findGameForOwner` first, then `findGameForMember`, the same order
 * `GET /g/:id/f/:fixtureId` uses to decide which page to render (see that
 * route in `src/routes/games.ts`) — but unlike that route, both branches here
 * lead to the same next step, because filing a claim is not a role-dispatched
 * page. The fixture id is a second, independent path segment, so it is loaded
 * and checked against `game.id` before anything else: a fixture id from
 * another game must not be reachable (TR-18).
 */
async function loadEntitledFixture(c: Context<AppEnv>, gameId: string, fixtureId: string, playerId: string) {
  const db = getDb(c.env.DB);
  const game = (await findGameForOwner(db, gameId, playerId)) ?? (await findGameForMember(db, gameId, playerId));
  if (game === null) return null;
  const [fixture] = await db.select().from(fixtures).where(eq(fixtures.id, fixtureId));
  if (!fixture || fixture.gameId !== game.id) return null;
  return { db, game, fixture };
}

/**
 * File, move, agree with, or withdraw a claim about what happened (BR-37,
 * §7).
 *
 * The order of checks below is load-bearing, for the reason
 * `POST /g/:id/f/:fixtureId/teams/publish` documents at length for its own
 * three checks (`src/routes/games.ts`): entitlement first and always, because
 * anything that reads or reports the claims before it is decided would leak
 * how many people have voted on a fixture the caller has no standing in.
 */
resultsRoutes.post("/g/:id/f/:fixtureId/result", requirePlayer, async (c) => {
  if (wrongOrigin(c)) return c.text("Forbidden", 403);

  const player = c.get("player")!;
  // Check 1: entitlement, before anything reads or reveals a fixture.
  const target = await loadEntitledFixture(c, c.req.param("id"), c.req.param("fixtureId"), player.id);
  if (target === null) return c.text("Not found", 404);

  const now = new Date(Date.now());

  // Check 2: a fixture that has not been played has no result to have an
  // opinion about — this endpoint does not exist for it, and BR-37 §7's
  // refusal table gives that its own 404 row, separate from "locked". Kept
  // as its own boolean rather than folded into `resultWritable` (which owns
  // only the lock) so this guard can be exercised independently of the
  // electorate check below — the review that asked for this line named a
  // guard folded into another boolean as untestable in isolation.
  if (target.fixture.lifecycle !== "played") return c.text("Not found", 404);

  // Check 3: standing to vote on *this* fixture specifically — a member of
  // the game who never played it, and is not an owner, gets the same 404
  // (TR-18): the electorate is re-asked per handler, not assumed from
  // entitlement to the game.
  const electorate = await resultElectorate(target.db, target.game.id, target.fixture.id);
  if (!electorate.eligibleIds.has(player.id)) return c.text("Not found", 404);

  // Check 4: the window. The caller is entitled, so a refusal here is a 422
  // with the page re-rendered, not a 404 — the fixture merely stopped taking
  // claims, which is not an entitlement question.
  const claims = await listResultClaims(target.db, target.fixture.id);
  if (!resultWritable(target.fixture.lifecycle, target.fixture.kicksOffAt, claims.length, now)) {
    return renderPlayerFixture(
      c,
      target.game,
      target.fixture.id,
      player.id,
      now,
      { problem: "That fixture isn't taking a result any more." },
      422,
    );
  }

  // Check 5: the submitted form. `parseClaim` is the single place that
  // derives `outcome` from a submitted score — see its own comment for why
  // this route must not re-derive or second-guess it.
  const form = await c.req.parseBody();
  const parsed = parseClaim({
    outcome: typeof form["outcome"] === "string" ? form["outcome"] : undefined,
    scoreA: typeof form["scoreA"] === "string" ? form["scoreA"] : undefined,
    scoreB: typeof form["scoreB"] === "string" ? form["scoreB"] : undefined,
  });
  if (!parsed.ok) {
    return renderPlayerFixture(c, target.game, target.fixture.id, player.id, now, { problem: parsed.problem }, 422);
  }

  // The before-value for the audit row, read before the write replaces it.
  const before = await findResultClaim(target.db, target.fixture.id, player.id);
  await putResultClaim(target.db, {
    fixtureId: target.fixture.id,
    playerId: player.id,
    outcome: parsed.outcome,
    scoreA: parsed.scoreA,
    scoreB: parsed.scoreB,
    now,
  });

  await recordAudit(target.db, {
    actorPlayerId: player.id,
    entityType: "fixture",
    entityId: target.fixture.id,
    action: before === null ? "fixture.result_filed" : "fixture.result_changed",
    before:
      before === null
        ? undefined
        : { outcome: before.outcome, scoreA: before.scoreA, scoreB: before.scoreB },
    after: { outcome: parsed.outcome, scoreA: parsed.scoreA, scoreB: parsed.scoreB },
    now,
  });

  return c.redirect(fixturePath(target.game.id, target.fixture.id), 303);
});

/**
 * Withdraw the caller's own claim (BR-37, §7). Through the same first three
 * checks as filing — entitlement, standing, and the window — because a
 * withdrawal is exactly as much a write to `fixture_result_claims` as filing
 * is, and the same leaks the same ordering guards against.
 *
 * Withdrawing a claim that is already gone is not an error worth a page:
 * `deleteResultClaim` reports whether it removed a row, and the redirect is
 * the same either way.
 */
resultsRoutes.post("/g/:id/f/:fixtureId/result/clear", requirePlayer, async (c) => {
  if (wrongOrigin(c)) return c.text("Forbidden", 403);

  const player = c.get("player")!;
  const target = await loadEntitledFixture(c, c.req.param("id"), c.req.param("fixtureId"), player.id);
  if (target === null) return c.text("Not found", 404);

  const now = new Date(Date.now());

  // Same lifecycle guard as the filing route above, and for the same reason
  // (BR-37 §7): a fixture that has not been played has no result to withdraw
  // an opinion about, and this is a 404 independent of the lock the check
  // below owns.
  if (target.fixture.lifecycle !== "played") return c.text("Not found", 404);

  const electorate = await resultElectorate(target.db, target.game.id, target.fixture.id);
  if (!electorate.eligibleIds.has(player.id)) return c.text("Not found", 404);

  const claims = await listResultClaims(target.db, target.fixture.id);
  if (!resultWritable(target.fixture.lifecycle, target.fixture.kicksOffAt, claims.length, now)) {
    return renderPlayerFixture(
      c,
      target.game,
      target.fixture.id,
      player.id,
      now,
      { problem: "That fixture isn't taking a result any more." },
      422,
    );
  }

  const removed = await deleteResultClaim(target.db, target.fixture.id, player.id);
  if (removed) {
    await recordAudit(target.db, {
      actorPlayerId: player.id,
      entityType: "fixture",
      entityId: target.fixture.id,
      action: "fixture.result_cleared",
      now,
    });
  }

  return c.redirect(fixturePath(target.game.id, target.fixture.id), 303);
});

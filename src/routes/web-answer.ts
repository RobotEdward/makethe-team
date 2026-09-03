import type { Context } from "hono";
import { notifyPromotedPlayer } from "./respond.js";
import type { ResponseIntent } from "../capacity/types.js";
import { getDb } from "../db/client.js";
import { findActionableFixture } from "../db/dashboard-queries.js";
import type { AppEnv } from "../env.js";

/**
 * Record a signed-in player's own answer to one fixture, from the web rather
 * than from a reminder link.
 *
 * Extracted from `POST /app` in M52, when the player's game page gained the
 * same two buttons (it had shown an open fixture and offered no way to answer
 * it, while being the target of the largest link on every dashboard card). The
 * two routes differ only in where they send the player afterwards, and this is
 * everything they must not differ in: the entitlement re-check, the capacity
 * object, the promotion email and the race handling.
 *
 * A second copy would have been the fourth place in this codebase that decides
 * `in` versus `waitlisted`. `setResponse` is deliberately the only one.
 */
export function parseIntent(value: unknown): ResponseIntent | null {
  return value === "in" || value === "out" ? value : null;
}

export async function recordWebAnswer(
  c: Context<AppEnv>,
  playerId: string,
  fixtureId: string,
  intent: ResponseIntent,
  now: Date,
  /**
   * The game the caller's own path named, or `null` for a route that carries
   * no game (the dashboard, where the fixture id arrives in a hidden field).
   *
   * The entitlement re-check below only ever sees a fixture id, so without
   * this a member of one game could answer a fixture in another game the same
   * owner runs by editing the path — the same check `loadFixtureTarget` and
   * the broadcast handlers make, for the same reason (TR-18).
   */
  expectGameId: string | null = null,
): Promise<"recorded" | "not-found"> {
  // ---- The entitlement re-check (TR-18). ----
  // Nothing above this line has established that this viewer may touch this
  // fixture: the form is the caller's own input and the middleware only said
  // who they are. This asks the database the same question the listing asked —
  // active membership in the fixture's Game, a response row of the viewer's
  // own, and a non-terminal lifecycle — and a `null` here is a flat 404 rather
  // than a 403, so a fixture id cannot be probed for existence. It is also
  // what locks a `played` fixture (BR-15) against a replayed form: the page
  // offers no action on one because it is not listed, and this refuses one
  // even when the form is resubmitted by hand.
  const actionable = await findActionableFixture(getDb(c.env.DB), playerId, fixtureId);
  if (actionable === null) return "not-found";
  if (expectGameId !== null && actionable.gameId !== expectGameId) return "not-found";

  // The write goes through the Durable Object addressed by fixture id and
  // nowhere else (TR-10) — it is the only thing that may decide `in` versus
  // `waitlisted`, and `setResponse` derives the fixture id from its own
  // identity rather than taking one, so there is no argument here to disagree
  // with the lock. `source: "web"` is what distinguishes a dashboard change
  // from a `"token"` change made from a reminder email.
  //
  // A dropout posted from here frees a slot exactly as one posted to
  // `/r/:token` does, so the capacity object promotes the longest-waiting
  // waitlisted player inside the same lock and reports it as `promoted`. The
  // caller owns telling them: ignoring this field would move someone off the
  // waitlist and into the squad silently. `notifyPromotedPlayer` is shared
  // with `POST /r/:token` rather than reimplemented, so the quota wrapper,
  // the dedupe key and the ceiling-deferral audit row are identical on both
  // paths — this used to be guarded by a `NoPromotion<…>` type that made this
  // merge fail to compile at this line, which is how it came to be written.
  const outcome = await c.env.FIXTURE_CAPACITY.getByName(actionable.fixtureId).setResponse({
    playerId,
    intent,
    // The player set it themselves. An owner override is a different route
    // and would name the owner here (BR-27).
    actorPlayerId: null,
    source: "web",
    now: now.getTime(),
    whenFull: "waitlist",
  });

  if (outcome.kind === "recorded" && outcome.promoted) {
    // `waitUntil`, matching `POST /r/:token`: this runs on the *dropping*
    // player's request, no correctness property depends on the send, and a
    // slow provider must not hold up their redirect. Failures are not silent —
    // `notifyPromotedPlayer` writes a durable `notification_log` row and logs
    // every non-success with a stack.
    c.executionCtx.waitUntil(
      notifyPromotedPlayer(c.env, actionable.fixtureId, outcome.promoted, now),
    );
  }

  if (outcome.kind === "rejected") {
    // Not a fault, and not something to explain in its own page: the check
    // above passed, so this is a race — the fixture was cancelled, played or
    // deleted between that read and the lock. The redirect re-renders the list
    // from the database, which is the honest answer either way.
    console.warn(`web response rejected by the capacity object: ${outcome.reason}`);
  }

  return "recorded";
}

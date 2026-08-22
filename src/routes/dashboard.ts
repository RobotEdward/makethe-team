import { Hono } from "hono";
import type { Context } from "hono";
import { notifyPromotedPlayer } from "./respond.js";
import { eq } from "drizzle-orm";
import { DASHBOARD_PATH, ONBOARDING_DISMISS_PATH } from "../auth/paths.js";
import { requirePlayer, pageNav, type Player } from "../auth/session.js";
import type { ResponseIntent } from "../capacity/types.js";
import { getDb } from "../db/client.js";
import type { Db } from "../db/client.js";
import { passkey, players, pushSubscriptions } from "../db/schema.js";
import {
  findActionableFixture,
  listDashboardFixtures,
  listResultsNeededCandidates,
} from "../db/dashboard-queries.js";
import type { DashboardFixture } from "../db/dashboard-queries.js";
import { listMemberGames } from "../db/queries.js";
import { listClaimsForFixtures } from "../db/result-queries.js";
import { resultWordsForLockedRows } from "../db/result-summary.js";
import { blockingGamesFor } from "../domain/blocking-games.js";
import { fixtureView } from "../domain/fixture-view.js";
import { isResultLocked } from "../domain/result-lock.js";
import { removeMember } from "../domain/remove-member.js";
import { formatLocalDateTime } from "../domain/time/zone.js";
import type { AppEnv, Bindings } from "../env.js";
import {
  renderDashboardPage,
  type DashboardRow,
  type OnboardingHints,
  type RecentlyPlayedRow,
  type ResultsNeededRow,
} from "../views/dashboard.js";


export const dashboard = new Hono<AppEnv>();

/**
 * `requirePlayer`, not `requireSession`. An anonymous visitor is redirected to
 * the sign-in page and a session with no linked Player gets the 403 page with
 * its exits — neither of which says anything about whether a particular
 * address has a Player here, because neither reads an address at all. There is
 * no player identifier anywhere in this route's URLs: the viewer is always
 * `c.get("player")`, so there is nothing to enumerate.
 *
 * The guard establishes *who*, and stops there (TR-18). Every entitlement
 * question — which games, which fixtures, whether this one may be changed — is
 * re-asked against the database by `src/db/dashboard-queries.ts`.
 */
dashboard.get(DASHBOARD_PATH, requirePlayer, async (c) => renderDashboard(c));

/**
 * Renders `/app` from scratch — the plain `GET` above, and the sole-organiser
 * refusal `POST /app/games/:gameId/leave` answers with, so the two cannot
 * drift apart. Its own function for the same reason `renderOwnerFixture` and
 * `renderSquadRefusal` are their own functions in `src/routes/games.ts`: a
 * refusal must show the same page a normal load would, with the reason on it,
 * never a bare error.
 */
async function renderDashboard(c: Context<AppEnv>, problem?: string) {
  // The one wall-clock read at this edge; `fixtureView` takes it as an
  // argument (see the lint rule banning bare `new Date()` downstream).
  const now = new Date(Date.now());
  const player = c.get("player")!;
  const db = getDb(c.env.DB);

  const [rows, squads, onboarding, played] = await Promise.all([
    listDashboardFixtures(db, player.id),
    listMemberGames(db, player.id),
    onboardingHintsFor(db, player, c.get("session")!.user.id, now),
    playedFixtureSections(db, player.id, now),
  ]);

  // §6's third clause: a blocked erasure "surfaces on the player's dashboard
  // as a banner naming the game that is holding it up". Selected on the date
  // having passed rather than on `erasure_blocked_at`, exactly as
  // `/app/delete` selects its own `held-up` state and for the same reason —
  // the plain banner promises a future instant, and the instant passing is
  // what makes it false, whatever the reason. The extra queries only run for a
  // player whose erasure is overdue, which is nobody on an ordinary load.
  const heldUp =
    player.erasesAt !== null && (player.erasesAt <= now || player.erasureStartedAt !== null)
      ? {
          blockingGames: await blockingGamesFor(db, player.id),
          started: player.erasureStartedAt !== null,
        }
      : undefined;

  return c.html(
    renderDashboardPage({
      nav: pageNav(c, "games"),
      playerName: player.name,
      rows: rows.map((row) => toRow(row, now)),
      squads,
      resultsNeeded: played.resultsNeeded,
      recentlyPlayed: played.recentlyPlayed,
      problem,
      // `player` already carries `erasesAt` — `sessionMiddleware` selects the
      // whole row, so this is a field read, not a second query. Not scoped to
      // a game, same as `send-erasure-scheduled.ts`'s N-8 email, so there is
      // no game timezone to format in; `Europe/London` is the only zone this
      // product has any right to assume for a person absent one.
      erasesAtLocal:
        player.erasesAt === null ? undefined : formatLocalDateTime(player.erasesAt, "Europe/London"),
      erasureHeldUp: heldUp,
      onboarding,
    }),
    problem === undefined ? 200 : 422,
  );
}

/** A queried fixture as the page shows it. No other player's data is involved. */
function toRow(fixture: DashboardFixture, now: Date): DashboardRow {
  return {
    fixtureId: fixture.fixtureId,
    gameId: fixture.gameId,
    gameName: fixture.gameName,
    venueName: fixture.venueName,
    // Every timezone conversion in this codebase goes through this one module.
    kicksOffAtLocal: formatLocalDateTime(fixture.kicksOffAt, fixture.timezone),
    view: fixtureView(fixture, now),
    myStatus: fixture.myStatus,
    waitlistCount: fixture.waitlistCount,
    owner: fixture.owner,
  };
}

/**
 * The dashboard's two played-fixture sections, from one candidate list.
 *
 * "Results needed" (M25 Task 13, BR-37): every played fixture the viewer is
 * entitled to see, minus the two that are not a "need" — one they have
 * already filed a claim on, and one whose 48-hour window has already locked.
 *
 * "Recently played" (M27): the newest played fixture that is *not* in the
 * list above, with its result once that result has settled.
 *
 * One function rather than two because the second is a filter over the first
 * one's own candidate list and its claims: split apart they would read
 * `listResultsNeededCandidates` and `listClaimsForFixtures` twice per load
 * for the same rows.
 *
 * `isResultLocked` takes only a claim *count*, never whose claims they are,
 * so this needs no organiser set and no `deriveResult` — unlike the account
 * history's locked rows, this list only ever says "needs a result", never
 * what the result was.
 *
 * One extra query beyond the candidate list itself: every candidate's claims
 * in a single batched read (`listClaimsForFixtures`), rather than one query
 * per fixture — the same broad-select-then-JS-filter idiom
 * `src/sweep/result-cache.ts` documents at length for the same reason.
 */
async function playedFixtureSections(
  db: Db,
  playerId: string,
  now: Date,
): Promise<{ resultsNeeded: ResultsNeededRow[]; recentlyPlayed: RecentlyPlayedRow | null }> {
  const candidates = await listResultsNeededCandidates(db, playerId);
  if (candidates.length === 0) return { resultsNeeded: [], recentlyPlayed: null };

  const claims = await listClaimsForFixtures(
    db,
    candidates.map((candidate) => candidate.fixtureId),
  );
  const claimsByFixture = new Map<string, typeof claims>();
  for (const claim of claims) {
    const bucket = claimsByFixture.get(claim.fixtureId) ?? [];
    bucket.push(claim);
    claimsByFixture.set(claim.fixtureId, bucket);
  }

  const needed = candidates.filter((candidate) => {
    const fixtureClaims = claimsByFixture.get(candidate.fixtureId) ?? [];
    const alreadyFiled = fixtureClaims.some((claim) => claim.playerId === playerId);
    if (alreadyFiled) return false;
    return !isResultLocked(candidate.kicksOffAt, fixtureClaims.length, now);
  });

  const resultsNeeded = needed.map((candidate) => ({
    fixtureId: candidate.fixtureId,
    gameId: candidate.gameId,
    gameName: candidate.gameName,
    venueName: candidate.venueName,
    kicksOffAtLocal: formatLocalDateTime(candidate.kicksOffAt, candidate.timezone),
  }));

  // The newest played fixture that is not already listed above. `candidates`
  // is `desc` on kickoff, so the first survivor is the newest — and skipping
  // the ones in "Results needed" is what stops one fixture appearing twice on
  // one page, reading as two.
  const neededIds = new Set(needed.map((candidate) => candidate.fixtureId));
  const recent = candidates.find((candidate) => !neededIds.has(candidate.fixtureId));
  if (recent === undefined) return { resultsNeeded, recentlyPlayed: null };

  // Words only for a *locked* fixture, through the same derivation the account
  // history and the past-fixtures page use (`resultWordsForLockedRows`) — a
  // tally still inside its 48 hours is openly arguable, and a bare score line
  // here would read as settled while the panel on the fixture page itself
  // still shows it as a contested claim.
  const words = await resultWordsForLockedRows(db, [recent], now);

  return {
    resultsNeeded,
    recentlyPlayed: {
      fixtureId: recent.fixtureId,
      gameId: recent.gameId,
      gameName: recent.gameName,
      venueName: recent.venueName,
      kicksOffAtLocal: formatLocalDateTime(recent.kicksOffAt, recent.timezone),
      resultWords: words.get(recent.fixtureId),
    },
  };
}

function parseIntent(value: unknown): ResponseIntent | null {
  return value === "in" || value === "out" ? value : null;
}

/** This deployment's own origin, as the sign-out handler compares it. */
function originOf(env: Bindings): string {
  return new URL(env.BETTER_AUTH_URL).origin;
}

/**
 * Change one response, then send the browser back to the page.
 *
 * **A redirect, unlike `POST /r/:token`.** That handler re-renders in place on
 * purpose, because a redirect there would have to put the response token back
 * in a URL and buys nothing without JavaScript. Here there is no token, the
 * destination is a fixed constant, and redirecting means the dashboard has
 * exactly one renderer — `renderDashboardPage`, reached only through the `GET`
 * above — rather than a second copy of the page assembled after a write, which
 * is precisely how two renderings of the same list drift apart. 303, so the
 * browser follows it with a `GET` and a refresh does not re-post.
 *
 * The origin check mirrors `POST /sign-out`'s, for the same reason: this is a
 * state-changing form post, a browser always sends `Origin` on a cross-site
 * one, and a missing header is a non-browser client acting on its own behalf.
 */
dashboard.post(DASHBOARD_PATH, requirePlayer, async (c) => {
  const origin = c.req.header("origin");
  if (origin !== undefined && origin !== originOf(c.env)) {
    return c.text("Forbidden", 403);
  }

  const now = new Date(Date.now());
  const player = c.get("player")!;

  const form = await c.req.parseBody();
  const intent = parseIntent(form["intent"]);
  if (intent === null) {
    return c.text('Bad Request: "intent" must be exactly "in" or "out"', 400);
  }
  const fixtureId = typeof form["fixtureId"] === "string" ? form["fixtureId"] : "";

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
  const actionable = await findActionableFixture(getDb(c.env.DB), player.id, fixtureId);
  if (actionable === null) return c.text("Not found", 404);

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
    playerId: player.id,
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
    console.warn(`dashboard response rejected by the capacity object: ${outcome.reason}`);
  }

  return c.redirect(DASHBOARD_PATH, 303);
});

/**
 * A signed-in player leaving a game from their own account (M7a Task 4) — the
 * write behind the "your other squads" list on `/leave/:token`, which is its
 * only entry point today — there is no leave control on the dashboard itself.
 * `leaveOtherGamePath` names its path.
 *
 * **`wrongOrigin` here, unlike `POST /leave/:token`.** That route is
 * deliberately origin-check-free because it is reached from a link in an
 * email, opened by whatever renders the mail; this one is a same-origin form
 * on our own page, so the same check every other `/g/*` and `/app` mutation
 * makes applies here too.
 *
 * The subject and the actor are the same player throughout — the signed-in
 * viewer removing themselves, exactly as `POST /leave/:token` treats the
 * leaver as their own actor. `removeMember` re-establishes entitlement on its
 * own (`not-a-member` for a game this player is not actually in), so nothing
 * upstream of it needs to check membership first; `requirePlayer` only
 * established *who* is asking (TR-18).
 */
dashboard.post(`${DASHBOARD_PATH}/games/:gameId/leave`, requirePlayer, async (c) => {
  const origin = c.req.header("origin");
  if (origin !== undefined && origin !== originOf(c.env)) {
    return c.text("Forbidden", 403);
  }

  const now = new Date(Date.now());
  const player = c.get("player")!;
  const db = getDb(c.env.DB);
  const gameId = c.req.param("gameId");

  const result = await removeMember({
    db,
    gameId,
    playerId: player.id,
    actorPlayerId: player.id,
    now,
    withdraw: (fixtureId) =>
      c.env.FIXTURE_CAPACITY.getByName(fixtureId).withdrawMember({
        playerId: player.id,
        actorPlayerId: player.id,
        now: now.getTime(),
      }),
  });

  // Not a member of this game at all: a fabricated or stale game id, and a
  // 404 rather than a 403 so it cannot be probed for existence (TR-18).
  if (result.kind === "not-a-member") return c.text("Not found", 404);

  // The one refusal J6a's invariant produces, same as the owner-facing squad
  // routes in `src/routes/games.ts`: a game needs at least one organiser, and
  // this player is its only one. Re-rendered as the dashboard itself at 422,
  // with the reason on it, rather than a dead end.
  if (result.kind === "refused") {
    return renderDashboard(c, "A game needs at least one organiser. Make someone else an organiser first, then come back here to leave.");
  }

  for (const { fixtureId, promoted } of result.promotions) {
    c.executionCtx.waitUntil(notifyPromotedPlayer(c.env, fixtureId, promoted, now));
  }

  return c.redirect(DASHBOARD_PATH, 303);
});

/**
 * How long after first sign-in the "Get set up" card keeps appearing (M19).
 * A time window rather than a visit counter: a counter would mean a write on
 * every dashboard GET, and "the first fortnight" is the same idea without one.
 */
const ONBOARDING_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Whether the "Get set up" card shows, and which hints are still undone.
 *
 * Undefined — no card — once the player dismissed it, once the window after
 * `emailVerifiedAt` has passed, or for a player with no `emailVerifiedAt` at
 * all (pre-M19 rows backfilled nothing; a player who somehow has a session
 * without one is not someone to nudge). The two existence queries only run
 * inside the window, which after a fortnight is nobody.
 *
 * The card still renders when both flags are false: the install hint has no
 * server-side flag (see `renderOnboardingCard`), so an all-done player inside
 * the window sees a one-line card until they dismiss it or the window closes.
 */
async function onboardingHintsFor(
  db: Db,
  player: Player,
  authUserId: string,
  now: Date,
): Promise<OnboardingHints | undefined> {
  if (player.onboardingDismissedAt !== null) return undefined;
  if (player.emailVerifiedAt === null) return undefined;
  if (now.getTime() - player.emailVerifiedAt.getTime() > ONBOARDING_WINDOW_MS) return undefined;

  const [hasPasskey, hasSubscription] = await Promise.all([
    db.select({ id: passkey.id }).from(passkey).where(eq(passkey.userId, authUserId)).limit(1),
    db
      .select({ id: pushSubscriptions.id })
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.playerId, player.id))
      .limit(1),
  ]);
  return { passkey: hasPasskey.length === 0, notifications: hasSubscription.length === 0 };
}

/**
 * Dismisses the card for good. Session only, like everything on this page;
 * the origin check mirrors `POST /app`'s. Stamps rather than deletes, and
 * never clears — `/app/account` and `/app/passkeys` remain the permanent
 * routes to everything the card linked to, so there is nothing to bring back.
 */
dashboard.post(ONBOARDING_DISMISS_PATH, requirePlayer, async (c) => {
  const origin = c.req.header("origin");
  if (origin !== undefined && origin !== originOf(c.env)) {
    return c.text("Forbidden", 403);
  }
  const player = c.get("player")!;
  await getDb(c.env.DB)
    .update(players)
    .set({ onboardingDismissedAt: new Date(Date.now()) })
    .where(eq(players.id, player.id));
  return c.redirect(DASHBOARD_PATH, 303);
});

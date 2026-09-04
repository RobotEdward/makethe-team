import { Hono } from "hono";
import type { Context } from "hono";
import { notifyPromotedPlayer } from "./respond.js";
import { parseIntent, recordWebAnswer } from "./web-answer.js";
import { eq } from "drizzle-orm";
import {
  DASHBOARD_PATH,
  ONBOARDING_DISMISS_PATH,
  PRESENCE_PATH,
  gameMutePath,
  gameUnmutePath,
} from "../auth/paths.js";
import { requirePlayer, pageNav, type Player } from "../auth/session.js";
import { getDb } from "../db/client.js";
import type { Db } from "../db/client.js";
import { passkey, players, pushSubscriptions } from "../db/schema.js";
import {
  listDashboardFixtures,
  listResultsNeededCandidates,
} from "../db/dashboard-queries.js";
import type { DashboardFixture } from "../db/dashboard-queries.js";
import { listMemberGames, muteStateFor } from "../db/queries.js";
import { playerRecordByGame } from "../db/record-queries.js";
import { listClaimsForFixtures } from "../db/result-queries.js";
import { resultWordsForLockedRows } from "../db/result-summary.js";
import { blockingGamesFor } from "../domain/blocking-games.js";
import { fixtureView } from "../domain/fixture-view.js";
import { isResultLocked } from "../domain/result-lock.js";
import { shouldStampPresence } from "../domain/presence.js";
import { removeMember } from "../domain/remove-member.js";
import { formatLocalDate, formatLocalDateTime } from "../domain/time/zone.js";
import type { AppEnv, Bindings } from "../env.js";
import type { MuteControlsOptions } from "../views/mute-controls.js";
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

  const [rows, squads, onboarding, played, record] = await Promise.all([
    listDashboardFixtures(db, player.id),
    listMemberGames(db, player.id),
    onboardingHintsFor(db, player, c.get("session")!.user.id, now),
    playedFixtureSections(db, player.id, now),
    // One grouped aggregate, whatever the size of the history — see
    // `playerRecordByGame` for why this one read is scoped by the viewer's own
    // response rows rather than by an active membership.
    playerRecordByGame(db, player.id),
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
      mute: await muteControlsForDashboard(db, player.id, squads, now),
      nav: pageNav(c, "games"),
      playerName: player.name,
      rows: rows.map((row) => toRow(row, now)),
      squads,
      resultsNeeded: played.resultsNeeded,
      recentlyPlayed: played.recentlyPlayed,
      record,
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

/**
 * The dashboard's auto-decline panel (M58), for the first live squad the
 * viewer belongs to — `undefined` when they belong to none.
 *
 * Alphabetical, because that is the order `listMemberGames` returns and the
 * order "Your squads" further down the page already shows: whichever squad
 * the panel names, the reader can see it named in a list they recognise. The
 * squad it acts on matters less than it looks, because the panel's own
 * "do this for my other squads too" checkbox is what a player going away for
 * a fortnight actually wants, and `muteStateFor` counts the others for it.
 *
 * Archived games are skipped for the reason the squad page hides the panel on
 * one: nothing there is going to invite anybody.
 *
 * The state is read, not assumed off, so a player already auto-declining is
 * shown the switch that turns it back on — the whole point of putting it here
 * is that they should not have to remember which page it lives on.
 */
async function muteControlsForDashboard(
  db: Db,
  playerId: string,
  squads: readonly { id: string; name: string; archivedAt: Date | null; timezone: string }[],
  now: Date,
): Promise<MuteControlsOptions | undefined> {
  const squad = squads.find((entry) => entry.archivedAt === null);
  if (squad === undefined) return undefined;

  const state = await muteStateFor(db, squad.id, playerId, now);
  if (state === null) return undefined;

  return {
    muteAction: gameMutePath(squad.id),
    unmuteAction: gameUnmutePath(squad.id),
    // The squad page can say "this squad" and be understood. This page is
    // about all of them, so the panel names the one it acts on.
    squadName: squad.name,
    // Back here afterwards rather than into the squad page the routes would
    // otherwise land on; see `landingAfterMute` in `src/routes/games.ts`.
    returnTo: "dashboard",
    state:
      state.muted
        ? {
            muted: true,
            // The date alone, in the squad's zone (TR-5) — the same call the
            // game page's panel makes, for the same reason: the expiry's time
            // of day is four weeks after whichever minute the player tapped,
            // and naming it invites a precision the sweep does not honour.
            untilLocal:
              state.mutedUntil === null ? null : formatLocalDate(state.mutedUntil, squad.timezone),
          }
        : { muted: false },
    otherGamesCount: state.otherGamesCount,
  };
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
    yourSide: fixture.yourSide,
  };
}

/**
 * The dashboard's two played-fixture sections, from one candidate list.
 *
 * "Results needed" (M25 Task 13, BR-37): every played fixture the viewer is
 * entitled to see, minus the two that are not a "need" — one they have
 * already filed a claim on, and one whose result window has already locked.
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
    return !isResultLocked(candidate, candidate.resultLockHoursAfter, fixtureClaims.length, now);
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
  // tally still inside its game's window is openly arguable, and a bare score line
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
      yourSide: recent.yourSide,
      resultWords: words.get(recent.fixtureId),
    },
  };
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

  const recorded = await recordWebAnswer(c, player.id, fixtureId, intent, now);
  if (recorded === "not-found") return c.text("Not found", 404);

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
  return {
    passkey: hasPasskey.length === 0,
    installed: player.lastStandaloneAt !== null,
    notifications: hasSubscription.length === 0,
  };
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

/**
 * The presence ping (M33): every session-bearing page, once per browser tab.
 *
 * **No `requirePlayer`.** That guard redirects an anonymous caller to the
 * sign-in page, and this is not a caller who can follow a redirect — it is a
 * `fetch` from a page whose session may have expired while it sat open. 204
 * and no write is the honest answer to that, and it keeps a working page's
 * console clean. The origin check is the same one every other state-changing
 * POST here makes.
 *
 * Two columns, one conditional write. `standalone` is trusted for exactly
 * what it is: a claim by the page about its own display mode. A player who
 * forged it would mark their own row as installed and mislead nobody but
 * their organiser about their own phone; there is no entitlement here to
 * escalate, and the alternative is not being able to answer the question at
 * all.
 */
dashboard.post(PRESENCE_PATH, async (c) => {
  const origin = c.req.header("origin");
  if (origin !== undefined && origin !== originOf(c.env)) {
    return c.text("Forbidden", 403);
  }

  const player = c.get("player");
  if (!player) return c.body(null, 204);

  // A body this route cannot read is still a page load by a signed-in
  // player, which is the fact worth recording; only an explicit `true`
  // claims the installed app. `catch` rather than a content-type check: what
  // matters is whether the bytes parsed, not what the header promised.
  const body = await c.req.json().catch(() => null);
  const standalone = typeof body === "object" && body !== null && (body as Record<string, unknown>)["standalone"] === true;

  const now = new Date(Date.now());
  const stamp: Partial<typeof players.$inferInsert> = {};
  if (shouldStampPresence(player.lastSeenAt, now)) stamp.lastSeenAt = now;
  if (standalone && shouldStampPresence(player.lastStandaloneAt, now)) stamp.lastStandaloneAt = now;

  if (Object.keys(stamp).length > 0) {
    await getDb(c.env.DB).update(players).set(stamp).where(eq(players.id, player.id));
  }
  return c.body(null, 204);
});

import { and, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import type { Context } from "hono";
import {
  ACCOUNT_PATH,
  DASHBOARD_PATH,
  DELETE_ACCOUNT_CANCEL_PATH,
  DELETE_ACCOUNT_PATH,
} from "../auth/paths.js";
import { requirePlayer } from "../auth/session.js";
import { recordAudit } from "../db/audit.js";
import { getDb } from "../db/client.js";
import { listPlayerFixtureHistory } from "../db/dashboard-queries.js";
import { players } from "../db/schema.js";
import { blockingGamesFor } from "../domain/blocking-games.js";
import { erasureDeadline } from "../domain/erasure-window.js";
import { fixtureView, type FixtureStatus } from "../domain/fixture-view.js";
import { isTerminalLifecycle } from "../domain/lifecycle.js";
import { parsePlayerName } from "../domain/player-name.js";
import type { ResponseStatus } from "../domain/response-status.js";
import { formatLocalDateTime } from "../domain/time/zone.js";
import type { AppEnv, Bindings } from "../env.js";
import { createNotifier } from "../notify/factory.js";
import { sendErasureScheduledEmail } from "../notify/send-erasure-scheduled.js";
import { renderAccountPage } from "../views/account.js";
import { renderDeleteAccountPage } from "../views/delete-account.js";

export const account = new Hono<AppEnv>();

/** This deployment's own origin, as `src/routes/dashboard.ts` compares it. */
function originOf(env: Bindings): string {
  return new URL(env.BETTER_AUTH_URL).origin;
}

/**
 * Render `/app/delete` from scratch, in whichever state the database is in.
 *
 * Its own function for the reason `renderDashboard` is one: the `POST`'s
 * sole-organiser refusal must answer with the same page a plain `GET` would,
 * with the reason on it, and a refusal assembled separately from the page it
 * refuses on is exactly how the two drift apart. `problem` is the only
 * difference between the two callers, and it drives the status code.
 */
async function renderDeleteAccount(c: Context<AppEnv>, problem?: string) {
  const player = c.get("player")!;
  const db = getDb(c.env.DB);
  const now = new Date(Date.now());

  const [row] = await db
    .select({
      erasesAt: players.erasesAt,
      erasureStartedAt: players.erasureStartedAt,
    })
    .from(players)
    .where(eq(players.id, player.id));

  // A pending request wins over everything else. The person reading this
  // arrived from the confirmation email to check or cancel it, and re-running
  // the sole-organiser check first could answer them with a refusal page that
  // never mentions the erasure they came here about — one that is still going
  // to happen, because a block only stops the sweep, not the countdown.
  if (row?.erasesAt != null) {
    // Not scoped to a game, so there is no game timezone to format in;
    // `Europe/London` matches what the N-8 email itself says, and the two must
    // name the same instant in the same words.
    const erasesAtLocal = formatLocalDateTime(row.erasesAt, "Europe/London");

    // Past its own date — or already part-run, which implies it — is a
    // different page from "pending". The `pending` copy promises a future
    // instant and says nothing has changed; both are false here, and the
    // second is false in the direction that matters. Chosen on the clock
    // rather than on `erasure_blocked_at` so that *every* way an erasure can
    // fail to run on time lands somewhere honest, not only the blocked one.
    if (row.erasesAt <= now || row.erasureStartedAt !== null) {
      return c.html(
        renderDeleteAccountPage({
          playerName: player.name,
          state: "held-up",
          erasesAtLocal,
          // Read live. The audit row's payload records what blocked it when it
          // was blocked; this page has to say what is blocking it now, so a
          // handover done a minute ago shows.
          blockingGames: await blockingGamesFor(db, player.id),
          started: row.erasureStartedAt !== null,
          problem,
        }),
        problem === undefined ? 200 : 422,
      );
    }

    return c.html(
      renderDeleteAccountPage({
        playerName: player.name,
        state: "pending",
        erasesAtLocal,
        problem,
      }),
      problem === undefined ? 200 : 422,
    );
  }

  const blockingGames = await blockingGamesFor(db, player.id);

  return c.html(
    renderDeleteAccountPage({
      playerName: player.name,
      state: blockingGames.length > 0 ? "sole-organiser" : "offer",
      blockingGames,
      problem,
    }),
    problem === undefined ? 200 : 422,
  );
}

/**
 * The page itself. **Writes nothing** — the request is the `POST` below.
 *
 * `requirePlayer`, not `requireSession`, matching the dashboard: a session
 * with no linked Player has no data here to erase and belongs on the 403 page
 * with its exits. The guard establishes *who* and stops there (TR-18); there
 * is no player id in this route's URL to check, because the subject is always
 * `c.get("player")`.
 */
account.get(DELETE_ACCOUNT_PATH, requirePlayer, async (c) => renderDeleteAccount(c));

/**
 * Schedule this player's own erasure, two days out (BR-34, §2).
 *
 * **This handler is inert, and that is a guarantee rather than an
 * implementation detail.** It sets a date, writes an audit row and sends one
 * email. It touches no membership, no response, no fixture, no capacity object
 * and no session, because the whole point of the 48-hour window is that
 * cancelling within it restores nothing — there is nothing to restore. Ending
 * a membership frees each open fixture's slot and promotes the longest-waiting
 * replacement by email (`removeMember`), and those promotions cannot be taken
 * back: a "cancel" after that would be a rebuild of squads whose freed places
 * another player has already been told they hold. `test/routes/
 * delete-account.test.ts` asserts this directly.
 *
 * **Re-requesting while one is already pending is deliberate, not an
 * oversight.** There is no guard against it and none is wanted: the deadline
 * can only ever move *later*, the second audit row is a truthful record of a
 * second request, and the N-8 dedupe key includes the new date, so the second
 * email is accurate rather than a duplicate. It is unreachable from the UI
 * anyway — the `pending` state renders no request button — so the only callers
 * are a stale tab and a hand-crafted post, and neither is harmed by being
 * given a fresh two days.
 *
 * The origin check mirrors `POST /app`'s, for the same reason: this is a
 * same-origin form post on our own page, a browser always sends `Origin` on a
 * cross-site one, and a missing header is a non-browser client acting on its
 * own behalf. Unlike `POST /leave/:token`, nothing here is reached from an
 * email client.
 */
account.post(DELETE_ACCOUNT_PATH, requirePlayer, async (c) => {
  const origin = c.req.header("origin");
  if (origin !== undefined && origin !== originOf(c.env)) {
    return c.text("Forbidden", 403);
  }

  // The one wall-clock read at this edge; `erasureDeadline` takes it as an
  // argument (see the lint rule banning bare `new Date()` downstream).
  const now = new Date(Date.now());
  const player = c.get("player")!;
  const db = getDb(c.env.DB);

  // Re-asked here and not trusted from the page this form came from. That page
  // may have been rendered days ago, and a co-organiser leaving or being
  // demoted since would turn an honest offer into a request that the sweep
  // would refuse — after the confirmation email had already promised a date.
  // Refused as the page itself at 422 with the reason on it, the way
  // `renderDashboard` answers the same invariant, rather than a dead end.
  const blockingGames = await blockingGamesFor(db, player.id);
  if (blockingGames.length > 0) {
    return renderDeleteAccount(
      c,
      "A game needs at least one organiser. Make someone else an organiser first, then come back here.",
    );
  }

  const erasesAt = erasureDeadline(now);
  // `erasure_blocked_at` is cleared here too: it marks a block belonging to
  // the request being superseded, and leaving it set would make a fresh
  // request that is blocked again silently skip its own `player.erasure_blocked`
  // audit row, because `recordBlocked`'s guard would read it as already told.
  await db
    .update(players)
    .set({ erasesAt, erasureBlockedAt: null })
    .where(eq(players.id, player.id));
  await recordAudit(db, {
    actorPlayerId: player.id,
    entityType: "player",
    entityId: player.id,
    action: "player.erasure_requested",
    after: { erasesAt: erasesAt.toISOString() },
    now,
  });

  // `waitUntil`, matching how the dashboard hands off its promotion emails: the
  // deadline is already committed, so no correctness property depends on the
  // send, and a slow provider must not hold up this redirect.
  //
  // The outcome is inspected rather than discarded. §7 calls N-8 "the only
  // thing that reaches someone whose account was misused within the window",
  // and the one outcome that leaves *no* durable trace is `deferred`: the
  // daily ceiling refusal deletes the `notification_log` row so a retry stays
  // possible, and nothing here retries. Dropping the return value made that
  // case completely silent. This is the minimal fix — a log line each, worded
  // distinctly so they are greppable; a retry, or a
  // `player.erasure_email_deferred` audit action alongside the four the
  // ceiling already has, is deliberately left for the milestone that builds
  // the owner-visible ceiling UI.
  c.executionCtx.waitUntil(
    sendErasureScheduledEmail({
      db,
      notifier: createNotifier(c.env, db, now),
      playerId: player.id,
      erasesAt,
      now,
    }).then((outcome) => {
      if (outcome.kind === "deferred") {
        console.warn(
          `DAILY EMAIL CEILING REACHED: N-8 erasure confirmation for player ${player.id} was refused and nothing retries it — they have not been told their data is due to be erased on ${erasesAt.toISOString()}`,
        );
      } else if (outcome.kind === "failed") {
        console.error(
          `N-8 erasure confirmation failed for player ${player.id} (erases at ${erasesAt.toISOString()}): ${outcome.reason}`,
        );
      }
    }),
  );

  // 303 to the page itself, so a refresh does not re-post and the pending state
  // is rendered by the one `GET` above rather than by a second copy assembled
  // after the write.
  return c.redirect(DELETE_ACCOUNT_PATH, 303);
});

/**
 * Stop a pending erasure. The other half of the window, and the reason it
 * exists at all.
 *
 * No confirmation step, and **one** refusal path. Keeping an account is not
 * destructive, and anything that could turn this into an error page is a way
 * for an erasure nobody wants to go ahead — so cancelling when nothing is
 * pending clears a column that is already null and redirects exactly as a real
 * cancel does. A double-submitted form, or the second of two open tabs, must
 * not produce something that reads as a failure to cancel.
 *
 * The exception is an erasure that has already begun and stopped part-way
 * (`players.erasure_started_at`; see the column comment). By then the player
 * is out of some or all of their squads and the places they gave up have been
 * promoted to whoever was waiting and emailed about it. Clearing `erases_at`
 * there does not restore any of that — nothing can — it just removes the only
 * thing that would ever finish the job, leaving an account permanently
 * half-erased with no retry and nothing pending. So this refuses, on the page
 * itself with the reason on it at 422, the way the sole-organiser refusal
 * does. A refusal that explains is worse than a cancel and far better than a
 * silent unreachable state.
 *
 * Origin-checked like its sibling. It is state-changing, and while the state
 * it changes is the harmless direction, a cross-site post that silently
 * cancels somebody's erasure is still somebody else deciding.
 */
account.post(DELETE_ACCOUNT_CANCEL_PATH, requirePlayer, async (c) => {
  const origin = c.req.header("origin");
  if (origin !== undefined && origin !== originOf(c.env)) {
    return c.text("Forbidden", 403);
  }

  const now = new Date(Date.now());
  const player = c.get("player")!;
  const db = getDb(c.env.DB);

  const [row] = await db
    .select({ erasedAt: players.erasedAt, erasureStartedAt: players.erasureStartedAt })
    .from(players)
    .where(eq(players.id, player.id));

  if (row !== undefined && row.erasedAt === null && row.erasureStartedAt !== null) {
    return renderDeleteAccount(
      c,
      "This erasure has already started, so it can't be stopped now. You've been taken out of some of your squads and those places have gone to whoever was waiting for them, and nothing can put that back.",
    );
  }

  // Scoped by `erased_at is null` as well as by id. The sweep's final batch
  // sets `erased_at` without touching `erases_at` — §2.1 keeps the latter as
  // the record of what was promised — so a cancel landing between that batch
  // and this update would otherwise produce `erased_at` set with `erases_at`
  // null: a row that says it was erased with no trace of the request that
  // erased it. The `where` makes the loser of that race a no-op, and the
  // redirect below is unchanged, which is right — the account really is gone.
  //
  // Also scoped by `erasure_started_at is null`: the read above and this
  // write are not one transaction, so the sweep can set that column in
  // between. Without this guard such a cancel still clears `erases_at` —
  // exactly the stranded, half-erased, never-retried state the 422 refusal
  // above exists to prevent, reached through the race instead of the UI.
  //
  // `erasure_blocked_at` is cleared here too, for the same reason as the
  // request handler: it marks a block belonging to *this* request, and a
  // later request that is blocked again must get its own audit row rather
  // than being silently treated as already-told.
  await db
    .update(players)
    .set({ erasesAt: null, erasureBlockedAt: null })
    .where(
      and(
        eq(players.id, player.id),
        isNull(players.erasedAt),
        isNull(players.erasureStartedAt),
      ),
    );
  await recordAudit(db, {
    actorPlayerId: player.id,
    entityType: "player",
    entityId: player.id,
    action: "player.erasure_cancelled",
    now,
  });

  // Back to the dashboard rather than to this page: the thing that brought
  // them here is over, and the delete page in its `offer` state is not where
  // someone who just decided to stay belongs.
  return c.redirect(DASHBOARD_PATH, 303);
});

/** How many fixtures the account page shows. Twenty weeks of a weekly game. */
const HISTORY_LIMIT = 20;

/**
 * Render `/app/account` from scratch, in whichever state the database is in.
 *
 * Its own function for the reason `renderDeleteAccount` above and
 * `renderDashboard` are: the `POST`'s refusal must answer with the same page a
 * plain `GET` would, with the reason on it, and a refusal assembled separately
 * from the page it refuses on is exactly how the two drift apart. `problem` is
 * the only difference between the two callers, and it drives the status code.
 */
async function renderAccount(c: Context<AppEnv>, problem?: string) {
  const now = new Date(Date.now());
  const player = c.get("player")!;
  const db = getDb(c.env.DB);

  const history = await listPlayerFixtureHistory(db, player.id, HISTORY_LIMIT);

  return c.html(
    renderAccountPage({
      playerName: player.name,
      email: player.email,
      fixtures: history.map((fixture) => ({
        gameId: fixture.gameId,
        gameName: fixture.gameName,
        venueName: fixture.venueName,
        // Every timezone conversion in this codebase goes through this one
        // module, in the fixture's own game's zone (TR-5).
        kicksOffAtLocal: formatLocalDateTime(fixture.kicksOffAt, fixture.timezone),
        statusLabel: fixtureStatusLabel(fixtureView(fixture, now).status),
        myStatusLabel: historyStatusLabel(fixture.myStatus, isTerminalLifecycle(fixture.lifecycle)),
      })),
      problem,
      // `player` already carries `erasesAt` — `sessionMiddleware` selects the
      // whole row, so this is a field read, not a second query. Not scoped to
      // a game, so `Europe/London`, matching the N-8 email and the dashboard.
      erasesAtLocal:
        player.erasesAt === null
          ? undefined
          : formatLocalDateTime(player.erasesAt, "Europe/London"),
    }),
    problem === undefined ? 200 : 422,
  );
}

/**
 * The fixture's own state in words, past tense where the fixture is past.
 *
 * Its own function rather than `renderStatusLine` from `src/views/fixture.ts`:
 * that one words a fixture somebody can still act on ("2 more needed"), and
 * every row here may be history.
 */
function fixtureStatusLabel(status: FixtureStatus): string {
  switch (status) {
    case "played":
      return "Played";
    case "cancelled":
      return "Called off";
    case "scheduled":
      return "Not open yet";
    case "confirmed":
      return "Going ahead";
    case "short":
      return "Short of players";
    case "open":
      return "Open for answers";
  }
}

/**
 * What the viewer answered, worded for a list that is mostly — but not
 * purely — history (§6: "last 20 by kickoff" puts an upcoming fixture above
 * a played one).
 *
 * `isFinished` is the fixture's *own* lifecycle (`isTerminalLifecycle`), not
 * a fact about the response: an open fixture with a `pending` response is
 * something the player can still go and answer, and telling them "you didn't
 * answer" reads as a completed failure rather than as the open invitation it
 * still is. Terminal lifecycles (`played`, `cancelled`) get the past tense
 * that was here before this fix; everything else gets the present.
 */
function historyStatusLabel(status: ResponseStatus, isFinished: boolean): string {
  switch (status) {
    case "in":
      return isFinished ? "You were in" : "You're in";
    case "out":
      return isFinished ? "You couldn't make it" : "You can't make it";
    case "waitlisted":
      return isFinished ? "You were on the waitlist" : "You're on the waitlist";
    case "pending":
      return isFinished ? "You didn't answer" : "You haven't answered yet";
    case "withdrawn":
      // Unreachable: `entitledTo` excludes withdrawn rows. Here so the switch
      // is exhaustive and a new status becomes a typecheck failure.
      return "You withdrew";
  }
}

/**
 * The page itself. **Writes nothing** — the rename is the `POST` below.
 *
 * `requirePlayer`, matching the dashboard: an anonymous visitor is redirected
 * to sign-in and a session with no linked Player gets the 403 page with its
 * exits. The guard establishes *who* and stops there (TR-18); there is no
 * player id in this route's URL to check, because the subject is always
 * `c.get("player")`, which is also why this page has no denial state to
 * design.
 */
account.get(ACCOUNT_PATH, requirePlayer, async (c) => renderAccount(c));

/**
 * Rename yourself (M11).
 *
 * **`players.name` only — never Better Auth's `user.name`.** Nothing in this
 * product renders that column; the domain row is the name every page, every
 * email and every squad list reads. Writing both would create two names that
 * can disagree with no rule about which wins.
 *
 * The origin check mirrors `POST /app`'s, for the same reason: this is a
 * same-origin form post on our own page, a browser always sends `Origin` on a
 * cross-site one, and a missing header is a non-browser client acting on its
 * own behalf.
 */
account.post(ACCOUNT_PATH, requirePlayer, async (c) => {
  const origin = c.req.header("origin");
  if (origin !== undefined && origin !== originOf(c.env)) {
    return c.text("Forbidden", 403);
  }

  const now = new Date(Date.now());
  const player = c.get("player")!;
  const db = getDb(c.env.DB);

  const form = await c.req.parseBody();
  const parsed = parsePlayerName(form["name"]);
  // Re-rendered as the page itself at 422 with the reason on it, the way
  // `renderDeleteAccount` and `renderDashboard` answer their own refusals,
  // rather than a dead end.
  if (!parsed.ok) return renderAccount(c, parsed.problem);

  await db.update(players).set({ name: parsed.name }).where(eq(players.id, player.id));
  await recordAudit(db, {
    actorPlayerId: player.id,
    entityType: "player",
    entityId: player.id,
    action: "player.renamed",
    before: { name: player.name },
    after: { name: parsed.name },
    now,
  });

  // 303 to the page itself, so a refresh does not re-post and the new name is
  // rendered by the one `GET` above rather than by a second copy of the page
  // assembled after the write.
  return c.redirect(ACCOUNT_PATH, 303);
});

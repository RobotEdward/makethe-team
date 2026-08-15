import { eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import type { Context } from "hono";
import {
  DASHBOARD_PATH,
  DELETE_ACCOUNT_CANCEL_PATH,
  DELETE_ACCOUNT_PATH,
} from "../auth/paths.js";
import { requirePlayer } from "../auth/session.js";
import { recordAudit } from "../db/audit.js";
import { getDb, type Db } from "../db/client.js";
import { listActiveMemberships } from "../db/queries.js";
import { games, players } from "../db/schema.js";
import { erasureDeadline } from "../domain/erasure-window.js";
import { isLastActiveOwner } from "../domain/last-owner.js";
import { formatLocalDateTime } from "../domain/time/zone.js";
import type { AppEnv, Bindings } from "../env.js";
import { createNotifier } from "../notify/factory.js";
import { sendErasureScheduledEmail } from "../notify/send-erasure-scheduled.js";
import { renderDeleteAccountPage } from "../views/delete-account.js";

export const account = new Hono<AppEnv>();

/** This deployment's own origin, as `src/routes/dashboard.ts` compares it. */
function originOf(env: Bindings): string {
  return new URL(env.BETTER_AUTH_URL).origin;
}

/**
 * The games this player is the last active organiser of — the set that blocks
 * an erasure, with the names the refusal page shows.
 *
 * Asked exactly the way `erasePlayer` asks it (`listActiveMemberships`, then
 * `isLastActiveOwner` per game), and deliberately not a second implementation
 * of the rule: if this page's verdict and the erasure's could disagree, one of
 * them would be a lie — either an offer that the sweep then refuses, or a
 * refusal shown to someone who is not blocked at all.
 *
 * The names come from a single `inArray` join rather than a query per game,
 * and only for the blocking games: the offer state names nothing.
 */
async function blockingGamesFor(
  db: Db,
  playerId: string,
): Promise<{ gameId: string; gameName: string }[]> {
  const memberships = await listActiveMemberships(db, playerId);

  const blocked: string[] = [];
  for (const membership of memberships) {
    if (await isLastActiveOwner(db, membership.gameId, { role: membership.role, active: true })) {
      blocked.push(membership.gameId);
    }
  }
  if (blocked.length === 0) return [];

  const rows = await db
    .select({ gameId: games.id, gameName: games.name })
    .from(games)
    .where(inArray(games.id, blocked));
  return rows;
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

  const [row] = await db
    .select({ erasesAt: players.erasesAt })
    .from(players)
    .where(eq(players.id, player.id));

  // A pending request wins over everything else. The person reading this
  // arrived from the confirmation email to check or cancel it, and re-running
  // the sole-organiser check first could answer them with a refusal page that
  // never mentions the erasure they came here about — one that is still going
  // to happen, because a block only stops the sweep, not the countdown.
  if (row?.erasesAt != null) {
    return c.html(
      renderDeleteAccountPage({
        playerName: player.name,
        state: "pending",
        // Not scoped to a game, so there is no game timezone to format in;
        // `Europe/London` matches what the N-8 email itself says, and the two
        // must name the same instant in the same words.
        erasesAtLocal: formatLocalDateTime(row.erasesAt, "Europe/London"),
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
  await db.update(players).set({ erasesAt }).where(eq(players.id, player.id));
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
  // send, and a slow provider must not hold up this redirect. A failure is not
  // silent — `sendErasureScheduledEmail` leaves a durable `notification_log`
  // row either way.
  c.executionCtx.waitUntil(
    sendErasureScheduledEmail({
      db,
      notifier: createNotifier(c.env, db, now),
      playerId: player.id,
      erasesAt,
      now,
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
 * No confirmation step and no refusal path: keeping an account is not
 * destructive, and anything that could turn this into an error page is a way
 * for an erasure nobody wants to go ahead. Cancelling when nothing is pending
 * clears a column that is already null and redirects exactly as a real cancel
 * does — a double-submitted form, or the second of two open tabs, must not
 * produce something that reads as a failure to cancel.
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

  await db.update(players).set({ erasesAt: null }).where(eq(players.id, player.id));
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

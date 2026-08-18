import { Hono } from "hono";
import { wrongOrigin } from "../auth/origin.js";
import { getDb, type Db } from "../db/client.js";
import { findFirstScheduledFixture, findGameByInviteToken, listSquad } from "../db/queries.js";
import type { games } from "../db/schema.js";
import { isPlausibleEmail, joinSquad, normaliseEmail, type JoinOutcome } from "../domain/join-squad.js";
import { formatLocalDateTime } from "../domain/time/zone.js";
import type { AppEnv } from "../env.js";
import { createNotifier } from "../notify/factory.js";
import { sendWelcomeEmail } from "../notify/send-welcome.js";
import { renderInvitePage, renderJoinOutcomePage } from "../views/join.js";

export const join = new Hono<AppEnv>();

/**
 * The public invite flow (J1, spec §4).
 *
 * **Unauthenticated, and it both writes rows and sends email** — the same
 * class as `POST /r/:token`. What bounds the cost of abuse is the quota
 * wrapper around the notifier (`MAX_EMAILS_PER_DAY`, TR-31), not the origin
 * check or the token's unguessability; both of those are real but narrower.
 * A WAF rate-limit rule on `/j/*` is a supplement (TR-37), not a control:
 * everything here must hold with it switched off.
 *
 * Mounted outside every session prefix (`src/app.ts`). A visitor holding an
 * invite link has no session and must not need one (§1.6) — that is the whole
 * proposition of the link, and a redirect to `/sign-in` here would end the
 * journey for exactly the people it exists for.
 *
 * Every failure to resolve a token is a flat 404 with no explanation: see
 * `findGameByInviteToken` for why "this link has been replaced" is a worse
 * answer than "not found".
 */


/** The single string field of a submitted form, or "" — never a File. */
function field(form: Record<string, unknown>, name: string): string {
  const value = form[name];
  return typeof value === "string" ? value : "";
}

/** Everything both handlers need to render the invite page for one game. */
async function invitePageFor(params: {
  db: Db;
  game: typeof games.$inferSelect;
  now: Date;
  values?: { name?: string; email?: string };
  error?: string;
}): Promise<string> {
  const { db, game, now, values, error } = params;
  const [squad, firstFixture] = await Promise.all([
    listSquad(db, game.id),
    findFirstScheduledFixture(db, game.id, now),
  ]);

  return renderInvitePage({
    gameName: game.name,
    venueName: game.venueName,
    // Spec §4.3: address, when, how long and the squad size all belong on the
    // page somebody decides from — a link that only names the game asks them
    // to commit to a time and a place they cannot see.
    venueAddress: game.venueAddress,
    venueUrl: game.venueUrl,
    recurrenceRule: game.recurrenceRule,
    kickoffTime: game.kickoffTime,
    durationMinutes: game.durationMinutes,
    timezone: game.timezone,
    minPlayers: game.minPlayers,
    maxPlayers: game.maxPlayers,
    inviteToken: game.inviteToken,
    // Full names in, redacted inside the view (BR-26) — one place, so no
    // caller can forget.
    squad,
    firstFixtureLocal: firstFixture
      ? // The single permitted place cross-zone formatting happens.
        formatLocalDateTime(firstFixture.kicksOffAt, game.timezone)
      : null,
    values,
    error,
  });
}

join.get("/j/:token", async (c) => {
  // The one wall-clock read at this edge; everything downstream takes `now` as
  // a parameter (see the lint rule banning bare `new Date()`).
  const now = new Date(Date.now());
  const db = getDb(c.env.DB);

  const game = await findGameByInviteToken(db, c.req.param("token"));
  if (game === null) return c.text("Not found", 404);

  return c.html(await invitePageFor({ db, game, now }));
});

join.post("/j/:token", async (c) => {
  if (wrongOrigin(c)) return c.text("Forbidden", 403);

  const now = new Date(Date.now());
  const db = getDb(c.env.DB);

  // Before the body is even looked at: an unknown token does no work and
  // writes nothing.
  const game = await findGameByInviteToken(db, c.req.param("token"));
  if (game === null) return c.text("Not found", 404);

  const form = await c.req.parseBody();
  const name = field(form, "name").trim();
  const email = normaliseEmail(field(form, "email"));

  // 422 with the page back, not a bare 400: somebody has just typed this on a
  // phone and throwing it away to show them "Bad Request" is not an option.
  // The email is echoed back as they normalised-typed it so a fixable typo is
  // visible; nothing has been written, so nothing needs undoing.
  if (name === "") {
    return c.html(
      await invitePageFor({ db, game, now, values: { name, email }, error: "Please put your name in." }),
      422,
    );
  }
  if (!isPlausibleEmail(email)) {
    return c.html(
      await invitePageFor({
        db,
        game,
        now,
        values: { name, email },
        error: "That doesn't look like an email address. We need one that works — it's how you'll hear about games.",
      }),
      422,
    );
  }

  const outcome = await joinSquad({ db, gameId: game.id, name, email, now });

  if (outcome.kind === "joined" || outcome.kind === "rejoined") {
    // `waitUntil`, exactly as `POST /r/:token` does with the promotion email:
    // the membership is already committed and durable, nothing on this page
    // depends on the welcome arriving, and a person's first contact with this
    // product must not sit waiting on a mail provider's latency. Failures are
    // not silent — `notifyJoiner` logs every non-success and
    // `sendWelcomeEmail` leaves a durable `notification_log` row.
    c.executionCtx.waitUntil(notifyJoiner(c.env, game.id, outcome, now));
  }

  const firstFixture = await findFirstScheduledFixture(db, game.id, now);

  return c.html(
    renderJoinOutcomePage({
      kind: outcome.kind,
      gameName: game.name,
      venueName: game.venueName,
      firstFixtureLocal: firstFixture ? formatLocalDateTime(firstFixture.kicksOffAt, game.timezone) : null,
    }),
  );
});

/**
 * Send the N-6 welcome to someone who has just joined or rejoined, in the
 * background.
 *
 * The notifier is built here rather than passed in because it must be the
 * quota-wrapped one from `createNotifier` (TR-31). This is the one send path
 * in the app that an anonymous stranger can trigger, so it is the last place
 * that should be allowed to bypass the daily ceiling: the ceiling is what caps
 * what a leaked or scraped invite link can cost, and the wrapper is what
 * enforces it.
 *
 * Every branch is logged on one greppable line, including the one that has
 * bitten this codebase before — a rejected promise inside a `waitUntil` that
 * resolves into nothing. The `catch` is not decoration.
 */
export async function notifyJoiner(
  env: AppEnv["Bindings"],
  gameId: string,
  outcome: Extract<JoinOutcome, { kind: "joined" | "rejoined" }>,
  now: Date,
): Promise<void> {
  const who = `game ${gameId}, player ${outcome.playerId}`;
  const db = getDb(env.DB);
  try {
    const result = await sendWelcomeEmail({
      db,
      notifier: createNotifier(env, db, now),
      gameId,
      playerId: outcome.playerId,
      membershipId: outcome.membershipId,
      joinedAt: outcome.joinedAt,
      now,
      responseTokenSecret: env.RESPONSE_TOKEN_SECRET,
    });

    switch (result.kind) {
      case "sent":
        return;
      case "skipped-no-recipient":
        // Not reachable from this route today — a join always carries an
        // address — but J6's "add a squad member by hand" will share this
        // sender, and a guest has none (BR-32).
        console.log(`welcome email (N-6) skipped, no usable address: ${who}`);
        return;
      case "deferred":
        // The daily ceiling refused it and the row was removed, so a later
        // attempt would be legitimate — but nothing retries this one. The
        // person is in the squad either way; they will simply first hear from
        // us at the next fixture's reminder.
        console.error(`welcome email (N-6) refused by the daily send ceiling and nothing will retry it: ${who}`);
        return;
      case "already-logged":
        console.warn(`welcome email (N-6) already logged for this exact join, not resent: ${who}`);
        return;
      case "failed":
        console.error(`welcome email (N-6) failed to send: ${who}: ${result.reason}`);
        return;
    }
  } catch (error) {
    // The one line standing between a background failure and total silence.
    console.error(
      `welcome email (N-6) threw and was never sent: ${who}: ${
        error instanceof Error ? (error.stack ?? error.message) : String(error)
      }`,
    );
  }
}

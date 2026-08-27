import { eq } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { wrongOrigin } from "../auth/origin.js";
import { resolveSessionPlayer } from "../auth/session.js";
import { getDb, type Db } from "../db/client.js";
import { findFirstUpcomingFixture, findGameByInviteToken, findGameForMember, listSquad } from "../db/queries.js";
import { players, type games } from "../db/schema.js";
import { backfillOpenFixtureResponses } from "../domain/backfill-open-responses.js";
import { isPlausibleEmail, joinSquad, normaliseEmail, type JoinOutcome } from "../domain/join-squad.js";
import { gamePath, joinConfirmPath } from "../auth/paths.js";
import { verifyJoinToken } from "../domain/token.js";
import { formatLocalDateTime } from "../domain/time/zone.js";
import type { AppEnv } from "../env.js";
import { createNotifier } from "../notify/factory.js";
import { sendJoinConfirmation } from "../notify/send-join-confirmation.js";
import { sendLateInvitations } from "../notify/send-late-invitations.js";
import { sendWelcomeEmail } from "../notify/send-welcome.js";
import { renderCheckInboxPage, renderInvitePage, renderJoinConfirmPage, renderJoinOutcomePage } from "../views/join.js";
import { renderNotFoundPage } from "../views/not-found.js";

export const join = new Hono<AppEnv>();

/**
 * The public invite flow (J1, spec §4) and its confirmation-link sibling
 * `/join/:jtoken` (M39, BR-48–50).
 *
 * **Unauthenticated, and it both writes rows and sends email** — the same
 * class as `POST /r/:token`. What bounds the cost of abuse is the quota
 * wrapper around the notifier (`MAX_EMAILS_PER_DAY`, TR-31), not the origin
 * check or the token's unguessability; both of those are real but narrower.
 * A WAF rate-limit rule on `/j/*` and `/join/*` is a supplement (TR-37), not a
 * control: everything here must hold with it switched off.
 *
 * Mounted outside every session prefix (`src/app.ts`). A visitor holding an
 * invite link has no session and must not need one (§1.6) — that is the whole
 * proposition of the link, and a redirect to `/sign-in` here would end the
 * journey for exactly the people it exists for.
 *
 * Every failure to resolve a token is a flat 404 with no explanation: see
 * `findGameByInviteToken` for why "this link has been replaced" is a worse
 * answer than "not found". `resolveJoinToken` gives `/join/:jtoken` the same
 * property for a rotated invite link (BR-49).
 */


/** The single string field of a submitted form, or "" — never a File. */
function field(form: Record<string, unknown>, name: string): string {
  const value = form[name];
  return typeof value === "string" ? value : "";
}

/** BR-47: only a row with `email_verified_at` counts. Guests and erased rows have null email and never match. */
export async function isVerifiedAddress(db: Db, email: string): Promise<boolean> {
  const [row] = await db.select({ verified: players.emailVerifiedAt }).from(players).where(eq(players.email, email)).limit(1);
  return row?.verified != null;
}

/** Everything both handlers need to render the invite page for one game. */
async function invitePageFor(params: {
  db: Db;
  game: typeof games.$inferSelect;
  now: Date;
  values?: { name?: string; email?: string };
  error?: string;
  viewer?: { email: string; gamePath: string };
}): Promise<string> {
  const { db, game, now, values, error, viewer } = params;
  const [squad, firstFixture] = await Promise.all([
    listSquad(db, game.id),
    findFirstUpcomingFixture(db, game.id, now),
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
    viewer,
  });
}

/**
 * The banner facts for a signed-in visitor who is already in this squad, or
 * `undefined` (M38).
 *
 * **`resolveSessionPlayer`, not a `sessionMiddleware` mount on `/j/*`.** That
 * function's own doc comment is the argument: a mount would put a cookie
 * parse, an HMAC verification and a D1 round trip on a path every stranger,
 * prefetcher and crawler reaches, which is the same blast-radius reasoning
 * that keeps the middleware off `/r/:token`. Called from here it costs
 * nothing for a request with no cookie, and it changes nothing about who may
 * reach this page without one (§1.6).
 *
 * **Never fatal**, exactly as `resolveOtherGames` in `src/routes/respond.ts`
 * is not: this is the one part of the page that wants a session, on a route
 * whose whole promise is that it works without one, so a D1 fault must cost
 * the banner rather than the page.
 *
 * The membership re-check is `findGameForMember` rather than anything new —
 * a session says *who*, never *whether* (TR-18), and an ex-member whose row
 * is inactive must be offered the join form like anyone else rather than
 * told they are already in.
 */
async function resolveViewer(
  c: Context<AppEnv>,
  db: Db,
  gameId: string,
  now: Date,
): Promise<{ email: string; gamePath: string } | undefined> {
  try {
    const player = await resolveSessionPlayer(c.env, db, now, c.req.raw.headers);
    if (player === null || player.email === null) return undefined;
    if ((await findGameForMember(db, gameId, player.id)) === null) return undefined;
    return { email: player.email, gamePath: gamePath(gameId) };
  } catch (error) {
    console.error(
      `invite-page viewer lookup failed, rendering without the banner: ${
        error instanceof Error ? (error.stack ?? error.message) : String(error)
      }`,
    );
    return undefined;
  }
}

join.get("/j/:token", async (c) => {
  // The one wall-clock read at this edge; everything downstream takes `now` as
  // a parameter (see the lint rule banning bare `new Date()`).
  const now = new Date(Date.now());
  const db = getDb(c.env.DB);

  const game = await findGameByInviteToken(db, c.req.param("token"));
  if (game === null) return c.html(renderNotFoundPage(), 404);

  return c.html(await invitePageFor({ db, game, now, viewer: await resolveViewer(c, db, game.id, now) }));
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

  if (!(await isVerifiedAddress(db, email))) {
    // BR-47: nothing is written for an address nobody has proved reaches
    // anyone. The send is awaited, not handed to waitUntil — the page says
    // "we've sent", and a ceiling refusal must not make that a lie; it is
    // reported on the same page instead.
    const outcome = await sendJoinConfirmation({
      db, notifier: createNotifier(c.env, db, now), gameId: game.id, gameName: game.name,
      inviteToken: game.inviteToken, email, name, now, responseTokenSecret: c.env.RESPONSE_TOKEN_SECRET,
    });
    if (outcome.kind === "failed" || outcome.kind === "deferred") {
      console.error(`join confirmation (N-14) not sent for game ${game.id}: ${outcome.kind}${outcome.kind === "failed" ? ` ${outcome.reason}` : ""}`);
      return c.html(await invitePageFor({ db, game, now, values: { name, email }, error: "We couldn't send the confirmation email just now. Please try again in a little while." }), 503);
    }
    // `sent`, `already-sent-today` and `switched-off` all show the same page:
    // the first two so a resubmit does not reveal the guard, the third so an
    // administrator switching N-14 off closes joining rather than reopening
    // the unconfirmed path.
    return c.html(renderCheckInboxPage({ gameName: game.name, email }));
  }

  const outcome = await joinSquad({ db, gameId: game.id, name, email, now });

  if (outcome.kind === "joined" || outcome.kind === "rejoined") {
    // Backfilled *before* the page renders, not in the background task: the
    // page below names the open fixture as theirs (BR-2′), and it must not
    // say so ahead of the row that makes it true. Only the emails wait.
    const backfilledFixtureIds = await backfillOpenFixtureResponses(db, game.id, outcome.playerId);

    // `waitUntil`, exactly as `POST /r/:token` does with the promotion email:
    // the membership is already committed and durable, nothing on this page
    // depends on the welcome arriving, and a person's first contact with this
    // product must not sit waiting on a mail provider's latency. Failures are
    // not silent — `notifyJoiner` logs every non-success and
    // `sendWelcomeEmail` leaves a durable `notification_log` row.
    c.executionCtx.waitUntil(notifyJoiner(c.env, game.id, outcome, now, backfilledFixtureIds));
  }

  return c.html(await renderJoinOutcomeFor(db, game, outcome, now));
});

/**
 * The page every successful (or already-satisfied) join lands on, shared by
 * `POST /j/:token` and `POST /join/:jtoken` — both perform the same
 * `joinSquad` and must agree on what the person sees afterwards.
 */
async function renderJoinOutcomeFor(
  db: Db,
  game: typeof games.$inferSelect,
  outcome: JoinOutcome,
  now: Date,
): Promise<string> {
  const firstFixture = await findFirstUpcomingFixture(db, game.id, now);
  return renderJoinOutcomePage({
    kind: outcome.kind,
    gameName: game.name,
    venueName: game.venueName,
    firstFixture: firstFixture
      ? {
          local: formatLocalDateTime(firstFixture.kicksOffAt, game.timezone),
          lifecycle: firstFixture.lifecycle,
        }
      : null,
  });
}

/**
 * The game a join token points at, or null. `findGameByInviteToken` with the
 * token's *own* invite token, then an id check: a rotated link (BR-49), an
 * inactive game and a forged pairing all fall out as one flat 404.
 */
async function resolveJoinToken(c: Context<AppEnv, "/join/:jtoken">, db: Db, now: Date) {
  const verified = await verifyJoinToken(c.req.param("jtoken"), c.env.RESPONSE_TOKEN_SECRET, now);
  if (!verified.ok) return null;
  const game = await findGameByInviteToken(db, verified.payload.inviteToken);
  if (game === null || game.id !== verified.payload.gameId) return null;
  return { game, payload: verified.payload };
}

join.get("/join/:jtoken", async (c) => {
  const now = new Date(Date.now());
  const db = getDb(c.env.DB);
  const resolved = await resolveJoinToken(c, db, now);
  if (resolved === null) return c.html(renderNotFoundPage(), 404);
  return c.html(
    renderJoinConfirmPage({
      gameName: resolved.game.name,
      venueName: resolved.game.venueName,
      name: resolved.payload.name,
      action: joinConfirmPath(c.req.param("jtoken")),
    }),
  );
});

join.post("/join/:jtoken", async (c) => {
  if (wrongOrigin(c)) return c.text("Forbidden", 403);
  const now = new Date(Date.now());
  const db = getDb(c.env.DB);
  const resolved = await resolveJoinToken(c, db, now);
  if (resolved === null) return c.text("Not found", 404);
  const { game, payload } = resolved;

  // BR-48: the same join `POST /j/:token` performs for a verified address,
  // plus the verification stamp — the click on this link is the proof.
  const outcome = await joinSquad({ db, gameId: game.id, name: payload.name, email: payload.email, now, emailVerifiedAt: now });

  if (outcome.kind === "joined" || outcome.kind === "rejoined") {
    const backfilledFixtureIds = await backfillOpenFixtureResponses(db, game.id, outcome.playerId);
    c.executionCtx.waitUntil(notifyJoiner(c.env, game.id, outcome, now, backfilledFixtureIds));
  }

  return c.html(await renderJoinOutcomeFor(db, game, outcome, now));
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
  /** Open fixtures the join backfilled this player into (BR-2′) — each gets its N-1 now. */
  backfilledFixtureIds: readonly string[] = [],
): Promise<void> {
  const who = `game ${gameId}, player ${outcome.playerId}`;
  const db = getDb(env.DB);

  if (backfilledFixtureIds.length > 0) {
    try {
      // The same quota-wrapped notifier as the welcome below (TR-31): this is
      // the other send an anonymous stranger can trigger, and the daily
      // ceiling is what caps what a leaked invite link can cost. A ceiling
      // refusal here is benign — `sendLateInvitations` removes the row, so
      // the hourly sweep retries it (the pre-BR-2′ timing, never a loss).
      const invitations = await sendLateInvitations({
        db,
        notifier: createNotifier(env, db, now),
        playerId: outcome.playerId,
        fixtureIds: backfilledFixtureIds,
        responseTokenSecret: env.RESPONSE_TOKEN_SECRET,
        now,
      });
      if (invitations.failed > 0 || invitations.deferred > 0) {
        console.error(
          `late N-1 invitation(s) incomplete for ${who}: ` +
            `${invitations.sent} sent, ${invitations.failed} failed, ${invitations.deferred} deferred to the sweep`,
        );
      }
    } catch (error) {
      // Same last line of defence as the welcome's catch below: a rejected
      // promise inside `waitUntil` resolves into nothing.
      console.error(
        `late N-1 invitation(s) threw for ${who}: ${
          error instanceof Error ? (error.stack ?? error.message) : String(error)
        }`,
      );
    }
  }

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
      case "switched-off":
        // Expected and permanent (M37), not a fault: the administrator has
        // turned N-6 off on every channel.
        console.log(`welcome email (N-6) switched off by the administrator: ${who}`);
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

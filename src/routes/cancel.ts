import { Hono } from "hono";
import { getDb, type Db } from "../db/client.js";
import { fixtures, games } from "../db/schema.js";
import { eq } from "drizzle-orm";
import {
  cancelFixture,
  cancellationInfo,
  mayCancelFixture,
  type CancellationInfo,
  type CancellationRecipient,
} from "../domain/cancel-fixture.js";
import { formatLocalDateTime } from "../domain/time/zone.js";
import { verifyCancelToken } from "../domain/token.js";
import type { AppEnv } from "../env.js";
import { recordCeilingDeferral } from "../notify/ceiling-audit.js";
import { createNotifier } from "../notify/factory.js";
import { sendCancellationEmails } from "../notify/send-cancellation.js";
import {
  MAX_REASON_LENGTH,
  renderAlreadyCancelledPage,
  renderAlreadyPlayedPage,
  renderCancelConfirmPage,
  renderCancelledPage,
  type CancelPreview,
} from "../views/cancel.js";
import { renderLinkProblemPage } from "../views/link-problem.js";

export const cancel = new Hono<AppEnv>();

/**
 * Owner cancellation by signed link (BR-14, J5) — a deliberate, recorded
 * amendment to TR-17, which otherwise requires a session for every owner
 * action. There is no session mechanism yet, and the owner-attention email
 * promises a one-tap way to call a game off; the token is scoped to one
 * owner, one fixture, one act, expires at kickoff, and is signed with its own
 * secret (`CANCEL_TOKEN_SECRET` — see `src/env.ts`).
 *
 * The two verbs are split the way the product needs them, not the way the
 * token permits:
 *
 * - **`GET` renders and records absolutely nothing.** Not the fixture, not a
 *   response row, not an audit row, not a notification row. Mail clients
 *   prefetch links, security scanners follow them, and a link that destroys a
 *   game must survive all of that untouched. `test/routes/cancel.test.ts`
 *   snapshots every one of those four tables around a `GET` and asserts
 *   byte-identity.
 * - **`POST` is the only thing that cancels**, and it is the owner's own
 *   deliberate act on a page that has already told them exactly what it will
 *   do and to how many people.
 *
 * Every failure that is *about the token or the actor* — expired, tampered,
 * malformed, signed with the wrong secret, minted as a response token, or
 * belonging to somebody who is not an active owner of this Game — renders the
 * one shared `renderLinkProblemPage()`, identical bytes, identical 200. This
 * page is a higher-value target than the response page: a difference between
 * "bad signature" and "not an owner" would tell a prober that a fixture id
 * they guessed is real, and a difference between "expired" and "malformed"
 * would tell them their forgery attempt is structurally on track. The real
 * reason goes to `console.error` for operators and nowhere else.
 *
 * States that are *about the fixture* — already cancelled, already played —
 * do get their own page, but only after the token verified **and** entitlement
 * passed, so nothing is disclosed to anyone not already entitled to know it.
 */

/** Everything both handlers need after a token has verified and entitlement has passed. */
interface CancelContext {
  fixture: typeof fixtures.$inferSelect;
  game: typeof games.$inferSelect;
}

/**
 * Load the fixture and prove the actor may cancel it, or return `null` for
 * "render the shared failure page".
 *
 * The two refusals collapse into one deliberately. `cancelFixture` keeps
 * `not-found` and `not-entitled` distinct because a domain operation should
 * say what it means, but nothing reaching a browser may distinguish them:
 * fixture ids are unguessable v4 UUIDs, so a page that answered differently
 * for "no such fixture" and "not your fixture" would confirm a guessed id.
 * Read-only throughout — this is the whole of what a `GET` does.
 */
async function loadCancelContext(
  db: Db,
  fixtureId: string,
  actorPlayerId: string,
): Promise<CancelContext | null> {
  const [row] = await db
    .select({ fixture: fixtures, game: games })
    .from(fixtures)
    .innerJoin(games, eq(fixtures.gameId, games.id))
    .where(eq(fixtures.id, fixtureId));
  if (!row) {
    console.error(`cancel token verified for a fixture that does not exist: ${fixtureId}`);
    return null;
  }

  if (!(await mayCancelFixture(db, row.fixture.gameId, actorPlayerId))) {
    console.error(`cancel token rejected: player ${actorPlayerId} is not an active owner of fixture ${fixtureId}`);
    return null;
  }

  return { fixture: row.fixture, game: row.game };
}

/** How many of a recipient set can actually be reached — the same `.trim()` test the send path applies. */
function reachableCount(recipients: readonly CancellationRecipient[]): number {
  return recipients.filter((recipient) => (recipient.email?.trim() ?? "") !== "").length;
}

/**
 * Truncate `reason` to at most `maxLength` UTF-16 code units — matching both
 * the `.length` comparison the route checks it against and the textarea's
 * `maxlength` attribute, which also counts UTF-16 code units — without ever
 * leaving a lone half of a surrogate pair behind.
 *
 * A plain `slice(0, maxLength)` can land exactly between the two UTF-16 code
 * units of an astral character (an emoji, for instance): the result is a
 * dangling high surrogate, which has no valid Unicode meaning on its own and
 * renders as a replacement-character glyph in the textarea the owner is
 * supposed to fix and resubmit. Dropping that trailing high surrogate keeps
 * the string at or under `maxLength` (never over it, so the cap this feeds
 * back into still holds) and leaves only whole characters.
 */
function truncateReason(reason: string, maxLength: number): string {
  const truncated = reason.slice(0, maxLength);
  const lastUnit = truncated.charCodeAt(truncated.length - 1);
  const isDanglingHighSurrogate = lastUnit >= 0xd800 && lastUnit <= 0xdbff;
  return isDanglingHighSurrogate ? truncated.slice(0, -1) : truncated;
}

function previewOf(context: CancelContext, info: CancellationInfo): CancelPreview {
  return {
    gameName: context.game.name,
    venueName: context.fixture.venueOverride ?? context.game.venueName,
    // The single permitted place cross-zone formatting happens (TR-20).
    kicksOffAtLocal: formatLocalDateTime(context.fixture.kicksOffAt, context.game.timezone),
    // Both counts below come from the one `cancellationInfo` read of
    // `responses`, not from `fixtures.inCount` — see that function's doc
    // comment for why this page in particular must not have two sources of
    // truth for what is about to happen.
    inCount: info.inCount,
    recipientCount: info.recipients.length,
    unreachableCount: info.recipients.length - reachableCount(info.recipients),
  };
}

/**
 * The page for a fixture that cannot be cancelled because of the state it is
 * already in, shared by both verbs so a `GET` and a losing `POST` say the
 * same thing about the same situation.
 */
function terminalStatePage(context: CancelContext): string | null {
  if (context.fixture.lifecycle === "cancelled") return renderAlreadyCancelledPage(context.game.name);
  if (context.fixture.lifecycle === "played") return renderAlreadyPlayedPage(context.game.name);
  return null;
}

cancel.get("/cancel/:token", async (c) => {
  const token = c.req.param("token");
  // The one place this route reads the real wall clock.
  const now = new Date(Date.now());
  const verification = await verifyCancelToken(token, c.env.CANCEL_TOKEN_SECRET, now);
  if (!verification.ok) {
    console.error(`cancel token rejected: ${verification.reason}`);
    return c.html(renderLinkProblemPage(), 200);
  }

  const { ownerPlayerId, fixtureId } = verification.payload;
  const db = getDb(c.env.DB);
  const context = await loadCancelContext(db, fixtureId, ownerPlayerId);
  if (!context) return c.html(renderLinkProblemPage(), 200);

  const terminal = terminalStatePage(context);
  if (terminal) return c.html(terminal, 200);

  const info = await cancellationInfo(db, fixtureId);
  return c.html(
    renderCancelConfirmPage({ ...previewOf(context, info), token, gameId: context.fixture.gameId, fixtureId: context.fixture.id }),
    200,
  );
});

cancel.post("/cancel/:token", async (c) => {
  const token = c.req.param("token");
  const now = new Date(Date.now());
  const verification = await verifyCancelToken(token, c.env.CANCEL_TOKEN_SECRET, now);
  if (!verification.ok) {
    console.error(`cancel token rejected: ${verification.reason}`);
    return c.html(renderLinkProblemPage(), 200);
  }

  const { ownerPlayerId, fixtureId } = verification.payload;
  const db = getDb(c.env.DB);

  // `parseBody` reads the whole request body before the length check below
  // ever runs, so the check does not bound what gets buffered — a large body
  // is read in full and only then rejected. Left unbounded deliberately,
  // not overlooked: this line is reachable only *after* `verifyCancelToken`
  // has already accepted the token above, so a request has to carry a
  // correctly-signed, unexpired cancel token for a real owner of a real
  // fixture before its body is ever touched — there is no anonymous,
  // pre-auth path to this buffering. What remains is bounded by the platform
  // itself (Workers' own request-size ceiling) and by how the token is
  // minted (rarely, for owners only, expiring at kickoff), not by app code.
  // A `Content-Length` pre-check would add a second length rule to keep in
  // sync with `MAX_REASON_LENGTH` for a cost that is already this small and
  // already gated behind a signature check.
  //
  // The field must be *present*, and may be empty. A missing field is not an
  // owner who declined to give a reason — it is a request that did not come
  // from this form, and cancelling a game is not something to do on a guess.
  const form = await c.req.parseBody();
  const rawReason = form["reason"];
  if (typeof rawReason !== "string") {
    return c.text('Bad Request: "reason" must be present (it may be empty)', 400);
  }

  // Nothing has been read from the database yet, so this refusal costs one
  // token verification and no queries.
  if (rawReason.length > MAX_REASON_LENGTH) {
    const context = await loadCancelContext(db, fixtureId, ownerPlayerId);
    if (!context) return c.html(renderLinkProblemPage(), 200);
    const terminal = terminalStatePage(context);
    if (terminal) return c.html(terminal, 200);
    const info = await cancellationInfo(db, fixtureId);
    return c.html(
      renderCancelConfirmPage({
        ...previewOf(context, info),
        token,
        gameId: context.fixture.gameId,
        fixtureId: context.fixture.id,
        // Truncated on the way back into the box, so the page the owner gets
        // is one they can actually submit: re-rendering the full over-long
        // value would hand back a form that fails again on every attempt.
        reason: truncateReason(rawReason, MAX_REASON_LENGTH),
        error: `That reason is too long — ${MAX_REASON_LENGTH} characters at most. It's been shortened to fit; edit it before you send.`,
      }),
      400,
    );
  }

  const result = await cancelFixture(db, { fixtureId, actorPlayerId: ownerPlayerId, reason: rawReason, now });

  if (!result.cancelled) {
    switch (result.reason) {
      case "not-found":
      case "not-entitled":
        // Indistinguishable to the browser, on purpose — see
        // `loadCancelContext`. The reason is logged, not rendered.
        console.error(`cancellation refused (${result.reason}): fixture ${fixtureId}, actor ${ownerPlayerId}`);
        return c.html(renderLinkProblemPage(), 200);
      case "already-cancelled":
      case "played": {
        // Both of these are reachable only by an actor `cancelFixture` has
        // already confirmed is an active owner, so naming the state is safe.
        const context = await loadCancelContext(db, fixtureId, ownerPlayerId);
        if (!context) return c.html(renderLinkProblemPage(), 200);
        return c.html(terminalStatePage(context) ?? renderLinkProblemPage(), 200);
      }
    }
  }

  // Cancelled. Everything from here is reporting, not deciding: the lifecycle
  // change and its audit row are already durable in D1.
  const context = await loadCancelContext(db, fixtureId, ownerPlayerId);
  if (!context) {
    // The fixture vanished between being cancelled and being re-read. Nothing
    // useful left to render, and nobody can be emailed without the Game's
    // name and timezone.
    console.error(`fixture disappeared between cancelling it and rendering the result: ${fixtureId}`);
    return c.html(renderLinkProblemPage(), 200);
  }

  const summary = await sendCancellation(c.env, context, result.recipients, rawReason, now);

  return c.html(
    renderCancelledPage({
      gameName: context.game.name,
      emailed: summary.sent,
      notEmailed: result.recipients.length - summary.sent,
    }),
    200,
  );
});

/**
 * Send the N-3 cancellation email to every affected player, **awaited**, and
 * report what went out.
 *
 * **Why `await` and not `ctx.waitUntil`.** The N-2 promotion email is handed
 * to `waitUntil` (see `notifyPromotedPlayer` in `src/routes/respond.ts`) for
 * reasons that all point the other way here. That send runs on a *third
 * party's* request — the player dropping out — whose page says nothing about
 * it and whose correctness does not depend on it. This one runs on the
 * owner's own deliberate, destructive action, and the entire point of the
 * page they get back is to tell them what happened: "3 players have been
 * emailed" is a claim, and a claim made before the sends are attempted is a
 * claim this route cannot honestly make. An owner who cancels a game needs to
 * know whether the squad was actually told, right then, because if the answer
 * is "no" they have to go and tell people themselves — that is a real action
 * they will take on the strength of this page. Deferring the send would leave
 * them reading a number that was a prediction.
 *
 * The latency cost is bounded and small: one batch to the notifier for a
 * squad of at most a couple of dozen, on a request that happens a handful of
 * times a season, not on the hot path any player ever touches.
 *
 * Every failure is still *durable* rather than merely logged, exactly as the
 * background path is: `sendCancellationEmails` writes each `notification_log`
 * row before the message is handed over and records the result on it
 * afterwards, so "why wasn't I told?" is answerable from the database long
 * after the log line has aged out.
 *
 * The `try`/`catch` is not decoration. The cancellation is already committed
 * by the time this runs, so an exception escaping here would render a 500 for
 * an action that in fact succeeded — the worst possible page for an owner to
 * be looking at, because the natural response is to try again. It is caught,
 * logged, and reported as "nobody could be emailed", which is the honest
 * summary of that situation.
 *
 * The notifier is built here rather than passed in because it must be the
 * quota-wrapped one from `createNotifier` (TR-31).
 */
async function sendCancellation(
  env: AppEnv["Bindings"],
  context: CancelContext,
  recipients: readonly CancellationRecipient[],
  reason: string,
  now: Date,
): Promise<{ sent: number }> {
  const who = `fixture ${context.fixture.id}`;
  const db = getDb(env.DB);
  try {
    const summary = await sendCancellationEmails({
      db,
      notifier: createNotifier(env, db, now),
      fixture: context.fixture,
      game: context.game,
      recipients,
      reason,
      now,
      responseTokenSecret: env.RESPONSE_TOKEN_SECRET,
    });

    if (summary.skippedNoRecipient > 0) {
      // Expected and permanent (BR-32), not a fault — but worth a line,
      // because the owner is being shown a count they may need to act on.
      console.log(`cancellation email (N-3) skipped ${summary.skippedNoRecipient} player(s) with no usable address: ${who}`);
    }
    if (summary.alreadyLogged > 0) {
      console.warn(`cancellation email (N-3) already logged for ${summary.alreadyLogged} player(s), not resent: ${who}`);
    }
    if (summary.deferred > 0) {
      // The gap Task 4's review accepted for N-2 and this route inherited —
      // now closed the same way, and for a stronger reason. A ceiling refusal
      // deletes the log row so a retry *could* happen, but nothing sweeps for
      // one, and unlike N-2 there is no later message that corrects the
      // silence: the fixture is terminal, so no reminder follows, and the
      // players turn up to a game that is off. A `console.error` that ages
      // out of Workers Logs is not an adequate record of that. The audit row
      // names the fixture and every player who was never told, in a table
      // nothing prunes, so the question "who do I have to ring" is still
      // answerable next week.
      await recordCeilingDeferral(db, {
        action: "fixture.cancellation_email_deferred",
        notificationType: "n3",
        fixtureId: context.fixture.id,
        playerIds: summary.deferredPlayerIds,
        now,
      });
      console.error(`cancellation email (N-3) refused by the daily send ceiling for ${summary.deferred} player(s) and NOTHING WILL RETRY IT (audit_log row written): ${who}`);
    }
    if (summary.failed > 0) {
      console.error(`cancellation email (N-3) failed for ${summary.failed} player(s): ${who}: ${summary.failures.join("; ")}`);
    }

    return { sent: summary.sent };
  } catch (error) {
    console.error(
      `cancellation email (N-3) threw; the fixture IS cancelled but the squad may not have been told: ${who}: ${
        error instanceof Error ? (error.stack ?? error.message) : String(error)
      }`,
    );
    return { sent: 0 };
  }
}

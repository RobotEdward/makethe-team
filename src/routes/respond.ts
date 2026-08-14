import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { countActiveOwners, findMembershipInGame, getFixtureWithSquad } from "../db/queries.js";
import { games } from "../db/schema.js";
import { getDb, type Db } from "../db/client.js";
import { fixtureView } from "../domain/fixture-view.js";
import { formatLocalDateTime } from "../domain/time/zone.js";
import { verifyLeaveToken, verifyResponseToken } from "../domain/token.js";
import { removeMember } from "../domain/remove-member.js";
import type { ResponseIntent, WaitlistPromotion } from "../capacity/types.js";
import type { AppEnv } from "../env.js";
import { recordCeilingDeferral } from "../notify/ceiling-audit.js";
import { createNotifier } from "../notify/factory.js";
import { sendPromotionEmail } from "../notify/send-promotion.js";
import { renderLinkProblemPage } from "../views/link-problem.js";
import { renderFixturePage, type ReadOnlyReason } from "../views/fixture.js";
import { renderLeavePage } from "../views/leave.js";
import { squadForViewer } from "../domain/squad-visibility.js";

export const respond = new Hono<AppEnv>();

/**
 * Every `renderLinkProblemPage()` answer from this module is a 200, not a 410
 * or a 404: the link the player tapped is not itself gone or malformed from an
 * HTTP point of view — it is simply not something this request can act on
 * right now, and the body says so in plain language. A player's own mail
 * client, and any prefetcher ahead of them, should see an ordinary page, not
 * an error status that might get treated specially (e.g. retried, or flagged)
 * by something in the delivery path. Nothing on these paths is a server fault,
 * so 5xx is never appropriate here — `app.onError`, which renders the very
 * same page for a genuine server fault, answers 500 for exactly that reason.
 */
function parseIntent(value: string | undefined): "in" | "out" | null {
  return value === "in" || value === "out" ? value : null;
}

/**
 * Load a fixture and render the page one player sees of it — the read path
 * shared by the `GET` and, after it has (or has not) written anything, the
 * `POST`.
 *
 * Returns `null` only when the fixture itself cannot be found, which the
 * caller treats identically to a token failure (never leaking whether a
 * fixture existed, per the `GET`'s existing behaviour).
 *
 * `readOnlyReason` is derived from **`fixture.lifecycle` and squad
 * membership alone** — never from a Durable Object outcome. That is
 * deliberate: this function is the single place either handler decides what
 * a viewer may do here, so the two can no longer disagree about it. A
 * `scheduled` fixture (`not-open`) and a missing squad row (`not-eligible`)
 * are exactly the two conditions under which the Durable Object would also
 * refuse a write (`fixture-not-open` on a lifecycle other than `played`/
 * `cancelled`, and `not-eligible` respectively), so re-deriving from the
 * fixture row after the fact gives the same answer without the route having
 * to interpret the outcome's `reason` at all.
 */
async function renderFixtureForViewer(params: {
  db: Db;
  fixtureId: string;
  playerId: string;
  token: string;
  now: Date;
  intent: ResponseIntent | null;
}): Promise<string | null> {
  const { db, fixtureId, playerId, token, now, intent } = params;
  const loaded = await getFixtureWithSquad(db, fixtureId);
  if (!loaded) return null;

  const { fixture, game, squad } = loaded;
  const view = fixtureView(
    {
      lifecycle: fixture.lifecycle,
      kicksOffAt: fixture.kicksOffAt,
      inCount: fixture.inCount,
      minPlayers: fixture.minPlayers,
      maxPlayers: fixture.maxPlayers,
      prefersEvenNumbers: fixture.prefersEvenNumbers,
      shortWarningOffsetHours: fixture.shortWarningOffsetHours,
    },
    now,
  );

  // A player with no response row was eligible when the fixture opened but is
  // not any more (most likely removed from the squad after their link was
  // sent) — the token still verifies, so this is not a token failure, but
  // there is nothing for them to do here.
  const viewerMember = squad.find((member) => member.playerId === playerId);
  const viewer = {
    playerId,
    status: viewerMember?.status ?? ("pending" as const),
    waitlistRank: viewerMember?.waitlistRank ?? null,
  };

  // An organiser who also plays gets a response row like everyone else when a
  // fixture opens, so they are mailed a reminder carrying their own link and
  // land here — there is nothing about this route that makes its viewer a
  // player rather than an owner. The token names the player; the squad they
  // may see is decided by the membership that player holds in *this* game, so
  // it is read here rather than joined into `getFixtureWithSquad`: it is a
  // fact about the viewer, not about the fixture, and every other caller of
  // that query already knows its viewer's role without asking.
  //
  // `active` as well as `owner`: an organiser who has been removed from the
  // squad keeps neither the standing nor the visibility (the same rule the
  // owner-facing routes apply through `findGameForOwner`).
  const membership = await findMembershipInGame(db, game.id, playerId);
  const isOwner = membership?.active === true && membership.role === "owner";

  const readOnlyReason: ReadOnlyReason | undefined =
    fixture.lifecycle === "played" || fixture.lifecycle === "cancelled"
      ? fixture.lifecycle
      : fixture.lifecycle === "scheduled"
        ? "not-open"
        : viewerMember === undefined
          ? "not-eligible"
          : undefined;

  return renderFixturePage({
    gameName: game.name,
    venueName: fixture.venueOverride ?? game.venueName,
    kicksOffAtLocal: formatLocalDateTime(fixture.kicksOffAt, game.timezone),
    view,
    squad: squadForViewer(game, squad, { isOwner }),
    inCount: fixture.inCount,
    viewer,
    token,
    intent,
    readOnlyReason,
  });
}

respond.get("/r/:token", async (c) => {
  const token = c.req.param("token");
  // The one place this route reads the real wall clock; everything downstream
  // takes `now` as a parameter (see the lint rule banning bare `new Date()`).
  const now = new Date(Date.now());
  const verification = await verifyResponseToken(token, c.env.RESPONSE_TOKEN_SECRET, now);

  if (!verification.ok) {
    console.error(`response token rejected: ${verification.reason}`);
    return c.html(renderLinkProblemPage(), 200);
  }

  const { playerId, fixtureId } = verification.payload;
  const db = getDb(c.env.DB);
  const intent = parseIntent(c.req.query("intent"));

  const html = await renderFixtureForViewer({ db, fixtureId, playerId, token, now, intent });
  if (html === null) {
    console.error(`response token verified for a fixture that no longer exists: ${fixtureId}`);
    return c.html(renderLinkProblemPage(), 200);
  }

  return c.html(html, 200);
});

/**
 * Record a player's response and re-render the same page in place.
 *
 * Deliberately not a redirect (see the design note on `renderLinkProblemPage`
 * for why the equivalent choice was made on the failure path): a redirect
 * would have to carry the token in the URL again, and buys nothing without
 * JavaScript on this page (TR-4, TR-15).
 *
 * The write goes through `FIXTURE_CAPACITY.getByName(fixtureId).setResponse`
 * and nowhere else — that Durable Object is what serialises capacity-affecting
 * writes (TR-10) and is the only thing that may decide `in` versus
 * `waitlisted`. Its rejections are not otherwise inspected: `fixture-not-open`
 * and `not-eligible` are re-derived independently by `renderFixtureForViewer`
 * from the fixture row it reads immediately afterwards (see that function's
 * doc comment for why that is deliberately the single source of truth for
 * both handlers), and the waitlist number shown to the player always comes
 * from `getFixtureWithSquad`'s `waitlistRank`, never from the object's
 * `waitlistPosition`, which is a permanent, gappy, internal bookkeeping
 * number (spec amendment 5). Only `fixture-not-found` is checked directly,
 * because that is the one outcome `renderFixtureForViewer` cannot re-derive —
 * there is no fixture row left to read.
 */
respond.post("/r/:token", async (c) => {
  const token = c.req.param("token");
  const now = new Date(Date.now());
  const verification = await verifyResponseToken(token, c.env.RESPONSE_TOKEN_SECRET, now);

  if (!verification.ok) {
    console.error(`response token rejected: ${verification.reason}`);
    return c.html(renderLinkProblemPage(), 200);
  }

  const { playerId, fixtureId } = verification.payload;

  const form = await c.req.parseBody();
  const rawIntent = form["intent"];
  const intent = parseIntent(typeof rawIntent === "string" ? rawIntent : undefined);
  if (intent === null) {
    return c.text('Bad Request: "intent" must be exactly "in" or "out"', 400);
  }

  const outcome = await c.env.FIXTURE_CAPACITY.getByName(fixtureId).setResponse({
    playerId,
    intent,
    actorPlayerId: null,
    source: "token",
    now: now.getTime(),
    whenFull: "waitlist",
  });

  if (outcome.kind === "rejected" && outcome.reason === "fixture-not-found") {
    // Same not-yet-fatal race the GET handles: the token verified fine, the
    // fixture is simply gone by the time the write reached D1.
    console.error(`response token verified for a fixture that no longer exists: ${fixtureId}`);
    return c.html(renderLinkProblemPage(), 200);
  }

  const db = getDb(c.env.DB);

  if (outcome.kind === "recorded" && outcome.promoted) {
    // Handed to `waitUntil`, deliberately — see `notifyPromotedPlayer`.
    c.executionCtx.waitUntil(notifyPromotedPlayer(c.env, fixtureId, outcome.promoted, now));
  }

  const html = await renderFixtureForViewer({ db, fixtureId, playerId, token, now, intent });
  if (html === null) {
    console.error(`fixture disappeared between recording a response and re-rendering it: ${fixtureId}`);
    return c.html(renderLinkProblemPage(), 200);
  }

  return c.html(html, 200);
});

/**
 * Send the N-2 email to the one player this response promoted off the
 * waitlist (BR-7, J4), in the background.
 *
 * **Why `waitUntil` and not `await`.** This runs on the *dropping* player's
 * request. Everything they need has already been decided — their response is
 * committed inside the Durable Object and the promotion happened atomically
 * with it — and what is left is an HTTP call to a mail provider on someone
 * else's behalf. Awaiting it would put a third party's provider latency, and
 * a provider timeout, directly in front of a page whose only job is to say
 * "recorded". Nothing on that page depends on the email, and no correctness
 * property does either: the promotion is already durable in D1 whether or not
 * this send ever happens.
 *
 * **Why that is safe here, given `waitUntil` failures are invisible.** Two
 * independent surfaces, neither of which is "hope someone notices":
 *
 *  1. Every outcome is *durable*. `sendPromotionEmail` writes its
 *     `notification_log` row before the message is handed to the notifier and
 *     records the result on it afterwards, so a provider failure is a `failed`
 *     row with the reason in it — queryable long after the log line has aged
 *     out, and the thing a "why didn't I get told?" question is answered from.
 *  2. Every non-success is *logged*, below, on one greppable line per case,
 *     including the case this file has been bitten by before: a rejected
 *     promise inside a `waitUntil` that resolves into nothing. The `catch` is
 *     not decoration — without it a thrown D1 error here would vanish
 *     entirely. `observability` is enabled in `wrangler.jsonc`, so these reach
 *     Workers Logs.
 *
 * The notifier is built here rather than passed in because it must be the
 * quota-wrapped one from `createNotifier` (TR-31): the daily ceiling is the
 * project's only cost control, and a per-request send path is exactly where a
 * runaway would show up.
 */
export async function notifyPromotedPlayer(
  env: AppEnv["Bindings"],
  fixtureId: string,
  promoted: WaitlistPromotion,
  now: Date,
): Promise<void> {
  const who = `fixture ${fixtureId}, player ${promoted.playerId}`;
  const db = getDb(env.DB);
  try {
    const outcome = await sendPromotionEmail({
      db,
      notifier: createNotifier(env, db, now),
      fixtureId,
      promoted,
      now,
      responseTokenSecret: env.RESPONSE_TOKEN_SECRET,
    });

    switch (outcome.kind) {
      case "sent":
        return;
      case "skipped-no-recipient":
        // Expected and permanent (BR-32), not a fault: a guest has no address.
        console.log(`promotion email (N-2) skipped, no usable address: ${who}`);
        return;
      case "deferred":
        // Task 4's review ruled on this branch and deferred the fix to the
        // task that built TR-31's warning, because both need the same durable
        // signal. The ruling stands as written: the ceiling refusal *deletes*
        // the `notification_log` row — correct, because the message never
        // reached a provider — but that deletion also erases the only record
        // that a promoted player was never told, and no retry is even
        // possible, because `promotedAt` (which `promotionKey` needs) is
        // persisted nowhere. So: keep the delete, add the audit row. Written
        // before the log line so a D1 failure here cannot be mistaken for the
        // row having been written.
        await recordCeilingDeferral(db, {
          action: "fixture.promotion_email_deferred",
          notificationType: "n2",
          fixtureId,
          playerIds: [promoted.playerId],
          now,
        });
        console.error(
          `promotion email (N-2) refused by the daily send ceiling and NOTHING WILL RETRY IT (audit_log row written): ${who}`,
        );
        return;
      case "already-logged":
        console.warn(`promotion email (N-2) already logged for this exact promotion, not resent: ${who}`);
        return;
      case "failed":
        console.error(`promotion email (N-2) failed to send: ${who}: ${outcome.reason}`);
        return;
      default:
        // `fixture-not-found` / `player-not-found`: the row vanished between
        // the Durable Object promoting them and this read.
        console.error(`promotion email (N-2) not sent (${outcome.kind}): ${who}`);
        return;
    }
  } catch (error) {
    // The one line standing between a background failure and total silence.
    console.error(
      `promotion email (N-2) threw and was never sent: ${who}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
  }
}

/**
 * `GET /leave/:token` (BR-22) — the confirmation a player reaches from the
 * leave link in every reminder and promotion email. `GET`-only, deliberately:
 * it performs **no write on any path**, for the same reason `POST /sign-out`
 * has no `GET` alias. Mail scanners and link-preview bots issue a `GET` on
 * every URL in an incoming message before a person ever opens it; a `GET`
 * that removed someone from their squad would unsubscribe people who never
 * clicked anything.
 *
 * Every failure that is about the token itself — expired, tampered,
 * malformed, or a response token presented here (the `kind` discriminator
 * inside `verifyLeaveToken` rejects it as `malformed`) — renders the same
 * `renderLinkProblemPage()` at 200 that `/r/:token` answers with, so trying
 * one path against the other tells an attacker nothing.
 */
respond.get("/leave/:token", async (c) => {
  const token = c.req.param("token");
  const now = new Date(Date.now());
  const verification = await verifyLeaveToken(token, c.env.RESPONSE_TOKEN_SECRET, now);

  if (!verification.ok) {
    console.error(`leave link token rejected: ${verification.reason}`);
    return c.html(renderLinkProblemPage(), 200);
  }

  const { gameId, playerId } = verification.payload;
  const db = getDb(c.env.DB);

  const [game] = await db.select().from(games).where(eq(games.id, gameId)).limit(1);
  if (!game) {
    console.error(`leave link token verified for a game that no longer exists: ${gameId}`);
    return c.html(renderLinkProblemPage(), 200);
  }

  const membership = await findMembershipInGame(db, gameId, playerId);

  if (!membership || !membership.active) {
    return c.html(renderLeavePage({ token, gameId, gameName: game.name, state: "already-left" }), 200);
  }

  const state =
    membership.role === "owner" && (await countActiveOwners(db, gameId)) === 1
      ? "sole-organiser"
      : "confirm";

  return c.html(renderLeavePage({ token, gameId, gameName: game.name, state }), 200);
});

/**
 * `POST /leave/:token` (BR-22) — the write the confirmation page above posts
 * to. `removeMember` does the entire job (deactivate the membership, demote
 * an organiser, write the `membership.removed` audit row, withdraw the
 * leaver from every open fixture, and promote the longest-waiting
 * replacement on each) with the leaver as their own actor: a
 * `membership.removed` row whose actor equals its subject reads
 * unambiguously as "they left" rather than "an organiser removed them", so no
 * new audit action is needed.
 *
 * **Deliberately no `wrongOrigin` check.** Every other state-changing POST in
 * this application has one; this route does not, and that is a decision, not
 * an oversight. This form is reached from a link in an email and submitted
 * from whatever renders that email — a mail client's own webview, or a
 * browser opened from it — where `Origin` is frequently absent altogether or
 * set to the webmail provider's own domain rather than this app's. Checking
 * it here would refuse the unsubscribe for exactly the population BR-22
 * exists to serve. The signed, expiring token is the entire authorisation,
 * the same reasoning `POST /r/:token` above already applies for not checking
 * it either.
 *
 * `not-a-member` renders the same link-problem page a bad token does, rather
 * than a 404 or an explanation: the token names a game this player was never
 * in, which is indistinguishable from a broken link, and saying more would
 * confirm or deny that the game exists.
 *
 * Sends no email to the leaver. §1.11's notification catalogue is closed —
 * N-7 exists to tell someone something happened *to* them, and this person
 * did it deliberately and is looking at the confirmation page right now. The
 * only mail this route may cause is N-2, to any player promoted off a
 * waitlist by the leaver's withdrawal, sent through the same
 * `notifyPromotedPlayer` background path `POST /r/:token` uses.
 */
respond.post("/leave/:token", async (c) => {
  const token = c.req.param("token");
  const now = new Date(Date.now());
  const verification = await verifyLeaveToken(token, c.env.RESPONSE_TOKEN_SECRET, now);

  if (!verification.ok) {
    console.error(`leave link token rejected: ${verification.reason}`);
    return c.html(renderLinkProblemPage(), 200);
  }

  const { gameId, playerId } = verification.payload;
  const db = getDb(c.env.DB);

  const [game] = await db.select().from(games).where(eq(games.id, gameId)).limit(1);
  if (!game) {
    console.error(`leave link token verified for a game that no longer exists: ${gameId}`);
    return c.html(renderLinkProblemPage(), 200);
  }

  const result = await removeMember({
    db,
    gameId,
    playerId,
    // The leaver is their own actor. See this handler's doc comment.
    actorPlayerId: playerId,
    now,
    withdraw: (fixtureId) =>
      c.env.FIXTURE_CAPACITY.getByName(fixtureId).withdrawMember({
        playerId,
        actorPlayerId: playerId,
        now: now.getTime(),
      }),
  });

  if (result.kind === "not-a-member") {
    console.error(`leave link token verified for a game the player is not a member of: ${gameId}, ${playerId}`);
    return c.html(renderLinkProblemPage(), 200);
  }

  if (result.kind === "refused") {
    return c.html(
      renderLeavePage({ token, gameId, gameName: game.name, state: "sole-organiser" }),
      422,
    );
  }

  // `removed` and `resumed` are handled identically and deliberately so — see
  // `removeMember`'s doc comment on why a resume reaches the same end state a
  // first attempt does, and why a second submission of this same POST (which
  // is what a reload does) is the documented recovery for a removal that
  // failed partway through its fixture loop.
  for (const { fixtureId, promoted } of result.promotions) {
    c.executionCtx.waitUntil(notifyPromotedPlayer(c.env, fixtureId, promoted, now));
  }

  return c.html(renderLeavePage({ token, gameId, gameName: game.name, state: "done" }), 200);
});

import { Hono } from "hono";
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  countActiveOwners,
  findMembershipInGame,
  getFixtureWithSquad,
  listOtherActiveGames,
  muteStateFor,
} from "../db/queries.js";
import { isHeldByInviteOrder } from "../db/invite-queries.js";
import { tokenMutePath, tokenUnmutePath } from "../auth/paths.js";
import { parseMuteDuration } from "../domain/mute.js";
import { clearMute, setMute } from "../domain/set-mute.js";
import type { MuteControlsOptions } from "../views/mute-controls.js";
import { fixtures, games, players } from "../db/schema.js";
import { getDb, type Db } from "../db/client.js";
import { resolveSessionPlayer } from "../auth/session.js";
import { fixtureView } from "../domain/fixture-view.js";
import { formatLocalDate, formatLocalDateTime } from "../domain/time/zone.js";
import {
  leaveTokenMintedAt,
  verifyLeaveToken,
  verifyResponseToken,
  type LeaveTokenPayload,
} from "../domain/token.js";
import { removeMember } from "../domain/remove-member.js";
import type { ResponseIntent, SetResponseOutcome, WaitlistPromotion } from "../capacity/types.js";
import type { AppEnv } from "../env.js";
import { recordCeilingDeferral } from "../notify/ceiling-audit.js";
import {
  applySendResult,
  insertQueuedLogRows,
  markOrphanedRowsFailed,
} from "../notify/delivery.js";
import { createNotifier } from "../notify/factory.js";
import { loadNotificationSettings } from "../notify/notification-settings.js";
import { buildReminderMessages } from "../notify/reminder-messages.js";
import { sendPromotionEmail } from "../notify/send-promotion.js";
import { renderLinkProblemPage } from "../views/link-problem.js";
import { renderFixturePage, type ReadOnlyReason } from "../views/fixture.js";
import { renderLeavePage, type LeavePageParams } from "../views/leave.js";
import { squadForViewer } from "../domain/squad-visibility.js";
import { publishedTeamsFor } from "../domain/teams.js";

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
  /**
   * The one-time push offer (M14 Task 12), decided and stamped by the caller
   * — see `respond.post("/r/:token", …)` for the gate. `undefined` on every
   * other caller, including the `GET` below: the offer belongs to the act of
   * answering, not to revisiting an answer already given, and a `GET` is
   * also the request a mail scanner or link-preview bot issues on every
   * fixture link before a person ever opens it (the same reasoning this
   * module's own doc comment gives for why `GET` here writes nothing).
   */
  pushOffer?: { vapidPublicKey: string };
}): Promise<string | null> {
  const { db, fixtureId, playerId, token, now, intent, pushOffer } = params;
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
    // BR-40a. Asked only of a waitlisted viewer, because it is only a
    // waitlisted viewer whose page would otherwise give them the wrong reason
    // for waiting — and it costs two reads, which a page that will not use the
    // answer should not pay.
    heldByInviteOrder:
      viewerMember?.status === "waitlisted" &&
      (await isHeldByInviteOrder(db, {
        fixtureId,
        playerId,
        gatedInvitesEnabled: game.gatedInvitesEnabled,
      })),
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
    // The unfiltered squad this function already holds, not the
    // visibility-filtered list passed as `squad` above (which may be `null`
    // precisely when the organiser has hidden it, BR-33) — the case that most
    // needs this count.
    waitlistCount: squad.filter((member) => member.status === "waitlisted").length,
    viewer,
    token,
    intent,
    readOnlyReason,
    // The viewer's own row, not the visibility-filtered list above: their own
    // side is theirs to know whatever BR-33 does to everybody else's names
    // (see `publishedTeamsFor`), and reading it from a list that can be
    // `null` would hide it from exactly the players whose game keeps its
    // squad private — the ones already holding an email that names their side.
    teams: publishedTeamsFor(fixture, game, viewerMember),
    pushOffer,
    // Offered only on a page that is not read-only. Two separate reasons,
    // and either alone would be enough:
    //
    //  - `not-eligible` means the reader is no longer on this squad, so a
    //    control for silencing it is a promise nothing behind it could keep.
    //  - The other three reasons mean the fixture is over, off, or not yet
    //    open, and a page in that state offers **nothing to submit** — an
    //    invariant `test/routes/respond-get.test.ts` and
    //    `test/routes/respond-post.test.ts` both pin by asserting the page
    //    carries no `method="post"` at all. The squad-level switch is reachable
    //    from the next fixture's link and from `/g/:id`, so withholding it here
    //    costs a reader nothing.
    mute:
      readOnlyReason === undefined
        ? await muteControlsForToken(db, game, playerId, token, now)
        : undefined,
  });
}

/**
 * The auto-decline panel's props for a reader holding an emailed link (M28).
 *
 * Its own function rather than a shared import from `src/routes/games.ts`,
 * because the two differ in the only place that matters: the actions here are
 * token paths, and a signed-in path posted from an email would 302 the reader
 * to a sign-in page they may have no account for. What must not drift — the
 * durations, the wording, the on/off shape — lives in `renderMuteControls`,
 * which both call.
 *
 * A `null` state means the reader is not an active member. Unreachable here,
 * since `not-eligible` is already filtered out above by the time this is
 * called, and rendered as the off state for the reason its sibling gives.
 */
async function muteControlsForToken(
  db: Db,
  game: { id: string; timezone: string },
  playerId: string,
  token: string,
  now: Date,
): Promise<MuteControlsOptions> {
  const state = await muteStateFor(db, game.id, playerId, now);
  return {
    muteAction: tokenMutePath(token),
    unmuteAction: tokenUnmutePath(token),
    state:
      state?.muted === true
        ? {
            muted: true,
            // The date alone — see the same line in `src/routes/games.ts`.
            untilLocal: state.mutedUntil === null ? null : formatLocalDate(state.mutedUntil, game.timezone),
          }
        : { muted: false },
    otherGamesCount: state?.otherGamesCount ?? 0,
  };
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
/**
 * Decide, and — the same instant — spend, this player's one-time push offer
 * (M14 Task 12, spec §11's closing paragraph: "offered once in the product's
 * lifetime and never again").
 *
 * **Gated on the response having just landed as `"in"`, not merely on
 * `intent === "in"` having been posted.** A fixture that is full records the
 * same submitted intent as `"waitlisted"` (BR-5), and offering push on the
 * strength of a headline that will read "You're on the waitlist" rather than
 * "You're in" is exactly the confusion BR-5 exists to prevent one layer up —
 * so this reads `outcome.status`, the Durable Object's own answer, never the
 * form's.
 *
 * **Gated on a VAPID key existing at all**, and checked *before* the write:
 * M14 ships dark (`wrangler.jsonc`'s own comment on `PUSH_NOTIFIER`), so on
 * a fresh deploy this must stay a no-op that spends nothing, or every player
 * who says "in" tonight would burn their once-ever offer on a page with a
 * button that could never have worked, and none of them would ever be
 * offered push again once the real key exists tomorrow.
 *
 * **The `UPDATE … WHERE push_offered_at IS NULL` is the actual gate**, not a
 * preceding `SELECT`: `players.push_offered_at IS NULL` is checked and set
 * atomically, so two concurrent requests for the same player (a doubled tap,
 * two open tabs) cannot both see null and both decide to show the offer —
 * only the request whose `UPDATE` actually changed a row does. Mirrors
 * `linkPlayer`'s own compare-and-set in `src/auth/link-player.ts`.
 */
async function resolvePushOffer(
  env: AppEnv["Bindings"],
  db: Db,
  playerId: string,
  outcome: SetResponseOutcome,
  now: Date,
): Promise<{ vapidPublicKey: string } | undefined> {
  if (outcome.kind !== "recorded" || outcome.status !== "in") return undefined;

  // Typed as a required `string` in `src/env.ts`, but genuinely absent from
  // this deployment while `PUSH_NOTIFIER` is `"null"` — see that binding's
  // own doc comment. Read defensively rather than trusting the type.
  const vapidPublicKey = env.VAPID_PUBLIC_KEY || undefined;
  if (vapidPublicKey === undefined) return undefined;

  const stamped = await db
    .update(players)
    .set({ pushOfferedAt: now })
    .where(and(eq(players.id, playerId), isNull(players.pushOfferedAt)))
    .returning({ id: players.id });

  return stamped.length > 0 ? { vapidPublicKey } : undefined;
}

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

  // Only a decline can owe a tier (BR-41), so only a decline pays for the
  // claim. An `in` never releases anybody.
  if (intent === "out") {
    c.executionCtx.waitUntil(notifyReleasedSubs(c.env, fixtureId, now));
  }

  const pushOffer = await resolvePushOffer(c.env, db, playerId, outcome, now);

  const html = await renderFixtureForViewer({ db, fixtureId, playerId, token, now, intent, pushOffer });
  if (html === null) {
    console.error(`fixture disappeared between recording a response and re-rendering it: ${fixtureId}`);
    return c.html(renderLinkProblemPage(), 200);
  }

  return c.html(html, 200);
});

/**
 * Claim any tier this response released, and send the N-1 to whoever it newly
 * invited (BR-41, BR-42), in the background.
 *
 * **`waitUntil`, not `await`, for the reasons `notifyPromotedPlayer` gives at
 * length** — this runs on the *declining* player's request, and nothing on
 * their page depends on somebody else's invitation.
 *
 * **This path is an optimisation, never the guarantee.** If the claim lands and
 * the send then fails, `invited_at` is stamped with no message sent — and the
 * next sweep tick finds that player invited, finds no `n1` row for them, and
 * mails them. That is why there is no compensating write here and no attempt to
 * roll the stamp back: rolling it back is what would break the property, by
 * making the sweep unable to tell a failed send from a tier never released.
 *
 * The notifier is built here rather than passed in so that it is the
 * quota-wrapped one from `createNotifier` (TR-31): the daily ceiling is the
 * project's only cost control, and a per-request send path is exactly where a
 * runaway would show up.
 */
export async function notifyReleasedSubs(
  env: AppEnv["Bindings"],
  fixtureId: string,
  now: Date,
  options: { force?: boolean } = {},
): Promise<void> {
  try {
    // The claim happens *here*, not at the call site, and the owner's forced
    // release has to come through this flag rather than claim first and let
    // this function claim again. The claim is idempotent by design, so a
    // second one returns an empty list — a caller that claimed for itself
    // would stamp the tier and then mail nobody.
    const outcome = await env.FIXTURE_CAPACITY.getByName(fixtureId).claimInviteReleases({
      now: now.getTime(),
      force: options.force ?? false,
    });
    if (outcome.kind !== "claimed") return;

    // Anyone the release let straight off the waitlist (BR-40a) is told they
    // are in, not invited: they answered this question long ago. Sequential
    // rather than concurrent, because each send passes through the same daily
    // ceiling and firing them in parallel is how a batch races itself past it.
    for (const promotion of outcome.promoted) {
      await notifyPromotedPlayer(env, fixtureId, promotion, now);
    }

    if (outcome.playerIds.length === 0) return;

    const db = getDb(env.DB);
    const [row] = await db
      .select({ fixture: fixtures, game: games })
      .from(fixtures)
      .innerJoin(games, eq(fixtures.gameId, games.id))
      .where(eq(fixtures.id, fixtureId));
    if (!row) {
      console.error(`released subs for a fixture that no longer exists: ${fixtureId}`);
      return;
    }

    const candidates = await db
      .select({
        playerId: players.id,
        name: players.name,
        email: players.email,
        isGuest: players.isGuest,
      })
      .from(players)
      .where(inArray(players.id, outcome.playerIds));

    // BR-32, and the same `.trim()` the sweep applies: an email of `" "` is
    // truthy, so letting one through means a queued row that comes back
    // `no-recipient` and is retried forever.
    const mailable = candidates.filter(
      (candidate) =>
        !candidate.isGuest && candidate.email !== null && candidate.email.trim() !== "",
    );
    if (mailable.length === 0) return;

    // Masked by the administrator's switch only, never the owner's: an owner
    // who turns reminders off has never gated a promotion off the waitlist
    // before (n1 was unconditional pre-M37), and this is a promotion, not a
    // reminder about a place the player already held. The administrator's
    // switch is the one global kill switch and must have no holes, so it
    // alone masks this send.
    const settings = await loadNotificationSettings(db, [row.game.id]);
    const channels = {
      email: settings.adminAllows("n1", "email"),
      push: settings.adminAllows("n1", "push"),
    };
    if (!channels.email && !channels.push) return;

    const { pending } = await buildReminderMessages({
      db,
      fixture: row.fixture,
      game: row.game,
      candidates: mailable,
      responseTokenSecret: env.RESPONSE_TOKEN_SECRET,
      now,
      channels,
    });

    const inserted = await insertQueuedLogRows(db, { fixtureId, notificationType: "n1" }, pending);
    if (inserted.length === 0) return;

    const notifier = createNotifier(env, db, now);
    let results;
    try {
      results = await notifier.send(inserted.map((entry) => entry.message));
    } catch (error) {
      // Whether anything reached a provider is unknowable, so the rows are
      // marked `failed` — ambiguous, never retried — exactly as the sweep
      // does. BR-19 treats a duplicate as strictly worse than a miss.
      const message = error instanceof Error ? error.message : String(error);
      await markOrphanedRowsFailed(db, inserted, `released-sub send rejected: ${message}`);
      console.error(`released-sub send rejected for fixture ${fixtureId}: ${message}`);
      return;
    }

    for (let i = 0; i < inserted.length; i++) {
      const entry = inserted[i];
      if (!entry) continue;
      await applySendResult(db, entry, results[i], now);
    }
  } catch (error) {
    // Without this the whole promise rejects inside a `waitUntil` and vanishes
    // — the failure mode this file has already been bitten by once.
    console.error(
      `releasing subs failed for fixture ${fixtureId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

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
          entityType: "fixture",
          entityId: fixtureId,
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
/**
 * The "other squads" a signed-in visitor may be shown on this page (M7a Task
 * 4). `undefined` unless a session exists **and** its player id equals the
 * token's own — this is the entire security property of this task (BR-25). A
 * leave token names one player and one game; without this match, a forwarded
 * link opened by a different signed-in person would show them somebody
 * else's squads, and a leaked link would become a multi-game capability
 * rather than a single-game one.
 *
 * Resolved by calling `resolveSessionPlayer` directly rather than by mounting
 * `sessionMiddleware` on `/leave/*` — see that function's own doc comment for
 * why a mount here would be the wrong trade.
 */
/*
 * Never fatal, for the same reason `resolveSession` isn't. This is the one
 * part of this page that needs a session, on a route whose entire promise is
 * that it works without one — so a D1 fault in the session lookup or in the
 * list query must cost the visitor the extra list, not the page. Degrading to
 * `undefined` renders the sign-in offer a signed-out visitor already sees,
 * which is the honest answer when we could not establish who is asking.
 */
async function resolveOtherGames(
  env: AppEnv["Bindings"],
  db: Db,
  now: Date,
  headers: Headers,
  gameId: string,
  tokenPlayerId: string,
): Promise<LeavePageParams["otherGames"]> {
  try {
    const viewer = await resolveSessionPlayer(env, db, now, headers);
    if (viewer === null || viewer.id !== tokenPlayerId) return undefined;
    return await listOtherActiveGames(db, tokenPlayerId, gameId);
  } catch (error) {
    console.error(
      `other-squads list failed, rendering the leave page without it: ${
        error instanceof Error ? (error.stack ?? error.message) : String(error)
      }`,
    );
    return undefined;
  }
}

/**
 * Whether this token belongs to a spell in the squad that has since ended.
 *
 * A leave token names a player and a game, and nothing about *which*
 * membership it was minted against — so on its own it keeps working across a
 * leave and a rejoin, and one copy of an old email becomes a repeatable
 * eviction: tap, rejoin, tap again, for the ninety days the token lives. That
 * matters more here than on any other link in a message, because this one is
 * deliberately usable with no session and from any origin.
 *
 * The binding needs no new field. `joinSquad` rewrites `joined_at` every time
 * it reactivates a membership, and a leave token's mint time comes out of its
 * own expiry (`leaveTokenMintedAt`) — so a token minted *before* the current
 * spell began is, by construction, from a previous one, and must not act.
 * A token minted during the current spell is unaffected, which is the whole
 * of the narrowing: ordinary links keep working.
 *
 * Applied on the `GET` as well as the `POST`. The `GET` writes nothing, so it
 * is not where the harm is, but a stale token that renders a live "Leave this
 * game" button which then refuses on submission is a worse answer than the
 * link-problem page the token has earned — and it would confirm to the holder
 * that the player is back in the squad, which is exactly what the silent
 * refusal exists not to say.
 */
function isFromAPreviousSpell(payload: LeaveTokenPayload, joinedAt: Date): boolean {
  return leaveTokenMintedAt(payload).getTime() < joinedAt.getTime();
}

/**
 * The player's own auto-decline switch (M28), reached from an emailed fixture
 * link with no session at all.
 *
 * **Deliberately no `wrongOrigin` check**, for the reason `POST /leave/:token`
 * below sets out at length: this form is submitted from whatever rendered the
 * email, where `Origin` is often absent or the webmail provider's own. The
 * signed, expiring response token is the entire authorisation, exactly as it
 * is for `POST /r/:token` above.
 *
 * The token names a *player* and a *fixture*; the mute is written against the
 * fixture's **game**, which is read here rather than trusted from any field —
 * a game id in the body would let a holder of one squad's link mute a
 * different squad. "All my games" is still offered, and is the one thing here
 * a leaked link could reach beyond this squad: the same exposure
 * `POST /leave/:token` already carries, and reversible in one tap from any of
 * the pages the panel appears on.
 */
respond.post("/r/:token/mute", async (c) => {
  const token = c.req.param("token");
  const now = new Date(Date.now());
  const verification = await verifyResponseToken(token, c.env.RESPONSE_TOKEN_SECRET, now);
  if (!verification.ok) {
    console.error(`response token rejected on mute: ${verification.reason}`);
    return c.html(renderLinkProblemPage(), 200);
  }

  const form = await c.req.parseBody();
  const duration = parseMuteDuration(form["duration"]);
  if (duration === null) {
    return c.text('Bad Request: "duration" must be one of 2w, 4w, 8w, forever', 400);
  }

  const { playerId, fixtureId } = verification.payload;
  const db = getDb(c.env.DB);
  const gameId = await gameIdForFixture(db, fixtureId);
  if (gameId === null) {
    console.error(`response token verified for a fixture that no longer exists: ${fixtureId}`);
    return c.html(renderLinkProblemPage(), 200);
  }

  // See the identical collector in `src/routes/games.ts`'s mute route for why
  // the ids are gathered here rather than returned by `SetMuteResult`.
  const autoDeclined: string[] = [];
  const result = await setMute({
    db,
    playerId,
    gameId,
    duration,
    applyToAll: form["all-games"] !== undefined,
    now,
    decline: (declineFixtureId, declinePlayerId) => {
      autoDeclined.push(declineFixtureId);
      return c.env.FIXTURE_CAPACITY.getByName(declineFixtureId).setResponse({
        playerId: declinePlayerId,
        intent: "out",
        actorPlayerId: null,
        source: "token",
        now: now.getTime(),
        whenFull: "waitlist",
      });
    },
  });
  // Not on this squad any more: the same link-problem page a bad token gets,
  // for the reason `POST /leave/:token` gives — saying more would confirm the
  // game exists.
  if (result.kind === "not-a-member") return c.html(renderLinkProblemPage(), 200);

  // A mute is a decline the player made in advance (M28), so each fixture it
  // answered owes a tier just as a live decline does.
  for (const declinedFixtureId of autoDeclined) {
    c.executionCtx.waitUntil(notifyReleasedSubs(c.env, declinedFixtureId, now));
  }

  return c.redirect(`/r/${encodeURIComponent(token)}`, 303);
});

/** Turning it back off from the same link. See `POST /r/:token/mute`. */
respond.post("/r/:token/unmute", async (c) => {
  const token = c.req.param("token");
  const now = new Date(Date.now());
  const verification = await verifyResponseToken(token, c.env.RESPONSE_TOKEN_SECRET, now);
  if (!verification.ok) {
    console.error(`response token rejected on unmute: ${verification.reason}`);
    return c.html(renderLinkProblemPage(), 200);
  }

  const { playerId, fixtureId } = verification.payload;
  const db = getDb(c.env.DB);
  const gameId = await gameIdForFixture(db, fixtureId);
  if (gameId === null) {
    console.error(`response token verified for a fixture that no longer exists: ${fixtureId}`);
    return c.html(renderLinkProblemPage(), 200);
  }

  const form = await c.req.parseBody();
  const result = await clearMute({
    db,
    playerId,
    gameId,
    applyToAll: form["all-games"] !== undefined,
    now,
  });
  if (result.kind === "not-a-member") return c.html(renderLinkProblemPage(), 200);

  return c.redirect(`/r/${encodeURIComponent(token)}`, 303);
});

/** The game a fixture belongs to, or `null` if the fixture is gone. */
async function gameIdForFixture(db: Db, fixtureId: string): Promise<string | null> {
  const [row] = await db.select({ gameId: fixtures.gameId }).from(fixtures).where(eq(fixtures.id, fixtureId));
  return row?.gameId ?? null;
}

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

  if (membership && isFromAPreviousSpell(verification.payload, membership.joinedAt)) {
    // Silent on purpose: saying "you rejoined, so this link is finished" would
    // tell whoever holds this copy of the email something about the player.
    console.error(`leave link token predates the player's current membership: ${gameId}, ${playerId}`);
    return c.html(renderLinkProblemPage(), 200);
  }

  const otherGames = await resolveOtherGames(c.env, db, now, c.req.raw.headers, gameId, playerId);

  if (!membership || !membership.active) {
    return c.html(
      renderLeavePage({ token, gameId, gameName: game.name, state: "already-left", otherGames }),
      200,
    );
  }

  const isOrganiser = membership.role === "owner";
  const state = isOrganiser && (await countActiveOwners(db, gameId)) === 1 ? "sole-organiser" : "confirm";

  return c.html(
    renderLeavePage({ token, gameId, gameName: game.name, state, otherGames, isOrganiser }),
    200,
  );
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
 * A token minted before this player's current spell in the squad began is
 * refused before any write, with the same link-problem page — see
 * `isFromAPreviousSpell` for why that binding is what stops this from being a
 * repeatable eviction rather than a single one.
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

  // The binding this token is missing — see `isFromAPreviousSpell`. Read
  // before the write, so a token from a previous spell never reaches
  // `removeMember` at all.
  const membership = await findMembershipInGame(db, gameId, playerId);
  if (membership && isFromAPreviousSpell(verification.payload, membership.joinedAt)) {
    console.error(`leave link token predates the player's current membership: ${gameId}, ${playerId}`);
    return c.html(renderLinkProblemPage(), 200);
  }

  const otherGames = await resolveOtherGames(c.env, db, now, c.req.raw.headers, gameId, playerId);

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
      renderLeavePage({ token, gameId, gameName: game.name, state: "sole-organiser", otherGames }),
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

  return c.html(renderLeavePage({ token, gameId, gameName: game.name, state: "done", otherGames }), 200);
});

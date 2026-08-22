import { eq } from "drizzle-orm";
import { gamePath } from "../auth/paths.js";
import { listFixtureRecipients, listGameRecipients, type BroadcastRecipient } from "../db/broadcast-queries.js";
import type { Db } from "../db/client.js";
import { fixtures, games, notificationLog } from "../db/schema.js";
import { audienceSelectsStatus, isAddressable, type BroadcastAudience } from "../domain/broadcast-audience.js";
import { formatLocalDateTime } from "../domain/time/zone.js";
import { leaveTokenExpiry, responseTokenExpiry, signLeaveToken, signResponseToken } from "../domain/token.js";
import { broadcastKey, pushKey } from "./dedupe-key.js";
import {
  applySendResult,
  insertQueuedLogRows,
  markOrphanedRowsFailed,
  playersWithPushSubscriptions,
  SITE_ORIGIN,
  type PendingNotification,
} from "./delivery.js";
import type { Notifier } from "./notifier.js";
import { PUSH_COPY } from "./push-copy.js";
import { renderBroadcastEmail, type BroadcastEmailPayload } from "./templates/broadcast.js";

/**
 * What one organiser broadcast did, in aggregate (N-10, BR-36).
 *
 * `sent`/`failed`/`deferred` are **email only**, exactly as
 * `TeamsSendResult`'s doc comment explains at length: the route reports these
 * to the organiser as an email figure, and the push leg has no daily ceiling,
 * so it can never legitimately produce a `deferred` at all. Folding a push row
 * into them would inflate a number presented as an email count. The push leg
 * has `pushSent`/`pushFailed` of its own.
 */
export interface BroadcastSendResult {
  sent: number;
  failed: number;
  deferred: number;
  /**
   * Exactly who the deferrals were for, carried out rather than left a bare
   * count — the same shape and the same reason as `TeamsSendResult`. A ceiling
   * refusal *deletes* its `notification_log` row (`applySendResult`), so these
   * ids are the only remaining evidence that somebody never got the message
   * their organiser wrote by hand.
   */
  deferredPlayerIds: string[];
  /** The push leg's own `sent` count — never folded into `sent` above. */
  pushSent: number;
  /** The push leg's own `failed` count, and where a push `deferred` outcome lands. */
  pushFailed: number;
  /**
   * Selected by the audience but unreachable on any channel — a guest, or
   * nobody with an address or a device (spec §2.1, BR-32). Never a log row.
   *
   * Not the same thing as "asked for push but has no device": that player was
   * addressable, and the organiser simply picked a channel they lack.
   */
  skipped: number;
}

export interface SendBroadcastParams {
  db: Db;
  /** Always the quota-wrapped notifier from `createNotifier` — never a raw provider. */
  notifier: Notifier;
  /**
   * Minted once per request and shared by every recipient of this send. It is
   * the whole of the dedupe key's uniqueness (`broadcastKey`) and of the push
   * `tag` below.
   */
  broadcastId: string;
  gameId: string;
  /** The fixture for a fixture-scoped send, `null` for a game-scoped one. */
  fixtureId: string | null;
  audience: BroadcastAudience;
  subject: string;
  message: string;
  organiserName: string;
  /** Whether each channel was asked for. A ceiling on what is attempted, never a promise. */
  channels: { email: boolean; push: boolean };
  now: Date;
  responseTokenSecret: string;
}

/** A result in which nothing was sent. A fresh object each time, so no two callers share one `deferredPlayerIds`. */
function nothingSent(skipped: number): BroadcastSendResult {
  return { sent: 0, failed: 0, deferred: 0, deferredPlayerIds: [], pushSent: 0, pushFailed: 0, skipped };
}

/**
 * Send one organiser broadcast to everyone the chosen audience selects, on
 * whichever of the two channels was asked for (N-10, BR-36, §2).
 *
 * Same shape as `sendTeamsEmails`: one batch of messages, inserted, sent and
 * applied together in the order BR-19 and §2.4 require — the `queued` rows
 * land first, the send happens second, the outcomes are recorded third, and a
 * crash mid-apply is closed by `markOrphanedRowsFailed` rather than leaving
 * `queued` rows behind. Nothing here is retried: a genuinely new broadcast
 * always has a genuinely new `broadcastId`, so a dropped one is lost rather
 * than duplicated, which is the direction BR-19 chooses.
 *
 * **The game and fixture rows are read here, not passed in.** The email copy
 * needs the game's name, and `whenLocal`/`venueName` need its timezone and the
 * fixture's kick-off and venue override. Taking them as parameters would let a
 * caller hand over a stale game name — the same drift `sendTeamsEmails` avoids
 * by loading both from `getFixtureWithSquad` rather than accepting them.
 */
export async function sendBroadcast(params: SendBroadcastParams): Promise<BroadcastSendResult> {
  const {
    db,
    notifier,
    broadcastId,
    gameId,
    fixtureId,
    audience,
    subject,
    message,
    organiserName,
    channels,
    now,
    responseTokenSecret,
  } = params;

  const [game] = await db
    .select({ name: games.name, timezone: games.timezone, venueName: games.venueName })
    .from(games)
    .where(eq(games.id, gameId));
  if (game === undefined) {
    // Unreachable in practice: the compose route has just loaded and
    // entitlement-checked this game in the same request. Reported loudly
    // rather than thrown — this runs inside `c.executionCtx.waitUntil`, after
    // the organiser's response has already gone, so there is no caller left to
    // hand a rejection to.
    console.error(`sendBroadcast: game ${gameId} not found`);
    return nothingSent(0);
  }

  // `everyone` resolves from `memberships` and describes no fixture, so a
  // fixture id arriving alongside it is discarded here rather than trusted:
  // carried on, it would put a kick-off line in copy that went to people who
  // never responded to that fixture, and a `fixture_id` on every log row.
  // Making the pair impossible at this line beats asserting elsewhere that the
  // routes never produce it (review, Important 1).
  const scopedFixtureId = audience === "everyone" ? null : fixtureId;
  if (audience === "everyone" && fixtureId !== null) {
    console.error(`sendBroadcast: audience "everyone" ignores fixture ${fixtureId}`);
  }

  let fixture: { kicksOffAt: Date; venueOverride: string | null } | undefined;
  if (scopedFixtureId !== null) {
    [fixture] = await db
      .select({ kicksOffAt: fixtures.kicksOffAt, venueOverride: fixtures.venueOverride })
      .from(fixtures)
      .where(eq(fixtures.id, scopedFixtureId));
    if (fixture === undefined) {
      console.error(`sendBroadcast: fixture ${scopedFixtureId} not found`);
      return nothingSent(0);
    }
  }

  const selected = await selectRecipients(db, { gameId, fixtureId: scopedFixtureId, audience, now });
  const addressable = selected.filter((recipient) => isAddressable(recipient));
  const skipped = selected.length - addressable.length;
  if (addressable.length === 0) return nothingSent(skipped);

  // Consulted once for the batch, as `playersWithPushSubscriptions`' own doc
  // comment requires of every caller that builds both channels: a
  // `PushMessage` for a player with no subscription comes back
  // `NO_RECIPIENT_REASON` and is recorded `failed` forever, so a deviceless
  // player would accumulate one dead row per broadcast.
  const subscribed = channels.push
    ? await playersWithPushSubscriptions(db, addressable.map((recipient) => recipient.playerId))
    : new Set<string>();

  const whenLocal = fixture === undefined ? null : formatLocalDateTime(fixture.kicksOffAt, game.timezone);
  const venueName = fixture === undefined ? null : (fixture.venueOverride ?? game.venueName);

  // A response token outlives its fixture by a fixed window (BR-24), so a
  // broadcast about a fixture that kicked off days ago would sign one that is
  // already dead. The game page is the fallback: every holder of a push
  // subscription is a signed-in player, so it is always reachable for them.
  const tokenExpiry = fixture === undefined ? null : responseTokenExpiry(fixture.kicksOffAt);
  const fixtureLink =
    scopedFixtureId !== null && tokenExpiry !== null && tokenExpiry.getTime() > now.getTime()
      ? { fixtureId: scopedFixtureId, expiresAt: tokenExpiry.getTime() }
      : null;
  const gameUrl = `${SITE_ORIGIN}${gamePath(gameId)}`;

  const pending: PendingNotification[] = [];

  for (const recipient of addressable) {
    // `isAddressable` accepts a player with no address who has a device, so
    // the email leg re-checks. `.trim()` is load-bearing, as everywhere else:
    // an email of `" "` is truthy, and would produce a `queued` row and a
    // `no-recipient` result left `failed` forever.
    const email = (recipient.email ?? "").trim();

    // A leave token, scoped to the Game rather than to any fixture — the same
    // reasoning as every other game-scoped notification (BR-22, §2.2).
    const leaveToken = await signLeaveToken(
      { gameId, playerId: recipient.playerId, expiresAt: leaveTokenExpiry(now).getTime() },
      responseTokenSecret,
    );

    const payload: BroadcastEmailPayload = {
      playerName: recipient.name,
      gameName: game.name,
      organiserName,
      subject,
      message,
      whenLocal,
      venueName,
      leaveUrl: `${SITE_ORIGIN}/leave/${leaveToken}`,
    };

    const dedupeKey = broadcastKey(broadcastId, recipient.playerId);

    if (channels.email && email !== "") {
      const rendered = renderBroadcastEmail(payload);
      pending.push({
        logId: crypto.randomUUID(),
        dedupeKey,
        playerId: recipient.playerId,
        message: {
          channel: "email",
          to: email,
          subject: rendered.subject,
          html: rendered.html,
          text: rendered.text,
          dedupeKey,
        },
      });
    }

    if (channels.push && subscribed.has(recipient.playerId)) {
      const copy = PUSH_COPY.n10(payload);
      const url =
        fixtureLink === null
          ? gameUrl
          : `${SITE_ORIGIN}/r/${await signResponseToken(
              { playerId: recipient.playerId, fixtureId: fixtureLink.fixtureId, expiresAt: fixtureLink.expiresAt },
              responseTokenSecret,
            )}`;
      pending.push({
        logId: crypto.randomUUID(),
        dedupeKey: pushKey(dedupeKey),
        playerId: recipient.playerId,
        message: {
          channel: "push",
          to: recipient.playerId,
          title: copy.title,
          body: copy.body,
          url,
          // Overrides `PUSH_COPY.n10`'s own game-name-and-subject tag, which
          // two broadcasts of the same wording on the same game would share —
          // and the second would then replace the first in the tray unseen.
          tag: `n10:${broadcastId}`,
          dedupeKey: pushKey(dedupeKey),
        },
      });
    }
  }

  if (pending.length === 0) return nothingSent(skipped);

  const inserted = await insertQueuedLogRows(db, { fixtureId: scopedFixtureId, notificationType: "n10" }, pending);
  if (inserted.length === 0) return nothingSent(skipped);

  let results;
  try {
    results = await notifier.send(inserted.map((entry) => entry.message));
  } catch (error) {
    // The notifier rejected — e.g. `QuotaNotifier.reserve()` hitting a D1
    // error mid-batch. Whether any message reached a provider first is
    // unknowable from here, so every row this batch inserted is left `failed`
    // (ambiguous, never retried), as `send-teams.ts` and the sweep both do.
    const reason = error instanceof Error ? error.message : String(error);
    for (const entry of inserted) {
      await db
        .update(notificationLog)
        .set({ status: "failed", error: reason })
        .where(eq(notificationLog.id, entry.logId));
    }
    const emailCount = inserted.filter((entry) => entry.message.channel === "email").length;
    return {
      ...nothingSent(skipped),
      failed: emailCount,
      pushFailed: inserted.length - emailCount,
    };
  }

  // `results` and `inserted` are the same length in the same order (the
  // `Notifier` contract), so pairing by index never drifts. The loop writes
  // one row at a time and can abort part-way; `markOrphanedRowsFailed` closes
  // the hole that would otherwise leave rows `queued` forever.
  let sent = 0;
  let failed = 0;
  let deferred = 0;
  let pushSent = 0;
  let pushFailed = 0;
  const deferredPlayerIds: string[] = [];
  let applied = 0;
  try {
    for (; applied < inserted.length; applied++) {
      const entry = inserted[applied];
      const result = results[applied];
      if (!entry) continue;
      const outcome = await applySendResult(db, entry, result, now);
      const isEmail = entry.message.channel === "email";
      if (outcome.kind === "sent") {
        if (isEmail) sent++;
        else pushSent++;
      } else if (outcome.kind === "deferred") {
        // Only the email leg has a daily ceiling, so a push landing here is
        // folded into `pushFailed`: `deferred` is documented as an email
        // figure and is what the route reports to the organiser.
        if (isEmail) {
          deferred++;
          deferredPlayerIds.push(entry.playerId);
        } else {
          pushFailed++;
        }
      } else if (isEmail) {
        failed++;
      } else {
        pushFailed++;
      }
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const orphaned = inserted.slice(applied);
    for (const entry of orphaned) {
      if (entry.message.channel === "email") failed++;
      else pushFailed++;
    }
    await markOrphanedRowsFailed(db, orphaned, `abandoned mid-apply: ${reason}`);
  }

  return { sent, failed, deferred, deferredPlayerIds, pushSent, pushFailed, skipped };
}

/**
 * Everyone the audience names, before any addressability rule is applied.
 *
 * `everyone` is game-scoped and resolved from `memberships`; the other four
 * read `responses.status` through `audienceSelectsStatus`, which is where a
 * status this build cannot name is excluded rather than defaulted into an
 * audience.
 *
 * Both underlying queries drop auto-declining members (M28), so this send and
 * the count the compose page showed the organiser cannot disagree.
 */
async function selectRecipients(
  db: Db,
  params: { gameId: string; fixtureId: string | null; audience: BroadcastAudience; now: Date },
): Promise<BroadcastRecipient[]> {
  if (params.audience === "everyone") return listGameRecipients(db, params.gameId, params.now);
  if (params.fixtureId === null) {
    // A fixture-scoped audience with no fixture selects nobody. Unreachable
    // through the routes — the game-scoped form forces `everyone` — but a
    // silent empty send is worth a greppable line if it ever happens.
    console.error(`sendBroadcast: audience "${params.audience}" needs a fixture, but none was given`);
    return [];
  }
  const rows = await listFixtureRecipients(db, params.gameId, params.fixtureId, params.now);
  return rows.filter((row) => audienceSelectsStatus(params.audience, row.status ?? ""));
}

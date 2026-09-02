import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { notificationLog, responses, type fixtures, type games } from "../db/schema.js";
import { occupiesSlot } from "../domain/response-status.js";
import { formatLocalDateTime } from "../domain/time/zone.js";
import { leaveTokenExpiry, responseTokenExpiry, signLeaveToken, signResponseToken } from "../domain/token.js";
import { pushKey, reminderKey } from "./dedupe-key.js";
import { playersWithPushSubscriptions, SITE_ORIGIN, type PendingNotification } from "./delivery.js";
import { PUSH_COPY } from "./push-copy.js";
import { renderReminderEmail } from "./templates/reminder.js";

/** One player an N-1 could be built for. */
export interface ReminderCandidate {
  playerId: string;
  name: string;
  email: string | null;
  isGuest: boolean;
}

/**
 * Build the N-1 messages (email, plus push for subscribed devices) for a set
 * of candidates on one fixture.
 *
 * Extracted from `src/sweep/open-and-remind.ts` when the late-join invitation
 * (BR-2′) became its second caller: a player backfilled into an already-open
 * fixture is sent exactly this message at join time, under exactly this
 * dedupe key — which is what lets the hourly sweep see the log row and not
 * send a second one.
 */
export interface ReminderMessages {
  pending: PendingNotification[];
  /**
   * Candidates for whom neither leg was built — email off (or no address)
   * and push off (or no subscription). The caller's BR-32 count: "no usable
   * address" used to be decided before this function ran, but that guard
   * could no longer say "skip" correctly once a candidate's two legs can be
   * switched independently (M37) — a guest with no address but a device must
   * still get the push. Deciding it per leg, in here, is the only place that
   * knows both.
   */
  skippedPlayerIds: string[];
}

export async function buildReminderMessages(params: {
  db: Db;
  fixture: typeof fixtures.$inferSelect;
  game: typeof games.$inferSelect;
  candidates: ReminderCandidate[];
  responseTokenSecret: string;
  now: Date;
  channels: { email: boolean; push: boolean };
}): Promise<ReminderMessages> {
  const { db, fixture, game, candidates, responseTokenSecret, now, channels } = params;

  const kicksOffAtLocal = formatLocalDateTime(fixture.kicksOffAt, game.timezone);
  const inCount = fixture.inCount;
  const spotsLeft = Math.max(0, fixture.maxPlayers - fixture.inCount);
  const expiresAt = responseTokenExpiry(fixture.kicksOffAt).getTime();

  // Only a player with at least one registered device gets a `PushMessage`
  // (M14 Task 13, spec §9.3 rule 1) — otherwise every player without a phone
  // would accumulate a `no-recipient` row per reminder, forever. Fetched
  // once for the whole fixture's candidates rather than per player.
  const subscribed = await playersWithPushSubscriptions(
    db,
    candidates.map((candidate) => candidate.playerId),
  );

  const alreadyIn = await playersAlreadyToldTheyAreIn(db, fixture.id);
  const holdingASlot = await playersHoldingASlot(db, fixture.id);

  const pending: PendingNotification[] = [];
  const skippedPlayerIds: string[] = [];
  for (const candidate of candidates) {
    // The N-1 asks "can you play?". A player who has been told they are in
    // has already been given the answer, and asking anyway contradicts the
    // message they are still looking at.
    //
    // **Here, rather than in the sweep that found this.** Two senders build
    // the N-1 and each picks its own audience, so a guard at one call site is
    // a guard the other does not have — which is exactly how this arrived:
    // M43 made `claimInviteReleases` return the promoted and the newly
    // invited as disjoint lists, and the sweep then re-derived its audience
    // from `invited_at` and mailed a player it had promoted four seconds
    // earlier.
    //
    // Keyed on the log row, not on `status === "in"`, and that distinction is
    // load-bearing in two directions. A ceiling refusal *deletes* the N-2's
    // row (`applySendResult`), so a player who was promoted but never
    // actually told has no row here and still gets the N-1 — which is the
    // right outcome, and the one a status check would get wrong. And an early
    // volunteer who is `in` without ever having been promoted keeps receiving
    // the reminder exactly as they always have, in gated and ungated Games
    // alike; narrowing that is a separate product question, not this fix.
    if (alreadyIn.has(candidate.playerId)) continue;

    const token = await signResponseToken(
      { playerId: candidate.playerId, fixtureId: fixture.id, expiresAt },
      responseTokenSecret,
    );

    // A leave token, not the response token above: leaving is scoped to the
    // Game, not this one Fixture, and it must keep working long after this
    // reminder's response token has expired (BR-22, §2.2).
    const leaveToken = await signLeaveToken(
      { gameId: fixture.gameId, playerId: candidate.playerId, expiresAt: leaveTokenExpiry(now).getTime() },
      responseTokenSecret,
    );

    const respondInUrl = `${SITE_ORIGIN}/r/${token}?intent=in`;
    // Built unconditionally: it is the push copy's input as well as the
    // email's, and which leg(s) actually get sent is decided independently,
    // below.
    const emailPayload = {
      playerName: candidate.name,
      gameName: game.name,
      venueName: fixture.venueOverride ?? game.venueName,
      kicksOffAtLocal,
      inCount,
      spotsLeft,
      respondInUrl,
      respondOutUrl: `${SITE_ORIGIN}/r/${token}?intent=out`,
      leaveUrl: `${SITE_ORIGIN}/leave/${leaveToken}`,
      // M45. Read here rather than carried on `ReminderCandidate`: two senders
      // build this message and pick their own candidates, so a field they each
      // had to populate is a field one of them would eventually populate
      // wrongly — which is exactly how the N-1 came to contradict the N-2.
      confirmed: holdingASlot.has(candidate.playerId),
    };

    const dedupeKey = reminderKey(fixture.id, candidate.playerId);
    let builtSomething = false;

    // BR-32 (M37): "no usable address" is decided per leg, here, rather than
    // by the caller before this function runs — the caller can no longer say
    // in advance that a candidate should be skipped altogether, since a guest
    // with no address but a registered device must still get the push when
    // the email leg alone is off. The `.trim()` is load-bearing, not
    // defensive tidying: a `players.email` of `" "` is truthy, so without it
    // a blank address would pass this guard, get a token signed and a
    // `queued` row inserted, then be trimmed to empty inside `QuotaNotifier`
    // and come back `NO_RECIPIENT_REASON` — which the sweep treats as
    // retryable and deletes, so the whole cycle repeats on every sweep run,
    // forever, while raising a false daily-ceiling alarm each time.
    if (channels.email && candidate.email !== null && candidate.email.trim() !== "") {
      const rendered = renderReminderEmail(emailPayload);
      pending.push({
        logId: crypto.randomUUID(),
        dedupeKey,
        playerId: candidate.playerId,
        message: {
          channel: "email",
          to: candidate.email,
          subject: rendered.subject,
          html: rendered.html,
          text: rendered.text,
          dedupeKey,
        },
      });
      builtSomething = true;
    }

    if (channels.push && subscribed.has(candidate.playerId)) {
      const copy = PUSH_COPY.n1(emailPayload);
      pending.push({
        logId: crypto.randomUUID(),
        dedupeKey: pushKey(dedupeKey),
        playerId: candidate.playerId,
        message: {
          channel: "push",
          to: candidate.playerId,
          title: copy.title,
          body: copy.body,
          url: respondInUrl,
          // Sharpened from `PUSH_COPY`'s gameName+kickoff approximation
          // (Task 9) to the real fixture id, now that this caller holds one
          // (Task 13).
          tag: `n1:${fixture.id}`,
          dedupeKey: pushKey(dedupeKey),
        },
      });
      builtSomething = true;
    }

    if (!builtSomething) skippedPlayerIds.push(candidate.playerId);
  }
  return { pending, skippedPlayerIds };
}

/**
 * Players already told they hold a slot on this fixture — anyone with an `n2`
 * row for it (BR-7's promotion, or BR-40a's release off the waitlist).
 *
 * Any channel, unlike `existingReminderLog`'s deliberate `email` filter. The
 * question here is "have they been told they are in", and a push that told
 * them counts; there is no retry to mask, because nothing re-sends an N-2.
 */
async function playersAlreadyToldTheyAreIn(db: Db, fixtureId: string): Promise<Set<string>> {
  const rows = await db
    .select({ playerId: notificationLog.playerId })
    .from(notificationLog)
    .where(
      and(eq(notificationLog.fixtureId, fixtureId), eq(notificationLog.notificationType, "n2")),
    );
  return new Set(rows.map((row) => row.playerId));
}

/**
 * Players who already hold a slot on this fixture — `status === "in"` (M45).
 *
 * `occupiesSlot` rather than a literal comparison, so this and the capacity
 * object cannot come to disagree about what holding a slot means. A
 * `waitlisted` player is deliberately not here: they said they were in but do
 * not have a place, so "You're in." would be false for them and the asking
 * copy is the honest one.
 */
async function playersHoldingASlot(db: Db, fixtureId: string): Promise<Set<string>> {
  const rows = await db
    .select({ playerId: responses.playerId, status: responses.status })
    .from(responses)
    .where(eq(responses.fixtureId, fixtureId));

  return new Set(rows.filter((row) => occupiesSlot(row.status)).map((row) => row.playerId));
}

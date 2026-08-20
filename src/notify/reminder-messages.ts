import type { Db } from "../db/client.js";
import type { fixtures, games } from "../db/schema.js";
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
export async function buildReminderMessages(params: {
  db: Db;
  fixture: typeof fixtures.$inferSelect;
  game: typeof games.$inferSelect;
  candidates: ReminderCandidate[];
  responseTokenSecret: string;
  now: Date;
}): Promise<PendingNotification[]> {
  const { db, fixture, game, candidates, responseTokenSecret, now } = params;

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

  const pending: PendingNotification[] = [];
  for (const candidate of candidates) {
    // Filtered by the caller, but narrowed again here so the compiler — not
    // just the runtime check — refuses to let a null email reach `Message.to`.
    const email = candidate.email;
    if (!email) continue;

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
    };
    const rendered = renderReminderEmail(emailPayload);

    const dedupeKey = reminderKey(fixture.id, candidate.playerId);
    pending.push({
      logId: crypto.randomUUID(),
      dedupeKey,
      playerId: candidate.playerId,
      message: {
        channel: "email",
        to: email,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        dedupeKey,
      },
    });

    if (subscribed.has(candidate.playerId)) {
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
    }
  }
  return pending;
}

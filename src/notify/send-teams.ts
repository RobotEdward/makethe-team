import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { getFixtureWithSquad } from "../db/queries.js";
import { notificationLog, players, responses } from "../db/schema.js";
import { displayName } from "../domain/display-name.js";
import { squadForViewer } from "../domain/squad-visibility.js";
import { formatLocalDateTime } from "../domain/time/zone.js";
import { leaveTokenExpiry, signLeaveToken } from "../domain/token.js";
import { TEAM_IDS, isTeamId, teamNames } from "../domain/teams.js";
import { pushKey, teamsKey } from "./dedupe-key.js";
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
import { renderTeamsEmail } from "./templates/teams.js";

/**
 * What one publish's worth of N-9 sends did, in aggregate.
 *
 * `sent`/`failed`/`deferred` are **email only** — `src/routes/games.ts`'s
 * `publishTeams` logs these as an email count (`"teams email (N-9) failed
 * for N player(s)"`), the same reasoning `CancellationSendSummary.sent`'s
 * doc comment gives at length: folding a push row into these would inflate
 * what is reported as an email figure, and the push leg has no daily
 * ceiling so it can never legitimately produce `deferred` at all. See
 * `pushSent`/`pushFailed` for the push leg's own counts.
 */
export interface TeamsSendResult {
  sent: number;
  failed: number;
  deferred: number;
  /**
   * Exactly who those deferrals were for, carried out of here rather than
   * left as a bare count — the same shape `CancellationSendSummary` uses, for
   * the same reason. A ceiling refusal *deletes* its `notification_log` row
   * (`applySendResult`), so these player ids are the only remaining evidence
   * that somebody was never told which side they are on, and the publish
   * route writes them into `audit_log`
   * (`fixture.teams_email_deferred`). "How many" does not answer "which of my
   * squad turns up not knowing".
   */
  deferredPlayerIds: string[];
  /** The push leg's own `sent` count — informational only, never folded into `sent` above. */
  pushSent: number;
  /** The push leg's own `failed` count — informational only, never folded into `failed` above. Also where a push `deferred` outcome lands, since the push leg can't legitimately produce one. */
  pushFailed: number;
  /** BR-32: guests, and anyone with no usable address. Not a log row (see the guard below). */
  guestsSkipped: number;
}

export interface SendTeamsEmailsParams {
  db: Db;
  /** Always the quota-wrapped notifier from `createNotifier` — never a raw provider. */
  notifier: Notifier;
  fixtureId: string;
  /**
   * The instant this publish happened. Part of the dedupe key (`teamsKey`),
   * and echoed into every recipient's row unmodified — never re-derived per
   * player, or a single publish would mint a different key for each of them.
   */
  publishedAt: Date;
  /** The request's `now`. Used for `sent_at` and the leave token's expiry. */
  now: Date;
  responseTokenSecret: string;
}

/**
 * Tell the whole squad an organiser has just published a team pick for a
 * fixture (N-9, BR-35).
 *
 * **Every `in` player with a usable address, once per publish.** Unlike N-2
 * (one recipient) this is closer in shape to the reminder sweep: one batch of
 * messages, inserted, sent and applied together, following exactly the same
 * ordering as `insertQueuedLogRows` / `applySendResult` (§2.4, BR-19) — the
 * `queued` row lands first, the send happens second, the outcome is recorded
 * third, and a crash mid-apply is closed the same way the sweep closes it:
 * `markOrphanedRowsFailed` marks whatever `applySendResult` never reached
 * `failed` rather than leaving it `queued` forever, which the next publish's
 * dedupe key (`publishedAt` again) would not even see as "already handled",
 * since a genuinely new publish always has a genuinely new key.
 *
 * **Every recipient already has a side.** The publish route this sender is
 * called from (a later task) refuses to publish while `unassignedIn` from
 * `src/domain/teams.ts` is non-empty, so every `in` player reaching this
 * function has a `team`. This is not re-checked here — re-deriving that
 * invariant per player would be a second copy of the publish guard's rule,
 * which is exactly the kind of drift `src/domain/teams.ts`'s module comment
 * warns about.
 *
 * **BR-33 is applied here, once.** `squadForViewer` decides whether the
 * *other* players are visible — as a non-owner, since this message is the
 * player-facing announcement regardless of which recipient happens to also
 * be an owner. A `null` back from it means `lineUps` is `null` for every
 * recipient in this send; the recipient's own side is read from their own
 * squad row, never from the (possibly hidden) list, so it is never affected
 * by that decision.
 */
export async function sendTeamsEmails(params: SendTeamsEmailsParams): Promise<TeamsSendResult> {
  const { db, notifier, fixtureId, publishedAt, now, responseTokenSecret } = params;

  const withSquad = await getFixtureWithSquad(db, fixtureId);
  if (withSquad === null) {
    // Unreachable in practice: the publish route that calls this has just
    // loaded and updated this same fixture inside the same request. Reported
    // loudly rather than thrown — this typically runs inside
    // `c.executionCtx.waitUntil`, after the organiser's own response has
    // already been sent, so there is no caller left to hand a rejection to.
    console.error(`sendTeamsEmails: fixture ${fixtureId} not found`);
    return { sent: 0, failed: 0, deferred: 0, deferredPlayerIds: [], pushSent: 0, pushFailed: 0, guestsSkipped: 0 };
  }
  const { fixture, game, squad } = withSquad;

  const inStatusSquad = squad.filter((member) => member.status === "in");
  // `isTeamId`, not `!== null`: `responses.team` is a bare `text` column with
  // no CHECK constraint, so a row can hold a side this build cannot name, and
  // `names[team]` below would then put a literal "undefined" into the one
  // sentence this email exists to deliver. A player whose side cannot be read
  // is in exactly the position the unassigned check below already covers —
  // there is nothing truthful to tell them — so they fall into the same count
  // and the same loud log rather than into a broken email.
  const inSquad = inStatusSquad.filter((member) => isTeamId(member.team));
  const unassignedCount = inStatusSquad.length - inSquad.length;
  if (unassignedCount > 0) {
    // Should be unreachable: the publish route refuses to publish while
    // `unassignedIn` (`src/domain/teams.ts`) is non-empty, so nothing here
    // re-derives that rule. But if it is ever broken — a bug in the guard, or
    // a later caller that bypasses it — the affected player would otherwise
    // simply get no email with no trace anywhere. This turns that silent gap
    // into a greppable one, the same way the `fixture-not-found` branch above
    // is reported rather than swallowed.
    console.error(`sendTeamsEmails: fixture ${fixtureId} has ${unassignedCount} in player(s) with no side`);
  }

  const names = teamNames(game);
  const visibleSquad = squadForViewer(game, inSquad, { isOwner: false });
  const lineUps =
    visibleSquad === null
      ? null
      : TEAM_IDS.map((id) => ({
          name: names[id],
          players: visibleSquad
            .filter((member) => member.team === id)
            .map((member) => `${displayName(member.name, member.erasedAt)}${member.isGuest ? " (guest)" : ""}`),
        }));

  // `SquadMember` carries no email, so it is fetched separately — but as a
  // join on `responses.fixture_id`, not as a second lookup keyed by an
  // `IN (...)` list of player ids. `src/db/chunk.ts` documents D1's 100
  // bound-parameter ceiling, and `MAX_PLAYERS_CEILING` in
  // `src/domain/game-form.ts` allows a squad of up to 200, so an `IN` list
  // built from `inSquad` can legitimately exceed it — a first version of this
  // function did exactly that, and would have thrown before any row was
  // written, inside `waitUntil`, for the largest games with the most people
  // to disappoint. This mirrors `eligiblePlayers` in
  // `src/sweep/open-and-remind.ts`, which solves the identical problem for
  // N-1 the same way: join `responses` to `players` and read `email` off the
  // join, so the query's parameter count is fixed regardless of squad size.
  const emailRows = await db
    .select({ playerId: responses.playerId, email: players.email })
    .from(responses)
    .innerJoin(players, eq(responses.playerId, players.id))
    .where(and(eq(responses.fixtureId, fixtureId), eq(responses.status, "in")));
  const emailByPlayerId = new Map(emailRows.map((row) => [row.playerId, row.email]));

  const whenLocal = formatLocalDateTime(fixture.kicksOffAt, game.timezone);
  const venueName = fixture.venueOverride ?? game.venueName;
  const publishedAtIso = publishedAt.toISOString();

  // Only a player with at least one registered device gets a `PushMessage`
  // (M14 Task 13, spec §9.3 rule 1) — otherwise every player without a phone
  // would accumulate a `no-recipient` row per publish, forever. Fetched once
  // for the whole squad rather than per recipient.
  const subscribed = await playersWithPushSubscriptions(
    db,
    inSquad.map((member) => member.playerId),
  );

  let guestsSkipped = 0;
  const pending: PendingNotification[] = [];

  for (const member of inSquad) {
    // BR-32: a guest, or anyone whose address is missing or blank, is skipped
    // before a message is built and before anything is written. The
    // `.trim()` matches `send-welcome.ts` and `send-promotion.ts` exactly,
    // and is load-bearing for the same reason: an email of `" "` is truthy,
    // and letting it through would produce a `queued` row and a
    // `no-recipient` result that nothing usefully acts on.
    const email = emailByPlayerId.get(member.playerId)?.trim() ?? "";
    if (member.isGuest || email === "") {
      guestsSkipped++;
      continue;
    }

    // A leave token, scoped to the Game rather than to this Fixture — same
    // reasoning as every other game-scoped notification (BR-22, §2.2).
    const leaveToken = await signLeaveToken(
      { gameId: game.id, playerId: member.playerId, expiresAt: leaveTokenExpiry(now).getTime() },
      responseTokenSecret,
    );
    const leaveUrl = `${SITE_ORIGIN}/leave/${leaveToken}`;

    // A recognised side by the `inSquad` filter above, which is what makes
    // `names[team]` below total rather than merely type-checked.
    const team = member.team!;

    const emailPayload = {
      playerName: member.name,
      gameName: game.name,
      venueName,
      whenLocal,
      yourSideName: names[team],
      lineUps,
      leaveUrl,
    };
    const rendered = renderTeamsEmail(emailPayload);

    const dedupeKey = teamsKey(fixtureId, member.playerId, publishedAtIso);
    pending.push({
      logId: crypto.randomUUID(),
      dedupeKey,
      playerId: member.playerId,
      message: {
        channel: "email",
        to: email,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        dedupeKey,
      },
    });

    if (subscribed.has(member.playerId)) {
      const copy = PUSH_COPY.n9(emailPayload);
      pending.push({
        logId: crypto.randomUUID(),
        dedupeKey: pushKey(dedupeKey),
        playerId: member.playerId,
        message: {
          channel: "push",
          to: member.playerId,
          title: copy.title,
          body: copy.body,
          // `leaveUrl` is the only per-player URL this caller builds — there
          // is no non-token page showing the recipient's own side today
          // (BR-33 may hide the rest of the squad even from an authenticated
          // viewer). Reusing it at least lands on a page that names the
          // fixture, same as every other caller reusing its one token link.
          url: leaveUrl,
          // Sharpened from `PUSH_COPY`'s gameName+kickoff approximation
          // (Task 9) to the real fixture id (Task 13). Two teams-published
          // pushes about the same fixture collapse in the tray; a
          // re-publish after a late drop-out is a genuinely new fixture
          // state but still the same fixture id, so it also collapses —
          // consistent with the email side, where a re-publish is a new
          // `dedupeKey` (via `publishedAt`) but still describes "the
          // current teams for this fixture", which is what the tray should
          // show once, not stack.
          tag: `n9:${fixtureId}`,
          dedupeKey: pushKey(dedupeKey),
        },
      });
    }
  }

  const empty = { sent: 0, failed: 0, deferred: 0, deferredPlayerIds: [], pushSent: 0, pushFailed: 0, guestsSkipped };
  if (pending.length === 0) return empty;

  const inserted = await insertQueuedLogRows(db, { fixtureId, notificationType: "n9" }, pending);
  if (inserted.length === 0) return empty;

  let results;
  try {
    results = await notifier.send(inserted.map((entry) => entry.message));
  } catch (error) {
    // The notifier rejected — e.g. `QuotaNotifier.reserve()` hitting a D1
    // error mid-batch. Whether any message in this batch reached a provider
    // first is unknowable from here, so every row this batch inserted is left
    // `failed` (ambiguous, never retried), exactly as the sweep and
    // `send-promotion.ts` do with the same situation.
    const reason = error instanceof Error ? error.message : String(error);
    for (const entry of inserted) {
      await db
        .update(notificationLog)
        .set({ status: "failed", error: reason })
        .where(eq(notificationLog.id, entry.logId));
    }
    // Split by channel — see `TeamsSendResult.sent`'s doc comment for why
    // `failed` must count only the email rows.
    const emailCount = inserted.filter((entry) => entry.message.channel === "email").length;
    return {
      sent: 0,
      failed: emailCount,
      deferred: 0,
      deferredPlayerIds: [],
      pushSent: 0,
      pushFailed: inserted.length - emailCount,
      guestsSkipped,
    };
  }

  // `results` and `inserted` are the same length, in the same order — the
  // Notifier contract (`src/notify/notifier.ts`) — so pairing by index never
  // drifts. The loop writes one row at a time and can abort part-way through;
  // `markOrphanedRowsFailed` closes the hole an aborted loop would otherwise
  // leave, exactly as `sendDueReminders` does for N-1.
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
        // The push leg has no daily ceiling, so this can only legitimately
        // happen for the email row — a push landing here regardless is
        // folded into `pushFailed` rather than `deferred`, which is
        // documented as email-only and drives the publish-deferral audit
        // row.
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
    const message = error instanceof Error ? error.message : String(error);
    const orphaned = inserted.slice(applied);
    for (const entry of orphaned) {
      if (entry.message.channel === "email") failed++;
      else pushFailed++;
    }
    await markOrphanedRowsFailed(db, orphaned, `abandoned mid-apply: ${message}`);
  }

  return { sent, failed, deferred, deferredPlayerIds, pushSent, pushFailed, guestsSkipped };
}

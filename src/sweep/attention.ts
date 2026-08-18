import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { getFixtureWithSquad } from "../db/queries.js";
import { fixtures, games, memberships, notificationLog, players } from "../db/schema.js";
import { fixtureView } from "../domain/fixture-view.js";
import { formatLocalDateTime } from "../domain/time/zone.js";
import { cancelTokenExpiry, signCancelToken } from "../domain/token.js";
import { CEILING_DEFERRAL_COLLAPSE_WINDOW_MS, recordCeilingDeferral } from "../notify/ceiling-audit.js";
import { attentionKey, pushKey } from "../notify/dedupe-key.js";
import {
  applySendResult,
  insertQueuedLogRows,
  markOrphanedRowsFailed,
  playersWithPushSubscriptions,
  SITE_ORIGIN,
  type PendingNotification,
} from "../notify/delivery.js";
import type { Notifier } from "../notify/notifier.js";
import { PUSH_COPY } from "../notify/push-copy.js";
import { renderAttentionEmail, type AttentionProblem } from "../notify/templates/attention.js";

/** One fixture the attention step could not fully process, and why. */
export interface AttentionFailure {
  fixtureId: string;
  gameId: string | null;
  stage: "prepare" | "send" | "apply";
  message: string;
}

export interface AttentionResult {
  /** Fixtures `fixtureView` said need their owner's attention on this run. */
  fixturesNeedingAttention: number;
  /**
   * **Email only.** `src/cron/handler.ts` logs this as an email count on a
   * failed run, the same reasoning `CancellationSendSummary.sent`'s doc
   * comment gives at length: folding a push row in here would report an
   * inflated number of emails sent. See `pushAttentionSent` for the push
   * leg's own count.
   */
  attentionSent: number;
  /** Email only — see `attentionSent`. See `pushAttentionFailed` for the push leg's own count. */
  attentionFailed: number;
  /**
   * Refused by the daily send ceiling (TR-31) and *only* that — never mixed
   * with any other reason, so the handler's warning names the condition it is
   * actually reporting. The `notification_log` row is removed, so the next
   * sweep run retries it; an `audit_log` row records that it happened at all.
   * Email only — the push leg has no daily ceiling and can never produce
   * this outcome.
   */
  attentionDeferred: number;
  /** The push leg's own `sent` count — informational only, never folded into `attentionSent`. */
  pushAttentionSent: number;
  /** The push leg's own `failed` count — informational only, never folded into `attentionFailed`. Also where a push `deferred` outcome lands, since the push leg can't legitimately produce one. */
  pushAttentionFailed: number;
  /** Owners with no usable address, or who are guests. Permanent, not a failure, no log row (BR-32). */
  ownersSkippedNoRecipient: number;
  /** Owners who already have an `n4` row for this fixture — told once, ever (BR-31). */
  alreadyLogged: number;
  failures: AttentionFailure[];
}

export interface SendOwnerAttentionParams {
  db: Db;
  /** Always the quota-wrapped notifier from `createNotifier` — never a raw provider. */
  notifier: Notifier;
  now: Date;
  /** `CANCEL_TOKEN_SECRET`. Absent at runtime makes `signCancelToken` throw by name; see below. */
  cancelTokenSecret: string;
  /**
   * Whether the daily send ceiling is refusing messages right now (TR-31).
   * Decided by the caller — `handleScheduled` knows both whether this run's
   * reminders were deferred and whether `MAX_EMAILS_PER_DAY` failed closed to
   * zero — because neither fact is this module's to discover.
   */
  ceilingReached: boolean;
}

const MINUTE_MS = 60_000;

interface AttentionCandidate {
  fixtureId: string;
  gameId: string;
  problem: AttentionProblem;
}

interface OwnerRecipient {
  playerId: string;
  name: string;
  email: string;
}

/**
 * Sweep step 3 (§2.4, BR-31, J5): tell the Owner, once, that a Fixture of
 * theirs needs their attention — and give them enough to act on it before
 * kickoff. This is what makes SC-4 true.
 *
 * **The condition is not decided here.** `fixtureView(facts, now)` already
 * computes `needsOwnerAttention` — inside the warning window *and* either
 * `short` or flagged `uneven` — and every renderer in the product uses the
 * same function. Re-deriving the rule here is how the owner's email and the
 * fixture page start disagreeing about whether there is a problem, so this
 * module reads the flag and never reconstructs it. The only thing derived
 * from the view here is *which* of the two problems to describe, which is a
 * copy decision, not a judgement about the fixture.
 *
 * **Evaluated on every run, sent once ever.** BR-31 wants the first moment
 * the condition holds, not a fixed instant: a late dropout leaving an odd
 * number six hours before kickoff still triggers it, even though the fixture
 * looked fine when the window opened. That is why this runs every sweep tick
 * and why the dedupe key — `attentionKey(fixtureId, playerId)` — carries **no
 * timestamp**, unlike N-2's. Short, then fixed, then uneven is one email, not
 * two, and the unique index on `notification_log.dedupe_key` is the actual
 * guarantee, not the pre-check below (which exists only to avoid signing a
 * token and rendering an email that would immediately be discarded).
 *
 * Every fixture is processed in its own `try`: one bad Game must not silence
 * every other Game's owner, and — since this runs before retirement — must
 * not stop fixtures being retired either. Nothing here throws for an ordinary
 * failure; failures come back in `failures` for the handler to log and count.
 */
export async function sendOwnerAttention(params: SendOwnerAttentionParams): Promise<AttentionResult> {
  const { db, notifier, now, cancelTokenSecret, ceilingReached } = params;

  const result: AttentionResult = {
    fixturesNeedingAttention: 0,
    attentionSent: 0,
    attentionFailed: 0,
    attentionDeferred: 0,
    pushAttentionSent: 0,
    pushAttentionFailed: 0,
    ownersSkippedNoRecipient: 0,
    alreadyLogged: 0,
    failures: [],
  };

  for (const candidate of await fixturesNeedingAttention(db, now)) {
    result.fixturesNeedingAttention++;
    try {
      await processFixture({ db, notifier, now, cancelTokenSecret, ceilingReached }, candidate, result);
    } catch (error) {
      result.failures.push({
        fixtureId: candidate.fixtureId,
        gameId: candidate.gameId,
        stage: "prepare",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}

/**
 * Every `open` fixture whose Owner needs telling, with the problem to
 * describe.
 *
 * A fixture that has already ended is skipped on the identical boundary
 * `retirePastFixtures` and `fixturesDueByLifecycle` use
 * (`kicksOffAt + durationMinutes <= now`), so a cron backlog cannot make this
 * step email an owner about a game that finished days ago and is about to be
 * retired by the very same tick.
 *
 * Read-only, and never touches the Durable Object: deciding *which* fixtures
 * need attention changes no capacity (TR-11).
 */
async function fixturesNeedingAttention(db: Db, now: Date): Promise<AttentionCandidate[]> {
  const rows = await db
    .select({
      id: fixtures.id,
      gameId: fixtures.gameId,
      kicksOffAt: fixtures.kicksOffAt,
      durationMinutes: fixtures.durationMinutes,
      lifecycle: fixtures.lifecycle,
      inCount: fixtures.inCount,
      minPlayers: fixtures.minPlayers,
      maxPlayers: fixtures.maxPlayers,
      prefersEvenNumbers: fixtures.prefersEvenNumbers,
      shortWarningOffsetHours: fixtures.shortWarningOffsetHours,
    })
    .from(fixtures)
    .innerJoin(games, eq(fixtures.gameId, games.id))
    .where(eq(fixtures.lifecycle, "open"));

  const candidates: AttentionCandidate[] = [];
  for (const row of rows) {
    if (row.kicksOffAt.getTime() + row.durationMinutes * MINUTE_MS <= now.getTime()) continue;

    // The whole of the decision, made in one place for the whole product.
    const view = fixtureView(row, now);
    if (!view.needsOwnerAttention) continue;

    // Which of the two problems to describe follows from the view's own
    // verdict: `short` dominates parity (BR-30), so a `short` status is
    // reported as short even if the count also happens to be odd, and the
    // `uneven` branch is reachable only when the view flagged it.
    const problem: AttentionProblem =
      view.status === "short"
        ? { kind: "short", inCount: row.inCount, minPlayers: row.minPlayers }
        : { kind: "uneven", inCount: row.inCount };

    candidates.push({ fixtureId: row.id, gameId: row.gameId, problem });
  }

  return candidates;
}

/** One fixture's worth of work, in its own `try` at the call site. */
async function processFixture(
  params: SendOwnerAttentionParams,
  candidate: AttentionCandidate,
  result: AttentionResult,
): Promise<void> {
  const { db, notifier, now, cancelTokenSecret, ceilingReached } = params;
  const { fixtureId, gameId, problem } = candidate;

  const loaded = await getFixtureWithSquad(db, fixtureId);
  if (!loaded) return;
  const { fixture, game, squad } = loaded;

  const { owners, skippedNoRecipient } = await activeOwners(db, gameId);
  result.ownersSkippedNoRecipient += skippedNoRecipient;
  if (owners.length === 0) return;

  const alreadyLogged = await ownersAlreadyTold(db, fixtureId);

  const kicksOffAtLocal = formatLocalDateTime(fixture.kicksOffAt, game.timezone);
  const inPlayers = squad.filter((member) => member.status === "in").map((member) => member.name);
  const nonResponders = squad.filter((member) => member.status === "pending").map((member) => member.name);
  const expiresAt = cancelTokenExpiry(fixture.kicksOffAt).getTime();

  // Only an owner with at least one registered device gets a `PushMessage`
  // (M14 Task 13, spec §9.3 rule 1) — otherwise every owner without a phone
  // would accumulate a `no-recipient` row on every sweep tick this fixture
  // keeps needing attention, forever.
  const subscribed = await playersWithPushSubscriptions(
    db,
    owners.map((owner) => owner.playerId),
  );

  const pending: PendingNotification[] = [];
  for (const owner of owners) {
    if (alreadyLogged.has(owner.playerId)) {
      result.alreadyLogged++;
      continue;
    }

    // Signing throws by name when `CANCEL_TOKEN_SECRET` is unset — which it
    // currently is in production. That throw propagates to the per-fixture
    // `catch` in `sendOwnerAttention`, where it becomes one `AttentionFailure`
    // carrying the binding's name, logged by `handleScheduled` and greppable
    // in Workers Logs. It is deliberately not caught closer: an attention
    // email with no cancel link is not this email, and half-sending it would
    // hide the misconfiguration behind a message that looked fine.
    const token = await signCancelToken(
      { ownerPlayerId: owner.playerId, fixtureId, expiresAt },
      cancelTokenSecret,
    );

    const cancelUrl = `${SITE_ORIGIN}/cancel/${token}`;
    const emailPayload = {
      ownerName: owner.name,
      gameName: game.name,
      venueName: fixture.venueOverride ?? game.venueName,
      // The single permitted place cross-zone formatting happens (TR-20).
      kicksOffAtLocal,
      problem,
      inPlayers,
      nonResponders,
      // Every URL is server-constructed, from `SITE_ORIGIN` and a token this
      // function just signed.
      cancelUrl,
      ceilingReached,
    };
    const rendered = renderAttentionEmail(emailPayload);

    const dedupeKey = attentionKey(fixtureId, owner.playerId);
    pending.push({
      logId: crypto.randomUUID(),
      dedupeKey,
      playerId: owner.playerId,
      message: {
        channel: "email",
        to: owner.email,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        dedupeKey,
      },
    });

    if (subscribed.has(owner.playerId)) {
      const copy = PUSH_COPY.n4(emailPayload);
      pending.push({
        logId: crypto.randomUUID(),
        dedupeKey: pushKey(dedupeKey),
        playerId: owner.playerId,
        message: {
          channel: "push",
          to: owner.playerId,
          title: copy.title,
          body: copy.body,
          url: cancelUrl,
          // Sharpened from `PUSH_COPY`'s gameName+kickoff approximation
          // (Task 9) to the real fixture id, now that this caller holds one
          // (Task 13).
          tag: `n4:${fixtureId}`,
          dedupeKey: pushKey(dedupeKey),
        },
      });
    }
  }

  if (pending.length === 0) return;

  const inserted = await insertQueuedLogRows(db, { fixtureId, notificationType: "n4" }, pending);
  result.alreadyLogged += pending.length - inserted.length;
  if (inserted.length === 0) return;

  let results;
  try {
    results = await notifier.send(inserted.map((entry) => entry.message));
  } catch (error) {
    // The notifier itself rejected — e.g. `QuotaNotifier.reserve()` hitting a
    // D1 error. Whether anything reached a provider first is unknowable, so
    // every row is left `failed` (ambiguous, never retried — BR-19). Caught
    // here, per fixture, so one Game's outage does not stop the next Game's
    // owner being told, nor retirement from running afterwards.
    const message = error instanceof Error ? error.message : String(error);
    await markOrphanedRowsFailed(db, inserted, message);
    // Split by channel — see `AttentionResult.attentionSent`'s doc comment
    // for why `attentionFailed` must count only the email rows.
    for (const entry of inserted) {
      if (entry.message.channel === "email") result.attentionFailed++;
      else result.pushAttentionFailed++;
    }
    result.failures.push({ fixtureId, gameId, stage: "send", message });
    return;
  }

  const deferredPlayerIds: string[] = [];
  const sendFailureReasons: string[] = [];
  let applied = 0;
  try {
    for (; applied < inserted.length; applied++) {
      const entry = inserted[applied];
      if (!entry) continue;
      const outcome = await applySendResult(db, entry, results[applied], now);
      const isEmail = entry.message.channel === "email";
      if (outcome.kind === "sent") {
        if (isEmail) result.attentionSent++;
        else result.pushAttentionSent++;
      } else if (outcome.kind === "deferred") {
        // The push leg has no daily ceiling, so this can only legitimately
        // happen for the email row — a push landing here regardless is
        // folded into `pushAttentionFailed` rather than `attentionDeferred`,
        // which is documented as email-only.
        if (isEmail) {
          result.attentionDeferred++;
          deferredPlayerIds.push(entry.playerId);
        } else {
          result.pushAttentionFailed++;
        }
      } else if (isEmail) {
        result.attentionFailed++;
        sendFailureReasons.push(outcome.reason);
      } else {
        result.pushAttentionFailed++;
      }
    }
  } catch (error) {
    // Mid-apply abort: rows this loop never reached would otherwise stay
    // `queued`, taking their dedupe keys with them so nothing would ever tell
    // those owners, mark them failed, or count them.
    const message = error instanceof Error ? error.message : String(error);
    const orphaned = inserted.slice(applied);
    for (const entry of orphaned) {
      if (entry.message.channel === "email") result.attentionFailed++;
      else result.pushAttentionFailed++;
    }
    await markOrphanedRowsFailed(db, orphaned, `abandoned mid-apply: ${message}`);
    result.failures.push({
      fixtureId,
      gameId,
      stage: "apply",
      message: `${message} (${orphaned.length} row(s) left unapplied and marked failed)`,
    });
    return;
  }

  if (deferredPlayerIds.length > 0) {
    // TR-31's durable signal. Unlike N-2 and N-3, this one *is* retried — the
    // next sweep tick re-evaluates the fixture and the deleted row lets it
    // try again — so the row records a delay rather than a permanent loss.
    // Written anyway, because "the owner-attention email is the thing the
    // ceiling is currently eating" is precisely the fact TR-31's warning
    // exists to surface, and it cannot be surfaced by the email itself.
    await recordCeilingDeferral(db, {
      action: "fixture.attention_email_deferred",
      notificationType: "n4",
      fixtureId,
      playerIds: deferredPlayerIds,
      now,
      // N-4 retries every sweep tick, so a sustained ceiling would otherwise
      // write one row per tick, forever — see `collapseWindowMs`'s doc in
      // `src/notify/ceiling-audit.ts`.
      collapseWindowMs: CEILING_DEFERRAL_COLLAPSE_WINDOW_MS,
    });
  }

  if (sendFailureReasons.length > 0) {
    // A per-message failure is a real failure of the run, not just a counter:
    // without this, a provider outage that failed every attention email would
    // end in `handleScheduled` reporting a clean run.
    result.failures.push({
      fixtureId,
      gameId,
      stage: "send",
      message: `${sendFailureReasons.length} of ${inserted.length} attention email(s) failed to send; first reason: ${sendFailureReasons[0]}`,
    });
  }
}

/**
 * The Owners of a Game who may currently be told anything about it.
 *
 * `memberships.active` is required for the same reason `mayCancelFixture`
 * requires it: an owner removed from the squad must not be handed a fresh
 * cancel link. Guests and blank addresses are dropped here, before a token is
 * signed or a message built (BR-32) — the `.trim()` is load-bearing for the
 * reason the reminder sweep documents at length: an email of `" "` is truthy.
 *
 * Ordered deterministically so a two-owner Game produces the same batch order
 * on every run, which keeps test assertions and log lines stable.
 */
async function activeOwners(
  db: Db,
  gameId: string,
): Promise<{ owners: OwnerRecipient[]; skippedNoRecipient: number }> {
  const rows = await db
    .select({
      playerId: players.id,
      name: players.name,
      email: players.email,
      isGuest: players.isGuest,
    })
    .from(memberships)
    .innerJoin(players, eq(memberships.playerId, players.id))
    .where(
      and(eq(memberships.gameId, gameId), eq(memberships.role, "owner"), eq(memberships.active, true)),
    )
    .orderBy(asc(memberships.joinedAt), asc(memberships.id));

  const owners: OwnerRecipient[] = [];
  let skippedNoRecipient = 0;
  for (const row of rows) {
    const email = row.email?.trim() ?? "";
    if (row.isGuest || email === "") {
      skippedNoRecipient++;
      continue;
    }
    owners.push({ playerId: row.playerId, name: row.name, email });
  }
  return { owners, skippedNoRecipient };
}

/**
 * Owners who already have an `n4` row for this fixture — sent, failed or
 * `queued` (a run in flight for the same owner) all count as told.
 *
 * A pre-check, not the guarantee: the unique index on `dedupe_key` is what
 * actually makes "once per owner per fixture, ever" true against a concurrent
 * run. This exists so the common case does not sign a cancel token and render
 * an email that `onConflictDoNothing` would immediately discard.
 *
 * Filtered to `channel: "email"` — load-bearing, not tidying, for the same
 * reason `existingReminderLog` in `src/sweep/open-and-remind.ts` filters the
 * same way. The push leg has no daily ceiling, so a ceiling-deferred email's
 * `queued` row can be deleted (`applySendResult`) while that owner's push
 * row, sent independently, survives. BR-31 says "once per fixture, ever" —
 * counting a surviving push row as having told the owner would satisfy that
 * with a notification they may never have seen, and permanently suppress
 * the email this function exists to eventually get out. Do not remove this
 * filter.
 */
async function ownersAlreadyTold(db: Db, fixtureId: string): Promise<Set<string>> {
  const rows = await db
    .select({ playerId: notificationLog.playerId })
    .from(notificationLog)
    .where(
      and(
        eq(notificationLog.fixtureId, fixtureId),
        eq(notificationLog.notificationType, "n4"),
        eq(notificationLog.channel, "email"),
      ),
    );
  return new Set(rows.map((row) => row.playerId));
}

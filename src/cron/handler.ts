import { getDb, type Db } from "../db/client.js";
import { materialiseFixtures } from "../domain/materialise.js";
import type { Bindings } from "../env.js";
import { createNotifier, parseMaxEmailsPerDay } from "../notify/factory.js";
import type { Notifier } from "../notify/notifier.js";
import { sendOwnerAttention, type AttentionResult } from "../sweep/attention.js";
import { runDueErasures } from "../sweep/erasures.js";
import { openAndRemind } from "../sweep/open-and-remind.js";
import { retirePastFixtures } from "../sweep/retire.js";

// TEMPORARY TESTING CADENCE: every 5 minutes instead of hourly, so the
// reminder pipeline can be iterated on against real production data without
// waiting up to an hour per cycle. The intended production value is hourly
// ("0 * * * *"). This must stay in sync with wrangler.jsonc's `triggers`
// entry — handleScheduled throws on any cron string it doesn't recognise, so
// changing one without the other breaks every invocation. Ran at
// "*/5 * * * *" through the M4/M5 testing phase; reverted 12 August 2026.
export const CRON_SWEEP = "0 * * * *";
export const CRON_DAILY_MATERIALISE = "15 3 * * *";

/**
 * Route a cron event to its job. `now` is a parameter so tests can place the
 * run anywhere in the calendar without touching the clock.
 *
 * An unrecognised schedule throws: a typo in wrangler.jsonc that silently did
 * nothing would mean fixtures quietly stop being created.
 *
 * Materialisation failures throw too, for the same reason. Every game is
 * processed first — one broken recurrence rule must not stop the others — but
 * the invocation then ends in a rejection, so the runtime records it as failed
 * instead of a total outage reading as a clean run.
 */
export async function handleScheduled(cron: string, env: Bindings, now: Date): Promise<void> {
  switch (cron) {
    case CRON_DAILY_MATERIALISE: {
      const result = await materialiseFixtures(getDb(env.DB), now);
      console.log("materialise", JSON.stringify(result));
      for (const failure of result.failures) {
        console.error(`materialise failed for game ${failure.gameId}: ${failure.message}`);
      }
      if (result.failures.length > 0) {
        throw new Error(
          `materialise failed for ${result.failures.length} of ${result.gamesProcessed} games`,
        );
      }
      return;
    }

    case CRON_SWEEP: {
      const db = getDb(env.DB);
      const notifier = createNotifier(env, db, now);

      const remindResult = await openAndRemind(db, notifier, now, env.RESPONSE_TOKEN_SECRET);
      console.log("open-and-remind", JSON.stringify(remindResult));
      for (const failure of remindResult.failures) {
        console.error(
          `open-and-remind failed for fixture ${failure.fixtureId} (game ${failure.gameId ?? "unknown"}) at stage ${failure.stage}: ${failure.message}`,
        );
      }
      if (remindResult.remindersDeferred > 0) {
        // `remindersDeferred` counts the daily ceiling and nothing else —
        // `applyReminderResult` deliberately keeps every other reason out of
        // it, so this warning can name the real condition instead of standing
        // in for "some reminder didn't go out for some reason". (It used to
        // also cover "no usable recipient", which meant a single whitespace
        // email address raised a ceiling alarm every five minutes.)
        //
        // Not a failure: QuotaNotifier deleted the `queued` row so the next
        // sweep run retries it automatically. But it is the only signal that
        // exists today that TR-31's daily send ceiling is biting — there is
        // no owner-facing UI for it yet (that's M4) — so it is logged loudly
        // and distinctly here rather than folded into "sent"/"failed", to
        // stay greppable in Workers Logs. The real fix is an owner-visible
        // warning surfaced in the product itself once that UI exists.
        console.warn(
          `DAILY EMAIL CEILING REACHED: ${remindResult.remindersDeferred} reminder(s) deferred on this sweep run and will be retried on the next one`,
        );
      }

      // Step 3: the owner attention email (N-4, BR-31), between the reminder
      // sweep and retirement.
      //
      // Wrapped whole, on top of the per-fixture isolation `sendOwnerAttention`
      // already applies internally. That function is written not to throw for
      // an ordinary failure, but "written not to throw" is not the same as
      // "cannot throw" — a D1 error in its very first query would escape it —
      // and this project has already been bitten twice by one fixture taking
      // down a whole run (one rejecting notifier aborting a sweep, one bad
      // timezone silencing every game). Retirement runs below regardless.
      //
      // `ceilingReached` is TR-31's owner-visible warning, decided here
      // because this is the only place that knows both halves: reminders
      // deferred on *this* run, and a `MAX_EMAILS_PER_DAY` that failed closed
      // to zero (the config-typo case `docs/known-issues.md` names, which
      // refuses every send with no reminders needing to be due to reveal it).
      const attentionResult = await runAttentionStep(
        db,
        notifier,
        now,
        env.CANCEL_TOKEN_SECRET,
        remindResult.remindersDeferred > 0 || parseMaxEmailsPerDay(env.MAX_EMAILS_PER_DAY) === 0,
      );

      // Runs regardless of the outcome above: a reminder or attention failure
      // must not stop fixtures being retired, and retiring is independent of
      // whether any email went out.
      const retireResult = await retirePastFixtures(db, now);
      console.log("retire-past-fixtures", JSON.stringify(retireResult));

      // Step 5: perform every erasure whose 48-hour window has elapsed
      // (BR-34). Last, and deliberately so, in both directions: an erasure
      // walks a player's whole squad and every open fixture behind it, so
      // putting it earlier would delay time-critical reminders behind a slow
      // one — and running it after retirement means a failing erasure cannot
      // stop fixtures being retired either. Nothing above depends on its
      // result, which is what makes the position free to choose.
      //
      // `runDueErasures` takes a withdraw *factory* keyed by player id rather
      // than a plain `withdraw`: each erasure withdraws a different player and
      // the capacity object has to be told which one.
      const erasureResult = await runDueErasures(db, now, (playerId) => (fixtureId) =>
        env.FIXTURE_CAPACITY.getByName(fixtureId).withdrawMember({
          playerId,
          actorPlayerId: playerId,
          now: now.getTime(),
        }),
      );
      console.log("erasures", JSON.stringify(erasureResult));
      for (const failure of erasureResult.failures) {
        console.error(`erasure failed for player ${failure.playerId}: ${failure.message}`);
      }

      const failed =
        remindResult.failures.length + attentionResult.failures.length + erasureResult.failures.length;
      if (failed > 0) {
        throw new Error(
          // "fixture(s) and player(s)" because the erasure step counts people,
          // not fixtures; the leading "fixture(s)" wording is kept so the
          // existing log searches and tests that match on it still do.
          `sweep failed for ${failed} fixture(s) and player(s) during open/remind/attention/erasure ` +
            `(opened ${remindResult.fixturesOpened}, sent ${remindResult.remindersSent}, ` +
            `failed ${remindResult.remindersFailed}, attention sent ${attentionResult.attentionSent}, ` +
            `retired ${retireResult.retired}, erased ${erasureResult.erased}, ` +
            `erasures blocked ${erasureResult.blocked}, erasures failed ${erasureResult.failures.length})`,
        );
      }
      return;
    }

    default:
      throw new Error(`Unrecognised cron schedule "${cron}"`);
  }
}

/**
 * Sweep step 3, with its own outer failure boundary.
 *
 * A throw that escapes `sendOwnerAttention` entirely is reported as a single
 * synthetic failure with no fixture id — enough for the invocation to be
 * recorded as failed, without letting it take retirement down with it. The
 * empty-string `fixtureId` is deliberate: there is genuinely no one fixture to
 * blame for a whole-step outage, and inventing one would be worse than saying
 * so.
 *
 * **No committed test exercises this `try`/`catch` itself.** Two approaches
 * were tried and both are dead ends under this test pool:
 * `@cloudflare/vitest-pool-workers` does not let `vi.mock` intercept a
 * module's own internal import (`handler.ts`'s own call to
 * `sendOwnerAttention`) — the same limitation already recorded in
 * `docs/known-issues.md` for `openAndRemind`/`retirePastFixtures` — and there
 * is no in-band way to make `sendOwnerAttention`'s first query throw, because
 * D1's foreign-key constraints refuse a `DROP TABLE` on any table this data
 * references. The material guarantee — that an N-4 failure does not stop
 * retirement — *is* proven by execution, per-fixture, via the
 * `CANCEL_TOKEN_SECRET`-unset tests in `test/cron/handler.test.ts`; what is
 * untested is only this function's own outer `try`/`catch` wrapper. If you
 * find a way to trip it in-band, do; otherwise this comment is here so the
 * next person does not spend the same hour rediscovering both dead ends.
 */
async function runAttentionStep(
  db: Db,
  notifier: Notifier,
  now: Date,
  cancelTokenSecret: string,
  ceilingReached: boolean,
): Promise<AttentionResult> {
  try {
    const result = await sendOwnerAttention({ db, notifier, now, cancelTokenSecret, ceilingReached });
    console.log("owner-attention", JSON.stringify(result));
    for (const failure of result.failures) {
      console.error(
        `owner-attention failed for fixture ${failure.fixtureId} (game ${failure.gameId ?? "unknown"}) at stage ${failure.stage}: ${failure.message}`,
      );
    }
    if (result.attentionDeferred > 0) {
      // The recursion TR-31 cannot escape: the ceiling is refusing the very
      // email that carries the ceiling warning. Loud here, and durable in
      // `audit_log` (`fixture.attention_email_deferred`), because neither an
      // owner's inbox nor a log line alone is a signal that survives this.
      console.warn(
        `DAILY EMAIL CEILING REACHED: ${result.attentionDeferred} owner attention email(s) deferred on this sweep run; they will be retried on the next one, and an audit_log row records each`,
      );
    }
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`owner-attention step failed outright and no owner was told anything: ${message}`);
    return {
      fixturesNeedingAttention: 0,
      attentionSent: 0,
      attentionFailed: 0,
      attentionDeferred: 0,
      ownersSkippedNoRecipient: 0,
      alreadyLogged: 0,
      failures: [{ fixtureId: "", gameId: null, stage: "prepare", message }],
    };
  }
}

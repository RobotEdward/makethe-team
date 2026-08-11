import { getDb } from "../db/client.js";
import { materialiseFixtures } from "../domain/materialise.js";
import type { Bindings } from "../env.js";
import { createNotifier } from "../notify/factory.js";
import { openAndRemind } from "../sweep/open-and-remind.js";
import { retirePastFixtures } from "../sweep/retire.js";

export const CRON_HOURLY_SWEEP = "0 * * * *";
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

    case CRON_HOURLY_SWEEP: {
      // Step 3 (owner attention email) belongs to M4 and stays absent.
      const db = getDb(env.DB);
      const notifier = createNotifier(env, now);

      const remindResult = await openAndRemind(db, notifier, now, env.RESPONSE_TOKEN_SECRET);
      console.log("open-and-remind", JSON.stringify(remindResult));
      for (const failure of remindResult.failures) {
        console.error(
          `open-and-remind failed for fixture ${failure.fixtureId} (game ${failure.gameId ?? "unknown"}) at stage ${failure.stage}: ${failure.message}`,
        );
      }
      if (remindResult.remindersDeferred > 0) {
        // Not a failure: QuotaNotifier deleted the `queued` row so the next
        // sweep run retries it automatically. But it is the only signal that
        // exists today that TR-31's daily send ceiling is biting — there is
        // no owner-facing UI for it yet (that's M4) — so it is logged loudly
        // and distinctly here rather than folded into "sent"/"failed", to
        // stay greppable in Workers Logs. The real fix is an owner-visible
        // warning surfaced in the product itself once that UI exists.
        console.warn(
          `DAILY EMAIL CEILING REACHED: ${remindResult.remindersDeferred} reminder(s) deferred this hour and will be retried on the next sweep run`,
        );
      }

      // Runs regardless of the outcome above: a reminder failure must not
      // stop fixtures being retired, and retiring is independent of whether
      // any reminder went out.
      const retireResult = await retirePastFixtures(db, now);
      console.log("retire-past-fixtures", JSON.stringify(retireResult));

      if (remindResult.failures.length > 0) {
        throw new Error(
          `hourly sweep failed for ${remindResult.failures.length} fixture(s) during open/remind ` +
            `(opened ${remindResult.fixturesOpened}, sent ${remindResult.remindersSent}, ` +
            `retired ${retireResult.retired})`,
        );
      }
      return;
    }

    default:
      throw new Error(`Unrecognised cron schedule "${cron}"`);
  }
}

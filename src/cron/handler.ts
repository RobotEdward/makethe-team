import { getDb } from "../db/client.js";
import { materialiseFixtures } from "../domain/materialise.js";
import type { Bindings } from "../env.js";

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
      // Reminders, owner attention and the played transition arrive in M3/M4.
      console.log("hourly sweep: nothing to do yet");
      return;
    }

    default:
      throw new Error(`Unrecognised cron schedule "${cron}"`);
  }
}

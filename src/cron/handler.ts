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
 */
export async function handleScheduled(cron: string, env: Bindings, now: Date): Promise<void> {
  switch (cron) {
    case CRON_DAILY_MATERIALISE: {
      const result = await materialiseFixtures(getDb(env.DB), now);
      console.log("materialise", JSON.stringify(result));
      for (const failure of result.failures) {
        console.error(`materialise failed for game ${failure.gameId}: ${failure.message}`);
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

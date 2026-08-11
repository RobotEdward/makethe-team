import type { Bindings } from "../env.js";
import { ConsoleNotifier } from "./console-notifier.js";
import { NullNotifier } from "./null-notifier.js";
import type { Notifier } from "./notifier.js";

/**
 * Selects a `Notifier` implementation from `env.NOTIFIER`.
 *
 * An unrecognised value throws at startup rather than falling back to
 * anything — a typo in the binding (e.g. `wrangler.jsonc`'s `vars.NOTIFIER`)
 * would otherwise quietly disable all email, and the only way anyone would
 * find out is a player not getting a reminder.
 */
export function createNotifier(env: Bindings): Notifier {
  switch (env.NOTIFIER) {
    case "console":
      return new ConsoleNotifier();
    case "null":
      return new NullNotifier();
    default:
      throw new Error(
        `unrecognised NOTIFIER binding: ${JSON.stringify(env.NOTIFIER)} (expected "console" or "null")`,
      );
  }
}

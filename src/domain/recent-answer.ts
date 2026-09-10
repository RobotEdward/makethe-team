import type { ResponseIntent } from "../capacity/types.js";
import type { ResponseStatus } from "./response-status.js";

/**
 * How long after a player's own answer a *different* answer from them is
 * treated as a possible slip rather than a decision (M65).
 *
 * The number comes from production: two players on one fixture each flipped
 * their answer 1.5 and 10 seconds after giving it, and both said afterwards
 * that the second tap was a mistake. A deliberate change of mind takes
 * longer than that to happen — a message read, a lift falling through.
 */
export const RECENT_ANSWER_WINDOW_MS = 20_000;

/**
 * Which answer a stored status stands for, as the player would put it.
 * `waitlisted` is an outcome of asking to be in (BR-5), so it reads as "in".
 * `pending` and `withdrawn` are no answer at all and return `null`.
 */
export function answerOf(status: ResponseStatus): ResponseIntent | null {
  switch (status) {
    case "in":
    case "waitlisted":
      return "in";
    case "out":
      return "out";
    default:
      return null;
  }
}

/**
 * True when `intent` would reverse an answer the player gave themselves
 * within the last `RECENT_ANSWER_WINDOW_MS`.
 *
 * Only the player's own answers count. `setByPlayerId` non-null is an
 * owner's override (BR-27): a player reacting to that within seconds is
 * correcting the organiser, not slipping, and must not be asked twice.
 */
export function reversesRecentAnswer(
  existing: { status: ResponseStatus; respondedAt: Date | null; setByPlayerId: string | null },
  intent: ResponseIntent,
  now: number,
): boolean {
  if (existing.setByPlayerId !== null || existing.respondedAt === null) return false;
  const previous = answerOf(existing.status);
  if (previous === null || previous === intent) return false;
  const elapsed = now - existing.respondedAt.getTime();
  return elapsed >= 0 && elapsed < RECENT_ANSWER_WINDOW_MS;
}

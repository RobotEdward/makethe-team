import type { NotificationType } from "./dedupe-key.js";
import type { AttentionEmailPayload } from "./templates/attention.js";
import type { BroadcastEmailPayload } from "./templates/broadcast.js";
import type { CancellationEmailPayload } from "./templates/cancellation.js";
import type { ErasureScheduledEmailPayload } from "./templates/erasure-scheduled.js";
import type { MagicLinkEmailPayload } from "./templates/magic-link.js";
import type { PromotionEmailPayload } from "./templates/promotion.js";
import type { RemovedEmailPayload } from "./templates/removed.js";
import type { ReminderEmailPayload } from "./templates/reminder.js";
import type { TeamsEmailParams } from "./templates/teams.js";
import type { WelcomeEmailPayload } from "./templates/welcome.js";

/**
 * The words a player actually reads on a lock screen, one entry per
 * notification type (M14 Task 9, spec §10.5).
 *
 * Deliberately not derived from the email subjects in `./templates/`: an
 * email subject is a line of prose with no length budget, while a push
 * title has roughly forty characters before Android truncates it — cutting
 * a title mid-word is worse than a shorter, differently-worded one. Each
 * entry here is a fresh sentence written for the tray, not a reshaping of
 * the matching template's `subject`.
 *
 * Two things every entry holds to:
 *
 * - **Title says what happened; body says when and where.** A player who
 *   only glances at the lock screen — never opens the tray — has to get the
 *   event from the title alone. The body exists to answer "when, and
 *   where", not to repeat the title in longer words.
 * - **Vocabulary matches the rest of the product.** "fixture", never
 *   "event"; "squad", never "team list". `test/notify/push-copy.test.ts`
 *   and the pages/emails' own vocabulary tests both police this, so a
 *   slip here is caught locally rather than shipped to a phone.
 *
 * Each function takes exactly the payload its matching email template
 * takes (`ReminderEmailPayload` for `n1`, and so on) — the copy for a
 * notification is a product decision made once, and re-deriving a smaller
 * shape here would just be a second place for the two to drift apart. Only
 * the fields actually needed for two short lines are read; the rest (every
 * URL, mostly) is ignored, because `url` on the outgoing `PushMessage` is
 * supplied by the caller (Task 13), which is the only place holding the
 * player's token.
 */
export interface PushCopy {
  title: string;
  body: string;
  /**
   * Collapses an older, still-undismissed notification about the same
   * thing rather than stacking a new one on top of it. None of the email
   * payloads carry a fixture or membership id — they are pure rendering
   * data, named things and formatted dates — so the closest stand-in
   * available here is the combination of the game's name with whatever
   * date-shaped field distinguishes one occurrence from the next. That is
   * not a perfect key (two fixtures for the same recurring game on the
   * same displayed date would still collide), but nothing sharper is in
   * scope: the real, unambiguous id lives with the caller in Task 13,
   * which is free to widen or replace this tag before it reaches the push
   * service.
   */
  tag: string;
}

/** How many more players `problem` says are still needed. Mirrors `attention.ts`'s own `shortBy`, not re-derived differently. */
function shortBy(problem: Extract<AttentionEmailPayload["problem"], { kind: "short" }>): number {
  return Math.max(0, problem.minPlayers - problem.inCount);
}

/**
 * The Android tray budget every title below is held to (spec §10.5).
 * `PushCopy`'s own doc comment and `test/notify/push-copy.test.ts` both
 * name this same number, so a change here is a change everywhere it's
 * checked.
 */
const TITLE_MAX_CHARS = 40;

/**
 * What a truncated `gameName` ends in — one character, counted against the
 * budget below like any other.
 */
const ELLIPSIS = "…";

/**
 * Fits `name` inside `budget` characters, replacing the tail with a single
 * `ELLIPSIS` when it doesn't fit whole.
 *
 * A day-of-the-week plus a descriptor plus "Football" or "5-a-side" is an
 * entirely ordinary game name for this product and routinely lands in the
 * mid-to-high twenties of characters — long enough that a title built by
 * simply concatenating a fixed phrase with `gameName` exceeds
 * `TITLE_MAX_CHARS` for several of the nine notification types once the name
 * is realistic rather than the short one convenient for a test fixture. This
 * function is what makes every title below hold for a name of *any* length,
 * rather than buying headroom against one example name that a slightly
 * longer one immediately eats back up.
 */
function fitName(name: string, budget: number): string {
  if (name.length <= budget) return name;
  if (budget <= ELLIPSIS.length) return ELLIPSIS.slice(0, Math.max(budget, 0));
  return `${name.slice(0, budget - ELLIPSIS.length)}${ELLIPSIS}`;
}

/**
 * Builds `${before}${gameName}${after}`, truncating `gameName` (via
 * `fitName`) by however much is needed to keep the whole title at or under
 * `TITLE_MAX_CHARS` — never `before` or `after`, which are the fixed words
 * that say what happened and are what makes the notification legible at a
 * glance in the first place.
 */
function gameNameTitle(before: string, gameName: string, after: string): string {
  const budget = TITLE_MAX_CHARS - before.length - after.length;
  return `${before}${fitName(gameName, budget)}${after}`;
}

/**
 * N-1: the day-before reminder.
 *
 * What happened: it's tomorrow. When/where: kick-off and the venue.
 */
function reminder({ gameName, venueName, kicksOffAtLocal }: ReminderEmailPayload): PushCopy {
  return {
    title: gameNameTitle("", gameName, " — tomorrow"),
    body: `${kicksOffAtLocal} at ${venueName}.`,
    tag: `n1:${gameName}:${kicksOffAtLocal}`,
  };
}

/**
 * N-2: waitlist promotion.
 *
 * What happened: a spot opened up and it's theirs, already — the copy
 * mirrors `promotion.ts`'s own care that this is a confirmation, not an
 * offer to accept. When/where: kick-off and the venue.
 */
function promotion({ gameName, venueName, kicksOffAtLocal }: PromotionEmailPayload): PushCopy {
  return {
    title: gameNameTitle("You're in — ", gameName, ""),
    body: `${kicksOffAtLocal} at ${venueName}.`,
    tag: `n2:${gameName}:${kicksOffAtLocal}`,
  };
}

/**
 * N-3: fixture cancelled.
 *
 * What happened: it's off. When/where: what the cancelled kick-off and
 * venue were, so the notification still stands on its own once the tray
 * item is all a player sees.
 */
function cancellation({ gameName, venueName, kicksOffAtLocal }: CancellationEmailPayload): PushCopy {
  return {
    title: gameNameTitle("", gameName, " — cancelled"),
    body: `Was ${kicksOffAtLocal} at ${venueName}.`,
    tag: `n3:${gameName}:${kicksOffAtLocal}`,
  };
}

/**
 * N-4: owner attention.
 *
 * What happened: short of players, or an odd number in — the same
 * mutually-exclusive split `attention.ts` makes, because telling an owner
 * with a full squad that they're "short" would simply be false. When/where:
 * kick-off and venue, same as the email.
 */
function attention({ gameName, venueName, kicksOffAtLocal, problem }: AttentionEmailPayload): PushCopy {
  const after = problem.kind === "short" ? ` — ${shortBy(problem)} short` : " — odd number in";
  return {
    title: gameNameTitle("", gameName, after),
    body: `${kicksOffAtLocal} at ${venueName}.`,
    tag: `n4:${gameName}:${kicksOffAtLocal}`,
  };
}

/**
 * N-5: the magic sign-in link.
 *
 * No fixture behind this one, so "when and where" becomes "how long the
 * link is good for" — the closest thing this notification has to a
 * deadline, and the one fact `magic-link.ts` itself treats as load-bearing.
 */
function magicLink({ expiresInLabel }: MagicLinkEmailPayload): PushCopy {
  return {
    title: "Your sign-in link",
    body: `Works once, expires in ${expiresInLabel}.`,
    tag: "n5:sign-in",
  };
}

/**
 * N-6: welcome to the squad.
 *
 * What happened: they're in the squad. When/where: their first fixture if
 * the diary has one yet, mirroring `welcome.ts`'s own null case rather than
 * printing a blank date.
 */
function welcome({ gameName, venueName, whenLocal }: WelcomeEmailPayload): PushCopy {
  return {
    title: gameNameTitle("In the squad — ", gameName, ""),
    body: whenLocal === null ? `First game not in the diary yet.` : `First game ${whenLocal} at ${venueName}.`,
    tag: `n6:${gameName}`,
  };
}

/**
 * N-7: removed from the squad.
 *
 * What happened: removed. No fixture, no venue, nothing left to schedule —
 * `removed.ts` carries neither, and this doesn't invent one.
 */
function removed({ gameName }: RemovedEmailPayload): PushCopy {
  return {
    title: gameNameTitle("Removed from ", gameName, ""),
    body: "No more messages about this game.",
    tag: `n7:${gameName}`,
  };
}

/**
 * N-8: account erasure scheduled.
 *
 * What happened: erasure is scheduled. When: the deadline — the one fact
 * that gives someone who didn't ask for this a real chance to notice and
 * stop it, same reasoning as `erasure-scheduled.ts` itself.
 */
function erasureScheduled({ whenLocal }: ErasureScheduledEmailPayload): PushCopy {
  return {
    title: "Data erasure scheduled",
    body: `Erases ${whenLocal} unless you cancel.`,
    tag: "n8:erasure",
  };
}

/**
 * N-9: teams published.
 *
 * What happened: teams are up, and which side they're on — the one fact
 * `teams.ts` puts first, ahead of the full line-ups, because it survives a
 * game with squad visibility switched off. When/where: kick-off and venue.
 */
function teams({ gameName, venueName, whenLocal, yourSideName }: TeamsEmailParams): PushCopy {
  return {
    title: gameNameTitle("Teams are up — ", gameName, ""),
    body: `You're on ${yourSideName}. ${whenLocal} at ${venueName}.`,
    tag: `n9:${gameName}:${whenLocal}`,
  };
}

/**
 * N-10: organiser broadcast.
 *
 * What happened: the organiser's own subject, fitted to the tray. When and
 * where: their own first words, which is the only thing here the product did
 * not write and therefore the only thing worth showing.
 *
 * `tag` follows N-9's shape and is overridden by the caller with the real
 * broadcast id — two different broadcasts must never collapse into one another
 * in the tray, which is exactly what a game-name-based tag would do.
 */
function broadcast({ subject, message, gameName }: BroadcastEmailPayload): PushCopy {
  return {
    title: gameNameTitle("", subject, ""),
    body: message,
    tag: `n10:${gameName}:${subject}`,
  };
}

/**
 * What N-11 is built from (M22). Not an email payload, unlike every other
 * entry: the nudge has no email leg, so this is its whole input.
 */
export interface GroupNudgePayload {
  gameName: string;
  kicksOffAtLocal: string;
  inCount: number;
}

/**
 * N-11: the organiser's group nudge — "the fixture's open, post it to the
 * group" — sent the first sweep tick after the reminder instant.
 *
 * What happened: there is something to post. When: kick-off, and the
 * headcount that makes the post worth making. The title is a fixed question
 * so it reads the same whatever the game is called; the game name moves to
 * the body, where there is room for it.
 */
function groupNudge({ gameName, kicksOffAtLocal, inCount }: GroupNudgePayload): PushCopy {
  return {
    title: "Post it to the group?",
    body: `${gameName}, ${kicksOffAtLocal}: ${inCount} in so far.`,
    tag: `n11:${gameName}:${kicksOffAtLocal}`,
  };
}

/**
 * The push-copy catalogue, one builder per `NotificationType`
 * (`NOTIFICATION_TYPES` in `./dedupe-key.ts`). Indexed by type rather than
 * exported as nine loose functions so that a type added to the catalogue
 * without a matching entry here is a build-time property
 * (`test/notify/push-copy.test.ts`'s "covers every notification type"
 * case) rather than a push that silently never sends.
 */
export const PUSH_COPY: {
  n1: typeof reminder;
  n2: typeof promotion;
  n3: typeof cancellation;
  n4: typeof attention;
  n5: typeof magicLink;
  n6: typeof welcome;
  n7: typeof removed;
  n8: typeof erasureScheduled;
  n9: typeof teams;
  n10: typeof broadcast;
  n11: typeof groupNudge;
} = {
  n1: reminder,
  n2: promotion,
  n3: cancellation,
  n4: attention,
  n5: magicLink,
  n6: welcome,
  n7: removed,
  n8: erasureScheduled,
  n9: teams,
  n10: broadcast,
  n11: groupNudge,
};

// Referenced only for the mapped type above; re-exported so callers can
// name the catalogue's key type without reaching into `./dedupe-key.js`
// separately.
export type { NotificationType };

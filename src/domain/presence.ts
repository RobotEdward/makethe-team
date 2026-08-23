/**
 * Whether the product is actually reaching a squad member (M33).
 *
 * Four questions an organiser cannot otherwise answer about somebody who
 * never replies: is the app on their phone, will a push get to them, is
 * anything we sent them failing, and have they been near this at all lately.
 *
 * The predicates live here rather than in the view for the reason `isMuted`
 * does (M28): three of the four are relative to *now*, and a page that held a
 * clock would be untestable at the one boundary that matters.
 */

/** How long silence has to last before the squad list mentions it. */
export const QUIET_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How stale `players.last_seen_at` must be before a ping writes it again.
 *
 * The ping fires once per browser tab, so without this a player with the app
 * open on two devices and a habit of reopening tabs writes to `players` all
 * day for a column nothing reads more precisely than "within a fortnight".
 * An hour keeps the write rate at worst hourly per player, and costs the
 * squad list nothing it can perceive.
 */
export const PRESENCE_STAMP_INTERVAL_MS = 60 * 60 * 1000;

/** What is known about one member's reachability, straight from the columns. */
export interface SquadPresence {
  /**
   * A guest has no address, cannot sign in and cannot install (§2.8, BR-32),
   * so every signal below is false about them by construction rather than by
   * observation — see `squadSignals` for why that means showing none of them.
   */
  isGuest: boolean;
  /** `players.last_seen_at`: they opened a page with their session on it. */
  lastSeenAt: Date | null;
  /** Their newest answer *in this game*. A mailed link never touches the above. */
  lastAnsweredAt: Date | null;
  /** `players.last_standalone_at`: seen in the installed app. */
  lastStandaloneAt: Date | null;
  /** How many devices are registered for push right now. */
  pushDevices: number;
  /** A send to them failed more recently than one succeeded. */
  deliveryFailing: boolean;
}

/** The four things the squad row may say. Every one means "worth knowing". */
export interface SquadSignals {
  notInstalled: boolean;
  noPush: boolean;
  deliveryTrouble: boolean;
  quiet: boolean;
}

const NOTHING: SquadSignals = {
  notInstalled: false,
  noPush: false,
  deliveryTrouble: false,
  quiet: false,
};

function laterOf(a: Date | null, b: Date | null): Date | null {
  if (a === null) return b;
  if (b === null) return a;
  return a.getTime() >= b.getTime() ? a : b;
}

/**
 * Which of the four to show, given what we know and when it is being asked.
 *
 * A guest gets none of them. All four would be true of every guest on every
 * squad, permanently and by design — the organiser added them precisely
 * because they have no address and no app — so the row would carry four
 * markers that describe the feature working as intended. A marker that is
 * always on is a marker nobody reads, including on the rows where it means
 * something.
 *
 * "Seen" is the later of opening the app and answering something *here*.
 * Most of this product is reachable from a mailed link, so a player who never
 * signs in but replies to every fixture is the most engaged kind of member
 * there is, and reading `last_seen_at` alone would call them absent.
 */
export function squadSignals(presence: SquadPresence, now: Date): SquadSignals {
  if (presence.isGuest) return NOTHING;

  const seen = laterOf(presence.lastSeenAt, presence.lastAnsweredAt);
  return {
    notInstalled: presence.lastStandaloneAt === null,
    noPush: presence.pushDevices === 0,
    deliveryTrouble: presence.deliveryFailing,
    quiet: seen === null || now.getTime() - seen.getTime() > QUIET_DAYS * DAY_MS,
  };
}

/**
 * Whether a presence ping should write, given what the row already holds.
 *
 * A stamp in the future stamps: it can only come from a clock that disagreed
 * with this one, and leaving it would freeze the column until real time
 * caught up — showing an active player as gone quiet for as long as the skew
 * lasted.
 */
export function shouldStampPresence(stamped: Date | null, now: Date): boolean {
  if (stamped === null) return true;
  const age = now.getTime() - stamped.getTime();
  return age < 0 || age >= PRESENCE_STAMP_INTERVAL_MS;
}

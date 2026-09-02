import type { AuditAction } from "./audit.js";
import type { NotificationType } from "../notify/dedupe-key.js";
import { ordinal } from "./ordinal.js";

/**
 * One fixture's story, assembled from what is already recorded (M46).
 *
 * **Nothing here is a new source of truth.** The two inputs are `audit_log`
 * (who did what) and `notification_log` (what went out), both of which exist
 * for their own reasons and are written whether or not anybody ever opens this
 * page. That is deliberate: a timeline that needed its own writes would be a
 * third record of the same events, free to drift from the two that decide
 * behaviour.
 *
 * The corollary is a real limit, and the page says it out loud rather than
 * hiding it: history begins when these rows began. No backfill is possible,
 * because the facts were never stored.
 */
export interface AuditRow {
  action: AuditAction;
  actorPlayerId: string | null;
  before: unknown;
  after: unknown;
  createdAt: Date;
}

export interface NotificationRow {
  notificationType: NotificationType;
  playerId: string;
  channel: "email" | "push";
  status: string;
  sentAt: Date | null;
  createdAt: Date;
}

export interface TimelineEntry {
  at: Date;
  /**
   * Who did it, already resolved to a display name, or null for the system.
   *
   * Null is a fact, not a missing lookup: the sweep opening a fixture and an
   * owner opening it early are the same row but for this field, and rendering
   * "somebody" for both would erase the distinction the row exists to record.
   */
  actor: string | null;
  /** The subject, when the act was done *to* somebody. Null when it was not. */
  subject: string | null;
  title: string;
  /** A second line, or null when the title says everything. */
  detail: string | null;
}

/** Names by player id, for whatever ids the rows mention. */
export type NameLookup = (playerId: string) => string | null;

/**
 * Every name is a **noun**, because the row reads "<name> sent". A verb phrase
 * here produces "Told they are in sent", which is what shipped and what this
 * comment exists to stop coming back.
 */
const NOTIFICATION_NAMES: Record<NotificationType, string> = {
  n1: "Invitation",
  n2: "Promotion notice",
  n3: "Cancellation notice",
  n4: "Short-numbers warning",
  n5: "Sign-in link",
  n6: "Welcome",
  n7: "Removal notice",
  n8: "Erasure confirmation",
  n9: "Teams announcement",
  n10: "Message from the organiser",
  n11: "Group-chat nudge",
  n12: "Result prompt",
  n13: "Team-pick handover",
  n14: "Join confirmation",
};

/** How many recipients a send names before it starts counting them instead. */
const NAMES_BEFORE_COUNTING = 3;

/**
 * "Ada", "Ada and Bo", "Ada, Bo and Cy" — or a count once the list stops being
 * something a reader takes in at a glance.
 *
 * The threshold is a judgement, not a measurement: a fixture's opening send
 * names every member of the squad, and seventeen rows of one name each is what
 * this replaces.
 */
function describeRecipients(playerIds: readonly string[], names: NameLookup): string {
  if (playerIds.length > NAMES_BEFORE_COUNTING) {
    return `${playerIds.length} players`;
  }
  const resolved = playerIds.map((id) => names(id)).filter((name): name is string => name !== null);
  // Every name unknown (an erased player, a row pointing at nobody) leaves a
  // count rather than an empty string, which would render as a bare separator.
  if (resolved.length === 0) return `${playerIds.length} ${playerIds.length === 1 ? "player" : "players"}`;
  if (resolved.length === 1) return resolved[0]!;
  return `${resolved.slice(0, -1).join(", ")} and ${resolved[resolved.length - 1]}`;
}

/**
 * A stored value indexing a lookup table can be absent from it: neither
 * `notification_log.notification_type` nor `audit_log.action` carries a CHECK
 * constraint, so the TypeScript enum is a claim about the schema and not a
 * guarantee about the rows. Falling back to the raw value keeps the page up
 * and shows an operator the value it did not recognise.
 */
function notificationName(type: NotificationType): string {
  return NOTIFICATION_NAMES[type] ?? String(type);
}

function readStatus(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const status = (value as { status?: unknown }).status;
  return typeof status === "string" ? status : null;
}

function readPlayerId(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const playerId = (value as { playerId?: unknown }).playerId;
  return typeof playerId === "string" ? playerId : null;
}

function readNumber(value: unknown, key: string): number | null {
  if (typeof value !== "object" || value === null) return null;
  const found = (value as Record<string, unknown>)[key];
  return typeof found === "number" ? found : null;
}

/** How one audit row reads, or null for an action this page does not report. */
function describeAudit(row: AuditRow, names: NameLookup): { title: string; detail: string | null; subject: string | null } | null {
  const after = row.after;
  const before = row.before;

  switch (row.action) {
    case "fixture.opened": {
      const created = readNumber(after, "pendingCreated");
      const declined = readNumber(after, "autoDeclined");
      return {
        title: "Opened for answers",
        subject: null,
        detail:
          created === null
            ? null
            : `${created} ${created === 1 ? "player" : "players"} asked` +
              (declined === null || declined === 0 ? "" : `, ${declined} auto-declining`),
      };
    }
    case "fixture.tier_released": {
      const invited = readNumber(after, "invited");
      return {
        title: "Next group invited",
        subject: null,
        detail: invited === null ? null : `${invited} ${invited === 1 ? "player" : "players"} asked`,
      };
    }
    case "fixture.invited_individually": {
      const playerId = readPlayerId(after);
      return {
        title: "Invited on their own",
        subject: playerId === null ? null : names(playerId),
        detail: "Their group stays held.",
      };
    }
    case "fixture.response_recorded": {
      const to = readStatus(after);
      const from = readStatus(before);
      // An answer that changed nothing is not history, and the rows exist:
      // re-tapping "out" on an already-out row wrote one each time, so one
      // player's ten taps filled the page with ten identical entries. The
      // write is guarded too (`FixtureCapacity#setResponse`), but the rows
      // already stored can only be dealt with here.
      if (from !== null && from === to) return null;
      return {
        title: to === null ? "Answered" : `Answered: ${to}`,
        subject: null,
        // Only when it is a *change*. "was pending" on a first answer is noise
        // on every row of a fourteen-person squad.
        detail: from === null || from === "pending" ? null : `was ${from}`,
      };
    }
    case "fixture.response_overridden": {
      const playerId = readPlayerId(after);
      const to = readStatus(after);
      const from = readStatus(before);
      const fromWaitlist =
        typeof after === "object" && after !== null && (after as { fromWaitlist?: unknown }).fromWaitlist === true;
      const rank = readNumber(after, "waitlistRank");
      return {
        title: fromWaitlist ? "Promoted off the waitlist" : `Set to ${to ?? "a new answer"} by the organiser`,
        subject: playerId === null ? null : names(playerId),
        detail: fromWaitlist
          ? rank === null
            ? "Ahead of the queue."
            : `They were ${ordinal(rank)} in the queue.`
          : from === null || from === to
            ? null
            : `was ${from}`,
      };
    }
    case "fixture.guest_added":
      return { title: "Guest added", subject: null, detail: null };
    case "fixture.guest_removed":
      return { title: "Guest removed", subject: null, detail: null };
    case "fixture.teams_saved":
      return { title: "Teams saved", subject: null, detail: null };
    case "fixture.teams_published":
      return { title: "Teams announced", subject: null, detail: null };
    case "fixture.picker_changed":
      return { title: "Who picks the teams changed", subject: null, detail: null };
    case "fixture.cancelled":
      return { title: "Called off", subject: null, detail: null };
    case "fixture.reminder_email_deferred":
    case "fixture.promotion_email_deferred":
    case "fixture.cancellation_email_deferred":
    case "fixture.attention_email_deferred":
    case "fixture.teams_email_deferred":
    case "fixture.result_nudge_email_deferred":
      return {
        title: "An email could not be sent",
        subject: null,
        detail: "The daily sending limit stopped it.",
      };
    default:
      // Every other action is either about a Game or a player rather than this
      // fixture, or is a result-stage row the result panel already reports.
      // Dropping them here keeps the page about the run-up to the game.
      return null;
  }
}

/**
 * Merge the two records into one list, newest first (M46).
 *
 * Sorted by the instant each thing happened, with a stable tie-break on the
 * kind, because several rows can share a millisecond: opening a fixture writes
 * its audit row and its invitations in one request, and a list whose order
 * changed between two loads of the same page reads as a bug.
 */
export function buildTimeline(input: {
  audit: readonly AuditRow[];
  notifications: readonly NotificationRow[];
  names: NameLookup;
}): TimelineEntry[] {
  const entries: TimelineEntry[] = [];

  for (const row of input.audit) {
    const described = describeAudit(row, input.names);
    if (described === null) continue;
    entries.push({
      at: row.createdAt,
      actor: row.actorPlayerId === null ? null : input.names(row.actorPlayerId),
      subject: described.subject,
      title: described.title,
      detail: described.detail,
    });
  }

  // One send to a whole squad is one thing that happened, not seventeen. Keyed
  // on the minute rather than the exact instant because a fan-out writes its
  // rows over several hundred milliseconds, and on status as well as type and
  // channel because a send that *failed* for one player is the thing an
  // organiser came to this page to find — folding it in with the successes
  // would hide it.
  const groups = new Map<string, { at: Date; row: NotificationRow; playerIds: string[] }>();
  for (const row of input.notifications) {
    // `sent_at` when there is one, and the row's own creation otherwise: a
    // queued or failed message still belongs in the story at the moment it was
    // owed, and leaving it out would make a send failure invisible on the one
    // page an organiser would look for it.
    const at = row.sentAt ?? row.createdAt;
    const minute = Math.floor(at.getTime() / 60_000);
    const key = `${row.notificationType}|${row.channel}|${row.status}|${minute}`;
    const found = groups.get(key);
    if (found === undefined) {
      groups.set(key, { at, row, playerIds: [row.playerId] });
      continue;
    }
    found.playerIds.push(row.playerId);
    // The earliest instant in the group, so the line sits where the send
    // started rather than wherever the last write happened to land.
    if (at < found.at) found.at = at;
  }

  for (const group of groups.values()) {
    entries.push({
      at: group.at,
      // Null on every send, always. A notification is the system acting, and
      // the recipient is not the actor — rendering their name in the actor's
      // place read as "Ed sent this", which is the opposite of what happened.
      actor: null,
      subject: describeRecipients(group.playerIds, input.names),
      title: `${notificationName(group.row.notificationType)} sent`,
      detail:
        group.row.status === "sent"
          ? group.row.channel === "push"
            ? "by push"
            : "by email"
          : `${group.row.channel} — ${group.row.status}`,
    });
  }

  return entries.sort((a, b) => {
    const byTime = b.at.getTime() - a.at.getTime();
    if (byTime !== 0) return byTime;
    return a.title.localeCompare(b.title);
  });
}

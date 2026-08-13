import { escapeHtml } from "../../views/layout.js";

/**
 * Everything the removal email (N-7) needs. Pure (TR-20): no clock, no
 * bindings, no database, no lookups — every string arriving here is already
 * exactly what should be shown.
 *
 * The second email in the catalogue with no Fixture behind it, after N-6:
 * being removed from a squad is a membership event, and it may happen when the
 * game has no fixture at all.
 *
 * **No leave or unsubscribe link.** Every other notification carries one under
 * BR-22, and its absence here is deliberate rather than an omission: there is
 * nothing left to leave. This is the one message in the system whose subject
 * matter satisfies BR-22 on its own — it *is* the confirmation that no further
 * mail about this game is coming.
 *
 * No dashboard link either, unlike N-6. The dashboard shows the games a player
 * belongs to, and this one is no longer among them; sending them there to find
 * nothing would be a worse answer than the sentence in the copy.
 */
export interface RemovedEmailPayload {
  /** The player this copy is for. Shown only in a plain greeting. */
  playerName: string;
  gameName: string;
}

export interface RemovedEmail {
  subject: string;
  html: string;
  text: string;
}

/**
 * Render the email telling a player they have been removed from a squad
 * (N-7, J6a §5).
 *
 * The copy states the fact and stops. It does not say who removed them or
 * why: the organiser knows both, this is usually the tail of a conversation
 * that already happened, and speculating in either direction would be worse
 * than the plain sentence.
 */
export function renderRemovedEmail(payload: RemovedEmailPayload): RemovedEmail {
  const { playerName, gameName } = payload;

  const text = [
    `Hi ${playerName},`,
    "",
    `You've been removed from the squad for ${gameName}.`,
    "",
    "You'll get no more email about this game. If you think it was a mistake,",
    "ask the organiser — they can send you the invite link again.",
  ].join("\n");

  const html = [
    `<p>Hi ${escapeHtml(playerName)},</p>`,
    `<p>You've been removed from the squad for ${escapeHtml(gameName)}.</p>`,
    "<p>You'll get no more email about this game. If you think it was a mistake, ask the organiser — they can send you the invite link again.</p>",
  ].join("\n");

  return { subject: `You've been removed from ${gameName}`, html, text };
}

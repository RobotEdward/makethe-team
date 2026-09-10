import { escapeHtml } from "../../views/layout.js";

/**
 * Everything the day-before reminder (N-1) needs to render one Player's copy
 * of it. Every string arriving here is already exactly what should be
 * shown — this module does no date maths, no lookups, no formatting of its
 * own. It is pure (TR-20): no clock, no bindings, no database. The caller
 * (the sweep, M3.15) resolves the Fixture, works out this Player's counts,
 * signs their token, and builds every URL below before calling in.
 *
 * The three links are carried as complete, absolute URLs rather than a bare
 * token plus a path this module would have to assemble. That keeps this
 * module ignorant of the site's origin and of exactly how the leave-game
 * action is implemented (see `leaveUrl`) — it only has to know a link
 * exists and where it points, not how it was built.
 */
export interface ReminderEmailPayload {
  /** The Player this copy of the email is for. Shown only in a plain greeting. */
  playerName: string;
  gameName: string;
  venueName: string;
  /** Already formatted in the Game's local timezone by the caller (src/domain/time/zone.ts). Never formatted here. */
  kicksOffAtLocal: string;
  /** How many Players currently hold a slot (occupiesSlot(status) === true, at send time). */
  inCount: number;
  spotsLeft: number;
  /**
   * `GET /r/<token>` — the Player's response page, where the one deliberate
   * tap happens. One link, not an "I'm in" and a "Can't make it" pair (M65):
   * two buttons that looked like answers and recorded nothing sent players
   * tapping twice — once here, once on the page — and the second tap was
   * where the slips happened. See the module doc comment on
   * `renderReminderEmail` for why the tap cannot record anything from here.
   */
  respondUrl: string;
  /**
   * True when this Player already holds a slot (`status === "in"`) at send
   * time, so the email confirms rather than asks (M45).
   *
   * **The way out stays either way, and must.** Every tier release and every
   * waitlist promotion in the product is driven by somebody dropping out
   * early; an email that tells a Player their game is tomorrow and offers
   * them no way to say they cannot make it after all sends them hunting for
   * the app, and the ones who do not bother are the no-shows the organiser
   * finds out about at kick-off. Since M65 that way out is a sentence under
   * the link rather than a second button.
   *
   * Optional, defaulting to the asking copy: every existing caller and test
   * predates this and means "ask them".
   */
  confirmed?: boolean;
  /**
   * A working leave-game/unsubscribe link (BR-22).
   *
   * The sweep builds this as `/leave/:token` (`src/sweep/open-and-remind.ts`),
   * signed with a leave token scoped to the Game rather than the Fixture this
   * reminder is about — leaving works from here, the way the copy now says.
   * This module only ever embeds whatever URL it is given and never inspects
   * it, so how that token is built needs no edit here.
   */
  leaveUrl: string;
}

export interface ReminderEmail {
  subject: string;
  html: string;
  text: string;
}

/** Absolute-URL-safe: escapes for use inside a double-quoted HTML attribute. */
function href(url: string): string {
  return escapeHtml(url);
}

function spotsLine(spotsLeft: number, inCount: number): string {
  const spotsWord = spotsLeft === 1 ? "spot" : "spots";
  const playersWord = inCount === 1 ? "player is" : "players are";
  return `${inCount} ${playersWord} in — ${spotsLeft} ${spotsWord} left.`;
}

/**
 * Render the single email a Player gets the day before a Game (N-1).
 *
 * The link records nothing, and the copy says so. Mail scanners and security
 * appliances follow every link in every email automatically; if the link
 * recorded a response, every inbox that got pre-fetched or scanned would
 * silently fill a slot for a Player who never opened the message. The
 * response page on the other end is where the actual, single, deliberate
 * tap happens — which is why, since M65, the email offers one "respond"
 * link rather than a yes and a no that only looked like answers.
 */
export function renderReminderEmail(payload: ReminderEmailPayload): ReminderEmail {
  const { playerName, gameName, venueName, kicksOffAtLocal, inCount, spotsLeft, respondUrl, leaveUrl } = payload;
  const confirmed = payload.confirmed === true;

  // Unchanged for both. It is accurate either way, and it is what makes the
  // message findable in an inbox the next morning — the one job a subject
  // line has here.
  const subject = `${gameName} — tomorrow`;

  const spots = spotsLine(spotsLeft, inCount);

  /**
   * The one line that differs, and the reason this variant exists: asking
   * "can you play?" of somebody who answered weeks ago reads as though their
   * answer went missing.
   */
  const standing = confirmed ? "You're in." : null;
  const ask = confirmed ? null : "Can you make it?";
  const button = confirmed ? "See the game" : "Respond on Make The Team";
  const after = confirmed
    ? "Can't make it after all? Say so on your response page — it frees your spot for the next player."
    : "Opens your response page — say yes or no there, and change your mind any time before kick-off.";

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0; padding:0; background-color:#efe3cd; color:#201e1d;">
<div style="display:none; max-height:0; overflow:hidden; opacity:0; mso-hide:all;">
${escapeHtml(spots)}
</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#efe3cd;">
<tr>
<td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px; background-color:#f9f4ed; border:1px solid #d6c9b3; border-radius:20px;">
<tr>
<td style="padding:28px 24px; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; color:#201e1d;">

<p style="margin:0 0 16px; font-size:15px; line-height:1.5; color:#201e1d;">Hi ${escapeHtml(playerName)},</p>

<h1 style="margin:0 0 4px; font-size:22px; line-height:1.3; color:#201e1d;">${escapeHtml(gameName)}</h1>
<p style="margin:0 0 2px; font-size:15px; line-height:1.5; color:#645c50;">${escapeHtml(venueName)}</p>
<p style="margin:0 0 16px; font-size:15px; line-height:1.5; color:#645c50;">${escapeHtml(kicksOffAtLocal)}</p>

${standing === null ? "" : `<p style="margin:0 0 12px; font-size:17px; line-height:1.4; font-weight:700; color:#201e1d;">${escapeHtml(standing)}</p>`}
<p style="margin:0 0 20px; font-size:14px; line-height:1.5; color:#645c50;">${escapeHtml(spots)}</p>

${ask === null ? "" : `<p style="margin:0 0 12px; font-size:17px; line-height:1.4; font-weight:700; color:#201e1d;">${escapeHtml(ask)}</p>`}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
<tr>
<td>
<a href="${href(respondUrl)}" style="display:block; text-align:center; padding:14px 16px; background-color:#c67139; color:#fff7f0; text-decoration:none; font-weight:700; font-size:16px; border-radius:999px; border:2px solid #c67139;">${escapeHtml(button)}</a>
</td>
</tr>
</table>

<p style="margin:16px 0 0; font-size:13px; line-height:1.5; color:#645c50;">${escapeHtml(after)}</p>

<hr style="margin:24px 0; border:none; border-top:1px solid #d6c9b3;">

<p style="margin:0; font-size:12px; line-height:1.6; color:#645c50;">
Make The Team — organising this Game for your squad.
<br>
Not playing any more? <a href="${href(leaveUrl)}" style="color:#645c50;">Leave this game</a>.
</p>

</td>
</tr>
</table>

</td>
</tr>
</table>
</body>
</html>
`;

  const text = [
    `Hi ${playerName},`,
    "",
    gameName,
    venueName,
    kicksOffAtLocal,
    "",
    ...(standing === null ? [] : [standing, ""]),
    spots,
    "",
    ...(ask === null ? [] : [ask]),
    `${button}:`,
    respondUrl,
    "",
    after,
    "",
    "---",
    "Make The Team — organising this Game for your squad.",
    `Not playing any more? Leave this game: ${leaveUrl}`,
    "",
  ].join("\n");

  return { subject, html, text };
}

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
   * `GET /r/<token>?intent=in` — opens the response page with "I'm in"
   * emphasised. Tapping this link does not itself record a response: the
   * player still taps the button on that page to confirm. See the module
   * doc comment on `renderReminderEmail` for why that second tap is
   * deliberate, and keep the copy honest about it.
   */
  respondInUrl: string;
  /** As `respondInUrl`, but opens with "Can't make it" emphasised. */
  respondOutUrl: string;
  /**
   * A working leave-game/unsubscribe link (BR-22). What it currently points
   * at, and what it must become before this ships, is documented where the
   * caller builds it (task-14-report.md) — this module only ever embeds
   * whatever URL it is given.
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
 * The copy is deliberately careful about the two response links: "I'm in"
 * and "Can't make it" describe an intention, not a completed action —
 * nothing here says "click to confirm" or implies the tap itself records
 * anything, because it does not. Mail scanners and security appliances
 * follow every link in every email automatically; if the link recorded a
 * response, every inbox that got pre-fetched or scanned would silently fill
 * a slot for a Player who never opened the message. The response page on
 * the other end is where the actual, single, deliberate confirming tap
 * happens.
 */
export function renderReminderEmail(payload: ReminderEmailPayload): ReminderEmail {
  const { playerName, gameName, venueName, kicksOffAtLocal, inCount, spotsLeft, respondInUrl, respondOutUrl, leaveUrl } =
    payload;

  const subject = `${gameName} — tomorrow`;

  const spots = spotsLine(spotsLeft, inCount);

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0; padding:0; background-color:#f2efe9; color:#1c1b19;">
<div style="display:none; max-height:0; overflow:hidden; opacity:0; mso-hide:all;">
${escapeHtml(spots)}
</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f2efe9;">
<tr>
<td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px; background-color:#ffffff; border:1px solid #e3ded4; border-radius:8px;">
<tr>
<td style="padding:28px 24px; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; color:#1c1b19;">

<p style="margin:0 0 16px; font-size:15px; line-height:1.5; color:#1c1b19;">Hi ${escapeHtml(playerName)},</p>

<h1 style="margin:0 0 4px; font-size:22px; line-height:1.3; color:#1c1b19;">${escapeHtml(gameName)}</h1>
<p style="margin:0 0 2px; font-size:15px; line-height:1.5; color:#4a4741;">${escapeHtml(venueName)}</p>
<p style="margin:0 0 16px; font-size:15px; line-height:1.5; color:#4a4741;">${escapeHtml(kicksOffAtLocal)}</p>

<p style="margin:0 0 20px; font-size:14px; line-height:1.5; color:#6b6862;">${escapeHtml(spots)}</p>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
<tr>
<td style="padding:0 0 12px;">
<a href="${href(respondInUrl)}" style="display:block; text-align:center; padding:14px 16px; background-color:#1f6f4a; color:#ffffff; text-decoration:none; font-weight:700; font-size:16px; border-radius:6px; border:2px solid #1f6f4a;">I'm in</a>
</td>
</tr>
<tr>
<td>
<a href="${href(respondOutUrl)}" style="display:block; text-align:center; padding:14px 16px; background-color:#ffffff; color:#1c1b19; text-decoration:none; font-weight:700; font-size:16px; border-radius:6px; border:2px solid #cfc9bc;">Can't make it</a>
</td>
</tr>
</table>

<p style="margin:16px 0 0; font-size:13px; line-height:1.5; color:#6b6862;">Either one opens a page where you'll tap once more to confirm — nothing is recorded until then.</p>

<hr style="margin:24px 0; border:none; border-top:1px solid #e3ded4;">

<p style="margin:0; font-size:12px; line-height:1.6; color:#928d84;">
Make The Team — organising this Game for your squad.
<br>
Not playing any more? <a href="${href(leaveUrl)}" style="color:#928d84;">Leave this Game</a>.
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
    spots,
    "",
    "I'm in:",
    respondInUrl,
    "",
    "Can't make it:",
    respondOutUrl,
    "",
    "Either link opens a page where you'll tap once more to confirm — nothing is recorded until then.",
    "",
    "---",
    "Make The Team — organising this Game for your squad.",
    `Not playing any more? Leave this Game: ${leaveUrl}`,
    "",
  ].join("\n");

  return { subject, html, text };
}

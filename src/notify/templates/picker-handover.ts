import { escapeHtml } from "../../views/layout.js";

/**
 * Everything the "you're picking the teams" hand-over (N-13, M29) needs to
 * render one Player's copy of it. Pure (TR-20): no clock, no bindings, no
 * database, no lookups — every string arriving here is already exactly what
 * should be shown. The caller (`src/notify/send-picker-handover.ts`) resolves
 * the fixture and builds `pickerUrl` before calling in.
 */
export interface PickerHandoverEmailPayload {
  /** The Player this copy is for. Shown only in a plain greeting. */
  playerName: string;
  gameName: string;
  /** Already formatted in the Game's local timezone by the caller (src/domain/time/zone.ts). Never formatted here. */
  whenLocal: string;
  venueName: string;
  /** Absolute URL of the picker page (`pickerPagePath`), built by the caller against `SITE_ORIGIN`. */
  pickerUrl: string;
  /**
   * A working leave-game/unsubscribe link (BR-22). The recipient is a current
   * squad member of a game they are still in, so the one documented exception
   * to BR-22 (N-7, whose recipient has already left) does not reach here and
   * the link is required exactly as it is on every other notification.
   */
  leaveUrl: string;
}

export interface PickerHandoverEmail {
  subject: string;
  html: string;
  text: string;
}

/** Absolute-URL-safe: escapes for use inside a double-quoted HTML attribute. */
function href(url: string): string {
  return escapeHtml(url);
}

/**
 * Render the email telling somebody the teams are theirs to pick (N-13, BR-22).
 *
 * The copy is deliberately explicit that publishing emails the squad. This is
 * the one notification in the catalogue whose recipient is being handed a
 * control that sends mail to other people, and a delegate who presses Publish
 * expecting a private save would be messaging a squad by accident.
 */
export function renderPickerHandoverEmail(payload: PickerHandoverEmailPayload): PickerHandoverEmail {
  const { playerName, gameName, whenLocal, venueName, pickerUrl, leaveUrl } = payload;

  const subject = `You're picking the teams: ${gameName}, ${whenLocal}`;
  const ask = "The organiser has asked you to pick the teams for this one.";
  const closing =
    "Put everyone who's in on a side, then publish — publishing is what tells the squad, so nothing goes out until you do.";

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
${escapeHtml(ask)}
</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#efe3cd;">
<tr>
<td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px; background-color:#f9f4ed; border:1px solid #d6c9b3; border-radius:20px;">
<tr>
<td style="padding:28px 24px; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; color:#201e1d;">

<p style="margin:0 0 16px; font-size:15px; line-height:1.5; color:#201e1d;">Hi ${escapeHtml(playerName)},</p>

<h1 style="margin:0 0 4px; font-size:22px; line-height:1.3; color:#201e1d;">${escapeHtml(gameName)}</h1>
<p style="margin:0 0 4px; font-size:15px; line-height:1.5; color:#645c50;">${escapeHtml(whenLocal)}</p>
<p style="margin:0 0 16px; font-size:15px; line-height:1.5; color:#645c50;">${escapeHtml(venueName)}</p>

<p style="margin:0 0 20px; font-size:15px; line-height:1.5; color:#201e1d;">${escapeHtml(ask)}</p>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
<tr>
<td>
<a href="${href(pickerUrl)}" style="display:block; text-align:center; padding:14px 16px; background-color:#c67139; color:#fff7f0; text-decoration:none; font-weight:700; font-size:16px; border-radius:999px; border:2px solid #c67139;">Pick the teams</a>
</td>
</tr>
</table>

<p style="margin:16px 0 0; font-size:13px; line-height:1.5; color:#645c50;">${escapeHtml(closing)}</p>

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
    whenLocal,
    venueName,
    "",
    ask,
    "",
    "Pick the teams:",
    pickerUrl,
    "",
    closing,
    "",
    "---",
    "Make The Team — organising this Game for your squad.",
    `Not playing any more? Leave this game: ${leaveUrl}`,
    "",
  ].join("\n");

  return { subject, html, text };
}

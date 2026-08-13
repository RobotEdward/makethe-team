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

  const subject = `You've been removed from ${gameName}`;

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
You've been removed from the squad for ${escapeHtml(gameName)}.
</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f2efe9;">
<tr>
<td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px; background-color:#ffffff; border:1px solid #e3ded4; border-radius:8px;">
<tr>
<td style="padding:28px 24px; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; color:#1c1b19;">

<p style="margin:0 0 16px; font-size:15px; line-height:1.5; color:#1c1b19;">Hi ${escapeHtml(playerName)},</p>

<p style="margin:0 0 16px; font-size:15px; line-height:1.5; color:#1c1b19;">You've been removed from the squad for ${escapeHtml(gameName)}.</p>

<p style="margin:0 0 0; font-size:15px; line-height:1.5; color:#1c1b19;">You'll get no more email about this game. If you think it was a mistake, ask the organiser — they can send you the invite link again.</p>

<hr style="margin:24px 0; border:none; border-top:1px solid #e3ded4;">

<p style="margin:0; font-size:12px; line-height:1.6; color:#928d84;">
Make The Team — organising this Game for your squad.
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
    `You've been removed from the squad for ${gameName}.`,
    "",
    "You'll get no more email about this game. If you think it was a mistake,",
    "ask the organiser — they can send you the invite link again.",
    "",
    "---",
    "Make The Team — organising this Game for your squad.",
    "",
  ].join("\n");

  return { subject, html, text };
}

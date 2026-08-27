import { escapeHtml } from "../../views/layout.js";

/**
 * N-14 (M39, BR-51). The only email the product sends to an address it does
 * not trust yet, so it carries the game's name, the name typed and one link —
 * and deliberately no fixture date, no response, invite or leave link and no
 * squad. Delivered to the wrong inbox, it tells its reader nothing.
 */
export interface JoinConfirmationEmailPayload {
  name: string;
  gameName: string;
  /** Absolute `/join/:jtoken` URL, server-built from `SITE_ORIGIN`. */
  confirmUrl: string;
}

export function renderJoinConfirmationEmail(payload: JoinConfirmationEmailPayload): { subject: string; html: string; text: string } {
  const { name, gameName, confirmUrl } = payload;
  const subject = `Confirm you want to join ${gameName}`;
  const lead = `Someone — probably you — asked to join the squad for ${gameName} as ${name}.`;
  const action = "Tap the button to confirm it's you and take your place in the squad.";
  const ignore = "If you didn't ask for this, ignore it — nothing happens unless you confirm.";
  const expiry = "The link works for seven days.";

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
${escapeHtml(lead)}
</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#efe3cd;">
<tr>
<td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px; background-color:#f9f4ed; border:1px solid #d6c9b3; border-radius:20px;">
<tr>
<td style="padding:28px 24px; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; color:#201e1d;">

<p style="margin:0 0 16px; font-size:15px; line-height:1.5; color:#201e1d;">Hi ${escapeHtml(name)},</p>

<h1 style="margin:0 0 4px; font-size:22px; line-height:1.3; color:#201e1d;">${escapeHtml(gameName)}</h1>

<p style="margin:0 0 12px; font-size:15px; line-height:1.5; color:#201e1d;">${escapeHtml(lead)}</p>

<p style="margin:0 0 20px; font-size:15px; line-height:1.5; color:#645c50;">${escapeHtml(action)}</p>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
<tr>
<td>
<a href="${escapeHtml(confirmUrl)}" style="display:block; text-align:center; padding:14px 16px; background-color:#c67139; color:#fff7f0; text-decoration:none; font-weight:700; font-size:16px; border-radius:999px; border:2px solid #c67139;">Yes, join the squad</a>
</td>
</tr>
</table>

<p style="margin:16px 0 0; font-size:13px; line-height:1.5; color:#645c50;">If the button doesn't work, copy this address into your browser:</p>
<p style="margin:4px 0 0; font-size:12px; line-height:1.5; word-break:break-all; color:#645c50;">${escapeHtml(confirmUrl)}</p>

<p style="margin:16px 0 0; font-size:13px; line-height:1.5; color:#645c50;">${escapeHtml(expiry)}</p>

<hr style="margin:24px 0; border:none; border-top:1px solid #d6c9b3;">

<p style="margin:0; font-size:12px; line-height:1.6; color:#645c50;">${escapeHtml(ignore)}</p>

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
    `Hi ${name},`,
    "",
    gameName,
    "",
    lead,
    action,
    "",
    "Yes, join the squad:",
    confirmUrl,
    "",
    expiry,
    "",
    "---",
    ignore,
    "",
  ].join("\n");

  return { subject, html, text };
}

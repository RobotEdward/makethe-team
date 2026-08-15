import { escapeHtml } from "../../views/layout.js";

/**
 * N-8: erasure scheduled (BR-34).
 *
 * **It carries no leave link, and that is not an oversight.** BR-22 is about
 * leaving a *game*, and this message is not about a game — it is about the
 * account, and its recipient is in the middle of leaving every game at once.
 * `removed.ts` (N-7) documents the same absence for its own reason.
 *
 * The cancel instruction points at sign-in, never at a token link. A token
 * would make cancellation reachable from a forwarded email, which is exactly
 * the opposite of what this message is for: the whole point is that only the
 * account's real owner can stop it.
 */
export interface ErasureScheduledEmailPayload {
  /** The player this copy is for. Shown only in a plain greeting. */
  playerName: string;
  /**
   * The erasure deadline, already formatted for a human by the caller
   * (`src/domain/time/zone.ts`, `Europe/London` — see `send-erasure-scheduled.ts`
   * for why). Never formatted here.
   */
  whenLocal: string;
  /** Absolute URL of the sign-in page. Server-built by the caller from `SITE_ORIGIN`. */
  signInUrl: string;
}

export interface ErasureScheduledEmail {
  subject: string;
  html: string;
  text: string;
}

/** Absolute-URL-safe: escapes for use inside a double-quoted HTML attribute. */
function href(url: string): string {
  return escapeHtml(url);
}

/**
 * Render the email announcing a player's own request to erase their data
 * (N-8, BR-34).
 *
 * The copy is deliberately blunt about what erasure takes with it — every
 * squad, the account, the sign-in itself — because the entire purpose of this
 * message is to give someone who did not ask for this a real chance to notice
 * and stop it before it is irreversible. Softening the list would just make a
 * genuine mistake more likely to go unnoticed until it is too late to undo.
 */
export function renderErasureScheduledEmail(payload: ErasureScheduledEmailPayload): ErasureScheduledEmail {
  const { playerName, whenLocal, signInUrl } = payload;

  const subject = "Your data is scheduled to be erased";

  const whenLine = `Your data will be erased on ${whenLocal}.`;
  const loseLine =
    "That means every squad you're in, your account, and your sign-in — all of it, permanently.";
  const cancelLine = "If this wasn't you, sign in and cancel it before then.";
  const finalLine = "Once it runs, this cannot be undone.";

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
${escapeHtml(whenLine)}
</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f2efe9;">
<tr>
<td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px; background-color:#ffffff; border:1px solid #e3ded4; border-radius:8px;">
<tr>
<td style="padding:28px 24px; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; color:#1c1b19;">

<p style="margin:0 0 16px; font-size:15px; line-height:1.5; color:#1c1b19;">Hi ${escapeHtml(playerName)},</p>

<p style="margin:0 0 16px; font-size:15px; line-height:1.5; color:#1c1b19; font-weight:700;">${escapeHtml(whenLine)}</p>

<p style="margin:0 0 16px; font-size:15px; line-height:1.5; color:#1c1b19;">${escapeHtml(loseLine)}</p>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
<tr>
<td>
<a href="${href(signInUrl)}" style="display:block; text-align:center; padding:14px 16px; background-color:#1f6f4a; color:#ffffff; text-decoration:none; font-weight:700; font-size:16px; border-radius:6px; border:2px solid #1f6f4a;">Sign in to cancel</a>
</td>
</tr>
</table>

<p style="margin:16px 0 0; font-size:13px; line-height:1.5; color:#6b6862;">${escapeHtml(cancelLine)} If the button doesn't work, copy this address into your browser:</p>
<p style="margin:4px 0 0; font-size:12px; line-height:1.5; word-break:break-all; color:#6b6862;">${escapeHtml(signInUrl)}</p>

<p style="margin:16px 0 0; font-size:15px; line-height:1.5; color:#4a4741;">${escapeHtml(finalLine)}</p>

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
    whenLine,
    "",
    loseLine,
    "",
    cancelLine,
    "Sign in:",
    signInUrl,
    "",
    finalLine,
    "",
    "---",
    "Make The Team — organising this Game for your squad.",
    "",
  ].join("\n");

  return { subject, html, text };
}

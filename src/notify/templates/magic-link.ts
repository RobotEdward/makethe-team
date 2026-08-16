import { escapeHtml } from "../../views/layout.js";

/**
 * Everything the sign-in link email (N-5) needs.
 *
 * Pure (TR-20), exactly like `reminder.ts`: no clock, no bindings, no
 * database, and no date maths. The expiry is handed in already worded by the
 * caller, which is the only place that knows what the magic-link plugin was
 * configured with — the template must never restate a duration it cannot see.
 *
 * `signInUrl` is always constructed server-side (Better Auth builds it from
 * `BETTER_AUTH_URL`; nothing user-supplied reaches it). That matters because
 * the `href()` helper below escapes for an HTML attribute but does *not*
 * validate the scheme, so a caller-supplied `javascript:` URL would be
 * embedded verbatim. Keep every URL passed in here server-built.
 */
export interface MagicLinkEmailPayload {
  /** The complete, absolute `/magic-link/verify?token=…` URL. Server-built, never user-supplied. */
  signInUrl: string;
  /** Already worded by the caller, e.g. "5 minutes". Never computed here. */
  expiresInLabel: string;
}

export interface MagicLinkEmail {
  subject: string;
  html: string;
  text: string;
}

/** Absolute-URL-safe: escapes for use inside a double-quoted HTML attribute. */
function href(url: string): string {
  return escapeHtml(url);
}

/**
 * Render the one email that carries a sign-in link (N-5).
 *
 * Unlike the reminder's response links, this link *does* perform an action
 * when followed: it mints a session. Mail scanners follow links, which is
 * precisely why the plugin's expiry is short and each token is consumed on
 * first use — a scanner that burns the link costs the player a re-request,
 * never a silent sign-in they did not make (no cookie ever reaches their
 * browser from a scanner's fetch). The copy says so plainly rather than
 * pretending the tap is inert.
 *
 * The "didn't ask for this" line is not boilerplate: because issuance is
 * deliberately silent about whether an address is known (TR-35), the only
 * person who can tell that a link was requested for their address is the
 * person holding the inbox, and they must be told what to do about it.
 */
export function renderMagicLinkEmail(payload: MagicLinkEmailPayload): MagicLinkEmail {
  const { signInUrl, expiresInLabel } = payload;

  const subject = "Your sign-in link";
  const expiryLine = `This link works once and expires in ${expiresInLabel}.`;
  const ignoreLine = "If you didn't ask to sign in, you can ignore this email — nothing has changed.";

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
${escapeHtml(expiryLine)}
</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f2efe9;">
<tr>
<td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px; background-color:#ffffff; border:1px solid #e3ded4; border-radius:8px;">
<tr>
<td style="padding:28px 24px; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; color:#1c1b19;">

<h1 style="margin:0 0 12px; font-size:22px; line-height:1.3; color:#1c1b19;">Sign in to Make The Team</h1>

<p style="margin:0 0 20px; font-size:15px; line-height:1.5; color:#4a4741;">Tap the button below and you'll be signed in.</p>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
<tr>
<td>
<a href="${href(signInUrl)}" style="display:block; text-align:center; padding:14px 16px; background-color:#1f6f4a; color:#ffffff; text-decoration:none; font-weight:700; font-size:16px; border-radius:6px; border:2px solid #1f6f4a;">Sign in</a>
</td>
</tr>
</table>

<p style="margin:16px 0 0; font-size:13px; line-height:1.5; color:#635f59;">${escapeHtml(expiryLine)}</p>

<p style="margin:12px 0 0; font-size:13px; line-height:1.5; color:#635f59;">If the button doesn't work, copy this address into your browser:</p>
<p style="margin:4px 0 0; font-size:12px; line-height:1.5; word-break:break-all; color:#635f59;">${escapeHtml(signInUrl)}</p>

<hr style="margin:24px 0; border:none; border-top:1px solid #e3ded4;">

<p style="margin:0; font-size:12px; line-height:1.6; color:#928d84;">
${escapeHtml(ignoreLine)}
<br>
Make The Team — organising football for your squad.
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
    "Sign in to Make The Team",
    "",
    "Open this link and you'll be signed in:",
    signInUrl,
    "",
    expiryLine,
    "",
    "---",
    ignoreLine,
    "Make The Team — organising football for your squad.",
    "",
  ].join("\n");

  return { subject, html, text };
}

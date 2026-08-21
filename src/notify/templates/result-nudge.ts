import { escapeHtml } from "../../views/layout.js";

/**
 * Everything the "how did it go?" nudge (N-12, M25, BR-37) needs to render
 * one Player's copy of it. Pure (TR-20): no clock, no bindings, no database,
 * no lookups — every string arriving here is already exactly what should be
 * shown. The caller (`src/notify/send-result-nudge.ts`) resolves the
 * fixture and builds `fixtureUrl` before calling in.
 */
export interface ResultNudgeEmailPayload {
  /** The Player this copy is for. Shown only in a plain greeting. */
  playerName: string;
  gameName: string;
  /** Already formatted in the Game's local timezone by the caller (src/domain/time/zone.ts). Never formatted here. */
  whenLocal: string;
  /** Absolute URL of the fixture page (`fixturePath`), built by the caller against `SITE_ORIGIN`. */
  fixtureUrl: string;
  /**
   * A working leave-game/unsubscribe link (BR-22): `/leave/:token`, scoped to
   * `(gameId, playerId)` rather than to this fixture — the master spec's one
   * documented exception to BR-22 is N-7, and only because its recipient has
   * already left by the time it sends; N-12's recipients are current squad
   * members about a game they are still in, so the exception does not reach
   * this notification and the link is required like every other one here.
   */
  leaveUrl: string;
}

export interface ResultNudgeEmail {
  subject: string;
  html: string;
  text: string;
}

/** Absolute-URL-safe: escapes for use inside a double-quoted HTML attribute. */
function href(url: string): string {
  return escapeHtml(url);
}

/**
 * Render the email asking somebody to record what happened (N-12, BR-22).
 */
export function renderResultNudgeEmail(payload: ResultNudgeEmailPayload): ResultNudgeEmail {
  const { playerName, gameName, whenLocal, fixtureUrl, leaveUrl } = payload;

  const subject = `How did it go? ${gameName}, ${whenLocal}`;
  const ask =
    "Somebody needs to say what the score was. Whoever gets there first, everyone else can agree or put them right.";
  const closing = "This closes 48 hours after kick-off.";

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
<p style="margin:0 0 16px; font-size:15px; line-height:1.5; color:#645c50;">${escapeHtml(whenLocal)}</p>

<p style="margin:0 0 20px; font-size:15px; line-height:1.5; color:#201e1d;">${escapeHtml(ask)}</p>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
<tr>
<td>
<a href="${href(fixtureUrl)}" style="display:block; text-align:center; padding:14px 16px; background-color:#c67139; color:#fff7f0; text-decoration:none; font-weight:700; font-size:16px; border-radius:999px; border:2px solid #c67139;">Record the result</a>
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
    "",
    ask,
    "",
    "Record the result:",
    fixtureUrl,
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

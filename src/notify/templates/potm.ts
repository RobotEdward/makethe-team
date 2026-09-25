import { escapeHtml } from "../../views/layout.js";

/**
 * Everything the player-of-the-match email (N-15, M68) needs for one winner.
 * Pure (TR-20): every string arrives already formatted by the caller
 * (`src/notify/send-potm.ts`).
 */
export interface PotmEmailPayload {
  playerName: string;
  gameName: string;
  /** Kickoff in the Game's local timezone, formatted by the caller. */
  whenLocal: string;
  votes: number;
  /** True when the award is shared with somebody tied on the same count. */
  joint: boolean;
  fixtureUrl: string;
  /** BR-22: every email to a current squad member carries one. */
  leaveUrl: string;
}

export interface PotmEmail {
  subject: string;
  html: string;
  text: string;
}

/** Render the email telling a player their squad voted them player of the match. */
export function renderPotmEmail(payload: PotmEmailPayload): PotmEmail {
  const { playerName, gameName, whenLocal, votes, joint, fixtureUrl, leaveUrl } = payload;

  const subject = `You're player of the match: ${gameName}, ${whenLocal}`;
  const votesWords = `${votes} ${votes === 1 ? "vote" : "votes"}`;
  const news = joint
    ? `Your squad voted you joint player of the match, with ${votesWords}.`
    : `Your squad voted you player of the match, with ${votesWords}.`;

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
${escapeHtml(news)}
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

<p style="margin:0 0 20px; font-size:15px; line-height:1.5; color:#201e1d;">${escapeHtml(news)}</p>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
<tr>
<td>
<a href="${escapeHtml(fixtureUrl)}" style="display:block; text-align:center; padding:14px 16px; background-color:#c67139; color:#fff7f0; text-decoration:none; font-weight:700; font-size:16px; border-radius:999px; border:2px solid #c67139;">See the fixture</a>
</td>
</tr>
</table>

<hr style="margin:24px 0; border:none; border-top:1px solid #d6c9b3;">

<p style="margin:0; font-size:12px; line-height:1.6; color:#645c50;">
Make The Team — organising this Game for your squad.
<br>
Not playing any more? <a href="${escapeHtml(leaveUrl)}" style="color:#645c50;">Leave this game</a>.
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
    news,
    "",
    "See the fixture:",
    fixtureUrl,
    "",
    "---",
    "Make The Team — organising this Game for your squad.",
    `Not playing any more? Leave this game: ${leaveUrl}`,
    "",
  ].join("\n");

  return { subject, html, text };
}

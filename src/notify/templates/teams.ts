import { escapeHtml } from "../../views/layout.js";

/**
 * Everything the teams-published email (N-9) needs to render one Player's
 * copy of it. Pure (TR-20): no clock, no bindings, no database, no lookups —
 * every string arriving here is already exactly what should be shown. The
 * caller (`src/notify/send-teams.ts`) resolves the fixture, decides
 * visibility once via `squadForViewer` (BR-33), and builds the leave URL
 * before calling in.
 */
export interface TeamsEmailParams {
  /** The Player this copy is for. Shown only in a plain greeting. */
  playerName: string;
  gameName: string;
  venueName: string;
  /** Already formatted in the Game's local timezone by the caller (src/domain/time/zone.ts). Never formatted here. */
  whenLocal: string;
  /**
   * The recipient's own side, by name. Always shown, and shown first — it is
   * the one thing every recipient must get from this message, whatever the
   * game's squad-visibility setting does to the rest of it. A player's own
   * response is never routed through `squadForViewer`; it is rendered from
   * their own row, so it survives a `null` below (see
   * `src/domain/squad-visibility.ts`).
   */
  yourSideName: string;
  /**
   * Both full line-ups, or `null` when the game hides its squad from players
   * (BR-33). `null` renders the recipient's own side and nothing else —
   * never an empty list, which would read as "nobody else is playing".
   */
  lineUps: readonly { name: string; players: readonly string[] }[] | null;
  /** A working leave-game/unsubscribe link (BR-22): `/leave/:token`. */
  leaveUrl: string;
}

export interface TeamsEmail {
  subject: string;
  html: string;
  text: string;
}

/** Absolute-URL-safe: escapes for use inside a double-quoted HTML attribute. */
function href(url: string): string {
  return escapeHtml(url);
}

function renderLineUpHtml(lineUp: { name: string; players: readonly string[] }): string {
  const rows =
    lineUp.players.length === 0
      ? `<p style="margin:0 0 12px; font-size:14px; line-height:1.5; color:#645c50;">Nobody.</p>`
      : `<ul style="margin:0 0 12px; padding-left:20px; font-size:14px; line-height:1.6; color:#201e1d;">${lineUp.players
          .map((name) => `<li>${escapeHtml(name)}</li>`)
          .join("")}</ul>`;
  return `<h3 style="margin:0 0 6px; font-size:15px; color:#201e1d;">${escapeHtml(lineUp.name)}</h3>${rows}`;
}

function renderLineUpText(lineUp: { name: string; players: readonly string[] }): string[] {
  return [
    lineUp.name,
    ...(lineUp.players.length === 0 ? ["Nobody."] : lineUp.players.map((name) => `- ${name}`)),
    "",
  ];
}

/**
 * Render the email announcing the teams an organiser has picked for a
 * fixture (N-9, BR-35).
 *
 * **The recipient's own side comes first and is stated plainly.** Everything
 * after it is a bonus: the full line-ups when the game shares them, nothing
 * more when it does not. A recipient who only reads the first line still
 * knows the one fact this email exists to deliver.
 */
export function renderTeamsEmail(payload: TeamsEmailParams): TeamsEmail {
  const { playerName, gameName, venueName, whenLocal, yourSideName, lineUps, leaveUrl } = payload;

  const subject = `${gameName} — teams are up`;
  const lead = `You're on ${yourSideName}.`;

  const lineUpsHtml =
    lineUps === null ? "" : lineUps.map((lineUp) => `<div style="margin:0 0 8px;">${renderLineUpHtml(lineUp)}</div>`).join("");

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

<p style="margin:0 0 16px; font-size:15px; line-height:1.5; color:#201e1d;">Hi ${escapeHtml(playerName)},</p>

<h1 style="margin:0 0 4px; font-size:22px; line-height:1.3; color:#201e1d;">${escapeHtml(gameName)}</h1>
<p style="margin:0 0 2px; font-size:15px; line-height:1.5; color:#645c50;">${escapeHtml(venueName)}</p>
<p style="margin:0 0 16px; font-size:15px; line-height:1.5; color:#645c50;">${escapeHtml(whenLocal)}</p>

<p style="margin:0 0 20px; font-size:17px; line-height:1.5; color:#8c491a; font-weight:700;">${escapeHtml(lead)}</p>

${lineUpsHtml}

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
    whenLocal,
    "",
    lead,
    "",
    ...(lineUps === null ? [] : lineUps.flatMap((lineUp) => renderLineUpText(lineUp))),
    "---",
    "Make The Team — organising this Game for your squad.",
    `Not playing any more? Leave this game: ${leaveUrl}`,
    "",
  ].join("\n");

  return { subject, html, text };
}

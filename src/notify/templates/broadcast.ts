import { escapeHtml } from "../../views/layout.js";

/**
 * Everything the organiser broadcast (N-10) needs. Pure (TR-20): no clock, no
 * bindings, no database. `whenLocal` arrives already formatted in the game's
 * timezone by the caller (TR-5), as in every other template here.
 *
 * The first template in the catalogue rendering text a *person* typed rather
 * than copy written in this repo. Everything from `subject` and `message` is
 * escaped and nothing in it is interpreted — no Markdown, no autolinking — so
 * that what an organiser sees in the textarea is what lands in the inbox, and
 * so that there is exactly one answer to "what can a message do to the HTML".
 */
export interface BroadcastEmailPayload {
  /** The player this copy is for. Shown only in a plain greeting. */
  playerName: string;
  gameName: string;
  /** Who sent it. There is no reply-to (spec §6), so the name is the whole attribution. */
  organiserName: string;
  /** The organiser's own subject line, used verbatim. */
  subject: string;
  /** The organiser's own words. Blank lines separate paragraphs; nothing else is interpreted. */
  message: string;
  /**
   * The fixture's kick-off, already formatted. `null` for a game-scoped
   * broadcast, which has no fixture — and the copy then says nothing about
   * one rather than rendering an empty line, which is how "Your first game is
   * null" reaches an inbox (see `welcome.ts`).
   */
  whenLocal: string | null;
  /** The fixture's venue. `null` alongside `whenLocal`, and for the same reason. */
  venueName: string | null;
  /** A working leave-game link (BR-22), scoped to the game. */
  leaveUrl: string;
}

export interface BroadcastEmail {
  subject: string;
  html: string;
  text: string;
}

/** Absolute-URL-safe: escapes for use inside a double-quoted HTML attribute. */
function href(url: string): string {
  return escapeHtml(url);
}

/**
 * Turn the organiser's message into HTML paragraphs.
 *
 * Escaped **first**, then the newline handling is applied to the escaped
 * string — the other order would let an escape sequence be produced from
 * markup this function itself inserted. A blank line starts a paragraph; a
 * single newline is a `<br>`, because an organiser typing a list of three
 * things expects three lines.
 */
function paragraphs(message: string): string {
  return message
    .split(/\r?\n\s*\r?\n/)
    .map((block) => escapeHtml(block).replace(/\r?\n/g, "<br>"))
    .filter((block) => block.trim() !== "")
    .map(
      (block) =>
        `<p style="margin:0 0 16px; font-size:15px; line-height:1.5; color:#1c1b19;">${block}</p>`,
    )
    .join("\n");
}

/**
 * Render one Player's copy of an organiser's quick message (N-10, §6).
 *
 * A game-scoped broadcast has no fixture, so `whenLocal`/`venueName` are both
 * `null` and the fixture line is omitted rather than rendered blank — see the
 * payload doc comment and `welcome.ts`'s note on the same failure.
 *
 * The layout and palette match `welcome.ts`, `promotion.ts`, `reminder.ts`
 * and `magic-link.ts` on purpose: this is still the same product's mail.
 */
export function renderBroadcastEmail(payload: BroadcastEmailPayload): BroadcastEmail {
  const { playerName, gameName, organiserName, subject, message, whenLocal, venueName, leaveUrl } = payload;

  // The organiser's own words, unprefixed. A product-added prefix would eat
  // the front of the subject line in every mail client's list view, which is
  // the one place the organiser's sixty characters have to work.
  const emailSubject = subject;

  const attribution = `${escapeHtml(organiserName)} sent this to the squad for ${escapeHtml(gameName)}.`;
  const attributionText = `${organiserName} sent this to the squad for ${gameName}.`;

  const hasFixture = whenLocal !== null && venueName !== null;
  const fixtureLine = hasFixture
    ? `<p style="margin:0 0 16px; font-size:14px; line-height:1.5; color:#6b6862;">About ${escapeHtml(whenLocal as string)} at ${escapeHtml(venueName as string)}.</p>`
    : "";
  const fixtureLineText = hasFixture ? `About ${whenLocal} at ${venueName}.` : "";

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${escapeHtml(emailSubject)}</title>
</head>
<body style="margin:0; padding:0; background-color:#f2efe9; color:#1c1b19;">
<div style="display:none; max-height:0; overflow:hidden; opacity:0; mso-hide:all;">
${attribution}
</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f2efe9;">
<tr>
<td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px; background-color:#ffffff; border:1px solid #e3ded4; border-radius:8px;">
<tr>
<td style="padding:28px 24px; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; color:#1c1b19;">

<p style="margin:0 0 16px; font-size:15px; line-height:1.5; color:#1c1b19;">Hi ${escapeHtml(playerName)},</p>

<h1 style="margin:0 0 4px; font-size:22px; line-height:1.3; color:#1c1b19;">${escapeHtml(subject)}</h1>
<p style="margin:0 0 16px; font-size:15px; line-height:1.5; color:#4a4741;">${attribution}</p>

${fixtureLine}
${paragraphs(message)}

<hr style="margin:24px 0; border:none; border-top:1px solid #e3ded4;">

<p style="margin:0; font-size:12px; line-height:1.6; color:#928d84;">
Make The Team — organising this Game for your squad.
<br>
Don't want these? <a href="${href(leaveUrl)}" style="color:#928d84;">Leave this game</a>.
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
    subject,
    attributionText,
    "",
    ...(hasFixture ? [fixtureLineText, ""] : []),
    message,
    "",
    "---",
    "Make The Team — organising this Game for your squad.",
    `Don't want these? Leave this game: ${leaveUrl}`,
    "",
  ].join("\n");

  return { subject: emailSubject, html, text };
}

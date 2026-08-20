import { escapeHtml } from "../../views/layout.js";

/**
 * Everything the welcome email (N-6) needs to render one Player's copy of it.
 * Every string arriving here is already exactly what should be shown — this
 * module does no date maths, no lookups, no formatting of its own. It is pure
 * (TR-20): no clock, no bindings, no database. The caller
 * (`src/notify/send-welcome.ts`, from the invite-link join) resolves the Game,
 * finds the next `scheduled` Fixture and formats its kick-off in the Game's
 * timezone before calling in.
 *
 * The only email in the catalogue with no Fixture behind it: N-6 is about
 * joining a *squad*, and a squad can be joined before any Fixture exists.
 * That is why `whenLocal` is nullable — see `renderWelcomeEmail`.
 *
 * Its leave link is a leave token, not a response token, unlike `promotion.ts`
 * and `reminder.ts`: those are scoped to a Fixture, and this email is sent
 * when there may be no Fixture to scope one to. A leave token is scoped to
 * the Game instead (BR-22, §2.2), which is exactly the gap N-6 used to carry
 * — someone who joins and never wants to hear from this squad again had no
 * working way to say so until now.
 */
export interface WelcomeEmailPayload {
  /** The Player this copy of the email is for. Shown only in a plain greeting. */
  playerName: string;
  gameName: string;
  /** The venue of their first Fixture if there is one, else the Game's default. Resolved by the caller. */
  venueName: string;
  /**
   * Their **first** Fixture's kick-off, already formatted in the Game's local
   * timezone by the caller (src/domain/time/zone.ts). Never formatted here.
   *
   * `null` when the Game has no `scheduled` Fixture ahead of it — a squad can
   * be joined before the sweep has materialised anything, and the copy says so
   * rather than rendering an empty date.
   */
  whenLocal: string | null;
  /** Absolute URL of the player dashboard. Server-built by the caller from `SITE_ORIGIN`. */
  dashboardUrl: string;
  /**
   * A working leave-game/unsubscribe link (BR-22), scoped to the Game rather
   * than to any Fixture — see the module doc comment for why N-6 needs that
   * and not a response token.
   */
  leaveUrl: string;
}

export interface WelcomeEmail {
  subject: string;
  html: string;
  text: string;
}

/** Absolute-URL-safe: escapes for use inside a double-quoted HTML attribute. */
function href(url: string): string {
  return escapeHtml(url);
}

/**
 * Render the one email a Player gets when they join a squad (N-6, §4.4).
 *
 * Three things the copy is deliberately careful about:
 *
 * - **The first fixture is not necessarily the current one (BR-2).** A Player
 *   who joins after a Fixture has already `open`ed is not in it: `pending`
 *   response rows were written for the eligible set at the moment it opened
 *   and nothing back-fills them. So `whenLocal` is the next *`scheduled`*
 *   Fixture, and the copy calls it "your first game" rather than "the next
 *   game" — the next game may well be one they are watching from outside.
 * - **A squad can have no fixtures yet.** With `whenLocal` null the email says
 *   the diary is empty and that they will hear when it is not, rather than
 *   printing a blank line where a date should be. Getting this wrong is how an
 *   email arrives reading "Your first game is null".
 * - **It sets the expectation for every later email.** This is the one message
 *   that can explain the day-before reminder and its two buttons before the
 *   first one lands, so the first reminder is a familiar thing rather than an
 *   unexplained one.
 *
 * The layout and the palette match `promotion.ts`, `reminder.ts` and
 * `magic-link.ts` on purpose: for most Players this is the first mail they
 * ever get from the product, and every later one should read as coming from
 * the same place.
 */
export function renderWelcomeEmail(payload: WelcomeEmailPayload): WelcomeEmail {
  const { playerName, gameName, venueName, whenLocal, dashboardUrl, leaveUrl } = payload;

  const subject = `You're in the squad for ${gameName}`;

  const lead = "You joined from this Game's invite link, so you're in the squad.";
  // BR-2 in one sentence: what they are told about is their *first* game, which
  // is the next scheduled one — never a fixture that is already open.
  const firstGameLine =
    whenLocal === null
      ? "Your first game isn't in the diary yet — you'll get an email as soon as one is."
      : `Your first game is ${whenLocal}.`;
  const reminderLine =
    "The day before each game you'll get an email with two buttons — “I'm in” and “Can't make it”. One tap is the whole job.";

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
<p style="margin:0 0 16px; font-size:15px; line-height:1.5; color:#645c50;">${escapeHtml(venueName)}</p>

<p style="margin:0 0 12px; font-size:15px; line-height:1.5; color:#8c491a; font-weight:700;">${escapeHtml(lead)}</p>

<p style="margin:0 0 12px; font-size:15px; line-height:1.5; color:#201e1d;">${escapeHtml(firstGameLine)}</p>

<p style="margin:0 0 20px; font-size:15px; line-height:1.5; color:#645c50;">${escapeHtml(reminderLine)}</p>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
<tr>
<td>
<a href="${href(dashboardUrl)}" style="display:block; text-align:center; padding:14px 16px; background-color:#c67139; color:#fff7f0; text-decoration:none; font-weight:700; font-size:16px; border-radius:999px; border:2px solid #c67139;">See your games</a>
</td>
</tr>
</table>

<p style="margin:16px 0 0; font-size:13px; line-height:1.5; color:#645c50;">If the button doesn't work, copy this address into your browser:</p>
<p style="margin:4px 0 0; font-size:12px; line-height:1.5; word-break:break-all; color:#645c50;">${escapeHtml(dashboardUrl)}</p>

<hr style="margin:24px 0; border:none; border-top:1px solid #d6c9b3;">

<p style="margin:0; font-size:12px; line-height:1.6; color:#645c50;">
Make The Team — organising this Game for your squad.
<br>
Didn't mean to join? <a href="${href(leaveUrl)}" style="color:#645c50;">Leave this game</a>.
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
    "",
    lead,
    "",
    firstGameLine,
    "",
    reminderLine,
    "",
    "See your games:",
    dashboardUrl,
    "",
    "---",
    "Make The Team — organising this Game for your squad.",
    `Didn't mean to join? Leave this game: ${leaveUrl}`,
    "",
  ].join("\n");

  return { subject, html, text };
}

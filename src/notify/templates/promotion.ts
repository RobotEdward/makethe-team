import { escapeHtml } from "../../views/layout.js";

/**
 * Everything the waitlist-promotion email (N-2) needs to render one Player's
 * copy of it. Every string arriving here is already exactly what should be
 * shown — this module does no date maths, no lookups, no formatting of its
 * own. It is pure (TR-20): no clock, no bindings, no database. The caller
 * (`src/notify/send-promotion.ts`, from `POST /r/:token`) resolves the
 * Fixture, signs this Player's token, and builds every URL below before
 * calling in.
 *
 * Deliberately narrower than `ReminderEmailPayload`: there is no `inCount`
 * and no `spotsLeft`. A promotion happens precisely because the fixture was
 * full and a slot was freed and immediately re-taken by this Player, so
 * "spots left" is 0 by construction at send time and would read as a nudge to
 * recruit rather than the confirmation this email is. The counts are on the
 * fixture page one tap away, where they are live rather than a snapshot of
 * the instant the mail was queued.
 *
 * The three links are carried as complete, absolute URLs rather than a bare
 * token plus a path this module would have to assemble — same reasoning as
 * the reminder: this module stays ignorant of the site's origin and of how
 * the leave-game action is implemented.
 */
export interface PromotionEmailPayload {
  /** The Player this copy of the email is for. Shown only in a plain greeting. */
  playerName: string;
  gameName: string;
  venueName: string;
  /** Already formatted in the Game's local timezone by the caller (src/domain/time/zone.ts). Never formatted here. */
  kicksOffAtLocal: string;
  /**
   * `GET /r/<token>?intent=in` — opens the response page. The Player is
   * *already* `in` by the time this email is sent (the Durable Object moved
   * them inside the capacity lock), so this link confirms nothing and records
   * nothing: it is how they see the squad and the details. See the doc
   * comment on `renderPromotionEmail` for why the copy is careful about that.
   */
  respondInUrl: string;
  /** As `respondInUrl`, but opens with "Can't make it" emphasised — the way a promoted Player hands the spot straight back. */
  respondOutUrl: string;
  /**
   * A working leave-game/unsubscribe link (BR-22): `/leave/:token`, signed
   * with a leave token scoped to the Game rather than to this Fixture. This
   * module only ever embeds whatever URL it is given and never inspects it,
   * so how that token is built needs no edit here.
   */
  leaveUrl: string;
}

export interface PromotionEmail {
  subject: string;
  html: string;
  text: string;
}

/** Absolute-URL-safe: escapes for use inside a double-quoted HTML attribute. */
function href(url: string): string {
  return escapeHtml(url);
}

/**
 * Render the single email a Player gets when a slot they were waiting for
 * came free and they took it (N-2, BR-7).
 *
 * Two things the copy is deliberately careful about:
 *
 * - **The promotion has already happened.** The Player is `in` before this
 *   message is built, so nothing here asks them to accept or confirm. Saying
 *   "tap to claim your spot" would be a lie, and a lie with a race in it: the
 *   spot is theirs whether or not they ever open the mail.
 * - **The links still record nothing.** Mail scanners follow every link in
 *   every email; both of these open the response page, where the single
 *   deliberate tap happens. That is the same guarantee the reminder makes,
 *   and it is why "Can't make it" is a link to a page rather than a one-tap
 *   withdrawal — a prefetcher must not be able to give the spot away again.
 *
 * The layout and the palette match `reminder.ts` on purpose, including the
 * filled/solid treatment of the accept action: these are the two emails a
 * Player receives about a Fixture, and they should read as coming from the
 * same place.
 */
export function renderPromotionEmail(payload: PromotionEmailPayload): PromotionEmail {
  const { playerName, gameName, venueName, kicksOffAtLocal, respondInUrl, respondOutUrl, leaveUrl } = payload;

  const subject = `${gameName} — you're in`;

  const lead = "A spot opened up and it's yours — you're off the waitlist and in the squad.";
  const caveat = "Nothing to do to accept: the spot is already yours. If you can't make it after all, say so and it goes to the next player waiting.";

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
${escapeHtml(lead)}
</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f2efe9;">
<tr>
<td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px; background-color:#ffffff; border:1px solid #e3ded4; border-radius:8px;">
<tr>
<td style="padding:28px 24px; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; color:#1c1b19;">

<p style="margin:0 0 16px; font-size:15px; line-height:1.5; color:#1c1b19;">Hi ${escapeHtml(playerName)},</p>

<h1 style="margin:0 0 4px; font-size:22px; line-height:1.3; color:#1c1b19;">${escapeHtml(gameName)}</h1>
<p style="margin:0 0 2px; font-size:15px; line-height:1.5; color:#4a4741;">${escapeHtml(venueName)}</p>
<p style="margin:0 0 16px; font-size:15px; line-height:1.5; color:#4a4741;">${escapeHtml(kicksOffAtLocal)}</p>

<p style="margin:0 0 20px; font-size:15px; line-height:1.5; color:#1f6f4a; font-weight:700;">${escapeHtml(lead)}</p>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
<tr>
<td style="padding:0 0 12px;">
<a href="${href(respondInUrl)}" style="display:block; text-align:center; padding:14px 16px; background-color:#1f6f4a; color:#ffffff; text-decoration:none; font-weight:700; font-size:16px; border-radius:6px; border:2px solid #1f6f4a;">See the Game</a>
</td>
</tr>
<tr>
<td>
<a href="${href(respondOutUrl)}" style="display:block; text-align:center; padding:14px 16px; background-color:#ffffff; color:#1c1b19; text-decoration:none; font-weight:700; font-size:16px; border-radius:6px; border:2px solid #cfc9bc;">Can't make it</a>
</td>
</tr>
</table>

<p style="margin:16px 0 0; font-size:13px; line-height:1.5; color:#6b6862;">${escapeHtml(caveat)}</p>

<hr style="margin:24px 0; border:none; border-top:1px solid #e3ded4;">

<p style="margin:0; font-size:12px; line-height:1.6; color:#928d84;">
Make The Team — organising this Game for your squad.
<br>
Not playing any more? <a href="${href(leaveUrl)}" style="color:#928d84;">Leave this game</a>.
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
    kicksOffAtLocal,
    "",
    lead,
    "",
    "See the Game:",
    respondInUrl,
    "",
    "Can't make it:",
    respondOutUrl,
    "",
    caveat,
    "",
    "---",
    "Make The Team — organising this Game for your squad.",
    `Not playing any more? Leave this game: ${leaveUrl}`,
    "",
  ].join("\n");

  return { subject, html, text };
}

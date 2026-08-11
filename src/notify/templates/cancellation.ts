import { escapeHtml } from "../../views/layout.js";
import type { ResponseStatus } from "../../domain/response-status.js";

/**
 * Everything the fixture-cancellation email (N-3) needs to render one
 * Player's copy of it. Every string arriving here is already exactly what
 * should be shown — this module does no date maths, no lookups, no
 * formatting of its own. It is pure (TR-20): no clock, no bindings, no
 * database. The caller (a later task's `cancelFixture` operation) resolves
 * the Fixture, decides who to mail with `isCancellationRecipient` below, and
 * builds the leave URL before calling in.
 *
 * Unlike the reminder and promotion emails, there is no response link here:
 * the fixture is off, so there is nothing left to accept or decline. The
 * only action offered is leaving the Game altogether (BR-22).
 */
export interface CancellationEmailPayload {
  /** The Player this copy of the email is for. Shown only in a plain greeting. */
  playerName: string;
  gameName: string;
  venueName: string;
  /** Already formatted in the Game's local timezone by the caller (src/domain/time/zone.ts). Never formatted here. */
  kicksOffAtLocal: string;
  /**
   * Free text typed by the Owner when they cancelled the fixture (BR-20).
   * Optional: absent when no reason was given, in which case the message
   * still reads correctly without it. A reason that is empty or
   * whitespace-only after trimming is treated the same as absent — there is
   * nothing worth a "Reason given" block if the Owner typed nothing but
   * spaces.
   *
   * This is the first genuinely owner-authored free text to reach an email
   * in this project — everything else so far is server-constructed or a
   * player's name. It is treated as hostile: escaped in the HTML rendition
   * like any other string, and additionally quoted line-by-line in the text
   * rendition so it cannot forge a fake header, a fake footer separator, or
   * impersonate the message's own "Make The Team" framing (see
   * `quoteReasonLines` below).
   */
  reason?: string;
  /**
   * A working leave-game/unsubscribe link (BR-22). Currently
   * `/leave/:token`, which explains that leaving is not self-service yet;
   * this module only ever embeds whatever URL it is given and never inspects
   * it, so that change needs no edit here.
   */
  leaveUrl: string;
}

export interface CancellationEmail {
  subject: string;
  html: string;
  text: string;
}

/** Absolute-URL-safe: escapes for use inside a double-quoted HTML attribute. */
function href(url: string): string {
  return escapeHtml(url);
}

/**
 * BR-20: who gets told a fixture was cancelled. Exactly the Players who held
 * or wanted a slot — `in` or `waitlisted` — and never a guest, who has no
 * address to mail (BR-32). `pending`, `out`, and `withdrawn` never receive
 * this message: `pending` and `out` never committed to the slot, and
 * `withdrawn` explicitly gave it back.
 *
 * A pure predicate rather than a query, so the recipient rule can be pinned
 * here, independently of however the wiring task ends up selecting rows.
 */
export function isCancellationRecipient(status: ResponseStatus, isGuest: boolean): boolean {
  if (isGuest) return false;
  return status === "in" || status === "waitlisted";
}

/**
 * Every line-terminator this quoting treats as a line break. A reason is
 * hostile input — chosen by whoever typed the cancellation reason, not by a
 * text editor — so "what line separators does a real editor produce" is
 * the wrong question; the right one is "what will some plain-text renderer
 * on the receiving end treat as a line break."
 *
 * This set is pinned to exactly the boundaries Python's `str.splitlines()`
 * recognises (CPython's `STRINGLIB_ISLINEBREAK` set) — that standard is
 * cited explicitly so the set below can be checked against it rather than
 * argued about one character at a time:
 *
 * - `\r\n` (CRLF) — tried before bare `\r` in the alternation so a CRLF
 *   pair is not split into a spurious blank line.
 * - `\n` (LF) and bare `\r` (CR, classic Mac line endings) — the original
 *   review's bypass.
 * - `\v` / U+000B (LINE TABULATION) and `\f` / U+000C (FORM FEED).
 * - U+001C (FILE SEPARATOR), U+001D (GROUP SEPARATOR), U+001E (RECORD
 *   SEPARATOR) — the round-2 review's reproduced bypass: `splitlines()`
 *   treats all three as line breaks, but the previous version of this set
 *   omitted them despite citing `splitlines()` as its own justification.
 * - U+0085 (NEL, NEXT LINE) — a line terminator with a long history outside
 *   ASCII-only systems.
 * - U+2028 (LINE SEPARATOR) and U+2029 (PARAGRAPH SEPARATOR) —
 *   Unicode-mandated line breaks (UAX #14) that browsers honour in rendered
 *   text and that some HTML-izing plain-text-to-HTML mail converters follow.
 *   The *text* rendition here is delivered as MIME `text/plain`, so most
 *   direct plain-text viewers won't act on these — but since some
 *   renderers do, and the cost of handling them is one more character
 *   class, they're included too.
 *
 * Deliberately not included: things `splitlines()` itself does not treat as
 * a line break — e.g. U+00A0 no-break space, ordinary tabs — since treating
 * those as line breaks would just fragment ordinary reason text for no
 * anti-forgery benefit.
 *
 * `test/notify/templates/cancellation.test.ts` enumerates this exact set
 * table-driven, one case per separator listed above, so silently dropping
 * any single member here fails a test instead of surviving until someone
 * thinks to try it.
 */
// \v, \f, and the U+001C–U+001E separators below are deliberately included
// as line-break conventions (per str.splitlines(), see above), not
// accidental control characters; ESLint's no-control-regex flags them
// regardless, so the whole class is disabled here, narrowly, for this one
// regex literal.
// eslint-disable-next-line no-control-regex
const LINE_SEPARATOR = /\r\n|[\r\n\u000b\u000c\u001c\u001d\u001e\u0085\u2028\u2029]/;

/**
 * Quote an owner-authored reason line-by-line, the way a reply quotes an
 * earlier message. Every line — including blank ones — gets a `> ` prefix.
 *
 * This is what stops a hostile reason from forging structure in the plain
 * text rendition: without it, a reason of "---\nMake The Team — organising
 * this Game for your squad.\nUnsubscribe: https://evil.example" would be
 * indistinguishable from the template's own footer once concatenated into
 * one string. Prefixing every line means an attacker's "---" reads as
 * `> ---`, never as the real separator, no matter what the reason contains
 * or which of `LINE_SEPARATOR`'s line-break conventions it uses.
 */
function quoteReasonLines(reason: string): string {
  return reason
    .split(LINE_SEPARATOR)
    .map((line) => `> ${line}`)
    .join("\n");
}

/**
 * Render the single email a Player gets when a Fixture they were `in` or
 * `waitlisted` for is cancelled (N-3, BR-20).
 *
 * The copy is deliberately unambiguous that the game is off, not merely in
 * doubt: no conditional language, no response links (there is nothing left
 * to accept or decline), and the cancelled notice is the first thing in the
 * body, styled as a warning rather than the confirmation green the
 * promotion and reminder emails use for a still-on fixture.
 */
export function renderCancellationEmail(payload: CancellationEmailPayload): CancellationEmail {
  const { playerName, gameName, venueName, kicksOffAtLocal, leaveUrl } = payload;
  // A reason that is empty or whitespace-only after trimming is treated as
  // absent, same as no reason at all — see the payload's `reason` doc.
  const reason = payload.reason && payload.reason.trim().length > 0 ? payload.reason : undefined;

  const subject = `${gameName} — cancelled`;
  const lead = "This game has been cancelled — it is not going ahead.";

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
<td align="center" style="padding:24px 12px; background-color:#f2efe9;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px; background-color:#ffffff; border:1px solid #e3ded4; border-radius:8px;">
<tr>
<td style="padding:28px 24px; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; color:#1c1b19; background-color:#ffffff;">

<p style="margin:0 0 16px; font-size:15px; line-height:1.5; color:#1c1b19; background-color:#ffffff;">Hi ${escapeHtml(playerName)},</p>

<p style="margin:0 0 16px; padding:12px 14px; font-size:15px; line-height:1.5; color:#7a1f1f; background-color:#fbe9e7; font-weight:700; border-radius:6px;">${escapeHtml(lead)}</p>

<h1 style="margin:0 0 4px; font-size:22px; line-height:1.3; color:#1c1b19; background-color:#ffffff;">${escapeHtml(gameName)}</h1>
<p style="margin:0 0 2px; font-size:15px; line-height:1.5; color:#4a4741; background-color:#ffffff;">${escapeHtml(venueName)}</p>
<p style="margin:0 0 16px; font-size:15px; line-height:1.5; color:#4a4741; background-color:#ffffff;">${escapeHtml(kicksOffAtLocal)}</p>

${
  reason
    ? `<p style="margin:0 0 4px; font-size:12px; line-height:1.5; color:#6b6862; background-color:#ffffff; text-transform:uppercase; letter-spacing:0.03em;">Reason given</p>
<p style="margin:0 0 20px; padding:12px 14px; font-size:14px; line-height:1.5; color:#4a4741; background-color:#f2efe9; border-left:3px solid #cfc9bc; border-radius:2px;">${escapeHtml(reason)}</p>`
    : ""
}

<p style="margin:0 0 0; font-size:14px; line-height:1.5; color:#4a4741; background-color:#ffffff;">No action needed — there's nothing to respond to. If you'd rather not hear about this Game again, you can leave it below.</p>

<hr style="margin:24px 0; border:none; border-top:1px solid #e3ded4;">

<p style="margin:0; font-size:12px; line-height:1.6; color:#928d84; background-color:#ffffff;">
Make The Team — organising this Game for your squad.
<br>
Not playing any more? <a href="${href(leaveUrl)}" style="color:#928d84; background-color:#ffffff;">See how to leave this Game</a>.
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
    lead.toUpperCase(),
    "",
    gameName,
    venueName,
    kicksOffAtLocal,
    "",
    ...(reason ? ["Reason given:", quoteReasonLines(reason), ""] : []),
    "No action needed — there's nothing to respond to. If you'd rather not hear about this Game again, you can leave it below.",
    "",
    "---",
    "Make The Team — organising this Game for your squad.",
    `Not playing any more? See how to leave this Game: ${leaveUrl}`,
    "",
  ].join("\n");

  return { subject, html, text };
}

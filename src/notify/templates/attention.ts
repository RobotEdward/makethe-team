import { escapeHtml } from "../../views/layout.js";

/**
 * Everything the owner attention email (N-4, BR-31, J5) needs to render one
 * Owner's copy of it. Every string arriving here is already exactly what
 * should be shown — this module does no date maths, no lookups, no
 * formatting of its own. It is pure (TR-20): no clock, no bindings, no
 * database. The caller (`src/sweep/attention.ts`) resolves the Fixture,
 * decides *whether* there is a problem at all (via `fixtureView`), reads the
 * squad, signs the cancel token and builds the URL before calling in.
 */

/**
 * The specific problem the Owner is being told about, as decided by
 * `fixtureView` — never re-derived here.
 *
 * The two cases are kept as a discriminated union rather than a pair of
 * booleans because they are genuinely different asks and the copy has to say
 * so: "you are two short" is a plea for two more bodies before the game can
 * go ahead at all, while "you have an odd number" is a fixture that is on and
 * playable but will have someone sitting out or uneven sides. Telling an
 * Owner with eleven confirmed players that they are "short" would be simply
 * false, and would train them to ignore the email.
 *
 * Being short dominates parity (BR-30, and `fixtureView`'s own comment), so
 * the two are mutually exclusive by construction, which a union expresses and
 * two flags do not.
 */
export type AttentionProblem =
  /** Below `minPlayers` inside the warning window. `inCount < minPlayers` always. */
  | { kind: "short"; inCount: number; minPlayers: number }
  /** At or above the minimum, but an odd number on a Game that prefers even sides. */
  | { kind: "uneven"; inCount: number };

export interface AttentionEmailPayload {
  /** The Owner this copy is for. Shown only in a plain greeting. */
  ownerName: string;
  gameName: string;
  venueName: string;
  /** Already formatted in the Game's local timezone by the caller (src/domain/time/zone.ts). Never formatted here. */
  kicksOffAtLocal: string;
  problem: AttentionProblem;
  /** Names of the players currently holding a slot, in the squad's display order. */
  inPlayers: readonly string[];
  /** Names of squad members who have not answered yet — the Owner's most obvious lever. */
  nonResponders: readonly string[];
  /**
   * The one-tap cancel link (`/cancel/:token`, Task 2 / BR-14 / J5), built by
   * the caller from a freshly signed cancel token. This module only ever
   * embeds the URL it is given and never inspects or constructs one.
   */
  cancelUrl: string;
  /**
   * True when the daily send ceiling (TR-31) is refusing messages at the
   * moment this email is being built — either because the day's quota is
   * exhausted or because `MAX_EMAILS_PER_DAY` is missing/unparseable and has
   * failed closed to zero.
   *
   * This is the owner-visible half of TR-31's warning, and it is deliberately
   * only the *half*. The recursion is obvious once stated: if the ceiling is
   * biting hard enough to matter, the very message carrying this warning is
   * itself liable to be refused. The durable half — an `audit_log` row
   * written whenever a ceiling refusal costs a real message — is what does
   * not depend on an email getting through; see `src/sweep/attention.ts`.
   */
  ceilingReached: boolean;
}

export interface AttentionEmail {
  subject: string;
  html: string;
  text: string;
}

/** Absolute-URL-safe: escapes for use inside a double-quoted HTML attribute. */
function href(url: string): string {
  return escapeHtml(url);
}

/** How many more players are needed. Presentation arithmetic only — the *judgement* was `fixtureView`'s. */
function shortBy(problem: Extract<AttentionProblem, { kind: "short" }>): number {
  return Math.max(0, problem.minPlayers - problem.inCount);
}

function subjectFor(gameName: string, problem: AttentionProblem): string {
  return problem.kind === "short"
    ? `${gameName} — ${shortBy(problem)} short`
    : `${gameName} — odd number in`;
}

/**
 * The one sentence that says what is wrong, in plain words.
 *
 * The word "short" appears only in the short branch: an odd-numbered fixture
 * is not short of anybody, and mixing the vocabulary would make the two
 * emails read as the same alarm.
 */
function problemLine(problem: AttentionProblem): string {
  if (problem.kind === "short") {
    const needed = shortBy(problem);
    return `You're ${needed} ${needed === 1 ? "player" : "players"} short — ${problem.inCount} in, ${problem.minPlayers} needed.`;
  }
  return `You've got an odd number — ${problem.inCount} in, so it's uneven sides or someone sits out.`;
}

/** What the Owner could actually do about it. Different problem, different ask. */
function askLine(problem: AttentionProblem): string {
  return problem.kind === "short"
    ? "Chase whoever hasn't answered, bring in a guest, or call it off below."
    : "One more in (or one fewer) evens it up. Nothing needs to change if you're happy to play as you are.";
}

const CEILING_LINE =
  "Heads up: Make The Team has hit its daily email limit, so some messages about your games may not have gone out. Check with your squad rather than assuming everyone was told.";

function nameList(names: readonly string[], emptyText: string): string {
  return names.length === 0 ? emptyText : names.join(", ");
}

/**
 * Render the single email an Owner gets when a Fixture of theirs needs their
 * attention (N-4, BR-31, J5, SC-4).
 *
 * At most one of these is ever sent per Owner per Fixture — enforced by
 * `attentionKey`'s deliberately timestamp-free dedupe key and the unique index
 * behind it, not by anything here — so this one message has to carry
 * everything the Owner needs to act: what is wrong, who is in, who has not
 * answered, and a way to call the game off without hunting for a login.
 */
export function renderAttentionEmail(payload: AttentionEmailPayload): AttentionEmail {
  const { ownerName, gameName, venueName, kicksOffAtLocal, problem, inPlayers, nonResponders, cancelUrl, ceilingReached } =
    payload;

  const subject = subjectFor(gameName, problem);
  const lead = problemLine(problem);
  const ask = askLine(problem);
  const inLine = `In (${inPlayers.length}): ${nameList(inPlayers, "Nobody is in yet.")}`;
  const waitingLine =
    nonResponders.length === 0
      ? "Everyone has answered."
      : `Not answered yet (${nonResponders.length}): ${nameList(nonResponders, "")}`;

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
<td align="center" style="padding:24px 12px; background-color:#efe3cd;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px; background-color:#f9f4ed; border:1px solid #d6c9b3; border-radius:20px;">
<tr>
<td style="padding:28px 24px; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; color:#201e1d; background-color:#f9f4ed;">

<p style="margin:0 0 16px; font-size:15px; line-height:1.5; color:#201e1d; background-color:#f9f4ed;">Hi ${escapeHtml(ownerName)},</p>

<p style="margin:0 0 16px; padding:12px 14px; font-size:15px; line-height:1.5; color:#8a4c14; background-color:#ffe1d0; font-weight:700; border-radius:12px;">${escapeHtml(lead)}</p>

<h1 style="margin:0 0 4px; font-size:22px; line-height:1.3; color:#201e1d; background-color:#f9f4ed;">${escapeHtml(gameName)}</h1>
<p style="margin:0 0 2px; font-size:15px; line-height:1.5; color:#645c50; background-color:#f9f4ed;">${escapeHtml(venueName)}</p>
<p style="margin:0 0 16px; font-size:15px; line-height:1.5; color:#645c50; background-color:#f9f4ed;">${escapeHtml(kicksOffAtLocal)}</p>

<p style="margin:0 0 6px; font-size:14px; line-height:1.5; color:#645c50; background-color:#f9f4ed;">${escapeHtml(inLine)}</p>
<p style="margin:0 0 20px; font-size:14px; line-height:1.5; color:#645c50; background-color:#f9f4ed;">${escapeHtml(waitingLine)}</p>

<p style="margin:0 0 20px; font-size:14px; line-height:1.5; color:#645c50; background-color:#f9f4ed;">${escapeHtml(ask)}</p>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
<tr>
<td>
<a href="${href(cancelUrl)}" style="display:block; text-align:center; padding:14px 16px; background-color:#ebddc5; color:#a4321f; text-decoration:none; font-weight:700; font-size:16px; border-radius:999px; border:2px solid #ebddc5;">Call this game off</a>
</td>
</tr>
</table>

<p style="margin:16px 0 0; font-size:13px; line-height:1.5; color:#645c50; background-color:#f9f4ed;">That opens a page showing exactly who would be told, and you tap once more to confirm — nothing happens until then.</p>
${
  ceilingReached
    ? `
<p style="margin:16px 0 0; padding:12px 14px; font-size:13px; line-height:1.5; color:#a4321f; background-color:#ffe1d0; border-radius:12px;">${escapeHtml(CEILING_LINE)}</p>`
    : ""
}

<hr style="margin:24px 0; border:none; border-top:1px solid #d6c9b3;">

<p style="margin:0; font-size:12px; line-height:1.6; color:#645c50; background-color:#f9f4ed;">
Make The Team — you're getting this because you organise this Game. It's sent once per game, not once per hour.
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
    `Hi ${ownerName},`,
    "",
    lead,
    "",
    gameName,
    venueName,
    kicksOffAtLocal,
    "",
    inLine,
    waitingLine,
    "",
    ask,
    "",
    "Call this game off:",
    cancelUrl,
    "That opens a page showing exactly who would be told, and you tap once more to confirm — nothing happens until then.",
    ...(ceilingReached ? ["", CEILING_LINE] : []),
    "",
    "---",
    "Make The Team — you're getting this because you organise this Game. It's sent once per game, not once per hour.",
    "",
  ].join("\n");

  return { subject, html, text };
}

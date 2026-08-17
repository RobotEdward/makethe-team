import { gamePath } from "../auth/paths.js";
import { escapeHtml, layout } from "./layout.js";
import { FIXTURE_STYLES_CSS, FORM_CSS } from "./styles.js";

export interface SquadMemberPageOptions {
  gameId: string;
  gameName: string;
  /** Already through `displayName` by the caller — never a raw column. */
  memberName: string;
  /** Null for a guest, who has no contact details (§2.8, BR-32). */
  email: string | null;
  isGuest: boolean;
  role: "player" | "owner";
  /** Already formatted in the game's timezone by the caller (TR-5). */
  joinedAtLocal: string;
}

/**
 * One squad member as their organiser sees them (M11).
 *
 * **Read-only, and there is no form on this page at all** — which is why the
 * route needs no origin check. The two things an organiser may actually do to
 * a member, role and removal, stay in the per-member disclosure on the game
 * overview; the closing link goes back there instead of duplicating them,
 * because two copies of a destructive control is one more than can be kept in
 * step.
 *
 * **No fixture history, and nothing from any other game.** An organiser is
 * entitled to their own squad, not to a person: what this player does
 * elsewhere is not this organiser's business, and there is no way to render
 * "only fixtures from this game" that does not immediately raise the question
 * of why not the rest. `src/views/account.ts` is the page that answers that
 * question, and only the player themselves can reach it.
 */
export function renderSquadMemberPage({
  gameId,
  gameName,
  memberName,
  email,
  isGuest,
  role,
  joinedAtLocal,
}: SquadMemberPageOptions): string {
  // An address we hold is a value, and gets the caption-above-value treatment:
  // the dashed .read-only box means "nothing here to act on", which of a value
  // reads as a field that has been disabled on you, and this organiser could
  // never have edited another player's address anyway.
  //
  // The other branch keeps the box, because it is not a value at all — it is
  // an absence, and the state it describes really is one the organiser cannot
  // act on: a guest was never asked for an address, and no form on this page
  // or anywhere else lets an organiser supply one for somebody else. It needs
  // no caption either, since the sentence names what is missing.
  const emailLine =
    email === null
      ? `<p class="read-only">No email address — ${isGuest ? "a guest, added for one fixture" : "we've never had one for them"}.</p>`
      : `<p class="readout-label">Email</p>
         <p>${escapeHtml(email)}</p>`;

  // One <h2> over both readouts, where there used to be one over each.
  // Two headings the size of a lead paragraph, each introducing a single
  // line, slice the page instead of naming its parts; none at all is worse
  // still, because a .readout-label is a plain paragraph and reaches the
  // accessibility tree as one, so dropping both headings would leave a
  // screen-reader user nothing to navigate by between the name and the way
  // out. The captions name each fact; the heading names what the two of them
  // together are.
  const body = `
    <h1>${escapeHtml(memberName)}</h1>
    <p>In <a href="${escapeHtml(gamePath(gameId))}">${escapeHtml(gameName)}</a>.</p>

    <h2>What we have for them</h2>
    ${emailLine}

    <p class="readout-label">In this squad</p>
    <p>${role === "owner" ? "Organiser" : "Player"}, since ${escapeHtml(joinedAtLocal)}.</p>

    <p class="back-link"><a href="${escapeHtml(gamePath(gameId))}">Back to ${escapeHtml(gameName)}</a>, where you can change their role or take them out of the squad.</p>
  `;

  return layout({
    title: `${memberName} — ${gameName} — Make The Team`,
    body,
    pageStyles: [FIXTURE_STYLES_CSS, FORM_CSS],
  });
}

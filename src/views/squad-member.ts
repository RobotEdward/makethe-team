import { gamePath } from "../auth/paths.js";
import { escapeHtml, layout } from "./layout.js";
import { FORM_CSS } from "./styles.js";

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
  const emailLine =
    email === null
      ? `<p class="read-only">No email address — ${isGuest ? "a guest, added for one fixture" : "we've never had one for them"}.</p>`
      : `<p class="read-only">${escapeHtml(email)}</p>`;

  const body = `
    <h1>${escapeHtml(memberName)}</h1>
    <p>In <a href="${escapeHtml(gamePath(gameId))}">${escapeHtml(gameName)}</a>.</p>

    <h2>Email</h2>
    ${emailLine}

    <h2>In this squad</h2>
    <p class="read-only">${role === "owner" ? "Organiser" : "Player"}, since ${escapeHtml(joinedAtLocal)}.</p>

    <p><a href="${escapeHtml(gamePath(gameId))}">Back to ${escapeHtml(gameName)}</a>, where you can change their role or take them out of the squad.</p>
  `;

  return layout({
    title: `${memberName} — ${gameName} — Make The Team`,
    body,
    pageStyles: [FORM_CSS],
  });
}

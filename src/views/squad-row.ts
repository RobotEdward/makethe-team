import type { SquadMember } from "../db/queries.js";
import { displayName } from "../domain/display-name.js";
import { escapeHtml } from "./layout.js";

/**
 * How one squad member's status and BR-27's attribution are worded — shared
 * between the player's own fixture page (`src/views/fixture.ts`) and the
 * organiser's (`src/views/owner-fixture.ts`).
 *
 * Extracted after the two pages' copies of `squadStatusLabel` drifted: the
 * player's page rendered a waitlist rank through `ordinal` ("2nd") while the
 * organiser's rendered the bare number ("2"), so the same player read as
 * differently-ranked depending on who was looking. One implementation is what
 * stops that happening again, here and as Task 5/6 add more to the organiser's
 * row.
 *
 * `renderSquadList`/the row markup itself is deliberately *not* shared here:
 * the organiser's rows carry mark-in/mark-out controls the player's page never
 * will, so each page owns its own row wrapper and calls into this module only
 * for the words.
 */

export function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

export function squadStatusLabel(member: SquadMember): string {
  switch (member.status) {
    case "in":
      return "In";
    case "waitlisted":
      return member.waitlistRank === null ? "Waitlisted" : `Waitlisted (${ordinal(member.waitlistRank)})`;
    case "pending":
      return "Not yet responded";
    case "out":
      return "Can't make it";
    case "withdrawn":
      return "Withdrawn";
  }
}

/**
 * BR-27's visible attribution, on the player's page and the organiser's alike.
 *
 * With §1.11's notification catalogue closed, no email tells a player that
 * somebody answered for them — so this line is the only way they can ever find
 * out. Shown only for `source === "owner"`: a `system` source is a waitlist
 * promotion, which the player's own headline already explains, and `token` and
 * `web` are the player themselves.
 *
 * `waitlisted` reads as "marked in", not "marked out": being marked in and
 * landing on the waitlist is still having been marked in from the player's
 * point of view, and the status badge beside this line already says
 * "waitlisted". `withdrawn` never reaches a squad read (filtered out of
 * `getFixtureWithSquad`), so `out` is the only status left that means "marked
 * out".
 */
export function attribution(member: SquadMember): string {
  if (member.source !== "owner" || member.setBy === null) return "";
  const verb = member.status === "out" ? "marked out" : "marked in";
  // §4: never `setBy.name` directly. An organiser who has since erased
  // themselves leaves this line behind on every response they set — the
  // `responses` rows are deliberately untouched by erasure — so without the
  // branch a played fixture reads "marked in by [erased player]".
  const who = displayName(member.setBy.name, member.setBy.erasedAt);
  return `<span class="set-by">${escapeHtml(`${verb} by ${who}`)}</span>`;
}

import type { Db } from "../db/client.js";
import { loadInviteState } from "../db/invite-queries.js";
import { whenGroupIsAsked } from "../domain/invite-tiers.js";
import { formatLocalCompactDateTime } from "../domain/time/zone.js";

/**
 * When this player's invite group will be asked, phrased to follow "Your
 * group is" (M69) — or null when there is nothing specific to say: an
 * ungated Game, a group already asked, or a fixture not yet open, whose
 * head starts have not started counting.
 *
 * Shared by both player pages, so the token page and the signed-in page
 * cannot promise the same player two different times.
 */
export async function inviteDuePhrase(
  db: Db,
  fixtureId: string,
  playerId: string,
  now: Date,
): Promise<string | null> {
  const state = await loadInviteState(db, fixtureId);
  if (state === null || !state.gated || state.openedAt === null) return null;

  const due = whenGroupIsAsked({ ...state, openedAt: state.openedAt }, playerId);
  if (due === null || due.kind === "asked") return null;
  if (due.kind === "when-needed") return "only asked if the groups above can't fill the game";
  if (due.at <= now) return "about to be asked";
  return `due to be asked ${formatLocalCompactDateTime(due.at, state.timeZone)}`;
}

/**
 * What a screen calls a player whose data has been erased (§4, BR-34).
 *
 * Lower-case and article-first, because it has to read as a phrase in both of
 * the positions a squad read puts a name in: "a former player — In" down a
 * squad list, and "marked in by a former player" in BR-27's attribution line.
 * A capitalised "Former player" reads as a name in the first position and as a
 * broken sentence in the second.
 *
 * Not "deleted", not "removed": neither is true. The person's identifying data
 * is gone, but their place in a fixture that has already been played is
 * deliberately kept, and that is precisely what this label stands in for.
 */
export const ERASED_DISPLAY_NAME = "a former player";

/**
 * A player's name as a screen may show it, given `players.erased_at`.
 *
 * §4 puts the rule plainly: "Renderers must branch on `erased_at` and show
 * their own label; the stored name is a fallback that should never reach a
 * screen." `players.name` after an erasure is the conspicuous `[erased
 * player]` placeholder, chosen so that a renderer which forgets this call
 * produces something visibly wrong rather than a plausible fake name — this
 * function is what stops it being seen at all.
 *
 * One implementation, for `redactName`'s reason (BR-26): a privacy rule with a
 * second copy on some other page is how the wrong thing eventually ships.
 * Every read of a *player's* name for display goes through here.
 */
export function displayName(name: string, erasedAt: Date | null): string {
  return erasedAt === null ? name : ERASED_DISPLAY_NAME;
}

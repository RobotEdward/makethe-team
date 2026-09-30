import type { OrderedTier } from "../db/invite-queries.js";
import { MAX_ASK_AFTER_HOURS } from "./invite-schedule.js";

/** The invite-order editor's submission, read against the order as stored. */
export interface ProposedOrder {
  /** The order as it would stand after saving: moved members, new positions and head starts. */
  tiers: OrderedTier[];
  memberMoves: Array<{ playerId: string; tierId: string | null }>;
  positions: Array<{ tierId: string; position: number }>;
  askAfterHours: Array<{ tierId: string; hours: number }>;
  /** Only when it changed; `undefined` leaves the game's value alone. */
  everyoneElseAskAfterHours: number | null | undefined;
  /** A box the owner must fix before anything can be saved. */
  error: string | null;
}

function parseHours(raw: unknown): number | "invalid" | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return "invalid";
  const hours = Number.parseInt(trimmed, 10);
  return hours > MAX_ASK_AFTER_HOURS ? "invalid" : hours;
}

/**
 * Read the editor's form into the order it proposes (M34, M69).
 *
 * Pure, and separate from the write, because the same proposal is shown back
 * by "Check schedule", checked against the kickoff before a save, and — only
 * if both pass — written. Showing the owner anything other than exactly what
 * would be saved is how a preview lies.
 *
 * **Every tier id in the form is checked against this Game's own tiers**, and
 * anything else becomes the implicit tier rather than being rejected. That
 * check is the only thing standing behind `memberships.invite_tier_id`: SQLite
 * cannot express "the referenced tier belongs to this Game", so a hand-built
 * request naming another squad's tier would otherwise be stored.
 */
export function parseInviteOrderForm(
  current: OrderedTier[],
  form: Record<string, unknown>,
): ProposedOrder {
  const ownTierIds = new Set(
    current.map((tier) => tier.tierId).filter((tierId): tierId is string => tierId !== null),
  );
  let error: string | null = null;

  const memberMoves: ProposedOrder["memberMoves"] = [];
  const destination = new Map<string, string | null>();
  for (const tier of current) {
    for (const member of tier.members) {
      const raw = form[`tier-${member.playerId}`];
      const target = typeof raw === "string" && ownTierIds.has(raw) ? raw : typeof raw === "string" ? null : tier.tierId;
      destination.set(member.playerId, target);
      if (target !== tier.tierId) memberMoves.push({ playerId: member.playerId, tierId: target });
    }
  }

  const positions: ProposedOrder["positions"] = [];
  const askAfterHours: ProposedOrder["askAfterHours"] = [];
  const stored = current.filter((tier) => tier.tierId !== null);
  const proposedStored = stored.map((tier) => {
    const id = tier.tierId!;
    let position = tier.position;
    const rawPosition = form[`position-${id}`];
    if (typeof rawPosition === "string") {
      const parsed = Number.parseInt(rawPosition, 10);
      // A blank or junk box leaves the tier where it is rather than sending it
      // to the front: `Number.parseInt("")` is NaN, and writing that would make
      // every ordering comparison false.
      if (Number.isInteger(parsed) && parsed >= 1 && parsed !== tier.position) {
        position = parsed;
        positions.push({ tierId: id, position });
      }
    }

    let hours = tier.askAfterHours;
    const parsedHours = parseHours(form[`after-${id}`]);
    if (parsedHours === "invalid") {
      error ??= `Give ${tier.name} a head start in whole hours, from 0 to ${MAX_ASK_AFTER_HOURS}.`;
    } else if (parsedHours !== undefined && parsedHours !== tier.askAfterHours) {
      hours = parsedHours;
      askAfterHours.push({ tierId: id, hours });
    }
    return { ...tier, position, askAfterHours: hours, members: [] as OrderedTier["members"] };
  });

  const implicit = current.find((tier) => tier.tierId === null)!;
  let everyoneElse: number | null = implicit.askAfterHours;
  const mode = form["everyone-mode"];
  if (mode === "needed") {
    everyoneElse = null;
  } else if (mode === "timed") {
    const parsed = parseHours(form["after-everyone"]);
    if (parsed === "invalid") {
      error ??= `Give ${implicit.name} a head start in whole hours, from 0 to ${MAX_ASK_AFTER_HOURS}.`;
    } else if (parsed !== undefined) {
      everyoneElse = parsed;
    }
  }

  // Stable, so two groups given the same number keep their current order —
  // which is the (position, created_at) order `loadInviteOrder` reads back.
  proposedStored.sort((a, b) => a.position - b.position);
  const tiers: OrderedTier[] = [
    ...proposedStored,
    { ...implicit, askAfterHours: everyoneElse, members: [] },
  ];
  const byId = new Map(tiers.map((tier) => [tier.tierId, tier]));
  for (const tier of current) {
    for (const member of tier.members) {
      byId.get(destination.get(member.playerId) ?? null)!.members.push(member);
    }
  }
  for (const tier of tiers) tier.members.sort((a, b) => a.name.localeCompare(b.name));

  return {
    tiers,
    memberMoves,
    positions,
    askAfterHours,
    everyoneElseAskAfterHours: everyoneElse === implicit.askAfterHours ? undefined : everyoneElse,
    error,
  };
}

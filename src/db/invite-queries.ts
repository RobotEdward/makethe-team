import { and, asc, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import type { TierState } from "../domain/invite-tiers.js";
import { chunk, INSERT_CHUNK_SIZE } from "./chunk.js";
import type { Db } from "./client.js";
import { fixtures, games, inviteTiers, memberships, players, responses } from "./schema.js";

const HOUR_MS = 3_600_000;

/** Everything `planReleases` needs about one fixture. */
export interface InviteState {
  gated: boolean;
  maxPlayers: number;
  minPlayers: number;
  fallbackDue: boolean;
  tiers: TierState[];
  guestInCount: number;
}

/**
 * Read the invite state of one fixture (M34).
 *
 * `gated`, the fallback offset and the tier list come from `games`, **live** —
 * an owner who turns gating on means the fixtures that already exist, the same
 * reasoning the M26 switches carry. `minPlayers`/`maxPlayers` come from the
 * *fixture's* own snapshot, because those genuinely are history (§2.8) and an
 * edit must not rewrite what a fixture was opened under.
 */
export async function loadInviteState(
  db: Db,
  fixtureId: string,
  now: Date,
): Promise<InviteState | null> {
  const [row] = await db
    .select({ fixture: fixtures, game: games })
    .from(fixtures)
    .innerJoin(games, eq(fixtures.gameId, games.id))
    .where(eq(fixtures.id, fixtureId));
  if (!row) return null;

  const { fixture, game } = row;
  const fallbackDue =
    game.gatedFallbackHoursBefore !== null &&
    now.getTime() >= fixture.kicksOffAt.getTime() - game.gatedFallbackHoursBefore * HOUR_MS;

  const base = {
    gated: game.gatedInvitesEnabled,
    maxPlayers: fixture.maxPlayers,
    minPlayers: fixture.minPlayers,
    fallbackDue,
  };

  // An ungated fixture never reaches the rule, so the three remaining queries
  // are skipped outright rather than run and thrown away (BR-39). The single
  // empty implicit tier keeps the shape non-optional for callers.
  if (!game.gatedInvitesEnabled) {
    return { ...base, tiers: [{ tierId: null, members: [] }], guestInCount: 0 };
  }

  const tierRows = await db
    .select({ id: inviteTiers.id })
    .from(inviteTiers)
    .where(eq(inviteTiers.gameId, fixture.gameId))
    .orderBy(asc(inviteTiers.position), asc(inviteTiers.createdAt));

  const memberRows = await db
    .select({
      playerId: memberships.playerId,
      inviteTierId: memberships.inviteTierId,
      status: responses.status,
      invitedAt: responses.invitedAt,
    })
    .from(memberships)
    .leftJoin(
      responses,
      and(eq(responses.fixtureId, fixtureId), eq(responses.playerId, memberships.playerId)),
    )
    .where(and(eq(memberships.gameId, fixture.gameId), eq(memberships.active, true)));

  const memberIds = memberRows.map((member) => member.playerId);
  // A guest holds a response row and no membership, so they fall out of the
  // join above entirely. They still occupy a slot, which is exactly what
  // `potential` has to know about (BR-43).
  const guestRows = await db
    .select({ playerId: responses.playerId })
    .from(responses)
    .where(
      memberIds.length === 0
        ? and(eq(responses.fixtureId, fixtureId), eq(responses.status, "in"))
        : and(
            eq(responses.fixtureId, fixtureId),
            eq(responses.status, "in"),
            notInArray(responses.playerId, memberIds),
          ),
    );

  const byTier = new Map<string | null, TierState>();
  for (const tier of tierRows) byTier.set(tier.id, { tierId: tier.id, members: [] });
  byTier.set(null, { tierId: null, members: [] });

  for (const member of memberRows) {
    // A membership pointing at another Game's tier arrives here as an unknown
    // key. It falls to the implicit tier rather than being dropped: silently
    // un-inviting somebody is worse than asking them last.
    const bucket = byTier.get(member.inviteTierId) ?? byTier.get(null)!;
    bucket.members.push({
      playerId: member.playerId,
      status: member.status ?? null,
      invitedAt: member.invitedAt ?? null,
    });
  }

  const tiers = [...tierRows.map((tier) => byTier.get(tier.id)!), byTier.get(null)!];
  return { ...base, tiers, guestInCount: guestRows.length };
}

/**
 * Stamp `invited_at` on the named players' rows for this fixture, and return
 * the ids actually stamped (BR-41).
 *
 * **`isNull(responses.invitedAt)` in the WHERE is a second idempotency
 * mechanism, and it is load-bearing.** The Durable Object serialises callers
 * that address it by fixture id, but the return value is what the caller then
 * mails — so if two paths ever did overlap, the one that lost the race must
 * come back with an empty list rather than a second invitation to a real
 * person. The `n1` dedupe key is the third.
 *
 * Chunked (TR-38) because D1 rejects a statement with more than 100 bound
 * parameters and a squad is unbounded in principle.
 */
export async function stampInvited(
  db: Db,
  fixtureId: string,
  playerIds: readonly string[],
  now: Date,
): Promise<string[]> {
  const stamped: string[] = [];
  for (const batch of chunk(playerIds, INSERT_CHUNK_SIZE)) {
    if (batch.length === 0) continue;
    const updated = await db
      .update(responses)
      .set({ invitedAt: now })
      .where(
        and(
          eq(responses.fixtureId, fixtureId),
          inArray(responses.playerId, batch),
          isNull(responses.invitedAt),
        ),
      )
      .returning({ playerId: responses.playerId });
    stamped.push(...updated.map((update) => update.playerId));
  }
  return stamped;
}

/** One member of a tier as the owner's two M34 screens list them. */
export interface OrderedMember {
  playerId: string;
  name: string;
  /** Null when this member holds no live response row on the fixture, or when no fixture was asked for. */
  status: string | null;
  invitedAt: Date | null;
}

/** One rung of a Game's invite order, named, with its members. */
export interface OrderedTier {
  tierId: string | null;
  name: string;
  /** Ascending. Zero for the implicit tier, which has no stored row to carry one. */
  position: number;
  members: OrderedMember[];
}

/**
 * A Game's invite order with names attached, for the editor and the fixture
 * progress panel (M34).
 *
 * Separate from `loadInviteState`, which the release rule uses: that one is
 * deliberately name-free and shaped for arithmetic, and widening it to carry
 * display strings would put player names into the Durable Object's critical
 * section for no reason.
 *
 * `fixtureId` is optional. Without it every `status` and `invitedAt` is null,
 * which is what the editor wants — it is about the Game, not about any one
 * fixture.
 */
export async function loadInviteOrder(
  db: Db,
  gameId: string,
  fixtureId?: string,
): Promise<OrderedTier[]> {
  const tierRows = await db
    .select({ id: inviteTiers.id, name: inviteTiers.name, position: inviteTiers.position })
    .from(inviteTiers)
    .where(eq(inviteTiers.gameId, gameId))
    .orderBy(asc(inviteTiers.position), asc(inviteTiers.createdAt));

  const memberRows = await db
    .select({
      playerId: memberships.playerId,
      name: players.name,
      inviteTierId: memberships.inviteTierId,
      status: responses.status,
      invitedAt: responses.invitedAt,
    })
    .from(memberships)
    .innerJoin(players, eq(players.id, memberships.playerId))
    .leftJoin(
      responses,
      fixtureId === undefined
        ? // A condition that is never true, so the join contributes null
          // columns without a second query shape for the no-fixture case.
          eq(responses.id, sql`NULL`)
        : and(eq(responses.fixtureId, fixtureId), eq(responses.playerId, memberships.playerId)),
    )
    .where(and(eq(memberships.gameId, gameId), eq(memberships.active, true)))
    .orderBy(asc(players.name));

  const byTier = new Map<string | null, OrderedTier>();
  for (const tier of tierRows) {
    byTier.set(tier.id, { tierId: tier.id, name: tier.name, position: tier.position, members: [] });
  }
  byTier.set(null, { tierId: null, name: "Everyone else", position: 0, members: [] });

  for (const member of memberRows) {
    // An unknown key means a membership pointing at another Game's tier. It
    // falls to the implicit tier rather than vanishing from the page, so the
    // owner can see the person and move them.
    const bucket = byTier.get(member.inviteTierId) ?? byTier.get(null)!;
    bucket.members.push({
      playerId: member.playerId,
      name: member.name,
      status: member.status ?? null,
      invitedAt: member.invitedAt ?? null,
    });
  }

  return [...tierRows.map((tier) => byTier.get(tier.id)!), byTier.get(null)!];
}

import { and, eq } from "drizzle-orm";
import { buildAuditInsert } from "../db/audit.js";
import type { Db } from "../db/client.js";
import { memberships, players } from "../db/schema.js";

/**
 * Put someone in a squad from the public invite link (J1, spec §4.4).
 *
 * Shared rather than inlined in the route, because J6's "add a squad member
 * directly" is the same operation with a different caller — and because the
 * four outcomes below are the interesting part, not the HTTP around them.
 *
 * **One address is one person.** An email that already exists reuses the
 * `players` row and the *stored* name wins; the name typed on the form is
 * discarded. Joining a second squad therefore cannot rename you in the first,
 * and there is no unaudited path by which one squad's form input changes how
 * you appear to another. The cost is that a typo'd name cannot be corrected
 * here — that belongs to a profile-edit surface (§1.6, M7).
 *
 * **BR-2 is deliberate, not a bug.** A player who joins after a fixture has
 * opened is not in that fixture: `pending` rows are written for the eligible
 * set at the moment a fixture opens (BR-1) and nothing back-fills them. The
 * page that renders this outcome says which fixture is their first.
 */

export type JoinOutcome =
  | { kind: "joined"; playerId: string; membershipId: string; joinedAt: Date; playerName: string }
  | { kind: "rejoined"; playerId: string; membershipId: string; joinedAt: Date; playerName: string }
  | { kind: "already-member"; playerId: string; playerName: string };

export interface JoinSquadParams {
  db: Db;
  gameId: string;
  name: string;
  /** Raw from the form. Normalised here, not by the caller. */
  email: string;
  now: Date;
}

/**
 * Trimmed and lowercased, so `Ed@x.com` and `ed@x.com` cannot become two
 * Players under the `UNIQUE (email) WHERE email IS NOT NULL` index.
 */
export function normaliseEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * A shape check, not a deliverability check — nothing here can know whether an
 * address exists, and the N-6 welcome is what actually tests that (spec §4.4:
 * the email doubles as proof of address).
 */
export function isPlausibleEmail(value: string): boolean {
  if (value.length === 0 || value.length > 254) return false;
  if (/\s/.test(value)) return false;
  const at = value.indexOf("@");
  if (at <= 0 || at !== value.lastIndexOf("@")) return false;
  const domain = value.slice(at + 1);
  return domain.length > 0 && domain.includes(".") && !domain.startsWith(".") && !domain.endsWith(".");
}

export async function joinSquad(params: JoinSquadParams): Promise<JoinOutcome> {
  const { db, gameId, name, now } = params;
  const email = normaliseEmail(params.email);

  const [existing] = await db.select().from(players).where(eq(players.email, email)).limit(1);

  // A guest can never collide here: guests have `email IS NULL` by definition
  // (§2.8) and this lookup is by email.
  const playerId = existing?.id ?? crypto.randomUUID();
  const playerName = existing?.name ?? name.trim();

  if (!existing) {
    await db.insert(players).values({ id: playerId, name: playerName, email, createdAt: now });
  }

  const [membership] = await db
    .select()
    .from(memberships)
    .where(and(eq(memberships.gameId, gameId), eq(memberships.playerId, playerId)))
    .limit(1);

  if (membership?.active === true) {
    return { kind: "already-member", playerId, playerName };
  }

  if (membership) {
    // Reactivate rather than insert: UNIQUE (game_id, player_id) forbids a
    // second row. `joinedAt` is reset because it is what makes the N-6 dedupe
    // key differ, which is what lets a rejoin be welcomed again (§4.4).
    await db.batch([
      db
        .update(memberships)
        .set({ active: true, leftAt: null, joinedAt: now })
        .where(eq(memberships.id, membership.id)),
      buildAuditInsert(db, {
        actorPlayerId: playerId,
        entityType: "membership",
        entityId: membership.id,
        action: "membership.rejoined",
        after: { gameId, playerId },
        now,
      }),
    ]);
    return { kind: "rejoined", playerId, membershipId: membership.id, joinedAt: now, playerName };
  }

  const membershipId = crypto.randomUUID();
  await db.batch([
    db.insert(memberships).values({
      id: membershipId,
      gameId,
      playerId,
      role: "player",
      active: true,
      joinedAt: now,
    }),
    buildAuditInsert(db, {
      actorPlayerId: playerId,
      entityType: "membership",
      entityId: membershipId,
      action: "membership.joined",
      after: { gameId, playerId },
      now,
    }),
  ]);

  return { kind: "joined", playerId, membershipId, joinedAt: now, playerName };
}

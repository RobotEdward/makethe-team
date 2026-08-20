import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { fixtures, responses } from "../db/schema.js";

/**
 * Put a player who has just joined the squad into every fixture of the game
 * that is already `open` (BR-2′).
 *
 * BR-1 still fixes the eligible set at open; this is the one sanctioned
 * addition to it, run from the join flow so a last-minute invitee can be
 * asked about this week's game rather than waiting for the next one.
 *
 * A `pending` row holds no slot and touches neither cached count, so this is
 * not a capacity write and deliberately stays outside the Durable Object —
 * the same shape as `openFixture`'s BR-1 inserts (TR-12 governs capacity
 * writes, not eligibility rows).
 *
 * `onConflictDoNothing` on `(fixture_id, player_id)` carries two rules at
 * once: a re-run inserts nothing (safe under the join flow's retry loop), and
 * a surviving `withdrawn` row is left standing — BR-3's marker that an
 * organiser removed this player from the fixture, which an anonymous invite
 * link must not be able to undo. `returning` reports only the rows actually
 * inserted, so the caller invites exactly the fixtures this call put the
 * player into and nobody is re-invited to a fixture they were removed from.
 *
 * Known gap, accepted: a join committing in the same instant the sweep opens
 * a fixture can miss both this backfill (the fixture not yet `open` here) and
 * BR-1's insert (the membership not yet visible there). The window is one
 * cron tick racing one form submit; see docs/known-issues.md.
 */
export async function backfillOpenFixtureResponses(
  db: Db,
  gameId: string,
  playerId: string,
): Promise<string[]> {
  const open = await db
    .select({ id: fixtures.id })
    .from(fixtures)
    .where(and(eq(fixtures.gameId, gameId), eq(fixtures.lifecycle, "open")));
  if (open.length === 0) return [];

  const inserted = await db
    .insert(responses)
    .values(
      open.map(({ id }) => ({
        id: crypto.randomUUID(),
        fixtureId: id,
        playerId,
        status: "pending" as const,
        source: "system" as const,
      })),
    )
    .onConflictDoNothing()
    .returning({ fixtureId: responses.fixtureId });

  return inserted.map((row) => row.fixtureId);
}

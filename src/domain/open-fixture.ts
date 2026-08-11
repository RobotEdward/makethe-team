import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { fixtures, memberships, responses } from "../db/schema.js";
import { chunk, INSERT_CHUNK_SIZE } from "../db/chunk.js";
import { isTerminalLifecycle } from "./lifecycle.js";

export interface OpenFixtureResult {
  opened: boolean;
  pendingCreated: number;
  reason?: "already-open" | "terminal" | "not-found";
}

/**
 * Move a fixture from `scheduled` to `open`, fixing its eligible set (BR-1).
 *
 * The set of players who can respond is decided here and nowhere else: a
 * `pending` row is written for every active member at this instant, so someone
 * who joins the squad afterwards is not retroactively invited (BR-2) and
 * someone who left is not asked.
 *
 * Idempotent by two mechanisms, because the sweep may retry or overlap:
 * the lifecycle guard short-circuits a second call, and the
 * (fixture_id, player_id) unique index makes the insert safe even if two runs
 * pass the guard simultaneously. That second mechanism matters because the
 * insert is chunked (TR-38) and a partial write must be completable.
 */
export async function openFixture(db: Db, fixtureId: string, now: Date): Promise<OpenFixtureResult> {
  const [fixture] = await db.select().from(fixtures).where(eq(fixtures.id, fixtureId));
  if (!fixture) return { opened: false, pendingCreated: 0, reason: "not-found" };
  if (isTerminalLifecycle(fixture.lifecycle)) {
    return { opened: false, pendingCreated: 0, reason: "terminal" };
  }
  if (fixture.lifecycle === "open") {
    return { opened: false, pendingCreated: 0, reason: "already-open" };
  }

  const eligible = await db
    .select({ playerId: memberships.playerId })
    .from(memberships)
    .where(and(eq(memberships.gameId, fixture.gameId), eq(memberships.active, true)));

  let pendingCreated = 0;
  for (const batch of chunk(eligible, INSERT_CHUNK_SIZE)) {
    const inserted = await db
      .insert(responses)
      .values(
        batch.map(({ playerId }) => ({
          id: crypto.randomUUID(),
          fixtureId,
          playerId,
          status: "pending" as const,
          source: "system" as const,
        })),
      )
      .onConflictDoNothing()
      .returning({ id: responses.id });
    pendingCreated += inserted.length;
  }

  await db
    .update(fixtures)
    .set({ lifecycle: "open", openedAt: now })
    .where(eq(fixtures.id, fixtureId));

  return { opened: true, pendingCreated };
}

import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { fixtures, memberships, responses } from "../db/schema.js";
import { chunk, INSERT_CHUNK_SIZE } from "../db/chunk.js";
import { recordAudit } from "../db/audit.js";
import { isTerminalLifecycle } from "./lifecycle.js";
import { isMuted } from "./mute.js";

export interface OpenFixtureResult {
  opened: boolean;
  /**
   * Response rows written, **muted members included** — the size of the
   * eligible set, not the number of people now waiting to answer. Renaming it
   * would touch every caller and every sweep log line to say something they
   * already mean; what changed in M28 is only that some of these rows start
   * life as `out`. {@link OpenFixtureResult.autoDeclined} says how many.
   */
  pendingCreated: number;
  /** How many of those rows were auto-declined for a muted member (M28). */
  autoDeclined: number;
  reason?: "already-open" | "terminal" | "not-found";
}

/**
 * Move a fixture from `scheduled` to `open`, fixing its eligible set (BR-1).
 *
 * The eligible set is fixed here at the moment of opening: a `pending` row is
 * written for every active member at this instant, and someone who left is
 * not asked. Since BR-2′ (M21) there is one sanctioned later addition — the
 * join flow backfills a `pending` row for a player who joins while this
 * fixture is open (`src/domain/backfill-open-responses.ts`); nothing else
 * back-fills.
 *
 * Idempotent by two mechanisms, because the sweep may retry or overlap:
 * the lifecycle guard short-circuits a second call, and the
 * (fixture_id, player_id) unique index makes the insert safe even if two runs
 * pass the guard simultaneously. That second mechanism matters because the
 * insert is chunked (TR-38) and a partial write must be completable.
 *
 * A member who is auto-declining (M28) still gets a row, and gets it here
 * rather than by some later pass: writing their `out` at the same instant as
 * everybody else's `pending` is what makes the organiser's numbers honest from
 * the moment the fixture opens, and what keeps every downstream reader — the
 * squad list, the reminder sweep, the broadcast audiences — needing no idea
 * that muting exists. `out` is a status they all already handle.
 */
export async function openFixture(
  db: Db,
  fixtureId: string,
  now: Date,
  /**
   * The owner who opened it early (BR-11), or null when the sweep opened it at
   * the reminder instant.
   *
   * The audit row is written **here** rather than by each caller, because the
   * two ways a fixture opens leave identical rows behind — `lifecycle` and
   * `opened_at` say nothing about who — and a caller that forgot would lose
   * the only evidence, silently. Defaulted to null so the sweep reads as the
   * system action it is without passing an argument to say so.
   */
  actorPlayerId: string | null = null,
): Promise<OpenFixtureResult> {
  const [fixture] = await db.select().from(fixtures).where(eq(fixtures.id, fixtureId));
  if (!fixture) return { opened: false, pendingCreated: 0, autoDeclined: 0, reason: "not-found" };
  if (isTerminalLifecycle(fixture.lifecycle)) {
    return { opened: false, pendingCreated: 0, autoDeclined: 0, reason: "terminal" };
  }
  if (fixture.lifecycle === "open") {
    return { opened: false, pendingCreated: 0, autoDeclined: 0, reason: "already-open" };
  }

  const eligible = await db
    .select({
      playerId: memberships.playerId,
      mutedAt: memberships.mutedAt,
      mutedUntil: memberships.mutedUntil,
    })
    .from(memberships)
    .where(and(eq(memberships.gameId, fixture.gameId), eq(memberships.active, true)));

  let pendingCreated = 0;
  let autoDeclined = 0;
  for (const batch of chunk(eligible, INSERT_CHUNK_SIZE)) {
    const rows = batch.map((member) => {
      const muted = isMuted(member, now);
      if (muted) autoDeclined += 1;
      return {
        id: crypto.randomUUID(),
        fixtureId,
        playerId: member.playerId,
        status: muted ? ("out" as const) : ("pending" as const),
        // Stamped for an auto-decline and left null otherwise. `pending` means
        // "has not answered" and silence is not consent (§1.4); a mute is an
        // answer the player gave in advance, so it carries a time.
        respondedAt: muted ? now : null,
        source: "system" as const,
      };
    });
    const inserted = await db
      .insert(responses)
      .values(rows)
      .onConflictDoNothing()
      .returning({ id: responses.id });
    pendingCreated += inserted.length;
  }

  await db
    .update(fixtures)
    .set({ lifecycle: "open", openedAt: now })
    .where(eq(fixtures.id, fixtureId));

  await recordAudit(db, {
    actorPlayerId,
    entityType: "fixture",
    entityId: fixtureId,
    action: "fixture.opened",
    // The size of the eligible set fixed at this instant (BR-1). No later
    // query can reconstruct it: people join and leave afterwards, and a muted
    // member's row starts life as `out`, so counting rows later answers a
    // different question.
    after: { pendingCreated, autoDeclined },
    now,
  });

  return { opened: true, pendingCreated, autoDeclined };
}

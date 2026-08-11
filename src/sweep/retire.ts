import { eq, inArray } from "drizzle-orm";
import { chunk, INSERT_CHUNK_SIZE } from "../db/chunk.js";
import type { Db } from "../db/client.js";
import { fixtures } from "../db/schema.js";

export interface RetireResult {
  retired: number;
}

const MINUTE_MS = 60_000;

/**
 * Step 3 of the hourly sweep (§2.4): transition every `open` fixture whose
 * kickoff-plus-duration has passed to `played` (BR-13).
 *
 * `scheduled` fixtures are untouched — they haven't kicked off in the model's
 * terms regardless of the clock, so it would be wrong to retire one that was
 * never opened. `cancelled` fixtures are untouched too: they are already
 * terminal, and BR-16 says a cancelled fixture must never be resurrected into
 * another lifecycle, including `played`. `played` itself is excluded by the
 * `open` filter below, so a fixture already retired is simply not selected
 * again — re-running this after every fixture is retired changes nothing.
 *
 * Once a fixture is `played`, responses lock (BR-15); that's enforced by the
 * response route (`src/routes/respond.ts`), not here — this function only
 * owns the lifecycle write that makes the lock take effect.
 *
 * This is a lifecycle change, not a capacity write (nothing here changes who
 * is in or out, or how many spots remain), so unlike `openFixture` it has no
 * business going through the Durable Object.
 *
 * Read-then-update rather than a single `UPDATE ... WHERE` with inline date
 * arithmetic: filtering in JS against `now.getTime()` keeps the boundary
 * comparison exact and easy to reason about, and matches how the sweep's
 * other lifecycle-transition step (`fixturesDueByLifecycle` in
 * `src/sweep/open-and-remind.ts`) already does it.
 */
export async function retirePastFixtures(db: Db, now: Date): Promise<RetireResult> {
  const openFixtures = await db
    .select({
      id: fixtures.id,
      kicksOffAt: fixtures.kicksOffAt,
      durationMinutes: fixtures.durationMinutes,
    })
    .from(fixtures)
    .where(eq(fixtures.lifecycle, "open"));

  const dueIds = openFixtures
    .filter((fixture) => fixture.kicksOffAt.getTime() + fixture.durationMinutes * MINUTE_MS <= now.getTime())
    .map((fixture) => fixture.id);

  let retired = 0;
  for (const batch of chunk(dueIds, INSERT_CHUNK_SIZE)) {
    const updated = await db
      .update(fixtures)
      .set({ lifecycle: "played" })
      .where(inArray(fixtures.id, batch))
      .returning({ id: fixtures.id });
    retired += updated.length;
  }

  return { retired };
}

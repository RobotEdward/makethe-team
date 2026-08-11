import { inArray } from "drizzle-orm";
import { chunk, INSERT_CHUNK_SIZE } from "../db/chunk.js";
import type { Db } from "../db/client.js";
import { fixtures } from "../db/schema.js";

export interface RetireResult {
  retired: number;
}

const MINUTE_MS = 60_000;

/**
 * Step 3 of the hourly sweep (§2.4): transition every `open` **or**
 * `scheduled` fixture whose kickoff-plus-duration has passed to `played`
 * (BR-13).
 *
 * `scheduled` is included alongside `open` because `openAndRemind` (step 1/2
 * of the same sweep) now deliberately declines to open — or remind anyone
 * about — a fixture that has already ended (see `fixturesDueByLifecycle` in
 * `src/sweep/open-and-remind.ts`), which exists to stop a cron backlog from
 * mailing "tomorrow" for a game that finished days ago. Without this,
 * a `scheduled` fixture that step 1 declines to open that way would never
 * transition at all — not opened (correctly declined), not retired (wrong
 * lifecycle for the old filter) — an orphan stuck `scheduled` forever,
 * never reminded and never closed out. Retiring it here trades a bad email
 * for silent, correct cleanup: nobody is notified about a fixture that never
 * got its reminder, which is the right outcome for something this stale.
 *
 * `cancelled` fixtures are untouched: they are already terminal, and BR-16
 * says a cancelled fixture must never be resurrected into another lifecycle,
 * including `played`. `played` itself is excluded by the filter below, so a
 * fixture already retired is simply not selected again — re-running this
 * after every fixture is retired changes nothing.
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
  const candidateFixtures = await db
    .select({
      id: fixtures.id,
      kicksOffAt: fixtures.kicksOffAt,
      durationMinutes: fixtures.durationMinutes,
    })
    .from(fixtures)
    .where(inArray(fixtures.lifecycle, ["open", "scheduled"]));

  const dueIds = candidateFixtures
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

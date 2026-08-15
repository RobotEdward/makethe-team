import { and, isNull, isNotNull, lte } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { players } from "../db/schema.js";
import type { WithdrawMemberOutcome } from "../capacity/types.js";
import { erasePlayer } from "../domain/erase-player.js";

/** One player the sweep could not erase, and why. */
export interface ErasureFailure {
  playerId: string;
  message: string;
}

export interface ErasureSweepResult {
  erased: number;
  /**
   * Requests still waiting on a handover — counted, never failed. See the
   * module comment: this is a normal state a player can sit in for days, and
   * folding it into `failures` would make every sweep run reject while the
   * person takes their time finding a replacement organiser.
   */
  blocked: number;
  failures: ErasureFailure[];
}

/**
 * Perform every erasure whose window has elapsed (§2, BR-34).
 *
 * **One player's failure never stops another's.** This project has been bitten
 * twice by exactly that shape — one rejecting notifier aborting a whole sweep,
 * one bad timezone silencing every game's reminders — so each erasure is
 * isolated and its failure is collected, exactly as `openAndRemind` and
 * `materialiseFixtures` collect theirs.
 *
 * `blocked` is not a failure. A player who has become the last organiser of a
 * game since requesting erasure stays pending and is retried on the next run;
 * `erasePlayer` writes nothing in that case, so retrying costs one query and
 * can never half-complete. It is counted separately so a log reader can tell
 * "waiting on a handover" apart from "something is wrong".
 *
 * The `erased_at is null` half of the filter is what makes re-running this
 * free: `erases_at` is deliberately *not* cleared by an erasure (it is the
 * record of what the player asked for and when), so without it every erased
 * player would be selected again on every run for the rest of time. It is
 * belt-and-braces with `erasePlayer`'s own `already-erased` check rather than
 * a substitute for it — that check is what protects a concurrent second caller
 * from writing a second `player.erased` audit row.
 *
 * `withdraw` is a *factory* keyed by player id, not the plain
 * `(fixtureId) => …` callback `erasePlayer` takes: each erasure withdraws a
 * different player, and the capacity object has to be told which one. Passing
 * one pre-bound callback here would withdraw whoever the first erasure
 * happened to bind, from every subsequent player's fixtures.
 */
export async function runDueErasures(
  db: Db,
  now: Date,
  withdraw: (playerId: string) => (fixtureId: string) => Promise<WithdrawMemberOutcome>,
): Promise<ErasureSweepResult> {
  // `isNotNull(erasesAt)` is stated rather than left to SQL's three-valued
  // logic (where `null <= now` is already unknown, and so not selected). It
  // costs nothing and it means "a player who never asked is never erased" —
  // the single worst thing this function could get wrong — is visible in the
  // query itself rather than inferred from a comparison's null semantics.
  const due = await db
    .select({ id: players.id })
    .from(players)
    .where(and(isNotNull(players.erasesAt), lte(players.erasesAt, now), isNull(players.erasedAt)));

  let erased = 0;
  let blocked = 0;
  const failures: ErasureFailure[] = [];

  // Sequential, and one `try` per player. Erasure walks a player's whole squad
  // and every open fixture behind its own Durable Object, so running these
  // together would buy nothing on a handful of rows and would make a partial
  // failure much harder to read back out of the logs — the same reasoning
  // `removeMember`'s own fixture loop records.
  for (const player of due) {
    try {
      const result = await erasePlayer({ db, playerId: player.id, now, withdraw: withdraw(player.id) });
      if (result.kind === "erased") erased++;
      else if (result.kind === "blocked") blocked++;
      // `already-erased` and `not-found` are neither: the first is a row that
      // was erased between this run's select and its turn in the loop, the
      // second a row deleted underneath us. Both mean there is nothing left to
      // do, and neither is worth failing an invocation over.
    } catch (error) {
      failures.push({
        playerId: player.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { erased, blocked, failures };
}

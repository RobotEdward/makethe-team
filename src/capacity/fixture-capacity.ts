import { DurableObject } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { fixtures, responses } from "../db/schema.js";
import type { Bindings } from "../env.js";
import type { SetResponseInput, SetResponseOutcome } from "./types.js";

/**
 * Serialises every write that can affect a fixture's capacity (TR-10).
 *
 * One instance per fixture, addressed by fixture id. It holds **no state of its
 * own** — it reads and writes D1 inside its critical section, so D1 stays the
 * single source of truth and the two can never disagree.
 */
export class FixtureCapacity extends DurableObject<Bindings> {
  ping(): string {
    return "fixture-capacity";
  }

  /**
   * Record a player's response, deciding `in` versus `waitlisted` against the
   * fixture's capacity (BR-4, BR-5, BR-9).
   *
   * **`blockConcurrencyWhile` is load-bearing and must not be removed.** A
   * Durable Object does not automatically serialise across every `await`:
   * input gating covers Durable Object *storage* operations, and this critical
   * section awaits **D1**, which is an external call. Without the block, two
   * requests can both read `in_count = 13` before either writes, and both take
   * the last slot — exactly the double-booking BR-9 forbids. The BR-9 tests
   * fail without it.
   */
  async setResponse(input: SetResponseInput): Promise<SetResponseOutcome> {
    return this.ctx.blockConcurrencyWhile(async () => this.#setResponseLocked(input));
  }

  async #setResponseLocked(input: SetResponseInput): Promise<SetResponseOutcome> {
    const db = getDb(this.env.DB);
    const now = new Date(input.now);

    const [fixture] = await db.select().from(fixtures).where(eq(fixtures.id, input.fixtureId));
    if (!fixture) return { kind: "rejected", reason: "fixture-not-found" };
    if (fixture.lifecycle !== "open") return { kind: "rejected", reason: "fixture-not-open" };

    // Read every response for this fixture once. The squad is at most a few
    // dozen rows, and holding them in memory lets the whole decision — new
    // status, waitlist position, both cached counts — be computed without
    // further round trips inside the lock.
    const all = await db
      .select({
        id: responses.id,
        playerId: responses.playerId,
        status: responses.status,
        waitlistPosition: responses.waitlistPosition,
      })
      .from(responses)
      .where(eq(responses.fixtureId, input.fixtureId));

    // A row exists for every player eligible when the fixture opened. No row
    // means this player was not in the squad at that moment (BR-2).
    const existing = all.find((r) => r.playerId === input.playerId);
    if (!existing) return { kind: "rejected", reason: "not-eligible" };

    const others = all.filter((r) => r.id !== existing.id);
    const inCountWithoutThisPlayer = others.filter((r) => r.status === "in").length;
    const waitlistedWithoutThisPlayer = others.filter((r) => r.status === "waitlisted");

    // Decide the new state.
    let status: "in" | "out" | "waitlisted";
    let waitlistPosition: number | null = null;

    if (input.intent === "out") {
      status = "out";
    } else if (existing.status === "in") {
      // Already in. Report current state without a pointless write.
      const inCount = inCountWithoutThisPlayer + 1;
      return { kind: "recorded", status: "in", inCount, spotsLeft: Math.max(0, fixture.maxPlayers - inCount) };
    } else if (existing.status === "waitlisted") {
      // Already waitlisted and still full. Keep the original position — BR-6
      // fixes order by arrival, so re-tapping must not move them to the back.
      if (inCountWithoutThisPlayer >= fixture.maxPlayers) {
        return {
          kind: "waitlisted",
          waitlistPosition: existing.waitlistPosition ?? 1,
          inCount: inCountWithoutThisPlayer,
        };
      }
      status = "in";
    } else if (inCountWithoutThisPlayer >= fixture.maxPlayers) {
      // Full (BR-4). Appended to the end of the waitlist (BR-5, BR-6) and told
      // so explicitly — never silently.
      const highest = waitlistedWithoutThisPlayer.reduce(
        (max, r) => Math.max(max, r.waitlistPosition ?? 0),
        0,
      );
      status = "waitlisted";
      waitlistPosition = highest + 1;
    } else {
      status = "in";
    }

    // Recompute both cached counts from the resulting set. Deriving the
    // waitlist count from the assigned position would be wrong: positions are
    // never reused, so they develop gaps and drift above the real count.
    const inCount = inCountWithoutThisPlayer + (status === "in" ? 1 : 0);
    const waitlistCount = waitlistedWithoutThisPlayer.length + (status === "waitlisted" ? 1 : 0);

    await db.batch([
      db
        .update(responses)
        .set({
          status,
          waitlistPosition,
          respondedAt: now,
          setByPlayerId: input.actorPlayerId,
          source: input.source,
        })
        .where(eq(responses.id, existing.id)),
      db.update(fixtures).set({ inCount, waitlistCount }).where(eq(fixtures.id, input.fixtureId)),
    ]);

    if (status === "waitlisted") {
      return { kind: "waitlisted", waitlistPosition: waitlistPosition ?? 1, inCount };
    }
    return { kind: "recorded", status, inCount, spotsLeft: Math.max(0, fixture.maxPlayers - inCount) };
  }
}

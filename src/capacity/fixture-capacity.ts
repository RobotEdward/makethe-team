import { DurableObject } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { fixtures, responses } from "../db/schema.js";
import { occupiesSlot } from "../domain/response-status.js";
import type { Bindings } from "../env.js";
import type { SetResponseInput, SetResponseOutcome, WaitlistPromotion } from "./types.js";

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
    // The lock this method runs under is keyed by the object's own identity
    // (whichever name the caller addressed via `getByName`), so the fixture id
    // used for every D1 read and write must come from that same identity —
    // never from an argument. If it came from the input instead, a caller
    // could address one object while passing a different fixture id, and the
    // lock and the mutation would no longer agree: two differently-named
    // objects could serialise separately while writing the same rows,
    // reintroducing the exact double-booking blockConcurrencyWhile exists to
    // prevent.
    const fixtureId = this.ctx.id.name;
    if (fixtureId === undefined) {
      throw new Error(
        "FixtureCapacity was addressed by unique id, not by fixture id — every caller must use getByName(fixtureId)",
      );
    }

    const db = getDb(this.env.DB);
    const now = new Date(input.now);

    const [fixture] = await db.select().from(fixtures).where(eq(fixtures.id, fixtureId));
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
      .where(eq(responses.fixtureId, fixtureId));

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

    // BR-7 — if this response gives up a slot, the longest-waiting player
    // takes it immediately, in the same batch as the dropout below.
    //
    // "Longest waiting" is the **lowest live `waitlist_position`**. Positions
    // are permanent and gappy: the next joiner takes the highest live position
    // plus one, so a departed top position is reused and numbering restarts at
    // 1 on an empty waitlist. What survives all of that — and what this relies
    // on — is that among the players currently waitlisted, the lowest position
    // is the earliest arrival.
    //
    // `occupiesSlot` rather than a literal `=== "in"`: BR-3's `withdrawn`
    // frees a slot exactly as `out` does, and this condition should already be
    // right on the day that status is first written.
    const givesUpASlot = occupiesSlot(existing.status) && !occupiesSlot(status);
    const promotedRow =
      givesUpASlot && inCountWithoutThisPlayer < fixture.maxPlayers
        ? waitlistedWithoutThisPlayer
            .filter((r) => r.waitlistPosition !== null)
            .reduce<(typeof waitlistedWithoutThisPlayer)[number] | null>(
              (best, r) =>
                best === null || (r.waitlistPosition ?? 0) < (best.waitlistPosition ?? 0) ? r : best,
              null,
            )
        : null;

    // Exactly one player can be promoted here: this response releases at most
    // one slot. Anything that frees several — a cancellation, a squad change —
    // is a different operation and must do its own promotion pass.
    const promoted: WaitlistPromotion | null =
      promotedRow === null
        ? null
        : {
            playerId: promotedRow.playerId,
            previousWaitlistPosition: promotedRow.waitlistPosition ?? 1,
            promotedAt: input.now,
          };

    // Recompute both cached counts from the resulting set. Deriving the
    // waitlist count from the assigned position would be wrong: the position
    // is highest-live-plus-one, which says nothing about how many people are
    // waitlisted — a single remaining player who happens to hold position 4
    // makes the next joiner position 5 while the real count is 2.
    const inCount =
      inCountWithoutThisPlayer + (status === "in" ? 1 : 0) + (promotedRow ? 1 : 0);
    const waitlistCount =
      waitlistedWithoutThisPlayer.length + (status === "waitlisted" ? 1 : 0) - (promotedRow ? 1 : 0);

    // One batch, deliberately. D1 has no interactive transactions, so
    // `db.batch` is the only way to make the dropout and the promotion
    // succeed or fail together. Split across two calls, a failure between them
    // would either free a slot nobody took or fill one that was never freed —
    // and the cached counts would then disagree with the rows either way.
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
      // The promoted player's `responded_at` is left alone on purpose: it
      // records when *they* said yes, which is what the squad list orders `in`
      // players by, and the promotion is not a new answer from them. `source`
      // becomes "system" because nobody asked for this write — the object did
      // it on their behalf.
      ...(promotedRow
        ? [
            db
              .update(responses)
              .set({ status: "in", waitlistPosition: null, source: "system" })
              .where(eq(responses.id, promotedRow.id)),
          ]
        : []),
      db.update(fixtures).set({ inCount, waitlistCount }).where(eq(fixtures.id, fixtureId)),
    ]);

    if (status === "waitlisted") {
      return { kind: "waitlisted", waitlistPosition: waitlistPosition ?? 1, inCount };
    }
    return {
      kind: "recorded",
      status,
      inCount,
      spotsLeft: Math.max(0, fixture.maxPlayers - inCount),
      // Carried out, never acted on in here: sending the N-2 email inside
      // `blockConcurrencyWhile` would put every other tap on this fixture
      // behind a mail provider's latency. See `WaitlistPromotion`.
      ...(promoted ? { promoted } : {}),
    };
  }
}

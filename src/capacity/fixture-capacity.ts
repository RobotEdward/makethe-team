import { DurableObject } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { getDb, type Db } from "../db/client.js";
import { fixtures, players, responses } from "../db/schema.js";
import { occupiesSlot } from "../domain/response-status.js";
import type { Bindings } from "../env.js";
import type {
  AddGuestInput,
  AddGuestOutcome,
  SetResponseInput,
  SetResponseOutcome,
  WaitlistPromotion,
  WithdrawMemberInput,
  WithdrawMemberOutcome,
} from "./types.js";

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
    //
    // A `withdrawn` row counts as no row: it is the marker that an organiser
    // took this player out of the fixture (BR-3), and someone taken out is no
    // longer eligible to answer. Without this, an old response link still in
    // the removed player's inbox — or an organiser's own mark-in — would put
    // them straight back into the squad, undoing the removal with no record
    // that it had been undone.
    const existing = all.find((r) => r.playerId === input.playerId && r.status !== "withdrawn");
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
      if (inCountWithoutThisPlayer >= fixture.maxPlayers && input.whenFull !== "exceed") {
        if (input.whenFull === "refuse") return { kind: "rejected", reason: "would-exceed-capacity" };
        return {
          kind: "waitlisted",
          waitlistPosition: existing.waitlistPosition ?? 1,
          inCount: inCountWithoutThisPlayer,
        };
      }
      // Self-promotion: a waitlisted player re-tapping once a slot has freed
      // moves straight to `in` here, without going through the BR-7 promotion
      // path below — `occupiesSlot("waitlisted")` is false, so `givesUpASlot`
      // is false and no `promoted` is attached to the outcome. That is
      // correct, not an oversight: this player is the one making the request
      // and is looking at the response page right now, so there is nobody to
      // send an N-2 to. `promoted` exists to tell a player something happened
      // *without* them tapping; it does not apply here.
      status = "in";
    } else if (inCountWithoutThisPlayer >= fixture.maxPlayers) {
      // Full. What happens now is the caller's declared policy, decided in
      // here rather than in the route because a route-level capacity check
      // would be a genuine TOCTOU race against a concurrent tap — this branch
      // runs under `blockConcurrencyWhile`, so the decision is atomic with the
      // count it is deciding against.
      if (input.whenFull === "refuse") return { kind: "rejected", reason: "would-exceed-capacity" };
      if (input.whenFull === "exceed") {
        // BR-8. The fixture goes over capacity, and `fixtureView` derives the
        // `over_capacity` flag from the counts — nothing is stored to say so.
        status = "in";
      } else {
        // BR-4/BR-5/BR-6: appended to the end of the waitlist and told so
        // explicitly, never silently.
        const highest = waitlistedWithoutThisPlayer.reduce(
          (max, r) => Math.max(max, r.waitlistPosition ?? 0),
          0,
        );
        status = "waitlisted";
        waitlistPosition = highest + 1;
      }
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
    //
    // Freeing a slot is necessary but not sufficient — an over-capacity
    // fixture has no slot to give away, so `#slotTakenBy` also checks the
    // fixture is back under `max_players` before handing it on. See that
    // method for why.
    const givesUpASlot = occupiesSlot(existing.status) && !occupiesSlot(status);
    const promotedRow = this.#slotTakenBy({
      freesASlot: givesUpASlot,
      inCountWithoutThisPlayer,
      maxPlayers: fixture.maxPlayers,
      waitlisted: waitlistedWithoutThisPlayer,
    });

    // Exactly one player can be promoted here: this response releases at most
    // one slot. Anything that frees several — a cancellation, a squad change —
    // is a different operation and must do its own promotion pass.
    const promoted: WaitlistPromotion | null =
      promotedRow === null
        ? null
        : {
            playerId: promotedRow.playerId,
            previousWaitlistPosition: promotedRow.waitlistPosition,
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
      ...this.#promotionWrite(db, promotedRow),
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

  /**
   * Remove a squad member's stake in this fixture (BR-3, J6a §3.2).
   *
   * A separate method rather than a `setResponse` variant: `setResponse` takes
   * an `in`/`out` intent and rejects any player without an existing row, which
   * is close to the opposite of what removal needs. It is in the Durable
   * Object at all because it both frees a slot and fills one, and TR-12 admits
   * no capacity write outside here.
   *
   * `blockConcurrencyWhile` is load-bearing for the same reason it is on
   * `setResponse` — read that method's comment. The critical section awaits
   * D1, which is an external call and is not covered by input gating, so
   * without the block a concurrent self-response could read a slot this
   * removal is about to free and both writers could claim it.
   */
  async withdrawMember(input: WithdrawMemberInput): Promise<WithdrawMemberOutcome> {
    return this.ctx.blockConcurrencyWhile(async () => this.#withdrawMemberLocked(input));
  }

  async #withdrawMemberLocked(input: WithdrawMemberInput): Promise<WithdrawMemberOutcome> {
    // From the object's own identity, never from an argument — see
    // `#setResponseLocked` for the full reasoning. The lock is keyed by this
    // name, so a mutation keyed on anything else is not covered by it.
    const fixtureId = this.ctx.id.name;
    if (fixtureId === undefined) {
      throw new Error(
        "FixtureCapacity was addressed by unique id, not by fixture id — every caller must use getByName(fixtureId)",
      );
    }

    const db = getDb(this.env.DB);
    const now = new Date(input.now);

    const [fixture] = await db.select().from(fixtures).where(eq(fixtures.id, fixtureId));
    if (!fixture) return { kind: "no-op", reason: "fixture-not-found" };
    // `scheduled` holds no response rows; `cancelled` and `played` are
    // terminal and rewriting them would be rewriting history.
    if (fixture.lifecycle !== "open") return { kind: "no-op", reason: "fixture-not-open" };

    const all = await db
      .select({
        id: responses.id,
        playerId: responses.playerId,
        status: responses.status,
        waitlistPosition: responses.waitlistPosition,
      })
      .from(responses)
      .where(eq(responses.fixtureId, fixtureId));

    const existing = all.find((row) => row.playerId === input.playerId);
    // No row, or a row already `withdrawn`: nothing left to act on. This is
    // what makes a second call safe, which is what makes a partly-failed
    // removal safe to retry (§3.3).
    if (!existing || existing.status === "withdrawn") return { kind: "no-op", reason: "no-response-row" };
    const previousStatus = existing.status;

    const others = all.filter((row) => row.id !== existing.id);
    const inCountWithoutThisPlayer = others.filter((row) => row.status === "in").length;
    const waitlistedWithoutThisPlayer = others.filter((row) => row.status === "waitlisted");

    // Only an `in` row held a slot, so only an `in` row can free one (BR-7).
    // `occupiesSlot` rather than a literal `=== "in"`, to stay in step with
    // the one definition of what holds a slot. `#slotTakenBy` then applies the
    // same capacity gate `setResponse` does — removing someone an organiser
    // squeezed in past the limit puts the fixture back at its limit rather
    // than passing the extra place to the waitlist.
    const promotedRow = this.#slotTakenBy({
      freesASlot: occupiesSlot(previousStatus),
      inCountWithoutThisPlayer,
      maxPlayers: fixture.maxPlayers,
      waitlisted: waitlistedWithoutThisPlayer,
    });

    const inCount = inCountWithoutThisPlayer + (promotedRow ? 1 : 0);
    const waitlistCount = waitlistedWithoutThisPlayer.length - (promotedRow ? 1 : 0);

    // One batch: D1 has no interactive transactions, so this is the only way
    // to make the withdrawal and the promotion succeed or fail together. Split
    // in two, a failure between them would free a slot nobody took or fill one
    // that was never freed, and the cached counts would disagree either way.
    await db.batch([
      previousStatus === "in"
        ? db
            .update(responses)
            .set({
              status: "withdrawn",
              waitlistPosition: null,
              respondedAt: now,
              setByPlayerId: input.actorPlayerId,
              source: "owner",
            })
            .where(eq(responses.id, existing.id))
        : // `pending`, `out` and `waitlisted` rows are deleted outright (§3.1).
          // None of them holds a slot, so none needs the `withdrawn` marker —
          // and deleting the `out` row is what stops an ex-member showing as
          // having declined.
          db.delete(responses).where(eq(responses.id, existing.id)),
      ...this.#promotionWrite(db, promotedRow),
      db.update(fixtures).set({ inCount, waitlistCount }).where(eq(fixtures.id, fixtureId)),
    ]);

    return {
      kind: "removed",
      previousStatus,
      inCount,
      // Carried out, never acted on in here: an HTTP call to a mail provider
      // inside `blockConcurrencyWhile` would put every other tap on this
      // fixture behind the provider's latency.
      ...(promotedRow
        ? {
            promoted: {
              playerId: promotedRow.playerId,
              previousWaitlistPosition: promotedRow.waitlistPosition,
              promotedAt: input.now,
            },
          }
        : {}),
    };
  }

  /**
   * Add a one-off guest to this fixture (J6b §5).
   *
   * **Why the `players` row is created in here.** It stretches this object's
   * "capacity only" remit, and both alternatives are worse. Creating the
   * person in the route first means a refused over-capacity add leaves an
   * orphaned human being in the database; pre-checking capacity in the route
   * to avoid that is exactly the TOCTOU race `whenFull` exists to close. The
   * guest and the slot they occupy are one fact, so they are one batch.
   *
   * `blockConcurrencyWhile` is load-bearing here for the same reason it is on
   * `setResponse` — read that method's comment.
   */
  async addGuest(input: AddGuestInput): Promise<AddGuestOutcome> {
    return this.ctx.blockConcurrencyWhile(async () => this.#addGuestLocked(input));
  }

  async #addGuestLocked(input: AddGuestInput): Promise<AddGuestOutcome> {
    // From the object's own identity, never from an argument — see
    // `#setResponseLocked` for the full reasoning.
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

    const all = await db
      .select({ status: responses.status })
      .from(responses)
      .where(eq(responses.fixtureId, fixtureId));
    const currentIn = all.filter((row) => row.status === "in").length;

    if (currentIn >= fixture.maxPlayers && input.whenFull === "refuse") {
      return { kind: "rejected", reason: "would-exceed-capacity" };
    }

    const playerId = crypto.randomUUID();
    const inCount = currentIn + 1;

    // One batch. The person and their slot commit together or not at all —
    // which is what makes the refusal above leave nothing behind.
    await db.batch([
      db.insert(players).values({ id: playerId, name: input.name, email: null, isGuest: true }),
      db.insert(responses).values({
        id: crypto.randomUUID(),
        fixtureId,
        playerId,
        status: "in",
        respondedAt: now,
        setByPlayerId: input.actorPlayerId,
        source: "owner",
      }),
      db.update(fixtures).set({ inCount }).where(eq(fixtures.id, fixtureId)),
    ]);

    return {
      kind: "added",
      playerId,
      inCount,
      spotsLeft: Math.max(0, fixture.maxPlayers - inCount),
    };
  }

  /**
   * Who, if anybody, takes the slot this write gives up (BR-7) — the **one**
   * place `setResponse` and `withdrawMember` decide it, so the rule cannot be
   * changed on one path and missed on the other.
   *
   * Two conditions, both required. A slot has to have been given up, and the
   * fixture has to be back **under** `max_players` once this write lands
   * (`inCountWithoutThisPlayer`, since the row being written no longer counts
   * and the promotion is what would push the count back up).
   *
   * The capacity half used to be treated as implied by the first: a row that
   * gave up a slot meant the count had been one higher, so it could only be
   * under the limit already. Going over capacity is now a legitimate state an
   * organiser can ask for deliberately, so that no longer holds. Without this
   * check an over-capacity fixture never returns to its limit — every dropout
   * hands the extra place to whoever is waiting instead — and a player would
   * be put in over capacity by the system, off another player's tap, with no
   * organiser deciding anything.
   */
  #slotTakenBy<T extends { waitlistPosition: number | null }>(args: {
    freesASlot: boolean;
    inCountWithoutThisPlayer: number;
    maxPlayers: number;
    waitlisted: readonly T[];
  }): (T & { waitlistPosition: number }) | null {
    if (!args.freesASlot) return null;
    if (args.inCountWithoutThisPlayer >= args.maxPlayers) return null;
    return this.#longestWaitingCandidate(args.waitlisted);
  }

  /**
   * Find the longest-waiting player among rows waitlisted on this fixture
   * (BR-6, BR-7).
   *
   * This is the **one implementation** of BR-6's "lowest live position" rule.
   * Positions are permanent and gappy: the next joiner takes the highest live
   * position plus one, so a departed top position is reused and numbering
   * restarts at 1 on an empty waitlist. What survives all of that is that the
   * lowest position among players *currently* waitlisted is always the
   * earliest arrival — never the first row returned or the smallest array
   * index.
   *
   * `#slotTakenBy` decides *whether* a slot is going spare; this method only
   * picks who takes it, and is called from there alone.
   */
  #longestWaitingCandidate<T extends { waitlistPosition: number | null }>(
    waitlisted: readonly T[],
  ): (T & { waitlistPosition: number }) | null {
    // Narrow to rows with a real position once, rather than re-deriving a
    // fallback (`?? 0`, `?? 1`) at every use — a filtered row that still had a
    // null position would be a bug in the filter, not something to paper
    // over, and a wrong fallback on `previousWaitlistPosition` in particular
    // would report a false position to the caller.
    const liveCandidates = waitlisted.filter(
      (row): row is T & { waitlistPosition: number } => row.waitlistPosition !== null,
    );
    return liveCandidates.reduce<(T & { waitlistPosition: number }) | null>(
      (best, row) => (best === null || row.waitlistPosition < best.waitlistPosition ? row : best),
      null,
    );
  }

  /**
   * The batch entry that fills a freed slot for the player
   * `#longestWaitingCandidate` selected — an empty array when nobody was
   * promoted, so callers can splice this straight into `db.batch()` without
   * an `if` at the call site.
   *
   * The promoted player's `responded_at` is left alone deliberately: it
   * records when *they* said yes, which is what the squad list orders `in`
   * players by, and a promotion is not a new answer from them. `source`
   * becomes `"system"` because nobody asked for this write — the object did
   * it on their behalf.
   */
  #promotionWrite(db: Db, promotedRow: { id: string } | null) {
    if (!promotedRow) return [];
    return [
      db
        .update(responses)
        .set({ status: "in", waitlistPosition: null, source: "system" })
        .where(eq(responses.id, promotedRow.id)),
    ];
  }
}

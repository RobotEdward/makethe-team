import { DurableObject } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { getDb, type Db } from "../db/client.js";
import { buildAuditInsert } from "../db/audit.js";
import {
  inviteGateApplies,
  loadInviteState,
  stampInvited,
  stampInvitedIndividually,
} from "../db/invite-queries.js";
import { planReleases } from "../domain/invite-tiers.js";
import { fixtures, games, players, responses } from "../db/schema.js";
import { occupiesSlot } from "../domain/response-status.js";
import type { Bindings } from "../env.js";
import type {
  AddGuestInput,
  AddGuestOutcome,
  ClaimInviteReleasesInput,
  ClaimInviteReleasesOutcome,
  InviteIndividuallyInput,
  InviteIndividuallyOutcome,
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
   * Release as many tiers of the Game's invite order as the current state owes
   * (BR-41 to BR-44), stamping `invited_at` on the players that newly invites.
   *
   * **Inside the critical section for the same reason `setResponse` is.** The
   * rule reads the fixture's `in`, `pending` and `waitlisted` counts, which is
   * exactly what a concurrent response changes. Two declines landing together
   * would otherwise each read the pre-decline state, each conclude a tier was
   * owed, and release two.
   */
  async claimInviteReleases(input: ClaimInviteReleasesInput): Promise<ClaimInviteReleasesOutcome> {
    return this.ctx.blockConcurrencyWhile(async () => this.#claimInviteReleasesLocked(input));
  }

  async #claimInviteReleasesLocked(
    input: ClaimInviteReleasesInput,
  ): Promise<ClaimInviteReleasesOutcome> {
    // The fixture id comes from the object's own identity, never from an
    // argument — see `#setResponseLocked` for what a mismatch would break.
    const fixtureId = this.ctx.id.name;
    if (fixtureId === undefined) {
      throw new Error(
        "FixtureCapacity was addressed by unique id, not by fixture id — every caller must use getByName(fixtureId)",
      );
    }

    const db = getDb(this.env.DB);
    const now = new Date(input.now);

    const state = await loadInviteState(db, fixtureId, now);
    if (!state) return { kind: "skipped", reason: "fixture-not-found" };

    const [fixture] = await db.select().from(fixtures).where(eq(fixtures.id, fixtureId));
    // `loadInviteState` already proved the row exists, so this can only be a
    // narrowing for the compiler.
    if (!fixture) return { kind: "skipped", reason: "fixture-not-found" };
    if (fixture.lifecycle !== "open") return { kind: "skipped", reason: "fixture-not-open" };
    if (!state.gated) return { kind: "skipped", reason: "not-gated" };

    // Gating switched on *after* this fixture's invitations already went out.
    //
    // Every member has had the N-1 and nothing has ever been stamped, so
    // releasing a tier now would record that a group had been "asked" when the
    // truth is that the whole squad was asked hours ago. Nobody would be
    // mailed twice — the `n1` dedupe key sees to that — but the organiser's
    // progress panel would report tiers as held, and the people in them would
    // be told "you haven't been asked yet" while holding the invitation.
    //
    // So the fixture stays ungated for the rest of its life and the order
    // takes effect from the next one. The condition is **mailed and never
    // stamped**, not merely mailed: a properly gated fixture also holds `n1`
    // rows the moment its core goes out, and keying on those alone would stop
    // it ever releasing a second tier.
    const anyStamped = state.tiers.some((tier) =>
      tier.members.some((member) => member.invitedAt !== null),
    );
    if (!(await this.#gateApplies(db, fixtureId, state.gated, anyStamped))) {
      return { kind: "skipped", reason: "already-invited" };
    }

    const plan = planReleases({
      tiers: state.tiers,
      guestInCount: state.guestInCount,
      maxPlayers: state.maxPlayers,
      minPlayers: state.minPlayers,
      fallbackDue: state.fallbackDue,
      force: input.force ?? false,
    });

    const stamped = await stampInvited(db, fixtureId, plan.toInvite, now);
    const promoted = await this.#fillFreeSlotsFromWaitlist(db, fixtureId, fixture.maxPlayers, input.now);

    // Disjoint, deliberately. A player promoted by this call is told they are
    // in (N-2); sending them the N-1 invitation as well would ask them a
    // question they have just been given the answer to. Subtracted here rather
    // than left to the caller, because there are two callers and a rule split
    // across both is a rule one of them will eventually get wrong.
    const promotedIds = new Set(promoted.map((row) => row.playerId));
    return { kind: "claimed", playerIds: stamped.filter((id) => !promotedIds.has(id)), promoted };
  }

  /**
   * Invite one player now, out of the invite order's turn (M46).
   *
   * **Inside the critical section, and not merely for the stamp.** The stamp
   * itself is a single guarded UPDATE, but the promotion pass that follows
   * reads how many slots are free — exactly what a concurrent response
   * changes. Stamping outside the lock and promoting inside it would let two
   * presses each see the same free slot.
   *
   * Ungated Games are skipped rather than served: with no order to be out of
   * turn with, every member is already invited, and stamping one would make
   * `inviteGateApplies` read the fixture as gated and strand everybody else
   * behind an order that will never release.
   */
  async inviteIndividually(input: InviteIndividuallyInput): Promise<InviteIndividuallyOutcome> {
    return this.ctx.blockConcurrencyWhile(async () => this.#inviteIndividuallyLocked(input));
  }

  async #inviteIndividuallyLocked(input: InviteIndividuallyInput): Promise<InviteIndividuallyOutcome> {
    // The fixture id comes from the object's own identity, never from an
    // argument — see `#setResponseLocked` for what a mismatch would break.
    const fixtureId = this.ctx.id.name;
    if (fixtureId === undefined) {
      throw new Error(
        "FixtureCapacity was addressed by unique id, not by fixture id — every caller must use getByName(fixtureId)",
      );
    }

    const db = getDb(this.env.DB);
    const now = new Date(input.now);

    const [row] = await db
      .select({ fixture: fixtures, game: games })
      .from(fixtures)
      .innerJoin(games, eq(fixtures.gameId, games.id))
      .where(eq(fixtures.id, fixtureId));
    if (!row) return { kind: "skipped", reason: "fixture-not-found" };
    if (row.fixture.lifecycle !== "open") return { kind: "skipped", reason: "fixture-not-open" };
    if (!row.game.gatedInvitesEnabled) return { kind: "skipped", reason: "not-gated" };

    // No row means this player is not in the fixture's eligible set (BR-1) —
    // they joined after it opened and have not been backfilled, or an owner
    // removed them. There is nothing to stamp, and inserting one here would
    // put somebody into a fixture the eligible set deliberately excludes.
    const [existing] = await db
      .select({ status: responses.status, invitedAt: responses.invitedAt })
      .from(responses)
      .where(and(eq(responses.fixtureId, fixtureId), eq(responses.playerId, input.playerId)));
    if (!existing) return { kind: "skipped", reason: "no-response-row" };

    const stamped = await stampInvitedIndividually(db, fixtureId, input.playerId, now);

    // Runs whether or not this call stamped. A player already invited but
    // still sitting behind the gate with a free slot in front of them is
    // exactly the state a second press is trying to fix, and this pass is
    // level-based, so a call with nothing to do writes nothing.
    const promoted = await this.#fillFreeSlotsFromWaitlist(db, fixtureId, row.fixture.maxPlayers, input.now);

    return {
      kind: "invited",
      stamped,
      // Disjoint from `promoted`, exactly as the release outcome's two lists
      // are: a player this call moved into a slot has been told they are in,
      // and an N-1 asking whether they can play would contradict it.
      owedInvitation: stamped && !promoted.some((entry) => entry.playerId === input.playerId),
      promoted,
    };
  }

  /**
   * Move players off the waitlist into whatever slots are free, in arrival
   * order (BR-40a, BR-7).
   *
   * This is the other half of the gate. A player held back by BR-40a said yes
   * long ago; releasing their tier without this would stamp `invited_at`, mail
   * them an invitation to a fixture they had already accepted, and leave them
   * waitlisted behind an empty slot until somebody else's dropout happened to
   * trigger a promotion.
   *
   * **Level-based, exactly as `planReleases` is, and for the same reason.** It
   * promotes from the *whole* promotable waitlist rather than only the players
   * this call stamped. `stampInvited` and this pass are separate writes — D1
   * has no interactive transaction spanning them — so a failure in between
   * would otherwise leave a player invited, waitlisted, and permanently
   * unpromotable: the next tick would find them already stamped, stamp
   * nothing, and never look at them again. Reconciling the current state
   * instead means any later tick repairs it, and a call with nothing to do
   * writes nothing.
   */
  async #fillFreeSlotsFromWaitlist(
    db: Db,
    fixtureId: string,
    maxPlayers: number,
    now: number,
  ): Promise<WaitlistPromotion[]> {
    const all = await db
      .select({
        id: responses.id,
        playerId: responses.playerId,
        status: responses.status,
        waitlistPosition: responses.waitlistPosition,
        invitedAt: responses.invitedAt,
      })
      .from(responses)
      .where(eq(responses.fixtureId, fixtureId));

    const inCount = all.filter((row) => row.status === "in").length;
    const freeSlots = maxPlayers - inCount;
    if (freeSlots <= 0) return [];

    const waitlisted = all.filter((row) => row.status === "waitlisted");
    // `gateApplies` is true throughout: the caller has already established
    // that this fixture is gated and not BR-46-exempt, which is that
    // predicate's entire content.
    const candidates = [...this.#promotable(waitlisted, true)]
      .filter((row): row is typeof row & { waitlistPosition: number } => row.waitlistPosition !== null)
      .sort((a, b) => a.waitlistPosition - b.waitlistPosition)
      .slice(0, freeSlots);
    if (candidates.length === 0) return [];

    // One batch, so every promotion and the counts that describe them commit
    // together — the same reasoning `setResponse` gives at length. The cached
    // counts lead only because `db.batch` types its first element separately
    // and a spread cannot be that element; a batch is a transaction, so the
    // order of independent statements within it decides nothing.
    await db.batch([
      db
        .update(fixtures)
        .set({
          inCount: inCount + candidates.length,
          waitlistCount: waitlisted.length - candidates.length,
        })
        .where(eq(fixtures.id, fixtureId)),
      ...candidates.map((row) =>
        db
          .update(responses)
          .set({ status: "in", waitlistPosition: null, source: "system" })
          .where(eq(responses.id, row.id)),
      ),
    ]);

    return candidates.map((row) => ({
      playerId: row.playerId,
      previousWaitlistPosition: row.waitlistPosition,
      promotedAt: now,
    }));
  }

  /**
   * Whether this fixture's invite order gates who may *take* a slot (BR-40a).
   *
   * The one place the question is asked, because `setResponse` and
   * `withdrawMember` must not be able to disagree about it: one decides
   * whether an answer is held, the other decides who a freed slot may go to,
   * and a fixture where those two read the gate differently would hold a
   * player back while handing their slot to nobody.
   *
   * The rule itself lives in `inviteGateApplies`, which the fixture pages also
   * read, so that what holds a player back and what the page tells them about
   * it cannot come apart. This wrapper exists only to feed it the row state
   * this object already has.
   */
  async #gateApplies(
    db: Db,
    fixtureId: string,
    gatedInvitesEnabled: boolean,
    anyStamped: boolean,
  ): Promise<boolean> {
    // `anyStamped` is passed rather than queried: this runs inside the lock,
    // where every response row is already in memory and a further read of them
    // would be a round trip bought for nothing.
    return inviteGateApplies(db, { fixtureId, gatedInvitesEnabled, anyStamped });
  }

  /**
   * Record a player's response, deciding `in` versus `waitlisted` against the
   * fixture's capacity (BR-4, BR-5, BR-9) and the invite order (BR-40a).
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
        invitedAt: responses.invitedAt,
      })
      .from(responses)
      .where(eq(responses.fixtureId, fixtureId));

    // A row exists for every eligible player: written when the fixture opened
    // (BR-1), or backfilled when they joined while it was open (BR-2′). No
    // row means they have never been in this fixture's squad.
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

    const [game] = await db
      .select({ gatedInvitesEnabled: games.gatedInvitesEnabled })
      .from(games)
      .where(eq(games.id, fixture.gameId));
    const gateApplies = await this.#gateApplies(
      db,
      fixtureId,
      game?.gatedInvitesEnabled ?? false,
      all.some((r) => r.invitedAt !== null),
    );

    /**
     * BR-40a: the invite order holds this answer back from taking a slot.
     *
     * **Only when the player is answering for themselves.** `actorPlayerId`
     * is the BR-27 record of an override, so a null one is precisely "nobody
     * decided this but them" — an owner marking someone in has the whole
     * picture in front of them and overrules their own order, exactly as
     * BR-8 lets them overrule capacity.
     */
    const heldByGate =
      gateApplies && input.intent === "in" && input.actorPlayerId === null && existing.invitedAt === null;

    /** The back of the waitlist: highest live position plus one (BR-6). */
    const nextWaitlistPosition = (): number =>
      waitlistedWithoutThisPlayer.reduce((max, r) => Math.max(max, r.waitlistPosition ?? 0), 0) + 1;

    // Decide the new state.
    let status: "in" | "out" | "waitlisted";
    let waitlistPosition: number | null = null;

    if (input.intent === "out") {
      status = "out";
    } else if (existing.status === "in") {
      // Already in. Report current state without a pointless write.
      const inCount = inCountWithoutThisPlayer + 1;
      return { kind: "recorded", status: "in", inCount, spotsLeft: Math.max(0, fixture.maxPlayers - inCount) };
    } else if (heldByGate) {
      // BR-40a. Ahead of every capacity branch below, deliberately: the gate
      // binds whether or not there is room, and that is the whole point of it
      // — a sub who has not been asked does not take a free slot ahead of the
      // core group merely because one happens to be free.
      //
      // They are not refused and nothing is lost. They hold a real waitlist
      // place from the moment they tap, so when their tier opens they are
      // ahead of anyone who volunteered later, and `claimInviteReleases` puts
      // them straight in without asking them twice.
      if (existing.status === "waitlisted") {
        // Already waiting on the gate. Keep the original position — BR-6 fixes
        // order by arrival, so re-tapping must not send them to the back — and
        // write nothing, exactly as the full-fixture shortcut below does.
        return {
          kind: "waitlisted",
          waitlistPosition: existing.waitlistPosition ?? 1,
          inCount: inCountWithoutThisPlayer,
        };
      }
      status = "waitlisted";
      waitlistPosition = nextWaitlistPosition();
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
        status = "waitlisted";
        waitlistPosition = nextWaitlistPosition();
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
      gateApplies,
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
      // In the batch, so the trail cannot record an answer the batch did not
      // keep. Only for an answer the player gave themselves: an owner's
      // override is audited by its route as `fixture.response_overridden`,
      // which carries the over-capacity flag and the waitlist rank this row
      // has no way to know about, and two rows for one act would read as two
      // acts.
      ...(input.source === "owner"
        ? []
        : [
            buildAuditInsert(db, {
              actorPlayerId: input.playerId,
              entityType: "fixture" as const,
              entityId: fixtureId,
              action: "fixture.response_recorded" as const,
              before: { status: existing.status },
              after: { status },
              now,
            }),
          ]),
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
        invitedAt: responses.invitedAt,
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
    const [game] = await db
      .select({ gatedInvitesEnabled: games.gatedInvitesEnabled })
      .from(games)
      .where(eq(games.id, fixture.gameId));
    const promotedRow = this.#slotTakenBy({
      freesASlot: occupiesSlot(previousStatus),
      inCountWithoutThisPlayer,
      maxPlayers: fixture.maxPlayers,
      waitlisted: waitlistedWithoutThisPlayer,
      // A removal frees a slot exactly as a decline does, so it must offer it
      // to exactly the same people (BR-40a) — the gate cannot bind on one path
      // and not the other.
      gateApplies: await this.#gateApplies(
        db,
        fixtureId,
        game?.gatedInvitesEnabled ?? false,
        all.some((row) => row.invitedAt !== null),
      ),
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
  #slotTakenBy<T extends { waitlistPosition: number | null; invitedAt: Date | null }>(args: {
    freesASlot: boolean;
    inCountWithoutThisPlayer: number;
    maxPlayers: number;
    waitlisted: readonly T[];
    gateApplies: boolean;
  }): (T & { waitlistPosition: number }) | null {
    if (!args.freesASlot) return null;
    if (args.inCountWithoutThisPlayer >= args.maxPlayers) return null;
    return this.#longestWaitingCandidate(this.#promotable(args.waitlisted, args.gateApplies));
  }

  /**
   * The waitlisted rows a freed slot may actually go to (BR-40a).
   *
   * On a gated fixture an unstamped row is somebody the order has not asked
   * yet, and handing them a slot the moment one frees is precisely what the
   * order exists to prevent — the fixture's own overflow, who *have* been
   * asked, would lose their place to a sub nobody invited. They are not
   * skipped for good: `claimInviteReleases` promotes them as soon as their
   * tier opens, and their waitlist position holds their arrival order in the
   * meantime.
   *
   * A filter, never a re-sort: BR-6's arrival order still decides among
   * whoever is left, so a released player who volunteered later does not
   * overtake a released player who volunteered first.
   */
  #promotable<T extends { invitedAt: Date | null }>(
    waitlisted: readonly T[],
    gateApplies: boolean,
  ): readonly T[] {
    if (!gateApplies) return waitlisted;
    return waitlisted.filter((row) => row.invitedAt !== null);
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

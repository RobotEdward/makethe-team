import { env } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../../src/db/client.js";
import { fixtures, games, inviteTiers, memberships, notificationLog, players, responses } from "../../src/db/schema.js";
import { openFixture } from "../../src/domain/open-fixture.js";
// The Durable Object's own source, as text. Read at build time by Vite's
// `?raw` loader so the "no network call inside the object" assertion below
// inspects the real module rather than trusting a spy.
import fixtureCapacitySource from "../../src/capacity/fixture-capacity.ts?raw";
import { insertGame, resetDatabase } from "../support/factories.js";

const db = getDb(env.DB);
const NOW = new Date("2026-08-13T09:00:00Z");
const KICKOFF = new Date("2026-08-13T18:00:00Z");

async function seedOpenFixture(squadSize: number, maxPlayers = 14): Promise<string> {
  const gameId = await insertGame(db, { maxPlayers });
  const fixtureId = crypto.randomUUID();
  await db.insert(fixtures).values({
    id: fixtureId, gameId, kicksOffAt: KICKOFF, minPlayers: 10, maxPlayers,
    prefersEvenNumbers: true, shortWarningOffsetHours: 12, durationMinutes: 60,
  });
  for (let i = 0; i < squadSize; i++) {
    await db.insert(players).values({ id: `p-${i}`, name: `Player ${i}`, email: `p${i}@example.com` });
    await db.insert(memberships).values({ id: `m-${i}`, gameId, playerId: `p-${i}`, active: true });
  }
  await openFixture(db, fixtureId, NOW);
  return fixtureId;
}

function stubFor(fixtureId: string) {
  return env.FIXTURE_CAPACITY.getByName(fixtureId);
}

// `now` defaults to the fixed `NOW` but can be overridden per call — needed to
// give distinct `responded_at` values to different players without sleeping
// or reading the wall clock (see the BR-7 ordering test below).
function accept(fixtureId: string, playerId: string, now: number = NOW.getTime()) {
  return stubFor(fixtureId).setResponse({
    playerId, intent: "in", actorPlayerId: null, source: "token", whenFull: "waitlist", now,
  });
}

function decline(fixtureId: string, playerId: string, now: number = NOW.getTime()) {
  return stubFor(fixtureId).setResponse({
    playerId, intent: "out", actorPlayerId: null, source: "token", whenFull: "waitlist", now,
  });
}

async function counts(fixtureId: string): Promise<{ inCount: number; cached: number }> {
  const rows = await db.select().from(responses)
    .where(and(eq(responses.fixtureId, fixtureId), eq(responses.status, "in")));
  const [fixture] = await db.select().from(fixtures).where(eq(fixtures.id, fixtureId));
  return { inCount: rows.length, cached: fixture?.inCount ?? -1 };
}

beforeEach(async () => {
  await resetDatabase();
});

describe("recording a response", () => {
  it("records in and updates the cached count", async () => {
    const fixtureId = await seedOpenFixture(5);

    const outcome = await accept(fixtureId, "p-0");

    expect(outcome).toMatchObject({ kind: "recorded", status: "in", inCount: 1, spotsLeft: 13 });
    expect(await counts(fixtureId)).toEqual({ inCount: 1, cached: 1 });
  });

  it("records out and stamps responded_at", async () => {
    const fixtureId = await seedOpenFixture(5);

    const outcome = await decline(fixtureId, "p-0");

    expect(outcome).toMatchObject({ kind: "recorded", status: "out", inCount: 0 });
    const [row] = await db.select().from(responses)
      .where(and(eq(responses.fixtureId, fixtureId), eq(responses.playerId, "p-0")));
    expect(row?.respondedAt?.toISOString()).toBe(NOW.toISOString());
  });

  it("lets a player change their mind, freeing the slot", async () => {
    const fixtureId = await seedOpenFixture(5);
    await accept(fixtureId, "p-0");

    await decline(fixtureId, "p-0");

    expect(await counts(fixtureId)).toEqual({ inCount: 0, cached: 0 });
  });

  it("is idempotent — accepting twice leaves one in", async () => {
    const fixtureId = await seedOpenFixture(5);

    await accept(fixtureId, "p-0");
    const second = await accept(fixtureId, "p-0");

    expect(second).toMatchObject({ kind: "recorded", status: "in", inCount: 1 });
    expect(await counts(fixtureId)).toEqual({ inCount: 1, cached: 1 });
  });
});

describe("capacity and the waitlist", () => {
  it("waitlists a player who accepts a full fixture (BR-5)", async () => {
    const fixtureId = await seedOpenFixture(5, 3);
    await accept(fixtureId, "p-0");
    await accept(fixtureId, "p-1");
    await accept(fixtureId, "p-2");

    const outcome = await accept(fixtureId, "p-3");

    expect(outcome).toMatchObject({ kind: "waitlisted", waitlistPosition: 1, inCount: 3 });
  });

  it("appends to the waitlist in arrival order (BR-6)", async () => {
    const fixtureId = await seedOpenFixture(6, 2);
    await accept(fixtureId, "p-0");
    await accept(fixtureId, "p-1");

    expect(await accept(fixtureId, "p-2")).toMatchObject({ waitlistPosition: 1 });
    expect(await accept(fixtureId, "p-3")).toMatchObject({ waitlistPosition: 2 });
    expect(await accept(fixtureId, "p-4")).toMatchObject({ waitlistPosition: 3 });
  });

  it("does not move a waitlisted player to the back when they tap again (BR-6)", async () => {
    const fixtureId = await seedOpenFixture(6, 2);
    await accept(fixtureId, "p-0");
    await accept(fixtureId, "p-1");
    await accept(fixtureId, "p-2"); // position 1
    await accept(fixtureId, "p-3"); // position 2

    expect(await accept(fixtureId, "p-2")).toMatchObject({ waitlistPosition: 1 });
  });

  it("promotes a waitlisted player who taps again once a slot has freed up", async () => {
    const fixtureId = await seedOpenFixture(6, 2);
    await accept(fixtureId, "p-0");
    await accept(fixtureId, "p-1");
    await accept(fixtureId, "p-2"); // waitlisted
    await decline(fixtureId, "p-0"); // a slot frees; automatic promotion is M4

    const outcome = await accept(fixtureId, "p-2");

    expect(outcome).toMatchObject({ kind: "recorded", status: "in" });
    // This is self-promotion, not BR-7 promotion: the player made this tap
    // themselves and is looking at the response page right now, so there is
    // nobody to send an N-2 to. `promoted` names a player who is told about a
    // status change they did not make — see the comment in
    // `fixture-capacity.ts` at the `existing.status === "waitlisted"` branch.
    expect(outcome).not.toHaveProperty("promoted");
  });

  it("keeps the cached waitlist count accurate when positions are gappy", async () => {
    const fixtureId = await seedOpenFixture(8, 2);
    await accept(fixtureId, "p-0");
    await accept(fixtureId, "p-1");
    await accept(fixtureId, "p-2"); // position 1
    await accept(fixtureId, "p-3"); // position 2
    await accept(fixtureId, "p-4"); // position 3
    await decline(fixtureId, "p-2"); // leaves a gap at 1

    const [fixture] = await db.select().from(fixtures).where(eq(fixtures.id, fixtureId));
    // Two people remain waitlisted, at stored positions 2 and 3. The count must
    // be 2, not 3 — deriving it from the highest position would be wrong.
    expect(fixture?.waitlistCount).toBe(2);
  });

  it("keeps the cached waitlist count accurate", async () => {
    const fixtureId = await seedOpenFixture(5, 2);
    await accept(fixtureId, "p-0");
    await accept(fixtureId, "p-1");
    await accept(fixtureId, "p-2");

    const [fixture] = await db.select().from(fixtures).where(eq(fixtures.id, fixtureId));
    expect(fixture?.waitlistCount).toBe(1);
  });
});

describe("BR-9 — no double-booking, ever", () => {
  it("resolves two simultaneous acceptances for one slot deterministically", async () => {
    const fixtureId = await seedOpenFixture(6, 3);
    await accept(fixtureId, "p-0");
    await accept(fixtureId, "p-1");
    // One slot left. Two players tap at the same instant.

    const [a, b] = await Promise.all([accept(fixtureId, "p-2"), accept(fixtureId, "p-3")]);

    const kinds = [a.kind, b.kind].sort();
    expect(kinds).toEqual(["recorded", "waitlisted"]);
    expect(await counts(fixtureId)).toEqual({ inCount: 3, cached: 3 });
  });

  it("survives a burst of simultaneous acceptances", async () => {
    const fixtureId = await seedOpenFixture(20, 6);

    const outcomes = await Promise.all(
      Array.from({ length: 20 }, (_, i) => accept(fixtureId, `p-${i}`)),
    );

    const accepted = outcomes.filter((o) => o.kind === "recorded").length;
    const waitlisted = outcomes.filter((o) => o.kind === "waitlisted").length;

    expect(accepted).toBe(6);
    expect(waitlisted).toBe(14);
    expect(await counts(fixtureId)).toEqual({ inCount: 6, cached: 6 });

    // Waitlist positions must be a contiguous 1..14 with no gaps or duplicates.
    const rows = await db.select().from(responses)
      .where(and(eq(responses.fixtureId, fixtureId), eq(responses.status, "waitlisted")));
    const positions = rows.map((r) => r.waitlistPosition).sort((x, y) => (x ?? 0) - (y ?? 0));
    expect(positions).toEqual(Array.from({ length: 14 }, (_, i) => i + 1));
  });

  it("cannot be double-booked by addressing the same fixture through two object names", async () => {
    // A prior version of this object took `fixtureId` as an argument and used
    // it for every D1 read/write, while the blockConcurrencyWhile lock was
    // keyed by whatever name the caller addressed via getByName. Those two
    // things could disagree: two differently-named DO instances, each
    // serialising independently, could both be told to operate on the same
    // fixture id and both take the last slot.
    //
    // Now the fixture id comes from `this.ctx.id.name` — the object's own
    // identity — so there is no argument left to disagree with the lock.
    // Addressing this fixture's rows through a second name doesn't touch this
    // fixture at all; that second name simply doesn't correspond to any row,
    // so it can only ever return fixture-not-found. This test can no longer
    // fail: the class of bug it guards against has no code path left to take.
    const fixtureId = await seedOpenFixture(6, 3);
    await accept(fixtureId, "p-0");
    await accept(fixtureId, "p-1");
    // One slot left. Half the taps go through the real object name, half
    // through an unrelated name that does not correspond to any fixture.
    const wrongName = `${fixtureId}-alt`;

    const outcomes = await Promise.all([
      accept(fixtureId, "p-2"),
      accept(fixtureId, "p-3"),
      env.FIXTURE_CAPACITY.getByName(wrongName).setResponse({
        playerId: "p-2", intent: "in", actorPlayerId: null, source: "token", whenFull: "waitlist", now: NOW.getTime(),
      }),
      env.FIXTURE_CAPACITY.getByName(wrongName).setResponse({
        playerId: "p-3", intent: "in", actorPlayerId: null, source: "token", whenFull: "waitlist", now: NOW.getTime(),
      }),
    ]);

    const [, , wrongA, wrongB] = outcomes;
    expect(wrongA).toMatchObject({ kind: "rejected", reason: "fixture-not-found" });
    expect(wrongB).toMatchObject({ kind: "rejected", reason: "fixture-not-found" });

    const { inCount, cached } = await counts(fixtureId);
    expect(inCount).toBeLessThanOrEqual(3);
    expect(cached).toBeLessThanOrEqual(3);
    expect(inCount).toBe(cached);
  });

  it("keeps the cached count equal to COUNT(*) after a randomised sequence", async () => {
    const fixtureId = await seedOpenFixture(10, 5);
    const script: Array<[string, "in" | "out"]> = [
      ["p-0", "in"], ["p-1", "in"], ["p-0", "out"], ["p-2", "in"], ["p-3", "in"],
      ["p-4", "in"], ["p-5", "in"], ["p-1", "out"], ["p-6", "in"], ["p-2", "out"],
      ["p-7", "in"], ["p-8", "in"], ["p-3", "out"], ["p-9", "in"],
    ];
    for (const [playerId, intent] of script) {
      await stubFor(fixtureId).setResponse({
        playerId, intent, actorPlayerId: null, source: "web", whenFull: "waitlist", now: NOW.getTime(),
      });
    }

    const { inCount, cached } = await counts(fixtureId);
    expect(cached).toBe(inCount);
  });
});

describe("BR-7 — promotion from the waitlist", () => {
  async function waitlistRows(fixtureId: string) {
    return db.select().from(responses)
      .where(and(eq(responses.fixtureId, fixtureId), eq(responses.status, "waitlisted")));
  }

  it("promotes the lowest live waitlist position — not the lowest id, not the most recent", async () => {
    const fixtureId = await seedOpenFixture(6, 2);
    await accept(fixtureId, "p-0");
    await accept(fixtureId, "p-1");
    // Build a gappy waitlist whose lowest live position is neither the lowest
    // player id nor the most recent joiner.
    await accept(fixtureId, "p-5"); // position 1
    await accept(fixtureId, "p-4"); // position 2
    await accept(fixtureId, "p-3"); // position 3
    await decline(fixtureId, "p-5"); // leaves a gap at 1; lowest live is now 2
    await accept(fixtureId, "p-2"); // highest live + 1 = position 4

    const outcome = await decline(fixtureId, "p-0");

    // p-2 is the lowest id and the most recent joiner; p-4 is the longest
    // waiting of those still on the list. Only p-4 may be promoted.
    expect(outcome).toMatchObject({
      kind: "recorded",
      status: "out",
      promoted: { playerId: "p-4", previousWaitlistPosition: 2, promotedAt: NOW.getTime() },
    });
  });

  it("promotes by lowest position even when lowest id and earliest responded_at each name a different player", async () => {
    // The first ordering test above pins position against id and row order,
    // but every candidate in it shares one hard-coded `NOW`, so it cannot
    // tell "lowest position" apart from "earliest responded_at". Here the
    // three signals point at three different players: p-6 has the lowest
    // live position, p-2 has the lowest id, and p-5's responded_at is
    // earlier than either — set explicitly via `now`, never by sleeping or
    // reading the clock twice. Only the position should decide the winner.
    const fixtureId = await seedOpenFixture(20, 2);
    await accept(fixtureId, "p-0");
    await accept(fixtureId, "p-1");
    const EARLIER = new Date(NOW.getTime() - 60_000);
    await accept(fixtureId, "p-6"); // position 1 — lowest position
    await accept(fixtureId, "p-2"); // position 2 — lowest id
    await accept(fixtureId, "p-5", EARLIER.getTime()); // position 3 — earliest responded_at

    const outcome = await decline(fixtureId, "p-0");

    expect(outcome).toMatchObject({
      kind: "recorded",
      status: "out",
      promoted: { playerId: "p-6", previousWaitlistPosition: 1 },
    });
  });

  it("writes the dropout and the promotion in a single db.batch call (BR-7 atomicity)", async () => {
    // D1 has no interactive transactions, so `db.batch()` is the only
    // primitive that makes the dropout and the promotion succeed or fail
    // together. This spies on the real binding the Durable Object writes
    // through (`env.DB.batch`) rather than trusting that the source reads a
    // certain way — moving the promotion UPDATE out of the batch into a
    // separate `await` would still read plausibly but would show up here as
    // a second call, or a batch of fewer than three statements.
    const fixtureId = await seedOpenFixture(6, 2);
    await accept(fixtureId, "p-0");
    await accept(fixtureId, "p-1");
    await accept(fixtureId, "p-2"); // waitlisted, position 1 — will be promoted

    const batchSpy = vi.spyOn(env.DB, "batch");
    try {
      const outcome = await decline(fixtureId, "p-0");

      expect(outcome).toMatchObject({ promoted: { playerId: "p-2" } });
      expect(batchSpy).toHaveBeenCalledTimes(1);
      expect(batchSpy.mock.calls[0]?.[0]).toHaveLength(3);
    } finally {
      batchSpy.mockRestore();
    }
  });

  it("makes the promoted row `in` with a null position, source 'system', an untouched responded_at, and keeps both cached counts right", async () => {
    const fixtureId = await seedOpenFixture(6, 2);
    await accept(fixtureId, "p-0");
    await accept(fixtureId, "p-1");
    await accept(fixtureId, "p-2"); // position 1
    await accept(fixtureId, "p-3"); // position 2

    const [beforePromotion] = await db.select().from(responses)
      .where(and(eq(responses.fixtureId, fixtureId), eq(responses.playerId, "p-2")));

    await decline(fixtureId, "p-0");

    const [promotedRow] = await db.select().from(responses)
      .where(and(eq(responses.fixtureId, fixtureId), eq(responses.playerId, "p-2")));
    expect(promotedRow?.status).toBe("in");
    expect(promotedRow?.waitlistPosition).toBeNull();
    // Both deliberate: `source` becomes "system" because nobody asked for
    // this write — the object did it on the departing player's behalf, not
    // the promoted player's own action. `responded_at` is left exactly as it
    // was: it records when *they* said yes, and `getFixtureWithSquad` orders
    // the squad by it (src/db/queries.ts:62), so overwriting it would reorder
    // the squad list as a side effect of a stranger's dropout.
    expect(promotedRow?.source).toBe("system");
    expect(promotedRow?.respondedAt?.toISOString()).toBe(beforePromotion?.respondedAt?.toISOString());

    expect(await counts(fixtureId)).toEqual({ inCount: 2, cached: 2 });
    const [fixture] = await db.select().from(fixtures).where(eq(fixtures.id, fixtureId));
    expect(fixture?.waitlistCount).toBe(1);
    // p-3 keeps its permanent, gappy position — promotion never renumbers.
    expect((await waitlistRows(fixtureId)).map((r) => r.waitlistPosition)).toEqual([2]);
  });

  it("reports the freed slot as taken — spotsLeft stays 0 when someone is promoted", async () => {
    const fixtureId = await seedOpenFixture(6, 2);
    await accept(fixtureId, "p-0");
    await accept(fixtureId, "p-1");
    await accept(fixtureId, "p-2");

    const outcome = await decline(fixtureId, "p-0");

    expect(outcome).toMatchObject({ kind: "recorded", status: "out", inCount: 2, spotsLeft: 0 });
  });

  it("promotes nobody when the waitlist is empty", async () => {
    const fixtureId = await seedOpenFixture(6, 2);
    await accept(fixtureId, "p-0");
    await accept(fixtureId, "p-1");

    const outcome = await decline(fixtureId, "p-0");

    expect(outcome).toMatchObject({ kind: "recorded", status: "out", inCount: 1, spotsLeft: 1 });
    expect(outcome).not.toHaveProperty("promoted");
  });

  it("promotes nobody when the fixture was never full", async () => {
    const fixtureId = await seedOpenFixture(6);
    await accept(fixtureId, "p-0");
    await accept(fixtureId, "p-1");

    const outcome = await decline(fixtureId, "p-0");

    expect(outcome).not.toHaveProperty("promoted");
    expect(await counts(fixtureId)).toEqual({ inCount: 1, cached: 1 });
  });

  it("promotes nobody when the player leaving was not in — an `out` on top of an `out`", async () => {
    const fixtureId = await seedOpenFixture(6, 2);
    await accept(fixtureId, "p-0");
    await accept(fixtureId, "p-1");
    await accept(fixtureId, "p-2"); // position 1
    await accept(fixtureId, "p-3"); // position 2

    const first = await decline(fixtureId, "p-0"); // frees a slot, promotes p-2
    const second = await decline(fixtureId, "p-0"); // frees nothing

    expect(first).toMatchObject({ promoted: { playerId: "p-2" } });
    expect(second).not.toHaveProperty("promoted");
    // p-3 is still waiting: the second decline released no slot for them.
    expect((await waitlistRows(fixtureId)).map((r) => r.playerId)).toEqual(["p-3"]);
    expect(await counts(fixtureId)).toEqual({ inCount: 2, cached: 2 });
  });

  it("promotes nobody when a waitlisted player declines — no slot was held", async () => {
    const fixtureId = await seedOpenFixture(6, 2);
    await accept(fixtureId, "p-0");
    await accept(fixtureId, "p-1");
    await accept(fixtureId, "p-2"); // position 1
    await accept(fixtureId, "p-3"); // position 2

    const outcome = await decline(fixtureId, "p-2");

    expect(outcome).not.toHaveProperty("promoted");
    expect((await waitlistRows(fixtureId)).map((r) => r.playerId)).toEqual(["p-3"]);
    expect(await counts(fixtureId)).toEqual({ inCount: 2, cached: 2 });
  });

  it("promotes exactly one player per simultaneous dropout, and never the same one twice", async () => {
    const fixtureId = await seedOpenFixture(20, 6);
    // Sequentially, so the six `in` players and the fourteen waitlist
    // positions are known: p-0..p-5 are in, p-6..p-19 hold positions 1..14.
    for (let i = 0; i < 20; i++) await accept(fixtureId, `p-${i}`);

    const outcomes = await Promise.all(
      Array.from({ length: 6 }, (_, i) => decline(fixtureId, `p-${i}`)),
    );

    const promoted = outcomes.flatMap((o) => (o.kind === "recorded" && o.promoted ? [o.promoted] : []));
    // As many promotions as dropouts, each a different player.
    expect(promoted).toHaveLength(6);
    expect(new Set(promoted.map((p) => p.playerId)).size).toBe(6);
    // The six longest waiting, and nobody else.
    expect(promoted.map((p) => p.playerId).sort()).toEqual(
      ["p-6", "p-7", "p-8", "p-9", "p-10", "p-11"].sort(),
    );
    expect(promoted.map((p) => p.previousWaitlistPosition).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);

    // No slot left unfilled, and the cache agrees with COUNT(*).
    expect(await counts(fixtureId)).toEqual({ inCount: 6, cached: 6 });
    const [fixture] = await db.select().from(fixtures).where(eq(fixtures.id, fixtureId));
    expect(fixture?.waitlistCount).toBe(8);
    const stillWaiting = await waitlistRows(fixtureId);
    expect(stillWaiting).toHaveLength(8);
    expect(stillWaiting.map((r) => r.waitlistPosition).sort((a, b) => (a ?? 0) - (b ?? 0)))
      .toEqual([7, 8, 9, 10, 11, 12, 13, 14]);
  });

  it("sends nothing itself — the promotion leaves the object in the outcome", async () => {
    // The N-2 email must be sent by the caller, outside the lock. An HTTP call
    // from inside `blockConcurrencyWhile` would serialise every other tap on
    // the fixture behind a mail provider's latency. The module therefore
    // contains no network call at all — asserted directly on its source rather
    // than inferred from a spy that a future edit could quietly bypass.
    //
    // Limitation: this reads only `fixture-capacity.ts?raw`, so it guards
    // this file and no other. If the promotion decision (or anything that
    // could reach a notifier) is ever extracted into a helper module, this
    // assertion goes on passing while the guarantee it names no longer holds
    // for the extracted code — the new module would need its own `?raw`
    // check, or this one would need to read a wider glob.
    expect(fixtureCapacitySource).not.toMatch(/\bfetch\s*\(/);
    expect(fixtureCapacitySource).not.toMatch(/\bnew\s+Request\s*\(/);
    // Nor does it reach a notifier by any other route: no import of the notify
    // layer, no use of the NOTIFIER binding. (Comments are exempt — the match
    // is on `import`/`env.` syntax, not on prose about the email.)
    expect(fixtureCapacitySource).not.toMatch(/^\s*import[^\n]*notify/m);
    expect(fixtureCapacitySource).not.toMatch(/env\.NOTIFIER/);

    const fixtureId = await seedOpenFixture(6, 2);
    await accept(fixtureId, "p-0");
    await accept(fixtureId, "p-1");
    await accept(fixtureId, "p-2");

    const outcome = await decline(fixtureId, "p-0");

    // The one and only way the promotion escapes the object.
    expect(outcome).toMatchObject({ promoted: { playerId: "p-2", previousWaitlistPosition: 1 } });
  });
});

describe("rejections", () => {
  it("refuses a fixture that is not open", async () => {
    const fixtureId = await seedOpenFixture(5);
    await db.update(fixtures).set({ lifecycle: "cancelled" }).where(eq(fixtures.id, fixtureId));

    expect(await accept(fixtureId, "p-0")).toMatchObject({ kind: "rejected", reason: "fixture-not-open" });
  });

  it("refuses a player with no response row — they were not eligible (BR-2)", async () => {
    const fixtureId = await seedOpenFixture(5);
    await db.insert(players).values({ id: "outsider", name: "Outsider", email: "o@example.com" });

    expect(await accept(fixtureId, "outsider")).toMatchObject({ kind: "rejected", reason: "not-eligible" });
  });

  it("refuses an unknown fixture", async () => {
    expect(
      await env.FIXTURE_CAPACITY.getByName("nope").setResponse({
        playerId: "p-0", intent: "in",
        actorPlayerId: null, source: "token", whenFull: "waitlist", now: NOW.getTime(),
      }),
    ).toMatchObject({ kind: "rejected", reason: "fixture-not-found" });
  });
});

describe("whenFull (BR-8)", () => {
  it("refuses without writing when an owner marks in on a full fixture", async () => {
    const fixtureId = await seedOpenFixture(5, 2);
    await accept(fixtureId, "p-0");
    await accept(fixtureId, "p-1");

    const outcome = await stubFor(fixtureId).setResponse({
      playerId: "p-2", intent: "in", actorPlayerId: "p-0", source: "owner",
      whenFull: "refuse", now: NOW.getTime(),
    });

    expect(outcome).toEqual({ kind: "rejected", reason: "would-exceed-capacity" });
    // Nothing written: the row is untouched and the cached count did not move.
    const [row] = await db.select().from(responses)
      .where(and(eq(responses.fixtureId, fixtureId), eq(responses.playerId, "p-2")));
    expect(row?.status).toBe("pending");
    expect(row?.respondedAt).toBeNull();
    expect(await counts(fixtureId)).toEqual({ inCount: 2, cached: 2 });
  });

  it("goes over capacity when the owner confirms", async () => {
    const fixtureId = await seedOpenFixture(5, 2);
    await accept(fixtureId, "p-0");
    await accept(fixtureId, "p-1");

    const outcome = await stubFor(fixtureId).setResponse({
      playerId: "p-2", intent: "in", actorPlayerId: "p-0", source: "owner",
      whenFull: "exceed", now: NOW.getTime(),
    });

    expect(outcome).toMatchObject({ kind: "recorded", status: "in", inCount: 3, spotsLeft: 0 });
    expect(await counts(fixtureId)).toEqual({ inCount: 3, cached: 3 });
    const [row] = await db.select().from(responses)
      .where(and(eq(responses.fixtureId, fixtureId), eq(responses.playerId, "p-2")));
    expect(row?.setByPlayerId).toBe("p-0");
    expect(row?.source).toBe("owner");
    expect(row?.waitlistPosition).toBeNull();
  });

  it("still waitlists a player answering for themselves", async () => {
    const fixtureId = await seedOpenFixture(5, 2);
    await accept(fixtureId, "p-0");
    await accept(fixtureId, "p-1");

    const outcome = await accept(fixtureId, "p-2");

    expect(outcome).toMatchObject({ kind: "waitlisted", waitlistPosition: 1 });
  });

  it("marks in normally when the fixture is not full, whatever whenFull says", async () => {
    const fixtureId = await seedOpenFixture(5, 10);

    const outcome = await stubFor(fixtureId).setResponse({
      playerId: "p-0", intent: "in", actorPlayerId: "p-1", source: "owner",
      whenFull: "refuse", now: NOW.getTime(),
    });

    expect(outcome).toMatchObject({ kind: "recorded", status: "in", inCount: 1 });
  });

  it("refuses `out` never — whenFull only governs taking a slot", async () => {
    const fixtureId = await seedOpenFixture(5, 2);
    await accept(fixtureId, "p-0");
    await accept(fixtureId, "p-1");

    const outcome = await stubFor(fixtureId).setResponse({
      playerId: "p-1", intent: "out", actorPlayerId: "p-0", source: "owner",
      whenFull: "refuse", now: NOW.getTime(),
    });

    expect(outcome).toMatchObject({ kind: "recorded", status: "out" });
  });

  it("refuses without writing when an owner marks in an already-waitlisted player", async () => {
    const fixtureId = await seedOpenFixture(6, 2);
    await accept(fixtureId, "p-0");
    await accept(fixtureId, "p-1");
    await accept(fixtureId, "p-2"); // waitlisted, position 1
    await accept(fixtureId, "p-3"); // waitlisted, position 2

    const outcome = await stubFor(fixtureId).setResponse({
      playerId: "p-2", intent: "in", actorPlayerId: "p-0", source: "owner",
      whenFull: "refuse", now: NOW.getTime(),
    });

    expect(outcome).toEqual({ kind: "rejected", reason: "would-exceed-capacity" });
    // Nothing written: still waitlisted at its original position, cached counts unmoved.
    const [row] = await db.select().from(responses)
      .where(and(eq(responses.fixtureId, fixtureId), eq(responses.playerId, "p-2")));
    expect(row?.status).toBe("waitlisted");
    expect(row?.waitlistPosition).toBe(1);
    expect(await counts(fixtureId)).toEqual({ inCount: 2, cached: 2 });
  });

  it("promotes an already-waitlisted player straight to in when the owner exceeds", async () => {
    const fixtureId = await seedOpenFixture(6, 2);
    await accept(fixtureId, "p-0");
    await accept(fixtureId, "p-1");
    await accept(fixtureId, "p-2"); // waitlisted, position 1
    await accept(fixtureId, "p-3"); // waitlisted, position 2

    const outcome = await stubFor(fixtureId).setResponse({
      playerId: "p-2", intent: "in", actorPlayerId: "p-0", source: "owner",
      whenFull: "exceed", now: NOW.getTime(),
    });

    expect(outcome).toMatchObject({ kind: "recorded", status: "in", inCount: 3, spotsLeft: 0 });
    expect(await counts(fixtureId)).toEqual({ inCount: 3, cached: 3 });
    const [row] = await db.select().from(responses)
      .where(and(eq(responses.fixtureId, fixtureId), eq(responses.playerId, "p-2")));
    expect(row?.status).toBe("in");
    expect(row?.waitlistPosition).toBeNull();
    expect(row?.setByPlayerId).toBe("p-0");
    expect(row?.source).toBe("owner");
  });

  it("keeps an already-waitlisted player's original position when they tap again themselves (BR-6)", async () => {
    const fixtureId = await seedOpenFixture(6, 2);
    await accept(fixtureId, "p-0");
    await accept(fixtureId, "p-1");
    await accept(fixtureId, "p-2"); // waitlisted, position 1
    await accept(fixtureId, "p-3"); // waitlisted, position 2

    // p-2 re-taps for themselves while the fixture is still full. With two
    // waitlisted players, "still position 1" is distinguishable from "moved
    // to the back and happened to land on 1" — the latter would give p-2
    // position 3 (highest live + 1) instead.
    const outcome = await accept(fixtureId, "p-2");

    expect(outcome).toMatchObject({ kind: "waitlisted", waitlistPosition: 1 });
    const [row] = await db.select().from(responses)
      .where(and(eq(responses.fixtureId, fixtureId), eq(responses.playerId, "p-2")));
    expect(row?.status).toBe("waitlisted");
    expect(row?.waitlistPosition).toBe(1);
  });
});

/**
 * BR-7's promotion is gated on the fixture being back *under* its limit. An
 * organiser can now deliberately put a fixture over capacity (BR-8), and while
 * it is over there is no spare place to hand on — a dropout returns the fixture
 * towards its limit instead.
 */
describe("promotion while over capacity (BR-7 × BR-8)", () => {
  async function rowFor(fixtureId: string, playerId: string) {
    const [row] = await db.select().from(responses)
      .where(and(eq(responses.fixtureId, fixtureId), eq(responses.playerId, playerId)));
    return row ?? null;
  }

  it("promotes nobody when a dropout only brings an over-capacity fixture back to its limit", async () => {
    const fixtureId = await seedOpenFixture(6, 2);
    await accept(fixtureId, "p-0");
    await accept(fixtureId, "p-1");
    await accept(fixtureId, "p-2"); // waitlisted, position 1
    // The organiser's deliberate second act: three in, two places.
    await stubFor(fixtureId).setResponse({
      playerId: "p-3", intent: "in", actorPlayerId: "p-0", source: "owner",
      whenFull: "exceed", now: NOW.getTime(),
    });
    expect(await counts(fixtureId)).toEqual({ inCount: 3, cached: 3 });

    // A player answering for themselves, on their own link.
    const outcome = await decline(fixtureId, "p-0");

    expect(outcome).toMatchObject({ kind: "recorded", status: "out", inCount: 2 });
    expect(outcome).not.toHaveProperty("promoted");
    expect(await counts(fixtureId)).toEqual({ inCount: 2, cached: 2 });
    // The waitlisted player stays put, at the position they arrived at.
    expect(await rowFor(fixtureId, "p-2")).toMatchObject({ status: "waitlisted", waitlistPosition: 1 });
    const [fixture] = await db.select().from(fixtures).where(eq(fixtures.id, fixtureId));
    expect(fixture?.waitlistCount).toBe(1);
  });

  it("still promotes when the fixture was exactly at its limit", async () => {
    const fixtureId = await seedOpenFixture(6, 2);
    await accept(fixtureId, "p-0");
    await accept(fixtureId, "p-1");
    await accept(fixtureId, "p-2"); // waitlisted, position 1

    const outcome = await decline(fixtureId, "p-0");

    // The gate narrows BR-7 to over-capacity fixtures only; at the limit a
    // dropout hands the place on exactly as it always has.
    expect(outcome).toMatchObject({
      kind: "recorded",
      status: "out",
      inCount: 2,
      promoted: { playerId: "p-2", previousWaitlistPosition: 1 },
    });
    expect(await rowFor(fixtureId, "p-2")).toMatchObject({ status: "in", waitlistPosition: null });
  });
});

/**
 * A player an organiser has removed from the fixture (BR-3) is no longer
 * eligible to answer — through their own response link or an organiser's
 * override — so `setResponse` refuses rather than putting them back in.
 */
describe("a withdrawn player", () => {
  async function withdrawnFixture(): Promise<string> {
    const fixtureId = await seedOpenFixture(5, 14);
    await accept(fixtureId, "p-0");
    await env.FIXTURE_CAPACITY.getByName(fixtureId).withdrawMember({
      playerId: "p-0", actorPlayerId: "p-1", now: NOW.getTime(),
    });
    return fixtureId;
  }

  async function statusOf(fixtureId: string, playerId: string) {
    const [row] = await db.select().from(responses)
      .where(and(eq(responses.fixtureId, fixtureId), eq(responses.playerId, playerId)));
    return row?.status;
  }

  it("is not eligible when presenting their own response link", async () => {
    const fixtureId = await withdrawnFixture();

    expect(await accept(fixtureId, "p-0")).toEqual({ kind: "rejected", reason: "not-eligible" });
    expect(await statusOf(fixtureId, "p-0")).toBe("withdrawn");
    expect(await counts(fixtureId)).toEqual({ inCount: 0, cached: 0 });
  });

  it("is not eligible when an organiser marks them in", async () => {
    const fixtureId = await withdrawnFixture();

    const outcome = await stubFor(fixtureId).setResponse({
      playerId: "p-0", intent: "in", actorPlayerId: "p-1", source: "owner",
      whenFull: "exceed", now: NOW.getTime(),
    });

    expect(outcome).toEqual({ kind: "rejected", reason: "not-eligible" });
    expect(await statusOf(fixtureId, "p-0")).toBe("withdrawn");
    expect(await counts(fixtureId)).toEqual({ inCount: 0, cached: 0 });
  });

  it("is not eligible to decline either — the removal stands", async () => {
    const fixtureId = await withdrawnFixture();

    expect(await decline(fixtureId, "p-0")).toEqual({ kind: "rejected", reason: "not-eligible" });
    expect(await statusOf(fixtureId, "p-0")).toBe("withdrawn");
  });
});

/**
 * BR-40a. Gating used to govern only who was *notified*; it now also governs
 * who may take a slot. A player whose tier is unreleased still answers, and
 * still holds their place in arrival order — they simply wait on the gate
 * rather than walking past it.
 */
describe("the invite order gates who takes a slot (BR-40a)", () => {
  async function gatedOpenFixture(opts: { core: number; subs: number; maxPlayers?: number }) {
    const gameId = await insertGame(db, {
      gatedInvitesEnabled: true,
      maxPlayers: opts.maxPlayers ?? 14,
    });
    const fixtureId = crypto.randomUUID();
    await db.insert(fixtures).values({
      id: fixtureId, gameId, kicksOffAt: KICKOFF, minPlayers: 2,
      maxPlayers: opts.maxPlayers ?? 14, prefersEvenNumbers: true,
      shortWarningOffsetHours: 12, durationMinutes: 60,
    });
    const coreTier = crypto.randomUUID();
    const subTier = crypto.randomUUID();
    await db.insert(inviteTiers).values([
      { id: coreTier, gameId, name: "Core", position: 1 },
      { id: subTier, gameId, name: "Subs", position: 2 },
    ]);
    for (let i = 0; i < opts.core + opts.subs; i++) {
      await db.insert(players).values({ id: `g-${i}`, name: `Player ${i}`, email: `g${i}@example.com` });
      await db.insert(memberships).values({
        id: `gm-${i}`, gameId, playerId: `g-${i}`, active: true,
        inviteTierId: i < opts.core ? coreTier : subTier,
      });
    }
    await openFixture(db, fixtureId, NOW);
    // Release the core, which is what puts the order into effect.
    await stubFor(fixtureId).claimInviteReleases({ now: NOW.getTime() });
    return fixtureId;
  }

  const rowFor = async (fixtureId: string, playerId: string) => {
    const [row] = await db.select().from(responses)
      .where(and(eq(responses.fixtureId, fixtureId), eq(responses.playerId, playerId)));
    return row;
  };

  it("waitlists an uninvited player even with the fixture nearly empty", async () => {
    const fixtureId = await gatedOpenFixture({ core: 2, subs: 2 });

    // Thirteen slots free, and they still do not get one.
    expect(await accept(fixtureId, "g-2")).toMatchObject({ kind: "waitlisted", waitlistPosition: 1 });
    expect((await rowFor(fixtureId, "g-2"))?.status).toBe("waitlisted");
    expect(await counts(fixtureId)).toEqual({ inCount: 0, cached: 0 });
  });

  it("lets an invited player straight in on the same fixture", async () => {
    // The control. Same fixture, same call, and the only difference is that
    // the order has reached this player — so a failure here means the gate is
    // catching everybody, not that it is catching the right people.
    const fixtureId = await gatedOpenFixture({ core: 2, subs: 2 });

    expect(await accept(fixtureId, "g-0")).toMatchObject({ kind: "recorded", status: "in" });
  });

  it("keeps their arrival position when they tap again", async () => {
    const fixtureId = await gatedOpenFixture({ core: 2, subs: 2 });
    await accept(fixtureId, "g-2");
    await accept(fixtureId, "g-3");

    // BR-6 fixes order by arrival, so re-tapping must not send them to the
    // back of a queue they were already at the front of.
    expect(await accept(fixtureId, "g-2")).toMatchObject({ waitlistPosition: 1 });
    expect((await rowFor(fixtureId, "g-3"))?.waitlistPosition).toBe(2);
  });

  it("still lets them decline — the gate holds nobody to a game", async () => {
    const fixtureId = await gatedOpenFixture({ core: 2, subs: 2 });

    expect(await decline(fixtureId, "g-2")).toMatchObject({ kind: "recorded", status: "out" });
  });

  it("does not gate an owner marking someone in", async () => {
    const fixtureId = await gatedOpenFixture({ core: 2, subs: 2 });

    const outcome = await stubFor(fixtureId).setResponse({
      playerId: "g-2", intent: "in", actorPlayerId: "g-0", source: "owner",
      whenFull: "refuse", now: NOW.getTime(),
    });

    // The owner has the whole picture and overrules their own order, exactly
    // as BR-8 lets them overrule capacity.
    expect(outcome).toMatchObject({ kind: "recorded", status: "in" });
  });

  it("does not hand a freed slot to an uninvited player", async () => {
    const fixtureId = await gatedOpenFixture({ core: 2, subs: 2, maxPlayers: 2 });
    await accept(fixtureId, "g-0");
    await accept(fixtureId, "g-1");
    await accept(fixtureId, "g-2"); // gate-waitlisted, and the fixture is full too

    await decline(fixtureId, "g-1");

    // BR-7 would have promoted them. The order outranks it: the slot stays
    // open for the tier that is actually being asked.
    expect((await rowFor(fixtureId, "g-2"))?.status).toBe("waitlisted");
    expect(await counts(fixtureId)).toEqual({ inCount: 1, cached: 1 });
  });

  it("hands a freed slot to an invited player waiting behind a full fixture", async () => {
    // The pair to the test above. An invited player who waitlisted on
    // capacity is promoted as they always were — the gate filters the
    // waitlist, it does not switch BR-7 off.
    const fixtureId = await gatedOpenFixture({ core: 3, subs: 1, maxPlayers: 2 });
    await accept(fixtureId, "g-0");
    await accept(fixtureId, "g-1");
    await accept(fixtureId, "g-2");

    await decline(fixtureId, "g-1");

    expect((await rowFor(fixtureId, "g-2"))?.status).toBe("in");
  });

  it("promotes the invited player over an uninvited one who volunteered first", async () => {
    // The ordering question this milestone had to answer: arrival order still
    // decides, but only among people the order has actually asked.
    const fixtureId = await gatedOpenFixture({ core: 3, subs: 1, maxPlayers: 2 });
    await accept(fixtureId, "g-0");
    await accept(fixtureId, "g-1");
    await accept(fixtureId, "g-3", NOW.getTime() + 1_000); // uninvited sub, first to wait
    await accept(fixtureId, "g-2", NOW.getTime() + 2_000); // invited core, second

    await decline(fixtureId, "g-1");

    expect((await rowFor(fixtureId, "g-2"))?.status).toBe("in");
    expect((await rowFor(fixtureId, "g-3"))?.status).toBe("waitlisted");
  });

  it("gates nobody on a fixture whose squad was mailed before gating (BR-46)", async () => {
    // No stamp anywhere and an n1 already sent means the whole squad holds the
    // invitation. Gating on the stamp here would waitlist every one of them,
    // permanently — nothing will ever release a tier on this fixture.
    const gameId = await insertGame(db, { gatedInvitesEnabled: true });
    const fixtureId = crypto.randomUUID();
    await db.insert(fixtures).values({
      id: fixtureId, gameId, kicksOffAt: KICKOFF, minPlayers: 2, maxPlayers: 14,
      prefersEvenNumbers: true, shortWarningOffsetHours: 12, durationMinutes: 60,
    });
    await db.insert(players).values({ id: "b-0", name: "Player", email: "b0@example.com" });
    await db.insert(memberships).values({ id: "bm-0", gameId, playerId: "b-0", active: true });
    await openFixture(db, fixtureId, NOW);
    await db.insert(notificationLog).values({
      id: crypto.randomUUID(), dedupeKey: `n1:${fixtureId}:b-0`, notificationType: "n1",
      fixtureId, playerId: "b-0", channel: "email", status: "sent",
    });

    expect(await accept(fixtureId, "b-0")).toMatchObject({ kind: "recorded", status: "in" });
  });

  it("gates nobody once the owner switches gating back off", async () => {
    // The stamps stay behind on the fixture. Reading those alone would strand
    // every unstamped player behind an order nothing will release again.
    const fixtureId = await gatedOpenFixture({ core: 2, subs: 2 });
    const [fixture] = await db.select().from(fixtures).where(eq(fixtures.id, fixtureId));
    await db.update(games).set({ gatedInvitesEnabled: false }).where(eq(games.id, fixture!.gameId));

    expect(await accept(fixtureId, "g-2")).toMatchObject({ kind: "recorded", status: "in" });
  });
});

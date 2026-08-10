import { env } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../src/db/client.js";
import { fixtures, memberships, players, responses } from "../../src/db/schema.js";
import { openFixture } from "../../src/domain/open-fixture.js";
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

function accept(fixtureId: string, playerId: string) {
  return stubFor(fixtureId).setResponse({
    playerId, intent: "in", actorPlayerId: null, source: "token", now: NOW.getTime(),
  });
}

function decline(fixtureId: string, playerId: string) {
  return stubFor(fixtureId).setResponse({
    playerId, intent: "out", actorPlayerId: null, source: "token", now: NOW.getTime(),
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

    expect(await accept(fixtureId, "p-2")).toMatchObject({ kind: "recorded", status: "in" });
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
        playerId: "p-2", intent: "in", actorPlayerId: null, source: "token", now: NOW.getTime(),
      }),
      env.FIXTURE_CAPACITY.getByName(wrongName).setResponse({
        playerId: "p-3", intent: "in", actorPlayerId: null, source: "token", now: NOW.getTime(),
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
        playerId, intent, actorPlayerId: null, source: "web", now: NOW.getTime(),
      });
    }

    const { inCount, cached } = await counts(fixtureId);
    expect(cached).toBe(inCount);
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
        actorPlayerId: null, source: "token", now: NOW.getTime(),
      }),
    ).toMatchObject({ kind: "rejected", reason: "fixture-not-found" });
  });
});

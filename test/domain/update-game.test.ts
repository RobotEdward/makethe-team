import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { auditLog, fixtures, games } from "../../src/db/schema.js";
import { parseGameForm } from "../../src/domain/game-form.js";
import { materialiseGame } from "../../src/domain/materialise.js";
import { updateGame } from "../../src/domain/update-game.js";
import { insertGame, insertPlayer, resetDatabase, testDb } from "../support/factories.js";

const NOW = new Date(Date.UTC(2026, 7, 12, 9, 0));

function values(overrides: Record<string, string> = {}) {
  const body: Record<string, string> = {
    name: "Thursday 7-a-side",
    venueName: "Oxford Sports Park",
    weekday: "TH",
    interval: "1",
    kickoffTime: "19:00",
    durationMinutes: "60",
    minPlayers: "10",
    maxPlayers: "14",
    prefersEvenNumbers: "on",
    ...overrides,
  };
  // A real <input type="checkbox"> submits nothing at all when unchecked — an
  // empty string is not how "unchecked" appears on the wire, and
  // parseGameForm's `typeof body["prefersEvenNumbers"] === "string"` check
  // would otherwise read an explicit "" override as still checked. Passing
  // `prefersEvenNumbers: ""` here means "leave it unchecked", so delete the
  // key entirely to match what a browser would actually send.
  if (overrides.prefersEvenNumbers === "") delete body.prefersEvenNumbers;
  const result = parseGameForm(body);
  if (!result.ok) throw new Error(`invalid fixture values: ${JSON.stringify(result.errors)}`);
  return result.values;
}

async function seed() {
  const db = testDb();
  const gameId = await insertGame(db, { recurrenceStartDate: "2026-08-13" });
  const [game] = await db.select().from(games).where(eq(games.id, gameId));
  await materialiseGame(db, game!, NOW);
  const actorPlayerId = await insertPlayer(db);
  return { db, game: game!, actorPlayerId };
}

describe("updateGame", () => {
  beforeEach(resetDatabase);

  it("rewrites scheduled fixtures with the new kickoff time", async () => {
    const { db, game, actorPlayerId } = await seed();

    await updateGame({ db, game, values: values({ kickoffTime: "20:30" }), actorPlayerId, now: NOW });

    const rows = await db.select().from(fixtures).where(eq(fixtures.gameId, game.id));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      // 20:30 Europe/London in August is 19:30 UTC.
      expect(row.kicksOffAt.getUTCHours()).toBe(19);
      expect(row.kicksOffAt.getUTCMinutes()).toBe(30);
    }
  });

  it("copies the new min, max, parity and duration onto scheduled fixtures", async () => {
    const { db, game, actorPlayerId } = await seed();

    await updateGame({
      db,
      game,
      values: values({ minPlayers: "8", maxPlayers: "12", durationMinutes: "90", prefersEvenNumbers: "" }),
      actorPlayerId,
      now: NOW,
    });

    const rows = await db.select().from(fixtures).where(eq(fixtures.gameId, game.id));
    for (const row of rows) {
      expect(row.minPlayers).toBe(8);
      expect(row.maxPlayers).toBe(12);
      expect(row.durationMinutes).toBe(90);
      expect(row.prefersEvenNumbers).toBe(false);
    }
  });

  it("never touches an open, played or cancelled fixture", async () => {
    const { db, game, actorPlayerId } = await seed();
    const existing = await db.select().from(fixtures).where(eq(fixtures.gameId, game.id));
    const [first, second, third] = existing;

    await db.update(fixtures).set({ lifecycle: "open" }).where(eq(fixtures.id, first!.id));
    await db.update(fixtures).set({ lifecycle: "played" }).where(eq(fixtures.id, second!.id));
    await db.update(fixtures).set({ lifecycle: "cancelled" }).where(eq(fixtures.id, third!.id));

    const result = await updateGame({
      db, game, values: values({ kickoffTime: "20:30", maxPlayers: "20" }), actorPlayerId, now: NOW,
    });

    // The three non-scheduled rows survive untouched — people have already
    // been emailed about them (spec §3.3).
    for (const id of [first!.id, second!.id, third!.id]) {
      const [row] = await db.select().from(fixtures).where(eq(fixtures.id, id));
      expect(row?.maxPlayers).toBe(14);
      expect(row?.kicksOffAt.getTime()).toBe(existing.find((f) => f.id === id)!.kicksOffAt.getTime());
    }
    expect(result.untouched).toBe(3);
  });

  /**
   * A `scheduled` fixture can legitimately sit in the past: `src/sweep/retire.ts`
   * only retires one an hour after kickoff. Nothing regenerates it —
   * `fixtureRowsFor` never looks behind `now` — so a delete unbounded by
   * `kicks_off_at` destroys it permanently, and `scheduledRewritten` (which is
   * bounded by `now`) reports that it never happened.
   */
  it("leaves a past-dated scheduled fixture alone", async () => {
    const { db, game, actorPlayerId } = await seed();
    const past = new Date(NOW.getTime() - 30 * 60_000);
    const id = crypto.randomUUID();
    await db.insert(fixtures).values({
      id,
      gameId: game.id,
      kicksOffAt: past,
      lifecycle: "scheduled",
      minPlayers: 10,
      maxPlayers: 14,
      prefersEvenNumbers: true,
      shortWarningOffsetHours: 12,
      durationMinutes: 60,
    });

    const result = await updateGame({ db, game, values: values({ kickoffTime: "20:30" }), actorPlayerId, now: NOW });

    const [survivor] = await db.select().from(fixtures).where(eq(fixtures.id, id));
    expect(survivor?.kicksOffAt.getTime()).toBe(past.getTime());
    // And the return value is telling the truth about what was rewritten.
    expect(result.scheduledRewritten).toBeGreaterThan(0);
  });

  it("does not violate the (game_id, kicks_off_at) unique index when times shift onto each other", async () => {
    // Shifting every fixture by exactly one week moves each onto the slot the
    // next one occupied. An in-place update would collide; delete-then-insert
    // does not (spec §3.3).
    const { db, game, actorPlayerId } = await seed();

    await expect(
      updateGame({ db, game, values: values({ weekday: "FR" }), actorPlayerId, now: NOW }),
    ).resolves.toBeDefined();

    const rows = await db.select().from(fixtures).where(eq(fixtures.gameId, game.id));
    const times = rows.map((row) => row.kicksOffAt.getTime());
    expect(new Set(times).size).toBe(times.length);
  });

  it("re-derives kickoffs correctly across a DST boundary", async () => {
    const db = testDb();
    const gameId = await insertGame(db, { recurrenceStartDate: "2026-10-20", kickoffTime: "19:00" });
    const [game] = await db.select().from(games).where(eq(games.id, gameId));
    const now = new Date(Date.UTC(2026, 9, 20, 9, 0));
    await materialiseGame(db, game!, now);
    const actorPlayerId = await insertPlayer(db);

    await updateGame({ db, game: game!, values: values({ kickoffTime: "19:00" }), actorPlayerId, now });

    const rows = await db.select().from(fixtures).where(eq(fixtures.gameId, gameId));
    // BST before the last Sunday in October, GMT after — 19:00 local either
    // way, which is 18:00Z then 19:00Z.
    const hours = new Set(rows.map((row) => row.kicksOffAt.getUTCHours()));
    expect(hours.size).toBeGreaterThan(1);
  });

  it("records the change in audit_log", async () => {
    const { db, game, actorPlayerId } = await seed();
    await updateGame({ db, game, values: values({ name: "Friday 7-a-side" }), actorPlayerId, now: NOW });

    const [row] = await db.select().from(auditLog).where(eq(auditLog.action, "game.updated"));
    expect(row?.actorPlayerId).toBe(actorPlayerId);
    expect(row?.beforeJson).toContain("Thursday 7-a-side");
    expect(row?.afterJson).toContain("Friday 7-a-side");
  });

  it("re-anchors the recurrence when the day or interval changes", async () => {
    const { db, game, actorPlayerId } = await seed();
    await updateGame({ db, game, values: values({ weekday: "MO", interval: "2" }), actorPlayerId, now: NOW });

    const [updated] = await db.select().from(games).where(eq(games.id, game.id));
    // A fortnightly pattern counted from a stale anchor lands on the wrong week.
    expect(updated?.recurrenceStartDate).toBe("2026-08-12");
  });

  it("keeps the anchor when the pattern is unchanged", async () => {
    const { db, game, actorPlayerId } = await seed();
    await updateGame({ db, game, values: values({ kickoffTime: "20:00" }), actorPlayerId, now: NOW });

    const [updated] = await db.select().from(games).where(eq(games.id, game.id));
    expect(updated?.recurrenceStartDate).toBe("2026-08-13");
  });

  /**
   * The single most destructive regression this function could have: the
   * delete's `where` dropping its `gameId` half and wiping every other
   * squad's `scheduled` fixtures along with the game actually being edited.
   * Every other test in this file seeds exactly one game, so none of them
   * would notice that — a second game's fixtures are the only thing that
   * can. Confirmed by deliberately breaking the scope (see task-8-report.md,
   * "Fix round 1") and watching this fail before restoring it.
   */
  it("never touches another game's scheduled fixtures", async () => {
    const { db, game, actorPlayerId } = await seed();

    const otherGameId = await insertGame(db, { recurrenceStartDate: "2026-08-13", name: "Sunday 5-a-side" });
    const [otherGame] = await db.select().from(games).where(eq(games.id, otherGameId));
    await materialiseGame(db, otherGame!, NOW);
    const otherFixturesBefore = await db.select().from(fixtures).where(eq(fixtures.gameId, otherGameId));
    expect(otherFixturesBefore.length).toBeGreaterThan(0);

    await updateGame({
      db, game, values: values({ kickoffTime: "20:30", weekday: "FR" }), actorPlayerId, now: NOW,
    });

    const otherFixturesAfter = await db.select().from(fixtures).where(eq(fixtures.gameId, otherGameId));
    expect(otherFixturesAfter.length).toBe(otherFixturesBefore.length);
    expect(new Set(otherFixturesAfter.map((f) => f.id))).toEqual(new Set(otherFixturesBefore.map((f) => f.id)));
    // Not just the same count and ids — the same kickoff instants too, so a
    // delete-and-recreate of the wrong rows (same count, different ids or
    // times) is caught as well as an outright loss.
    expect(new Set(otherFixturesAfter.map((f) => f.kicksOffAt.getTime()))).toEqual(
      new Set(otherFixturesBefore.map((f) => f.kicksOffAt.getTime())),
    );
  });

  /**
   * `fixtureRowsFor` copies five columns onto each fixture; `auditShape` must
   * capture all five or an edit that changes only one of the two easy to
   * forget — `durationMinutes` or `shortWarningOffsetHours` — produces a
   * before/after pair that is byte-identical, silently failing to record the
   * one thing that actually changed.
   */
  it("records a duration-only change in the audit trail", async () => {
    const { db, game, actorPlayerId } = await seed();
    await updateGame({ db, game, values: values({ durationMinutes: "90" }), actorPlayerId, now: NOW });

    const [row] = await db.select().from(auditLog).where(eq(auditLog.action, "game.updated"));
    expect(row?.beforeJson).not.toBe(row?.afterJson);
    expect(row?.beforeJson).toContain('"durationMinutes":60');
    expect(row?.afterJson).toContain('"durationMinutes":90');
  });
});

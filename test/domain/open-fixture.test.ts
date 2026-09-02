import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../src/db/client.js";
import { auditLog, fixtures, memberships, players, responses } from "../../src/db/schema.js";
import { openFixture } from "../../src/domain/open-fixture.js";
import { insertGame, resetDatabase } from "../support/factories.js";

const db = getDb(env.DB);
const NOW = new Date("2026-08-12T09:00:00Z");
const KICKOFF = new Date("2026-08-13T18:00:00Z");

async function seed(squadSize: number, opts: { inactive?: number } = {}): Promise<{ gameId: string; fixtureId: string }> {
  const gameId = await insertGame(db);
  const fixtureId = crypto.randomUUID();
  await db.insert(fixtures).values({
    id: fixtureId, gameId, kicksOffAt: KICKOFF, minPlayers: 10, maxPlayers: 14,
    prefersEvenNumbers: true, shortWarningOffsetHours: 12, durationMinutes: 60,
  });

  const total = squadSize + (opts.inactive ?? 0);
  for (let i = 0; i < total; i++) {
    const playerId = `p-${i}`;
    await db.insert(players).values({ id: playerId, name: `Player ${i}`, email: `p${i}@example.com` });
    await db.insert(memberships).values({
      id: `m-${i}`, gameId, playerId,
      role: i === 0 ? "owner" : "player",
      active: i < squadSize,
    });
  }
  return { gameId, fixtureId };
}

beforeEach(async () => {
  await resetDatabase();
});

describe("openFixture", () => {
  it("writes a pending response for every active member (BR-1)", async () => {
    const { fixtureId } = await seed(12);

    const result = await openFixture(db, fixtureId, NOW);

    expect(result).toMatchObject({ opened: true, pendingCreated: 12 });
    const rows = await db.select().from(responses).where(eq(responses.fixtureId, fixtureId));
    expect(rows).toHaveLength(12);
    expect(rows.every((r) => r.status === "pending")).toBe(true);
    expect(rows.every((r) => r.source === "system")).toBe(true);
    expect(rows.every((r) => r.respondedAt === null)).toBe(true);
  });

  it("sets the lifecycle and opened_at", async () => {
    const { fixtureId } = await seed(3);

    await openFixture(db, fixtureId, NOW);

    const [fixture] = await db.select().from(fixtures).where(eq(fixtures.id, fixtureId));
    expect(fixture?.lifecycle).toBe("open");
    expect(fixture?.openedAt?.toISOString()).toBe(NOW.toISOString());
  });

  it("excludes inactive members (BR-1)", async () => {
    const { fixtureId } = await seed(8, { inactive: 4 });

    const result = await openFixture(db, fixtureId, NOW);

    expect(result.pendingCreated).toBe(8);
  });

  it("chunks past the D1 parameter ceiling (TR-38)", async () => {
    // 25 members is well beyond the ~9-row single-statement limit.
    const { fixtureId } = await seed(25);

    const result = await openFixture(db, fixtureId, NOW);

    expect(result.pendingCreated).toBe(25);
    const rows = await db.select().from(responses).where(eq(responses.fixtureId, fixtureId));
    expect(rows).toHaveLength(25);
  });

  it("is idempotent — opening twice creates nothing extra", async () => {
    const { fixtureId } = await seed(12);

    const first = await openFixture(db, fixtureId, NOW);
    const second = await openFixture(db, fixtureId, new Date(NOW.getTime() + 3_600_000));

    expect(first.opened).toBe(true);
    expect(second).toMatchObject({ opened: false, pendingCreated: 0, reason: "already-open" });
    const rows = await db.select().from(responses).where(eq(responses.fixtureId, fixtureId));
    expect(rows).toHaveLength(12);
  });

  it("does not reopen a cancelled fixture", async () => {
    const { fixtureId } = await seed(12);
    await db.update(fixtures).set({ lifecycle: "cancelled" }).where(eq(fixtures.id, fixtureId));

    const result = await openFixture(db, fixtureId, NOW);

    expect(result).toMatchObject({ opened: false, reason: "terminal" });
    expect(await db.select().from(responses)).toHaveLength(0);
  });

  it("reports a missing fixture rather than throwing", async () => {
    expect(await openFixture(db, "no-such-fixture", NOW)).toMatchObject({ opened: false, reason: "not-found" });
  });

  it("auto-declines a muted member instead of asking them (M28)", async () => {
    const { fixtureId } = await seed(12);
    await db
      .update(memberships)
      .set({ mutedAt: new Date("2026-08-01T09:00:00Z"), mutedUntil: new Date("2026-09-01T09:00:00Z") })
      .where(eq(memberships.playerId, "p-3"));

    const result = await openFixture(db, fixtureId, NOW);

    expect(result).toMatchObject({ opened: true, pendingCreated: 12, autoDeclined: 1 });
    const rows = await db.select().from(responses).where(eq(responses.fixtureId, fixtureId));
    const muted = rows.find((r) => r.playerId === "p-3");
    expect(muted?.status).toBe("out");
    // Stamped, unlike a pending row: the player did answer, in advance.
    expect(muted?.respondedAt?.toISOString()).toBe(NOW.toISOString());
    expect(muted?.source).toBe("system");
    expect(muted?.setByPlayerId).toBe(null);
    expect(rows.filter((r) => r.status === "pending")).toHaveLength(11);
  });

  it("auto-declines a member muted indefinitely", async () => {
    const { fixtureId } = await seed(4);
    await db
      .update(memberships)
      .set({ mutedAt: new Date("2020-01-01T00:00:00Z"), mutedUntil: null })
      .where(eq(memberships.playerId, "p-1"));

    await openFixture(db, fixtureId, NOW);

    const rows = await db.select().from(responses).where(eq(responses.fixtureId, fixtureId));
    expect(rows.find((r) => r.playerId === "p-1")?.status).toBe("out");
  });

  it("asks a member whose mute has run out", async () => {
    const { fixtureId } = await seed(4);
    await db
      .update(memberships)
      .set({ mutedAt: new Date("2026-07-01T09:00:00Z"), mutedUntil: new Date("2026-08-01T09:00:00Z") })
      .where(eq(memberships.playerId, "p-1"));

    const result = await openFixture(db, fixtureId, NOW);

    expect(result.autoDeclined).toBe(0);
    const rows = await db.select().from(responses).where(eq(responses.fixtureId, fixtureId));
    expect(rows.every((r) => r.status === "pending")).toBe(true);
  });

  it("chunks a squad of muted members too (TR-38)", async () => {
    const { fixtureId } = await seed(25);
    await db.update(memberships).set({ mutedAt: NOW, mutedUntil: null });

    const result = await openFixture(db, fixtureId, NOW);

    expect(result).toMatchObject({ pendingCreated: 25, autoDeclined: 25 });
    const rows = await db.select().from(responses).where(eq(responses.fixtureId, fixtureId));
    expect(rows).toHaveLength(25);
    expect(rows.every((r) => r.status === "out")).toBe(true);
  });

  it("records the open with a null actor when nobody asked for it", async () => {
    const { fixtureId } = await seed(10);

    await openFixture(db, fixtureId, NOW);

    const [row] = await db.select().from(auditLog).where(eq(auditLog.entityId, fixtureId));
    expect(row?.action).toBe("fixture.opened");
    // Null, not the sweep's own id or the owner's: nobody acted. An actor here
    // would read as somebody having opened it early, which is the one question
    // this row exists to answer.
    expect(row?.actorPlayerId).toBeNull();
    expect(JSON.parse(row?.afterJson ?? "{}")).toEqual({ pendingCreated: 10, autoDeclined: 0 });
  });

  it("records the actor when an owner opened it early (BR-11)", async () => {
    const { fixtureId } = await seed(10);

    await openFixture(db, fixtureId, NOW, "p-0");

    const [row] = await db.select().from(auditLog).where(eq(auditLog.entityId, fixtureId));
    expect(row?.actorPlayerId).toBe("p-0");
  });

  it("writes no audit row for a call that opened nothing", async () => {
    const { fixtureId } = await seed(10);
    await openFixture(db, fixtureId, NOW);

    await openFixture(db, fixtureId, NOW, "p-0");

    // A second press must not leave a trail saying the owner opened a fixture
    // that was open already.
    expect(await db.select().from(auditLog).where(eq(auditLog.entityId, fixtureId))).toHaveLength(1);
  });

  it("does not retroactively invite someone who joins after opening (BR-2)", async () => {
    const { gameId, fixtureId } = await seed(10);
    await openFixture(db, fixtureId, NOW);

    await db.insert(players).values({ id: "late", name: "Late Joiner", email: "late@example.com" });
    await db.insert(memberships).values({ id: "m-late", gameId, playerId: "late", active: true });

    const again = await openFixture(db, fixtureId, NOW);

    expect(again.pendingCreated).toBe(0);
    expect(await db.select().from(responses).where(eq(responses.fixtureId, fixtureId))).toHaveLength(10);
  });
});

import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../src/db/client.js";
import { responses } from "../../src/db/schema.js";
import {
  insertFixture,
  insertGame,
  insertInviteTier,
  insertMembership,
  insertPlayer,
  insertResponse,
  resetDatabase,
} from "../support/factories.js";

const db = getDb(env.DB);
const NOW = new Date("2026-08-24T09:00:00Z");

async function gatedFixture(opts: { core: number; subs: number; maxPlayers?: number }) {
  const gameId = await insertGame(db, { gatedInvitesEnabled: true });
  const fixtureId = await insertFixture(db, gameId, {
    lifecycle: "open",
    minPlayers: 2,
    maxPlayers: opts.maxPlayers ?? 10,
  });
  const coreTier = await insertInviteTier(db, gameId, { name: "Core", position: 1 });
  const subTier = await insertInviteTier(db, gameId, { name: "Subs", position: 2 });
  for (let i = 0; i < opts.core + opts.subs; i++) {
    const playerId = await insertPlayer(db, { id: `p-${i}`, email: `p${i}@example.com` });
    await insertMembership(db, gameId, playerId, {
      inviteTierId: i < opts.core ? coreTier : subTier,
    });
    await insertResponse(db, fixtureId, playerId, { status: "pending" });
  }
  return { gameId, fixtureId };
}

const claim = (fixtureId: string, force = false) =>
  env.FIXTURE_CAPACITY.getByName(fixtureId).claimInviteReleases({ now: NOW.getTime(), force });

beforeEach(async () => {
  await resetDatabase();
});

describe("claimInviteReleases", () => {
  it("claims the core tier and stamps it", async () => {
    const { fixtureId } = await gatedFixture({ core: 3, subs: 2 });

    const outcome = await claim(fixtureId);

    expect(outcome).toEqual({ kind: "claimed", playerIds: ["p-0", "p-1", "p-2"] });
    const rows = await db.select().from(responses).where(eq(responses.fixtureId, fixtureId));
    expect(rows.filter((row) => row.invitedAt !== null)).toHaveLength(3);
  });

  it("is a no-op on a second call — the same state claims nothing new", async () => {
    const { fixtureId } = await gatedFixture({ core: 3, subs: 2 });
    await claim(fixtureId);

    const outcome = await claim(fixtureId);

    expect(outcome).toEqual({ kind: "claimed", playerIds: [] });
  });

  it("releases the next tier after a decline", async () => {
    const { fixtureId } = await gatedFixture({ core: 3, subs: 2 });
    await claim(fixtureId);
    await db
      .update(responses)
      .set({ status: "out", respondedAt: NOW })
      .where(eq(responses.playerId, "p-0"));

    const outcome = await claim(fixtureId);

    expect(outcome).toEqual({ kind: "claimed", playerIds: ["p-3", "p-4"] });
  });

  it("releases one tier, not two, when two declines are claimed concurrently", async () => {
    const { fixtureId } = await gatedFixture({ core: 4, subs: 2 });
    await claim(fixtureId);
    await db
      .update(responses)
      .set({ status: "out", respondedAt: NOW })
      .where(eq(responses.playerId, "p-0"));

    const [first, second] = await Promise.all([claim(fixtureId), claim(fixtureId)]);

    const claimed = [
      ...(first.kind === "claimed" ? first.playerIds : []),
      ...(second.kind === "claimed" ? second.playerIds : []),
    ];
    // Whichever call wins, each player is claimed exactly once — the stamp is
    // what makes a duplicate invitation impossible, not the ordering.
    expect(claimed.sort()).toEqual(["p-4", "p-5"]);
  });

  it("skips an ungated game (BR-39)", async () => {
    const gameId = await insertGame(db);
    const fixtureId = await insertFixture(db, gameId, { lifecycle: "open" });

    expect(await claim(fixtureId)).toEqual({ kind: "skipped", reason: "not-gated" });
  });

  it("skips a fixture that is not open", async () => {
    const gameId = await insertGame(db, { gatedInvitesEnabled: true });
    const fixtureId = await insertFixture(db, gameId, { lifecycle: "scheduled" });

    expect(await claim(fixtureId)).toEqual({ kind: "skipped", reason: "fixture-not-open" });
  });

  it("reports a missing fixture", async () => {
    expect(await claim(crypto.randomUUID())).toEqual({
      kind: "skipped",
      reason: "fixture-not-found",
    });
  });

  it("releases exactly one tier on force, even when the fixture is full", async () => {
    const { fixtureId } = await gatedFixture({ core: 2, subs: 2, maxPlayers: 2 });
    await claim(fixtureId);
    await db
      .update(responses)
      .set({ status: "in", respondedAt: NOW })
      .where(eq(responses.playerId, "p-0"));
    await db
      .update(responses)
      .set({ status: "in", respondedAt: NOW })
      .where(eq(responses.playerId, "p-1"));

    expect(await claim(fixtureId)).toEqual({ kind: "claimed", playerIds: [] });
    expect(await claim(fixtureId, true)).toEqual({ kind: "claimed", playerIds: ["p-2", "p-3"] });
  });
});

import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../src/db/client.js";
import { loadInviteState, stampInvited } from "../../src/db/invite-queries.js";
import { games, memberships, responses } from "../../src/db/schema.js";
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

beforeEach(async () => {
  await resetDatabase();
});

describe("gated invite schema", () => {
  it("defaults a game to ungated with no fallback (BR-39)", async () => {
    const gameId = await insertGame(db);

    const [row] = await db.select().from(games).where(eq(games.id, gameId));

    expect(row?.gatedInvitesEnabled).toBe(false);
    expect(row?.gatedFallbackHoursBefore).toBeNull();
  });

  it("defaults a membership to the implicit tier", async () => {
    const gameId = await insertGame(db);
    const playerId = await insertPlayer(db);
    await insertMembership(db, gameId, playerId);

    const [row] = await db.select().from(memberships).where(eq(memberships.playerId, playerId));

    expect(row?.inviteTierId).toBeNull();
  });

  it("stores a tier and lets a membership point at it", async () => {
    const gameId = await insertGame(db);
    const tierId = await insertInviteTier(db, gameId, { name: "Core", position: 1 });
    const playerId = await insertPlayer(db);
    await insertMembership(db, gameId, playerId, { inviteTierId: tierId });

    const [row] = await db.select().from(memberships).where(eq(memberships.playerId, playerId));

    expect(row?.inviteTierId).toBe(tierId);
  });

  it("clears invite_tiers between tests", async () => {
    const gameId = await insertGame(db);
    await insertInviteTier(db, gameId, { name: "Core", position: 1 });

    await resetDatabase();

    const rows = await db.select().from(responses);
    expect(rows).toHaveLength(0);
  });
});

describe("loadInviteState", () => {
  it("returns null for a fixture that does not exist", async () => {
    expect(await loadInviteState(db, crypto.randomUUID(), NOW)).toBeNull();
  });

  it("reports an ungated game as ungated (BR-39)", async () => {
    const gameId = await insertGame(db);
    const fixtureId = await insertFixture(db, gameId);

    const state = await loadInviteState(db, fixtureId, NOW);

    expect(state?.gated).toBe(false);
  });

  it("orders tiers by position then created_at, with the implicit tier last", async () => {
    const gameId = await insertGame(db, { gatedInvitesEnabled: true });
    const fixtureId = await insertFixture(db, gameId);
    const second = await insertInviteTier(db, gameId, { name: "Regulars", position: 2 });
    const first = await insertInviteTier(db, gameId, { name: "Core", position: 1 });
    const core = await insertPlayer(db, { id: "p-core" });
    const reg = await insertPlayer(db, { id: "p-reg" });
    const rest = await insertPlayer(db, { id: "p-rest" });
    await insertMembership(db, gameId, core, { inviteTierId: first });
    await insertMembership(db, gameId, reg, { inviteTierId: second });
    await insertMembership(db, gameId, rest);
    for (const playerId of [core, reg, rest]) {
      await insertResponse(db, fixtureId, playerId, { status: "pending" });
    }

    const state = await loadInviteState(db, fixtureId, NOW);

    expect(state?.tiers.map((tier) => tier.tierId)).toEqual([first, second, null]);
    expect(state?.tiers[0]?.members.map((member) => member.playerId)).toEqual(["p-core"]);
    expect(state?.tiers[2]?.members.map((member) => member.playerId)).toEqual(["p-rest"]);
  });

  it("gives a member with no response row a null status", async () => {
    const gameId = await insertGame(db, { gatedInvitesEnabled: true });
    const fixtureId = await insertFixture(db, gameId);
    const playerId = await insertPlayer(db);
    await insertMembership(db, gameId, playerId);

    const state = await loadInviteState(db, fixtureId, NOW);

    expect(state?.tiers[0]?.members[0]).toMatchObject({ playerId, status: null, invitedAt: null });
  });

  it("excludes an inactive member entirely", async () => {
    const gameId = await insertGame(db, { gatedInvitesEnabled: true });
    const fixtureId = await insertFixture(db, gameId);
    const playerId = await insertPlayer(db);
    await insertMembership(db, gameId, playerId, { active: false });

    const state = await loadInviteState(db, fixtureId, NOW);

    expect(state?.tiers[0]?.members).toHaveLength(0);
  });

  it("counts a guest who is in, and never puts them in a tier", async () => {
    const gameId = await insertGame(db, { gatedInvitesEnabled: true });
    const fixtureId = await insertFixture(db, gameId);
    const guestId = await insertPlayer(db, { isGuest: true, email: null });
    await insertResponse(db, fixtureId, guestId, { status: "in", source: "owner" });

    const state = await loadInviteState(db, fixtureId, NOW);

    expect(state?.guestInCount).toBe(1);
    expect(state?.tiers.flatMap((tier) => tier.members)).toHaveLength(0);
  });

  it("reports the fallback as due only once the offset has passed (BR-44)", async () => {
    const gameId = await insertGame(db, {
      gatedInvitesEnabled: true,
      gatedFallbackHoursBefore: 12,
    });
    const fixtureId = await insertFixture(db, gameId, {
      kicksOffAt: new Date("2026-08-25T18:00:00Z"),
    });

    const before = await loadInviteState(db, fixtureId, new Date("2026-08-25T05:59:00Z"));
    const after = await loadInviteState(db, fixtureId, new Date("2026-08-25T06:01:00Z"));

    expect(before?.fallbackDue).toBe(false);
    expect(after?.fallbackDue).toBe(true);
  });

  it("never reports the fallback as due when it is switched off", async () => {
    const gameId = await insertGame(db, {
      gatedInvitesEnabled: true,
      gatedFallbackHoursBefore: null,
    });
    const fixtureId = await insertFixture(db, gameId, {
      kicksOffAt: new Date("2026-08-25T18:00:00Z"),
    });

    const state = await loadInviteState(db, fixtureId, new Date("2026-08-25T17:59:00Z"));

    expect(state?.fallbackDue).toBe(false);
  });
});

describe("stampInvited", () => {
  it("stamps only rows that were not already invited, and reports which", async () => {
    const gameId = await insertGame(db, { gatedInvitesEnabled: true });
    const fixtureId = await insertFixture(db, gameId);
    const fresh = await insertPlayer(db, { id: "p-fresh" });
    const already = await insertPlayer(db, { id: "p-already" });
    await insertResponse(db, fixtureId, fresh, { status: "pending" });
    await insertResponse(db, fixtureId, already, {
      status: "pending",
      invitedAt: new Date("2026-08-20T09:00:00Z"),
    });

    const stamped = await stampInvited(db, fixtureId, [fresh, already], NOW);

    expect(stamped).toEqual(["p-fresh"]);
    const [row] = await db.select().from(responses).where(eq(responses.playerId, already));
    expect(row?.invitedAt?.toISOString()).toBe("2026-08-20T09:00:00.000Z");
  });

  it("stamps a squad larger than one chunk (TR-38)", async () => {
    const gameId = await insertGame(db, { gatedInvitesEnabled: true });
    const fixtureId = await insertFixture(db, gameId);
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) {
      const playerId = await insertPlayer(db, { id: `p-${i}` });
      await insertResponse(db, fixtureId, playerId, { status: "pending" });
      ids.push(playerId);
    }

    const stamped = await stampInvited(db, fixtureId, ids, NOW);

    expect(stamped).toHaveLength(20);
  });

  it("is a no-op for an empty list", async () => {
    const gameId = await insertGame(db);
    const fixtureId = await insertFixture(db, gameId);

    expect(await stampInvited(db, fixtureId, [], NOW)).toEqual([]);
  });
});

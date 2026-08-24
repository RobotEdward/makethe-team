import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../src/db/client.js";
import { games, memberships, responses } from "../../src/db/schema.js";
import {
  insertGame,
  insertInviteTier,
  insertMembership,
  insertPlayer,
  resetDatabase,
} from "../support/factories.js";

const db = getDb(env.DB);

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

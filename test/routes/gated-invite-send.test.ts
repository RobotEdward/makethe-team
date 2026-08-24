import { SELF, env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../src/db/client.js";
import { notificationLog, responses } from "../../src/db/schema.js";
import { openFixture } from "../../src/domain/open-fixture.js";
import { signResponseToken } from "../../src/domain/token.js";
import { kickoffIn, NOW } from "../support/clock.js";
import {
  insertFixture,
  insertGame,
  insertInviteTier,
  insertMembership,
  insertPlayer,
  resetDatabase,
} from "../support/factories.js";

const db = getDb(env.DB);
const SECRET = env.RESPONSE_TOKEN_SECRET;
// Relative to the real clock: the route verifies its token against the wall
// clock, so a pinned kickoff eventually reads as expired. See clock.ts.
const KICKOFF = kickoffIn(9);

/** A gated fixture with the core already invited and a sub tier still held. */
async function seedGatedOpenFixture(opts: { gated?: boolean } = {}) {
  const gameId = await insertGame(db, {
    gatedInvitesEnabled: opts.gated ?? true,
    maxPlayers: 14,
  });
  const fixtureId = await insertFixture(db, gameId, {
    kicksOffAt: KICKOFF,
    minPlayers: 1,
    maxPlayers: 14,
  });
  const coreTier = await insertInviteTier(db, gameId, { name: "Core", position: 1 });
  const subTier = await insertInviteTier(db, gameId, { name: "Subs", position: 2 });

  const coreId = await insertPlayer(db, { id: "core-1", email: "core1@example.com" });
  const subId = await insertPlayer(db, { id: "sub-1", email: "sub1@example.com" });
  await insertMembership(db, gameId, coreId, { inviteTierId: coreTier });
  await insertMembership(db, gameId, subId, { inviteTierId: subTier });

  await openFixture(db, fixtureId, NOW);
  // The core has been asked; the sub has not. This is the state a fixture is
  // in between the reminder instant and the first decline.
  await db
    .update(responses)
    .set({ invitedAt: NOW })
    .where(eq(responses.playerId, coreId));

  return { gameId, fixtureId, coreId, subId };
}

function tokenFor(fixtureId: string, playerId: string) {
  return signResponseToken(
    { playerId, fixtureId, expiresAt: Date.now() + 3_600_000 },
    SECRET,
  );
}

/**
 * The invitation is handed to `ctx.waitUntil`, so it is still in flight when
 * the response arrives. Polls the durable side effect — the `notification_log`
 * row reaching a terminal status — rather than a clock, for the reason
 * `test/routes/respond-post.test.ts` documents at its own helper.
 */
async function waitForN1(playerId: string, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  const read = async () =>
    (await db.select().from(notificationLog).where(eq(notificationLog.playerId, playerId))).filter(
      (row) => row.notificationType === "n1" && row.channel === "email",
    );

  let rows = await read();
  while ((rows.length === 0 || rows.some((row) => row.status === "queued")) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    rows = await read();
  }
  return rows;
}

beforeEach(async () => {
  await resetDatabase();
});

describe("a decline releases the next tier in the same request", () => {
  it("mails the released sub without waiting for a sweep", async () => {
    const { fixtureId, coreId, subId } = await seedGatedOpenFixture();
    const token = await tokenFor(fixtureId, coreId);

    const response = await SELF.fetch(`https://makethe.team/r/${token}`, {
      method: "POST",
      body: new URLSearchParams({ intent: "out" }),
    });

    expect(response.status).toBe(200);
    expect(await waitForN1(subId)).toHaveLength(1);
    const [row] = await db.select().from(responses).where(eq(responses.playerId, subId));
    expect(row?.invitedAt).not.toBeNull();
  });

  it("releases nobody when the answer is `in`", async () => {
    const { fixtureId, coreId, subId } = await seedGatedOpenFixture();
    const token = await tokenFor(fixtureId, coreId);

    await SELF.fetch(`https://makethe.team/r/${token}`, {
      method: "POST",
      body: new URLSearchParams({ intent: "in" }),
    });

    // Nothing to wait for; give any background task a chance to be wrong.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await waitForN1(subId, 0)).toHaveLength(0);
    const [row] = await db.select().from(responses).where(eq(responses.playerId, subId));
    expect(row?.invitedAt).toBeNull();
  });

  it("leaves an ungated game entirely alone (BR-39)", async () => {
    const { fixtureId, coreId, subId } = await seedGatedOpenFixture({ gated: false });
    const token = await tokenFor(fixtureId, coreId);

    await SELF.fetch(`https://makethe.team/r/${token}`, {
      method: "POST",
      body: new URLSearchParams({ intent: "out" }),
    });

    await new Promise((resolve) => setTimeout(resolve, 150));
    const [row] = await db.select().from(responses).where(eq(responses.playerId, subId));
    expect(row?.invitedAt).toBeNull();
  });
});

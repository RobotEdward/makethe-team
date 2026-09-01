import { env } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../src/db/client.js";
import { fixtures, notificationLog, responses } from "../../src/db/schema.js";
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

    expect(outcome).toEqual({ kind: "claimed", playerIds: ["p-0", "p-1", "p-2"], promoted: [] });
    const rows = await db.select().from(responses).where(eq(responses.fixtureId, fixtureId));
    expect(rows.filter((row) => row.invitedAt !== null)).toHaveLength(3);
  });

  it("is a no-op on a second call — the same state claims nothing new", async () => {
    const { fixtureId } = await gatedFixture({ core: 3, subs: 2 });
    await claim(fixtureId);

    const outcome = await claim(fixtureId);

    expect(outcome).toEqual({ kind: "claimed", playerIds: [], promoted: [] });
  });

  it("releases the next tier after a decline", async () => {
    const { fixtureId } = await gatedFixture({ core: 3, subs: 2 });
    await claim(fixtureId);
    await db
      .update(responses)
      .set({ status: "out", respondedAt: NOW })
      .where(eq(responses.playerId, "p-0"));

    const outcome = await claim(fixtureId);

    expect(outcome).toEqual({ kind: "claimed", playerIds: ["p-3", "p-4"], promoted: [] });
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

    expect(await claim(fixtureId)).toEqual({ kind: "claimed", playerIds: [], promoted: [] });
    expect(await claim(fixtureId, true)).toEqual({ kind: "claimed", playerIds: ["p-2", "p-3"], promoted: [] });
  });
});

describe("gating switched on after the invitations already went out", () => {
  /** The n1 row the ungated sweep would have written for every member. */
  async function alreadyMailed(fixtureId: string, playerIds: readonly string[]) {
    for (const playerId of playerIds) {
      await db.insert(notificationLog).values({
        id: crypto.randomUUID(),
        dedupeKey: `n1:${fixtureId}:${playerId}`,
        notificationType: "n1",
        fixtureId,
        playerId,
        channel: "email",
        status: "sent",
      });
    }
  }

  it("leaves the fixture alone — everyone has already been asked", async () => {
    const { fixtureId } = await gatedFixture({ core: 2, subs: 2 });
    await alreadyMailed(fixtureId, ["p-0", "p-1", "p-2", "p-3"]);

    const outcome = await claim(fixtureId);

    expect(outcome).toEqual({ kind: "skipped", reason: "already-invited" });
    const rows = await db.select().from(responses).where(eq(responses.fixtureId, fixtureId));
    // Nothing stamped: `invited_at` must not claim a tier was released when
    // the whole squad was mailed before gating was ever switched on.
    expect(rows.every((row) => row.invitedAt === null)).toBe(true);
  });

  it("still releases normally once gating has taken effect on the fixture", async () => {
    // The pair to the test above, and what stops it breaking the feature: a
    // properly gated fixture also holds n1 rows the moment its core is
    // mailed, so the skip must key on "mailed AND never stamped", not on
    // "mailed".
    const { fixtureId } = await gatedFixture({ core: 2, subs: 2 });
    await claim(fixtureId);
    await alreadyMailed(fixtureId, ["p-0", "p-1"]);
    await db
      .update(responses)
      .set({ status: "out", respondedAt: NOW })
      .where(eq(responses.playerId, "p-0"));

    const outcome = await claim(fixtureId);

    expect(outcome).toEqual({ kind: "claimed", playerIds: ["p-2", "p-3"], promoted: [] });
  });
});

/**
 * BR-40a's second half. Holding an uninvited player on the waitlist is only
 * half a rule: something has to let them in when their tier finally opens, or
 * the gate is just a way of losing volunteers.
 */
describe("releasing a tier promotes the players it was holding", () => {
  /** What `setResponse` does for a player answering for themselves. */
  const say = (fixtureId: string, playerId: string, intent: "in" | "out") =>
    env.FIXTURE_CAPACITY.getByName(fixtureId).setResponse({
      playerId,
      intent,
      actorPlayerId: null,
      source: "token",
      now: NOW.getTime(),
      whenFull: "waitlist",
    });

  const statusOf = async (fixtureId: string, playerId: string) => {
    const [row] = await db
      .select()
      .from(responses)
      .where(and(eq(responses.fixtureId, fixtureId), eq(responses.playerId, playerId)));
    return row;
  };

  it("puts a gate-waitlisted volunteer straight in, and does not also invite them", async () => {
    const { fixtureId } = await gatedFixture({ core: 2, subs: 2, maxPlayers: 4 });
    await claim(fixtureId);

    // A sub volunteers before being asked, and is held.
    expect(await say(fixtureId, "p-2", "in")).toMatchObject({ kind: "waitlisted" });

    // A core member drops out, which owes the subs tier.
    await say(fixtureId, "p-0", "out");
    const outcome = await claim(fixtureId);

    expect(outcome).toMatchObject({
      kind: "claimed",
      // p-2 is promoted, so they are owed the N-2 and must NOT appear in the
      // N-1 list as well — the two lists are disjoint by contract.
      playerIds: ["p-3"],
      promoted: [{ playerId: "p-2", previousWaitlistPosition: 1 }],
    });
    expect((await statusOf(fixtureId, "p-2"))?.status).toBe("in");
    // Stamped all the same: `invited_at` is the durable record of the tier
    // having been released (BR-41), independently of what it did to them.
    expect((await statusOf(fixtureId, "p-2"))?.invitedAt).not.toBeNull();
  });

  it("promotes in arrival order and only as far as there are slots", async () => {
    // Two of two slots taken, so the single decline below opens exactly one —
    // which is what makes this test able to tell "the first volunteer" from
    // "every volunteer".
    const { fixtureId } = await gatedFixture({ core: 2, subs: 3, maxPlayers: 2 });
    await claim(fixtureId);
    await say(fixtureId, "p-0", "in");
    await say(fixtureId, "p-1", "in");

    // Three subs volunteer, in this order.
    await say(fixtureId, "p-4", "in");
    await say(fixtureId, "p-2", "in");
    await say(fixtureId, "p-3", "in");

    await say(fixtureId, "p-0", "out");
    const outcome = await claim(fixtureId);

    // p-4 tapped first, so p-4 takes the one slot — arrival order, never row
    // order and never tier-member order, both of which would say p-2 here.
    // The other two stay waiting, invited but with nowhere to go.
    expect(outcome).toMatchObject({ promoted: [{ playerId: "p-4" }] });
    expect((await statusOf(fixtureId, "p-4"))?.status).toBe("in");
    expect((await statusOf(fixtureId, "p-2"))?.status).toBe("waitlisted");
    expect((await statusOf(fixtureId, "p-3"))?.status).toBe("waitlisted");
  });

  it("repairs a player left invited but waitlisted by an earlier half-failure", async () => {
    // The claim writes the stamp and the promotion as two statements, so a
    // crash between them is possible. A pass that only promoted players it
    // had *just* stamped would never look at this player again; this one
    // reconciles the state it finds.
    const { fixtureId } = await gatedFixture({ core: 1, subs: 1, maxPlayers: 4 });
    await claim(fixtureId);
    await say(fixtureId, "p-1", "in");
    await db
      .update(responses)
      .set({ invitedAt: NOW })
      .where(eq(responses.playerId, "p-1"));

    // Nothing new to stamp — and the promotion still happens.
    expect(await claim(fixtureId)).toMatchObject({
      playerIds: [],
      promoted: [{ playerId: "p-1" }],
    });
    expect((await statusOf(fixtureId, "p-1"))?.status).toBe("in");
  });

  it("leaves the counts on the fixture agreeing with the rows", async () => {
    const { fixtureId } = await gatedFixture({ core: 1, subs: 2, maxPlayers: 4 });
    await claim(fixtureId);
    await say(fixtureId, "p-1", "in");
    await say(fixtureId, "p-2", "in");
    await say(fixtureId, "p-0", "out");
    await claim(fixtureId);

    const rows = await db.select().from(responses).where(eq(responses.fixtureId, fixtureId));
    const [fixture] = await db.select().from(fixtures).where(eq(fixtures.id, fixtureId));
    expect(fixture?.inCount).toBe(rows.filter((row) => row.status === "in").length);
    expect(fixture?.waitlistCount).toBe(rows.filter((row) => row.status === "waitlisted").length);
  });
});

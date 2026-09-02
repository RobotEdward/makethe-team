import { SELF, env } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../src/db/client.js";
import { auditLog, notificationLog, players, responses } from "../../src/db/schema.js";
import { ALLOWED, ORIGIN, signIn } from "../support/sign-in.js";
import {
  insertFixture,
  insertGame,
  insertInviteTier,
  insertMembership,
  insertPlayer,
  insertResponse,
  resetDatabase,
} from "../support/factories.js";
import { kickoffIn } from "../support/clock.js";

const db = getDb(env.DB);

function appPost(path: string, cookie: string, origin = ORIGIN) {
  return SELF.fetch(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin, cookie },
    body: new URLSearchParams({}),
    redirect: "manual",
  });
}

async function settle(read: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!(await read()) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function drainSends(): Promise<void> {
  await settle(async () => {
    const log = await db.select().from(notificationLog);
    return !log.some((entry) => entry.status === "queued");
  });
}

/**
 * An open, gated fixture whose first tier has been released and whose second
 * holds two subs — the state an owner is in when they want one of them and
 * not the other.
 */
async function gatedFixtureWithHeldSubs(opts: { gated?: boolean } = {}) {
  const gated = opts.gated ?? true;
  const { cookie } = await signIn();
  const [viewer] = await db.select().from(players).where(eq(players.email, ALLOWED));
  const ownerId = viewer!.id;

  const gameId = await insertGame(db, { gatedInvitesEnabled: gated, minPlayers: 2, maxPlayers: 4 });
  const core = gated ? await insertInviteTier(db, gameId, { name: "Core", position: 1 }) : null;
  const subs = gated ? await insertInviteTier(db, gameId, { name: "Subs", position: 2 }) : null;

  await insertMembership(db, gameId, ownerId, { role: "owner", inviteTierId: core });
  const wantedId = await insertPlayer(db, { name: "Wanted Sub", email: "wanted@example.com" });
  await insertMembership(db, gameId, wantedId, { role: "player", inviteTierId: subs });
  const otherId = await insertPlayer(db, { name: "Other Sub", email: "other@example.com" });
  await insertMembership(db, gameId, otherId, { role: "player", inviteTierId: subs });

  const fixtureId = await insertFixture(db, gameId, {
    kicksOffAt: kickoffIn(48),
    lifecycle: "open",
    minPlayers: 2,
    maxPlayers: 4,
  });
  // The core is released; the subs' tier is not.
  await insertResponse(db, fixtureId, ownerId, { status: "in", invitedAt: kickoffIn(-24) });
  await insertResponse(db, fixtureId, wantedId, { status: "pending" });
  await insertResponse(db, fixtureId, otherId, { status: "pending" });

  return { cookie, ownerId, gameId, fixtureId, wantedId, otherId };
}

beforeEach(async () => {
  await resetDatabase();
});

describe("inviting one player out of turn (M46)", () => {
  it("stamps exactly that player and leaves the rest of their tier held", async () => {
    const { cookie, gameId, fixtureId, wantedId, otherId } = await gatedFixtureWithHeldSubs();

    const response = await appPost(`/g/${gameId}/f/${fixtureId}/invite/player/${wantedId}`, cookie);
    expect(response.status).toBe(303);

    const [wanted] = await db
      .select()
      .from(responses)
      .where(and(eq(responses.fixtureId, fixtureId), eq(responses.playerId, wantedId)));
    expect(wanted?.invitedAt).not.toBeNull();
    expect(wanted?.invitedIndividually).toBe(true);

    const [other] = await db
      .select()
      .from(responses)
      .where(and(eq(responses.fixtureId, fixtureId), eq(responses.playerId, otherId)));
    expect(other?.invitedAt).toBeNull();

    await drainSends();
  });

  it("does not let that stamp release the tier on the next reconcile", async () => {
    const { cookie, gameId, fixtureId, wantedId, otherId } = await gatedFixtureWithHeldSubs();

    await appPost(`/g/${gameId}/f/${fixtureId}/invite/player/${wantedId}`, cookie);
    await drainSends();

    // The owner's own "invite the next group" reads the same derivation the
    // sweep does. If the individual stamp counted, the next tier up would
    // already read as released and this would invite nobody.
    await appPost(`/g/${gameId}/f/${fixtureId}/invite/next`, cookie);
    await settle(async () => {
      const [row] = await db
        .select()
        .from(responses)
        .where(and(eq(responses.fixtureId, fixtureId), eq(responses.playerId, otherId)));
      return row?.invitedAt !== null;
    });

    const [other] = await db
      .select()
      .from(responses)
      .where(and(eq(responses.fixtureId, fixtureId), eq(responses.playerId, otherId)));
    expect(other?.invitedAt).not.toBeNull();
    expect(other?.invitedIndividually).toBe(false);

    await drainSends();
  });

  it("emails them the invitation, once", async () => {
    const { cookie, gameId, fixtureId, wantedId } = await gatedFixtureWithHeldSubs();

    await appPost(`/g/${gameId}/f/${fixtureId}/invite/player/${wantedId}`, cookie);
    await settle(async () => (await db.select().from(notificationLog)).length > 0);
    await drainSends();

    const log = await db
      .select()
      .from(notificationLog)
      .where(eq(notificationLog.playerId, wantedId));
    expect(log).toHaveLength(1);
    // The sweep's own key, so its later reminder skips this player rather
    // than mailing them a second time (BR-18).
    expect(log[0]?.notificationType).toBe("n1");
  });

  it("records who invited them", async () => {
    const { cookie, ownerId, gameId, fixtureId, wantedId } = await gatedFixtureWithHeldSubs();

    await appPost(`/g/${gameId}/f/${fixtureId}/invite/player/${wantedId}`, cookie);
    await drainSends();

    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, fixtureId), eq(auditLog.action, "fixture.invited_individually")));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actorPlayerId).toBe(ownerId);
    expect(JSON.parse(rows[0]?.afterJson ?? "{}")).toEqual({ playerId: wantedId });
  });

  it("writes nothing the second time it is pressed", async () => {
    const { cookie, gameId, fixtureId, wantedId } = await gatedFixtureWithHeldSubs();

    await appPost(`/g/${gameId}/f/${fixtureId}/invite/player/${wantedId}`, cookie);
    await drainSends();
    await appPost(`/g/${gameId}/f/${fixtureId}/invite/player/${wantedId}`, cookie);
    await drainSends();

    expect(
      await db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.entityId, fixtureId), eq(auditLog.action, "fixture.invited_individually"))),
    ).toHaveLength(1);
    expect(await db.select().from(notificationLog).where(eq(notificationLog.playerId, wantedId))).toHaveLength(1);
  });

  it("tells a gate-held player who already said yes that they are in, not asks again", async () => {
    const { cookie, gameId, fixtureId, wantedId } = await gatedFixtureWithHeldSubs();
    // BR-40a: they volunteered from an unreleased tier and were queued.
    await db
      .update(responses)
      .set({ status: "waitlisted", waitlistPosition: 1, respondedAt: kickoffIn(-12), source: "web" })
      .where(and(eq(responses.fixtureId, fixtureId), eq(responses.playerId, wantedId)));

    await appPost(`/g/${gameId}/f/${fixtureId}/invite/player/${wantedId}`, cookie);
    // Waiting on the promotion alone is not enough: the send is a later step of
    // the same background task, and `drainSends` returns at once while the log
    // is still empty.
    await settle(async () => {
      const rows = await db.select().from(notificationLog).where(eq(notificationLog.playerId, wantedId));
      return rows.length > 0;
    });
    await drainSends();

    const [after] = await db
      .select()
      .from(responses)
      .where(and(eq(responses.fixtureId, fixtureId), eq(responses.playerId, wantedId)));
    expect(after?.status).toBe("in");
    const log = await db.select().from(notificationLog).where(eq(notificationLog.playerId, wantedId));
    expect(log).toHaveLength(1);
    // N-2 "you're in", never N-1 "can you play?" — they answered that days ago.
    expect(log[0]?.notificationType).toBe("n2");
  });

  it("does nothing for an ungated game, where everybody is already invited", async () => {
    const { cookie, gameId, fixtureId, wantedId } = await gatedFixtureWithHeldSubs({ gated: false });

    const response = await appPost(`/g/${gameId}/f/${fixtureId}/invite/player/${wantedId}`, cookie);
    expect(response.status).toBe(303);

    await new Promise((resolve) => setTimeout(resolve, 200));
    const [row] = await db
      .select()
      .from(responses)
      .where(and(eq(responses.fixtureId, fixtureId), eq(responses.playerId, wantedId)));
    // A stamp here would make `inviteGateApplies` read this fixture as gated
    // and strand the rest of the squad behind an order that never releases.
    expect(row?.invitedAt).toBeNull();
    expect(await db.select().from(notificationLog)).toHaveLength(0);
  });

  it("refuses a non-owner, and a cross-origin post", async () => {
    const { cookie, gameId, fixtureId, wantedId } = await gatedFixtureWithHeldSubs();

    expect((await appPost(`/g/${gameId}/f/${fixtureId}/invite/player/${wantedId}`, "")).status).not.toBe(303);
    expect(
      (await appPost(`/g/${gameId}/f/${fixtureId}/invite/player/${wantedId}`, cookie, "https://elsewhere.example"))
        .status,
    ).toBe(403);

    const [row] = await db
      .select()
      .from(responses)
      .where(and(eq(responses.fixtureId, fixtureId), eq(responses.playerId, wantedId)));
    expect(row?.invitedAt).toBeNull();
  });

  it("offers the button on an unasked row only", async () => {
    const { cookie, gameId, fixtureId } = await gatedFixtureWithHeldSubs();

    const html = await (
      await SELF.fetch(`${ORIGIN}/g/${gameId}/f/${fixtureId}`, { headers: { cookie } })
    ).text();

    // Two subs unasked; the owner's own row carries a stamp already.
    expect(html.match(/Invite now/g)).toHaveLength(2);
  });

  it("offers it on no row at all for an ungated game (BR-39)", async () => {
    const { cookie, gameId, fixtureId } = await gatedFixtureWithHeldSubs({ gated: false });

    const html = await (
      await SELF.fetch(`${ORIGIN}/g/${gameId}/f/${fixtureId}`, { headers: { cookie } })
    ).text();

    expect(html).not.toContain("Invite now");
  });
});

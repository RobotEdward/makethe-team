import { SELF, env } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../src/db/client.js";
import { auditLog, fixtures, notificationLog, players, responses } from "../../src/db/schema.js";
import { ALLOWED, ORIGIN, signIn } from "../support/sign-in.js";
import {
  insertFixture,
  insertGame,
  insertInviteTier,
  insertMembership,
  insertPlayer,
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

/**
 * A `scheduled` fixture a week out, owned by the signed-in viewer, with one
 * other member on each of two tiers when gated.
 */
async function scheduledFixture(opts: { gated?: boolean } = {}) {
  const gated = opts.gated ?? true;
  const { cookie } = await signIn();
  const [viewer] = await db.select().from(players).where(eq(players.email, ALLOWED));
  const ownerId = viewer!.id;

  const gameId = await insertGame(db, { gatedInvitesEnabled: gated });
  const core = gated ? await insertInviteTier(db, gameId, { name: "Core", position: 1 }) : null;
  const subs = gated ? await insertInviteTier(db, gameId, { name: "Subs", position: 2 }) : null;

  await insertMembership(db, gameId, ownerId, { role: "owner", inviteTierId: core });
  const regularId = await insertPlayer(db, { name: "Reg Ular", email: "reg@example.com" });
  await insertMembership(db, gameId, regularId, { role: "player", inviteTierId: core });
  const subId = await insertPlayer(db, { name: "Sub Stitute", email: "sub@example.com" });
  await insertMembership(db, gameId, subId, { role: "player", inviteTierId: subs });

  const fixtureId = await insertFixture(db, gameId, { kicksOffAt: kickoffIn(24 * 7) });
  return { cookie, ownerId, gameId, fixtureId, regularId, subId };
}

/** Polls until `read` returns true, or the 3s deadline passes. */
async function settle(read: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!(await read()) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Drains any queued send so it cannot land after the next test's reset. */
async function drainSends(): Promise<void> {
  await settle(async () => {
    const log = await db.select().from(notificationLog);
    return !log.some((entry) => entry.status === "queued");
  });
}

beforeEach(async () => {
  await resetDatabase();
});

describe("the owner's open-now button (BR-11)", () => {
  it("opens a scheduled fixture and writes everyone a pending row", async () => {
    const { cookie, gameId, fixtureId } = await scheduledFixture();

    const response = await appPost(`/g/${gameId}/f/${fixtureId}/open`, cookie);
    expect(response.status).toBe(303);

    const [fixture] = await db.select().from(fixtures).where(eq(fixtures.id, fixtureId));
    expect(fixture?.lifecycle).toBe("open");
    expect(fixture?.openedAt).not.toBeNull();
    expect(await db.select().from(responses).where(eq(responses.fixtureId, fixtureId))).toHaveLength(3);

    await drainSends();
  });

  it("records who opened it early, so the trail separates it from the sweep", async () => {
    const { cookie, ownerId, gameId, fixtureId } = await scheduledFixture();

    await appPost(`/g/${gameId}/f/${fixtureId}/open`, cookie);

    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, fixtureId), eq(auditLog.action, "fixture.opened")));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actorPlayerId).toBe(ownerId);

    await drainSends();
  });

  it("releases the first tier at once, so a gated game's regulars hear now", async () => {
    const { cookie, gameId, fixtureId, regularId, subId } = await scheduledFixture();

    await appPost(`/g/${gameId}/f/${fixtureId}/open`, cookie);

    await settle(async () => {
      const [row] = await db
        .select()
        .from(responses)
        .where(and(eq(responses.fixtureId, fixtureId), eq(responses.playerId, regularId)));
      return row?.invitedAt !== null && row?.invitedAt !== undefined;
    });

    const [core] = await db
      .select()
      .from(responses)
      .where(and(eq(responses.fixtureId, fixtureId), eq(responses.playerId, regularId)));
    expect(core?.invitedAt).not.toBeNull();

    // The second tier stays held: opening early is not a release of the whole
    // order, and a sub asked a week out is the failure BR-38 exists to prevent.
    const [sub] = await db
      .select()
      .from(responses)
      .where(and(eq(responses.fixtureId, fixtureId), eq(responses.playerId, subId)));
    expect(sub?.invitedAt).toBeNull();

    await drainSends();
  });

  it("sends nothing for an ungated game — its one N-1 still goes day-before (BR-11)", async () => {
    const { cookie, gameId, fixtureId } = await scheduledFixture({ gated: false });

    await appPost(`/g/${gameId}/f/${fixtureId}/open`, cookie);

    // Given a moment to do the wrong thing before we assert it did not.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await db.select().from(notificationLog)).toHaveLength(0);
  });

  it("is a no-op on a fixture that is already open", async () => {
    const { cookie, gameId, fixtureId } = await scheduledFixture();

    await appPost(`/g/${gameId}/f/${fixtureId}/open`, cookie);
    await drainSends();
    const response = await appPost(`/g/${gameId}/f/${fixtureId}/open`, cookie);

    expect(response.status).toBe(303);
    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, fixtureId), eq(auditLog.action, "fixture.opened")));
    expect(rows).toHaveLength(1);
  });

  it("refuses a signed-out visitor with a 404, and the fixture stays scheduled (TR-18)", async () => {
    const { gameId, fixtureId } = await scheduledFixture();

    const response = await appPost(`/g/${gameId}/f/${fixtureId}/open`, "");

    expect(response.status).not.toBe(303);
    const [fixture] = await db.select().from(fixtures).where(eq(fixtures.id, fixtureId));
    expect(fixture?.lifecycle).toBe("scheduled");
  });

  it("refuses a member who is not the owner", async () => {
    const { cookie } = await signIn();
    const [viewer] = await db.select().from(players).where(eq(players.email, ALLOWED));
    const ownerId = await insertPlayer(db, { name: "The Owner" });
    const gameId = await insertGame(db, {});
    await insertMembership(db, gameId, ownerId, { role: "owner" });
    await insertMembership(db, gameId, viewer!.id, { role: "player" });
    const fixtureId = await insertFixture(db, gameId, { kicksOffAt: kickoffIn(24 * 7) });

    const response = await appPost(`/g/${gameId}/f/${fixtureId}/open`, cookie);

    expect(response.status).toBe(404);
    const [fixture] = await db.select().from(fixtures).where(eq(fixtures.id, fixtureId));
    expect(fixture?.lifecycle).toBe("scheduled");
  });

  it("refuses a cross-origin post", async () => {
    const { cookie, gameId, fixtureId } = await scheduledFixture();

    const response = await appPost(`/g/${gameId}/f/${fixtureId}/open`, cookie, "https://elsewhere.example");

    expect(response.status).toBe(403);
    const [fixture] = await db.select().from(fixtures).where(eq(fixtures.id, fixtureId));
    expect(fixture?.lifecycle).toBe("scheduled");
  });

  it("tells a gated game its first group is invited, and an ungated one that nobody is", async () => {
    // The gating flag has to reach the view on its own. The invite-progress
    // panel is the obvious source and the wrong one: it is built only for an
    // *open* fixture, so on the scheduled page this button lives on it is
    // always absent, and reading gating from it would show every owner the
    // ungated sentence.
    const gated = await scheduledFixture();
    const gatedHtml = await (
      await SELF.fetch(`${ORIGIN}/g/${gated.gameId}/f/${gated.fixtureId}`, { headers: { cookie: gated.cookie } })
    ).text();
    expect(gatedHtml).toContain("The first group is invited straight away");

    await resetDatabase();

    const ungated = await scheduledFixture({ gated: false });
    const ungatedHtml = await (
      await SELF.fetch(`${ORIGIN}/g/${ungated.gameId}/f/${ungated.fixtureId}`, {
        headers: { cookie: ungated.cookie },
      })
    ).text();
    expect(ungatedHtml).toContain("Nobody is emailed yet");
  });

  it("offers the button on a scheduled fixture and not on an open one", async () => {
    const { cookie, gameId, fixtureId } = await scheduledFixture();

    const scheduled = await (
      await SELF.fetch(`${ORIGIN}/g/${gameId}/f/${fixtureId}`, { headers: { cookie } })
    ).text();
    expect(scheduled).toContain("Open it now");

    await appPost(`/g/${gameId}/f/${fixtureId}/open`, cookie);
    await drainSends();

    const opened = await (
      await SELF.fetch(`${ORIGIN}/g/${gameId}/f/${fixtureId}`, { headers: { cookie } })
    ).text();
    expect(opened).not.toContain("Open it now");
  });
});

import { SELF, env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../src/db/client.js";
import { auditLog, notificationLog, players } from "../../src/db/schema.js";
import { ALLOWED, ORIGIN, signIn } from "../support/sign-in.js";
import {
  insertFixture,
  insertGame,
  insertMembership,
  insertPlayer,
  insertResponse,
  resetDatabase,
} from "../support/factories.js";
import { kickoffIn } from "../support/clock.js";

const db = getDb(env.DB);

async function ownedFixture() {
  const { cookie } = await signIn();
  const [viewer] = await db.select().from(players).where(eq(players.email, ALLOWED));
  const ownerId = viewer!.id;

  const gameId = await insertGame(db, {});
  await insertMembership(db, gameId, ownerId, { role: "owner" });
  const memberId = await insertPlayer(db, { name: "Bo Chen", email: "bo@example.com" });
  await insertMembership(db, gameId, memberId, { role: "player" });

  const fixtureId = await insertFixture(db, gameId, { kicksOffAt: kickoffIn(48), lifecycle: "open" });
  await insertResponse(db, fixtureId, memberId, { status: "pending" });
  return { cookie, ownerId, gameId, fixtureId, memberId };
}

async function insertAudit(
  fixtureId: string,
  action: string,
  over: { actorPlayerId?: string | null; before?: unknown; after?: unknown; createdAt?: Date } = {},
) {
  await db.insert(auditLog).values({
    id: crypto.randomUUID(),
    actorPlayerId: over.actorPlayerId ?? null,
    entityType: "fixture",
    entityId: fixtureId,
    action: action as never,
    beforeJson: over.before === undefined ? null : JSON.stringify(over.before),
    afterJson: over.after === undefined ? null : JSON.stringify(over.after),
    createdAt: over.createdAt ?? new Date(Date.now()),
  });
}

function get(path: string, cookie: string) {
  return SELF.fetch(`${ORIGIN}${path}`, { headers: { cookie }, redirect: "manual" });
}

beforeEach(async () => {
  await resetDatabase();
});

describe("the fixture timeline (M46)", () => {
  it("says nothing happened rather than showing an empty list", async () => {
    const { cookie, gameId, fixtureId } = await ownedFixture();

    const html = await (await get(`/g/${gameId}/f/${fixtureId}/timeline`, cookie)).text();

    expect(html).toContain("Nothing yet.");
    // The limit is on the page, not in a comment: an organiser reading an
    // empty week must not conclude nothing happened.
    expect(html).toContain("nothing before that was recorded");
  });

  it("shows the sweep's open and the owner's differently", async () => {
    const { cookie, ownerId, gameId, fixtureId } = await ownedFixture();
    await insertAudit(fixtureId, "fixture.opened", { after: { pendingCreated: 2, autoDeclined: 0 } });

    const automatic = await (await get(`/g/${gameId}/f/${fixtureId}/timeline`, cookie)).text();
    expect(automatic).toContain("Opened for answers");
    expect(automatic).toContain("Automatically");

    await db.delete(auditLog);
    await insertAudit(fixtureId, "fixture.opened", {
      actorPlayerId: ownerId,
      after: { pendingCreated: 2, autoDeclined: 0 },
    });

    const byHand = await (await get(`/g/${gameId}/f/${fixtureId}/timeline`, cookie)).text();
    expect(byHand).not.toContain("Automatically");
    expect(byHand).toContain("2 players asked");
  });

  it("names the player a message went to", async () => {
    const { cookie, gameId, fixtureId, memberId } = await ownedFixture();
    await db.insert(notificationLog).values({
      id: crypto.randomUUID(),
      dedupeKey: `n1:${fixtureId}:${memberId}`,
      notificationType: "n1",
      fixtureId,
      playerId: memberId,
      channel: "email",
      status: "sent",
      sentAt: new Date(Date.now()),
    });

    const html = await (await get(`/g/${gameId}/f/${fixtureId}/timeline`, cookie)).text();

    expect(html).toContain("Invitation sent");
    expect(html).toContain("Bo Chen");
  });

  it("renders a stored value it has never heard of instead of 500ing", async () => {
    // Neither `audit_log.action` nor `notification_log.notification_type`
    // carries a CHECK constraint, so the TypeScript enums are claims about the
    // schema and not guarantees about the rows.
    const { cookie, gameId, fixtureId, memberId } = await ownedFixture();
    await insertAudit(fixtureId, "fixture.something_new", { after: { playerId: memberId } });
    await db.insert(notificationLog).values({
      id: crypto.randomUUID(),
      dedupeKey: `n99:${fixtureId}:${memberId}`,
      notificationType: "n99" as never,
      fixtureId,
      playerId: memberId,
      channel: "email",
      status: "queued",
    });

    const response = await get(`/g/${gameId}/f/${fixtureId}/timeline`, cookie);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("n99 sent");
  });

  it("leaves out another fixture's rows", async () => {
    const { cookie, gameId, fixtureId } = await ownedFixture();
    const other = await insertFixture(db, gameId, { kicksOffAt: kickoffIn(96), lifecycle: "open" });
    await insertAudit(other, "fixture.cancelled");

    const html = await (await get(`/g/${gameId}/f/${fixtureId}/timeline`, cookie)).text();

    expect(html).not.toContain("Called off");
  });

  it("refuses a member who is not the owner, and a stranger, with a 404 (TR-18)", async () => {
    const { cookie: strangerCookie } = await signIn();
    const [viewer] = await db.select().from(players).where(eq(players.email, ALLOWED));
    const ownerId = await insertPlayer(db, { name: "The Owner" });
    const gameId = await insertGame(db, {});
    await insertMembership(db, gameId, ownerId, { role: "owner" });
    await insertMembership(db, gameId, viewer!.id, { role: "player" });
    const fixtureId = await insertFixture(db, gameId, { kicksOffAt: kickoffIn(48), lifecycle: "open" });

    // The trail names who answered what and when — more than a squad member is
    // entitled to read about everybody else.
    expect((await get(`/g/${gameId}/f/${fixtureId}/timeline`, strangerCookie)).status).toBe(404);
    expect((await get(`/g/${gameId}/f/${fixtureId}/timeline`, "")).status).not.toBe(200);
  });

  it("is linked from the fixture page", async () => {
    const { cookie, gameId, fixtureId } = await ownedFixture();

    const html = await (await get(`/g/${gameId}/f/${fixtureId}`, cookie)).text();

    expect(html).toContain(`/g/${gameId}/f/${fixtureId}/timeline`);
  });
});

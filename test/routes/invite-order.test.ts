import { SELF, env } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../src/db/client.js";
import { inviteTiers, memberships, notificationLog, players, responses } from "../../src/db/schema.js";
import { openFixture } from "../../src/domain/open-fixture.js";
import { ALLOWED, ORIGIN, signIn } from "../support/sign-in.js";
import {
  insertFixture,
  insertGame,
  insertInviteTier,
  insertMembership,
  insertPlayer,
  resetDatabase,
} from "../support/factories.js";
import { kickoffIn, NOW } from "../support/clock.js";

const db = getDb(env.DB);

function appPost(path: string, fields: Record<string, string>, cookie: string) {
  return SELF.fetch(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, cookie },
    body: new URLSearchParams(fields),
    redirect: "manual",
  });
}

/** Signs in and makes that player the owner of a fresh gated game. */
async function ownedGatedGame(opts: { gated?: boolean } = {}) {
  const { cookie } = await signIn();
  const [viewer] = await db.select().from(players).where(eq(players.email, ALLOWED));
  const ownerId = viewer!.id;

  const gameId = await insertGame(db, { gatedInvitesEnabled: opts.gated ?? true });
  await insertMembership(db, gameId, ownerId, { role: "owner" });
  return { cookie, ownerId, gameId };
}

beforeEach(async () => {
  await resetDatabase();
});

describe("the invite-order editor", () => {
  it("refuses a signed-in non-owner with a 404, not a 403 (TR-18)", async () => {
    // Signed in, but the game belongs to somebody else entirely. A 403 would
    // confirm the game exists to a person with no business knowing.
    const { cookie } = await signIn();
    const strangerId = await insertPlayer(db, { name: "Someone Else" });
    const gameId = await insertGame(db, { gatedInvitesEnabled: true });
    await insertMembership(db, gameId, strangerId, { role: "owner" });

    const response = await SELF.fetch(`${ORIGIN}/g/${gameId}/invites`, {
      headers: { cookie },
      redirect: "manual",
    });

    expect(response.status).toBe(404);
  });

  it("refuses a member who is not an owner with the same 404", async () => {
    const { cookie } = await signIn();
    const [viewer] = await db.select().from(players).where(eq(players.email, ALLOWED));
    const ownerId = await insertPlayer(db, { name: "The Owner" });
    const gameId = await insertGame(db, { gatedInvitesEnabled: true });
    await insertMembership(db, gameId, ownerId, { role: "owner" });
    await insertMembership(db, gameId, viewer!.id, { role: "player" });

    const response = await SELF.fetch(`${ORIGIN}/g/${gameId}/invites`, {
      headers: { cookie },
      redirect: "manual",
    });

    expect(response.status).toBe(404);
  });

  it("refuses a signed-out visitor", async () => {
    const { gameId } = await ownedGatedGame();

    const response = await SELF.fetch(`${ORIGIN}/g/${gameId}/invites`, { redirect: "manual" });

    expect(response.status).not.toBe(200);
  });

  it("lists every tier with the implicit one last and undeletable", async () => {
    const { cookie, gameId } = await ownedGatedGame();
    const core = await insertInviteTier(db, gameId, { name: "Core", position: 1 });
    const player = await insertPlayer(db, { name: "Ada" });
    await insertMembership(db, gameId, player, { inviteTierId: core });
    const unplaced = await insertPlayer(db, { name: "Bo" });
    await insertMembership(db, gameId, unplaced);

    const html = await (
      await SELF.fetch(`${ORIGIN}/g/${gameId}/invites`, { headers: { cookie } })
    ).text();

    expect(html).toContain("Core");
    expect(html).toContain("Everyone else");
    expect(html).toContain("Ada");
    expect(html).toContain("Bo");
    // The implicit tier is pinned: no remove control is offered for it.
    expect(html).toContain("always last");
  });

  it("offers an assignment control for a member of the implicit tier", async () => {
    // The exact production path: a game with no tiers yet, whose owner adds
    // their first group. Every squad member is still unplaced at that moment,
    // so if the implicit tier's members carry no control the editor is
    // unusable precisely when it is first opened.
    const { cookie, gameId } = await ownedGatedGame();
    await insertInviteTier(db, gameId, { name: "Core", position: 1 });
    const unplaced = await insertPlayer(db, { name: "Bo" });
    await insertMembership(db, gameId, unplaced);

    const html = await (
      await SELF.fetch(`${ORIGIN}/g/${gameId}/invites`, { headers: { cookie } })
    ).text();

    // Named somewhere is not enough — the order row lists names as plain text.
    // The select is what makes them assignable.
    expect(html).toContain(`name="tier-${unplaced}"`);
  });

  it("offers an assignment control for every squad member, whatever tier they are in", async () => {
    const { cookie, gameId } = await ownedGatedGame();
    const core = await insertInviteTier(db, gameId, { name: "Core", position: 1 });
    const middle = await insertInviteTier(db, gameId, { name: "Regulars", position: 2 });
    const inCore = await insertPlayer(db, { name: "Ada" });
    const inMiddle = await insertPlayer(db, { name: "Fin" });
    const unplaced = await insertPlayer(db, { name: "Jo" });
    await insertMembership(db, gameId, inCore, { inviteTierId: core });
    await insertMembership(db, gameId, inMiddle, { inviteTierId: middle });
    await insertMembership(db, gameId, unplaced);

    const html = await (
      await SELF.fetch(`${ORIGIN}/g/${gameId}/invites`, { headers: { cookie } })
    ).text();

    for (const playerId of [inCore, inMiddle, unplaced]) {
      expect(html, `every member needs a control, ${playerId} had none`).toContain(
        `name="tier-${playerId}"`,
      );
    }
  });

  it("saves a member's tier assignment", async () => {
    const { cookie, gameId } = await ownedGatedGame();
    const core = await insertInviteTier(db, gameId, { name: "Core", position: 1 });
    const player = await insertPlayer(db, { name: "Ada" });
    await insertMembership(db, gameId, player);

    await appPost(`/g/${gameId}/invites`, { [`tier-${player}`]: core }, cookie);

    const [row] = await db.select().from(memberships).where(eq(memberships.playerId, player));
    expect(row?.inviteTierId).toBe(core);
  });

  it("ignores a tier id belonging to another game", async () => {
    const { cookie, gameId } = await ownedGatedGame();
    const otherGameId = await insertGame(db, { gatedInvitesEnabled: true });
    const foreignTier = await insertInviteTier(db, otherGameId, { name: "Theirs", position: 1 });
    const player = await insertPlayer(db, { name: "Ada" });
    await insertMembership(db, gameId, player);

    await appPost(`/g/${gameId}/invites`, { [`tier-${player}`]: foreignTier }, cookie);

    const [row] = await db.select().from(memberships).where(eq(memberships.playerId, player));
    // Falls to the implicit tier rather than pointing across Games — the
    // invariant SQLite cannot express, so the write path has to.
    expect(row?.inviteTierId).toBeNull();
  });

  it("adds a named group at the end of the order", async () => {
    const { cookie, gameId } = await ownedGatedGame();
    await insertInviteTier(db, gameId, { name: "Core", position: 1 });

    await appPost(`/g/${gameId}/invites/tier`, { name: "Regulars" }, cookie);

    const rows = await db.select().from(inviteTiers).where(eq(inviteTiers.gameId, gameId));
    const added = rows.find((row) => row.name === "Regulars");
    expect(added?.position).toBe(2);
  });

  it("refuses a group with a blank name", async () => {
    const { cookie, gameId } = await ownedGatedGame();

    const response = await appPost(`/g/${gameId}/invites/tier`, { name: "   " }, cookie);

    expect(response.status).toBe(422);
    const rows = await db.select().from(inviteTiers).where(eq(inviteTiers.gameId, gameId));
    expect(rows).toHaveLength(0);
  });

  it("drops a deleted tier's members to the implicit tier", async () => {
    const { cookie, gameId } = await ownedGatedGame();
    const doomed = await insertInviteTier(db, gameId, { name: "Doomed", position: 2 });
    const player = await insertPlayer(db, { name: "Ada" });
    await insertMembership(db, gameId, player, { inviteTierId: doomed });

    await appPost(`/g/${gameId}/invites/tier/${doomed}/delete`, {}, cookie);

    const [row] = await db.select().from(memberships).where(eq(memberships.playerId, player));
    expect(row?.inviteTierId).toBeNull();
    const rows = await db.select().from(inviteTiers).where(eq(inviteTiers.id, doomed));
    expect(rows).toHaveLength(0);
  });

  it("refuses to delete a tier belonging to another game (TR-18)", async () => {
    const { cookie, gameId } = await ownedGatedGame();
    const otherGameId = await insertGame(db, { gatedInvitesEnabled: true });
    const foreignTier = await insertInviteTier(db, otherGameId, { name: "Theirs", position: 1 });

    const response = await appPost(`/g/${gameId}/invites/tier/${foreignTier}/delete`, {}, cookie);

    expect(response.status).toBe(404);
    const rows = await db.select().from(inviteTiers).where(eq(inviteTiers.id, foreignTier));
    expect(rows).toHaveLength(1);
  });

  it("reorders tiers by position", async () => {
    const { cookie, gameId } = await ownedGatedGame();
    const first = await insertInviteTier(db, gameId, { name: "First", position: 1 });
    const second = await insertInviteTier(db, gameId, { name: "Second", position: 2 });

    await appPost(
      `/g/${gameId}/invites`,
      { [`position-${first}`]: "5", [`position-${second}`]: "1" },
      cookie,
    );

    const rows = await db.select().from(inviteTiers).where(eq(inviteTiers.gameId, gameId));
    expect(rows.find((row) => row.id === first)?.position).toBe(5);
    expect(rows.find((row) => row.id === second)?.position).toBe(1);
  });

  it("leaves a tier where it is when the position box is junk", async () => {
    const { cookie, gameId } = await ownedGatedGame();
    const tier = await insertInviteTier(db, gameId, { name: "Core", position: 3 });

    await appPost(`/g/${gameId}/invites`, { [`position-${tier}`]: "" }, cookie);

    const [row] = await db.select().from(inviteTiers).where(eq(inviteTiers.id, tier));
    // Not NaN, and not 0: writing either would make every ordering comparison
    // against this tier false and quietly send it to the front.
    expect(row?.position).toBe(3);
  });
});

describe("the invite-progress panel and the manual release", () => {
  async function openGatedFixture(opts: { gated?: boolean } = {}) {
    const { cookie, ownerId, gameId } = await ownedGatedGame(opts);
    const core = await insertInviteTier(db, gameId, { name: "Core", position: 1 });
    const subs = await insertInviteTier(db, gameId, { name: "Subs", position: 2 });
    const coreId = await insertPlayer(db, { name: "Ada", email: "ada@example.com" });
    const subId = await insertPlayer(db, { name: "Bo", email: "bo@example.com" });
    await insertMembership(db, gameId, coreId, { inviteTierId: core });
    await insertMembership(db, gameId, subId, { inviteTierId: subs });

    const fixtureId = await insertFixture(db, gameId, {
      kicksOffAt: kickoffIn(30),
      minPlayers: 1,
      maxPlayers: 10,
    });
    await openFixture(db, fixtureId, NOW);
    await db.update(responses).set({ invitedAt: NOW }).where(eq(responses.playerId, coreId));

    return { cookie, ownerId, gameId, fixtureId, coreId, subId };
  }

  it("shows each tier's state and why a held one is held", async () => {
    const { cookie, gameId, fixtureId } = await openGatedFixture();

    const html = await (
      await SELF.fetch(`${ORIGIN}/g/${gameId}/f/${fixtureId}`, { headers: { cookie } })
    ).text();

    expect(html).toContain("Invite progress");
    expect(html).toContain("next up");
    expect(html).toContain("Invite Subs now");
  });

  it("renders no panel at all for an ungated game (BR-39)", async () => {
    const { cookie, gameId, fixtureId } = await openGatedFixture({ gated: false });

    const html = await (
      await SELF.fetch(`${ORIGIN}/g/${gameId}/f/${fixtureId}`, { headers: { cookie } })
    ).text();

    expect(html).not.toContain("Invite progress");
  });

  it("releases the next tier when the owner presses the button", async () => {
    const { cookie, gameId, fixtureId, subId } = await openGatedFixture();

    const response = await appPost(`/g/${gameId}/f/${fixtureId}/invite/next`, {}, cookie);
    expect(response.status).toBe(303);

    const deadline = Date.now() + 3000;
    let row = (await db.select().from(responses).where(eq(responses.playerId, subId)))[0];
    while (row?.invitedAt === null && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      row = (await db.select().from(responses).where(eq(responses.playerId, subId)))[0];
    }
    expect(row?.invitedAt).not.toBeNull();

    // Drain the send so it cannot land after the next test's reset.
    const logDeadline = Date.now() + 3000;
    let log = await db.select().from(notificationLog);
    while (log.some((entry) => entry.status === "queued") && Date.now() < logDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      log = await db.select().from(notificationLog);
    }
  });

  it("refuses the manual release to a non-owner (TR-18)", async () => {
    const { gameId, fixtureId } = await openGatedFixture();

    const response = await appPost(`/g/${gameId}/f/${fixtureId}/invite/next`, {}, "");

    expect(response.status).not.toBe(303);
    expect(await db.select().from(inviteTiers).where(and(eq(inviteTiers.gameId, gameId)))).toHaveLength(2);
  });
});

describe("the player's not-yet-asked state (BR-40)", () => {
  /** A gated, open fixture where the signed-in viewer is an unasked sub. */
  async function asUnaskedSub(opts: { gated?: boolean; invited?: boolean } = {}) {
    const { cookie } = await signIn();
    const [viewer] = await db.select().from(players).where(eq(players.email, ALLOWED));
    const viewerId = viewer!.id;

    const ownerId = await insertPlayer(db, { name: "The Owner" });
    const gameId = await insertGame(db, { gatedInvitesEnabled: opts.gated ?? true });
    const core = await insertInviteTier(db, gameId, { name: "Core", position: 1 });
    const subs = await insertInviteTier(db, gameId, { name: "Subs", position: 2 });
    await insertMembership(db, gameId, ownerId, { role: "owner", inviteTierId: core });
    await insertMembership(db, gameId, viewerId, { role: "player", inviteTierId: subs });

    const fixtureId = await insertFixture(db, gameId, {
      kicksOffAt: kickoffIn(30),
      minPlayers: 1,
      maxPlayers: 10,
    });
    await openFixture(db, fixtureId, NOW);
    // The core has been released — which is what makes an invite order
    // *running* on this fixture, and is the difference between "your tier has
    // not come up yet" and "gating is not in effect here at all".
    await db.update(responses).set({ invitedAt: NOW }).where(eq(responses.playerId, ownerId));
    if (opts.invited === true) {
      await db.update(responses).set({ invitedAt: NOW }).where(eq(responses.playerId, viewerId));
    }

    return { cookie, gameId, fixtureId };
  }

  it("tells an unasked member where they stand", async () => {
    const { cookie, gameId, fixtureId } = await asUnaskedSub();

    const html = await (
      await SELF.fetch(`${ORIGIN}/g/${gameId}/f/${fixtureId}`, { headers: { cookie } })
    ).text();

    expect(html).toContain("You haven't been asked yet");
    expect(html).toContain("The core group is being asked first");
  });

  it("says nothing of the sort once they have been asked", async () => {
    const { cookie, gameId, fixtureId } = await asUnaskedSub({ invited: true });

    const html = await (
      await SELF.fetch(`${ORIGIN}/g/${gameId}/f/${fixtureId}`, { headers: { cookie } })
    ).text();

    expect(html).not.toContain("been asked yet");
  });

  it("says nothing of the sort in an ungated game (BR-39)", async () => {
    const { cookie, gameId, fixtureId } = await asUnaskedSub({ gated: false });

    const html = await (
      await SELF.fetch(`${ORIGIN}/g/${gameId}/f/${fixtureId}`, { headers: { cookie } })
    ).text();

    expect(html).not.toContain("been asked yet");
  });
});

describe("a fixture whose invitations went out before gating was switched on", () => {
  /**
   * The mid-flight case: the fixture opened and was mailed while the Game was
   * ungated, and only then did the owner switch gating on. Nothing is ever
   * stamped on it (the Durable Object skips it), so every screen has to read
   * "gating is not running here" rather than "nobody has been asked".
   */
  async function midFlightGating() {
    const { cookie } = await signIn();
    const [viewer] = await db.select().from(players).where(eq(players.email, ALLOWED));
    const viewerId = viewer!.id;

    const ownerId = await insertPlayer(db, { name: "The Owner" });
    const gameId = await insertGame(db, { gatedInvitesEnabled: true });
    await insertInviteTier(db, gameId, { name: "Core", position: 1 });
    await insertMembership(db, gameId, ownerId, { role: "owner" });
    await insertMembership(db, gameId, viewerId, { role: "player" });

    const fixtureId = await insertFixture(db, gameId, {
      kicksOffAt: kickoffIn(30),
      minPlayers: 1,
      maxPlayers: 10,
    });
    await openFixture(db, fixtureId, NOW);
    // Everyone was mailed before gating existed, and nothing is stamped.
    for (const playerId of [ownerId, viewerId]) {
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

    return { cookie, gameId, fixtureId, ownerId };
  }

  it("does not tell a player they are unasked when they have had the invitation", async () => {
    const { cookie, gameId, fixtureId } = await midFlightGating();

    const html = await (
      await SELF.fetch(`${ORIGIN}/g/${gameId}/f/${fixtureId}`, { headers: { cookie } })
    ).text();

    expect(html).not.toContain("been asked yet");
  });

  it("shows the owner no progress panel, since no order is running here", async () => {
    const { gameId, fixtureId, ownerId } = await midFlightGating();
    // Sign in as the owner to reach the organiser's view of the same fixture.
    const [owner] = await db.select().from(players).where(eq(players.id, ownerId));
    expect(owner).toBeDefined();
    const { cookie } = await signIn();
    const [viewer] = await db.select().from(players).where(eq(players.email, ALLOWED));
    await db
      .update(memberships)
      .set({ role: "owner" })
      .where(eq(memberships.playerId, viewer!.id));

    const html = await (
      await SELF.fetch(`${ORIGIN}/g/${gameId}/f/${fixtureId}`, { headers: { cookie } })
    ).text();

    // A panel here would report tiers as "held" and offer a button that the
    // Durable Object refuses, which is worse than no panel at all.
    expect(html).not.toContain("Invite progress");
  });
});

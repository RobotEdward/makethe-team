import { SELF, env } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../src/db/client.js";
import { games, inviteTiers, memberships, notificationLog, players, responses } from "../../src/db/schema.js";
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

  /** Core, then A and B in the "Then" list, for the move buttons. */
  async function threeGroups() {
    const { cookie, gameId } = await ownedGatedGame();
    const core = await insertInviteTier(db, gameId, { name: "Core", position: 1 });
    const a = await insertInviteTier(db, gameId, { name: "Alpha", position: 2 });
    const b = await insertInviteTier(db, gameId, { name: "Bravo", position: 3 });
    const positions = async () =>
      Object.fromEntries(
        (await db.select().from(inviteTiers).where(eq(inviteTiers.gameId, gameId))).map((row) => [
          row.name,
          row.position,
        ]),
      );
    return { cookie, gameId, core, a, b, positions };
  }

  it("moves a group down, swapping it with the one below", async () => {
    const { cookie, gameId, a, positions } = await threeGroups();

    const response = await appPost(`/g/${gameId}/invites`, { move: `down:${a}` }, cookie);

    expect(response.status).toBe(303);
    expect(await positions()).toEqual({ Core: 1, Alpha: 3, Bravo: 2 });
  });

  it("moves a group up, swapping it with the one above", async () => {
    const { cookie, gameId, b, positions } = await threeGroups();

    await appPost(`/g/${gameId}/invites`, { move: `up:${b}` }, cookie);

    expect(await positions()).toEqual({ Core: 1, Alpha: 3, Bravo: 2 });
  });

  it("moves nothing past either end of the list", async () => {
    // The first group in the list stays below the core group — the core is
    // chosen by who is in it — and the last stays above Everyone else.
    const { cookie, gameId, a, b, positions } = await threeGroups();

    await appPost(`/g/${gameId}/invites`, { move: `up:${a}` }, cookie);
    await appPost(`/g/${gameId}/invites`, { move: `down:${b}` }, cookie);

    expect(await positions()).toEqual({ Core: 1, Alpha: 2, Bravo: 3 });
  });

  it("ignores a move naming another game's group", async () => {
    const { cookie, gameId, positions } = await threeGroups();
    const otherGameId = await insertGame(db, { gatedInvitesEnabled: true });
    await insertInviteTier(db, otherGameId, { name: "Theirs", position: 1 });
    const theirs = await insertInviteTier(db, otherGameId, { name: "Theirs too", position: 2 });

    await appPost(`/g/${gameId}/invites`, { move: `up:${theirs}` }, cookie);

    expect(await positions()).toEqual({ Core: 1, Alpha: 2, Bravo: 3 });
  });

  it("offers each move only where there is somewhere to go", async () => {
    const { cookie, gameId, a, b } = await threeGroups();

    const html = await (await SELF.fetch(`${ORIGIN}/g/${gameId}/invites`, { headers: { cookie } })).text();

    const button = (direction: string, id: string) =>
      new RegExp(`<button[^>]*value="${direction}:${id}"[^>]*>`).exec(html)?.[0] ?? "";
    expect(button("up", a)).toContain("disabled");
    expect(button("down", a)).not.toContain("disabled");
    expect(button("up", b)).not.toContain("disabled");
    expect(button("down", b)).toContain("disabled");
    expect(button("down", a)).toContain('aria-label="Move Alpha down"');
    expect(html).not.toContain("invite-pos");
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

  it("still reads a tier as held when one of its members was invited by hand (M46)", async () => {
    // The shape Wednesday Night Football was in on 30 September 2026: the
    // owner hand-invited one sub, the panel read the whole tier as asked,
    // and the button to release the rest of it disappeared.
    const { cookie, gameId, fixtureId, subId } = await openGatedFixture();
    await db
      .update(responses)
      .set({ invitedAt: NOW, invitedIndividually: true })
      .where(eq(responses.playerId, subId));

    const html = await (
      await SELF.fetch(`${ORIGIN}/g/${gameId}/f/${fixtureId}`, { headers: { cookie } })
    ).text();

    expect(html).toContain("next up");
    expect(html).toContain("Invite Subs now");
  });

  it("says when the next group is due, and who in it is already in (M69)", async () => {
    const { cookie, gameId, fixtureId, subId } = await openGatedFixture();
    await db
      .update(responses)
      .set({ invitedAt: NOW, invitedIndividually: true, status: "in" })
      .where(eq(responses.playerId, subId));

    const html = await (
      await SELF.fetch(`${ORIGIN}/g/${gameId}/f/${fixtureId}`, { headers: { cookie } })
    ).text();

    expect(html).toMatch(/due (now · asked (within the hour|at 06:00)|\w+ \d{1,2} \w+, \d\d:\d\d)/);
    expect(html).toContain("1 in already");
    expect(html).toContain("Nobody is asked between 23:00 and 06:00.");
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
    // 12 waking hours after the core, and well before the cut-off.
    expect(html).toContain("Your group is due to be asked");
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

  it("changes the sentence once the unasked sub has volunteered (BR-40a)", async () => {
    const { cookie, gameId, fixtureId } = await asUnaskedSub();
    const [viewer] = await db.select().from(players).where(eq(players.email, ALLOWED));
    await env.FIXTURE_CAPACITY.getByName(fixtureId).setResponse({
      playerId: viewer!.id,
      intent: "in",
      actorPlayerId: null,
      source: "web",
      now: NOW.getTime(),
      whenFull: "waitlist",
    });

    const html = await (
      await SELF.fetch(`${ORIGIN}/g/${gameId}/f/${fixtureId}`, { headers: { cookie } })
    ).text();

    // "You haven't been asked yet" would read as though their answer had gone
    // nowhere. It went somewhere: they hold a place in the queue.
    expect(html).toContain("You're in line. Your group is due to be asked");
    expect(html).not.toContain("You haven't been asked yet");
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

/**
 * M44. Saving the order releases people, and since BR-40a releasing somebody
 * is what takes them off the waitlist — so the save has to reconcile, not
 * leave an owner watching a page that appears to have done nothing for an
 * hour until the sweep catches up.
 */
describe("saving the invite order promotes whoever it releases", () => {
  /**
   * A gated game whose order has fully run, plus one late joiner sitting in
   * the implicit tier, unstamped and waitlisted — the shape a returning
   * regular lands in when they rejoin an open fixture (BR-2′).
   */
  async function withAWaitingLateJoiner(
    opts: { maxPlayers?: number; implicitAlreadyAsked?: boolean } = {},
  ) {
    const { cookie, ownerId, gameId } = await ownedGatedGame();
    const regulars = await insertInviteTier(db, gameId, { name: "Regulars", position: 1 });
    await db.update(memberships).set({ inviteTierId: regulars })
      .where(and(eq(memberships.gameId, gameId), eq(memberships.playerId, ownerId)));

    // A stamped member left in the implicit final tier, which is what makes
    // that tier *released* — without one it holds only the unstamped joiner
    // and reads as never asked, so dropping somebody into it releases nobody.
    if (opts.implicitAlreadyAsked === true) {
      const asked = await insertPlayer(db, { name: "Asked Already", email: "asked@example.com" });
      await insertMembership(db, gameId, asked, { role: "player" });
    }

    const joinerId = await insertPlayer(db, { name: "Dave Field", email: "dave@example.com" });
    await insertMembership(db, gameId, joinerId, { role: "player" });

    const fixtureId = await insertFixture(db, gameId, {
      kicksOffAt: kickoffIn(30),
      minPlayers: 1,
      maxPlayers: opts.maxPlayers ?? 16,
    });
    await openFixture(db, fixtureId, NOW);
    // The order has run: everyone present at the time was stamped.
    await db.update(responses).set({ invitedAt: NOW }).where(eq(responses.fixtureId, fixtureId));
    // The joiner arrives afterwards, unstamped, and volunteers — BR-40a puts
    // them on the waitlist even though the fixture is nearly empty.
    await db.update(responses).set({ invitedAt: null })
      .where(and(eq(responses.fixtureId, fixtureId), eq(responses.playerId, joinerId)));
    await env.FIXTURE_CAPACITY.getByName(fixtureId).setResponse({
      playerId: joinerId, intent: "in", actorPlayerId: null,
      source: "web", now: NOW.getTime(), whenFull: "waitlist",
    });

    return { cookie, gameId, fixtureId, joinerId, regulars };
  }

  const rowFor = async (fixtureId: string, playerId: string) => {
    const [row] = await db.select().from(responses)
      .where(and(eq(responses.fixtureId, fixtureId), eq(responses.playerId, playerId)));
    return row;
  };

  /**
   * The reconcile is handed to `waitUntil`, so it is not done when the
   * redirect arrives — the same polling this file's manual-release test uses,
   * and for the same reason.
   */
  async function settle(check: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await check()) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  /** Drain the sends so none lands after the next test's reset. */
  async function drainSends(timeoutMs = 3000): Promise<void> {
    await settle(async () => {
      const log = await db.select().from(notificationLog);
      return !log.some((entry) => entry.status === "queued");
    }, timeoutMs);
  }

  it("puts a released member into a free slot on save, without a sweep", async () => {
    const { cookie, gameId, fixtureId, joinerId, regulars } = await withAWaitingLateJoiner();
    expect((await rowFor(fixtureId, joinerId))?.status).toBe("waitlisted");

    const response = await appPost(`/g/${gameId}/invites`, { [`tier-${joinerId}`]: regulars }, cookie);

    expect(response.status).toBe(303);
    await settle(async () => (await rowFor(fixtureId, joinerId))?.status === "in");

    const row = await rowFor(fixtureId, joinerId);
    expect(row?.status).toBe("in");
    expect(row?.invitedAt).not.toBeNull();
    expect(row?.waitlistPosition).toBeNull();
    await drainSends();
  });

  it("leaves them waiting when the fixture has no room", async () => {
    // Released, so stamped — but a full fixture has nothing to promote them
    // into, and BR-8 says only an owner may push a fixture past its limit.
    const { cookie, gameId, fixtureId, joinerId, regulars } = await withAWaitingLateJoiner({
      maxPlayers: 1,
    });
    await env.FIXTURE_CAPACITY.getByName(fixtureId).setResponse({
      playerId: (await db.select().from(memberships)
        .where(and(eq(memberships.gameId, gameId), eq(memberships.role, "owner"))))[0]!.playerId,
      intent: "in", actorPlayerId: null, source: "web", now: NOW.getTime(), whenFull: "waitlist",
    });

    await appPost(`/g/${gameId}/invites`, { [`tier-${joinerId}`]: regulars }, cookie);
    // The release still happens — it is only the promotion that cannot. Waiting
    // on the stamp is what makes the status assertion below meaningful rather
    // than a race the reconcile simply had not reached yet.
    await settle(async () => (await rowFor(fixtureId, joinerId))?.invitedAt !== null);

    const row = await rowFor(fixtureId, joinerId);
    expect(row?.invitedAt).not.toBeNull();
    expect(row?.status).toBe("waitlisted");
    await drainSends();
  });

  it("reconciles when a group is deleted and its members drop to the implicit tier", async () => {
    const { cookie, gameId, fixtureId, joinerId } = await withAWaitingLateJoiner({
      implicitAlreadyAsked: true,
    });
    // Park the joiner in a group of their own, then delete it.
    const standby = await insertInviteTier(db, gameId, { name: "Standby", position: 2 });
    await appPost(`/g/${gameId}/invites`, { [`tier-${joinerId}`]: standby }, cookie);

    await appPost(`/g/${gameId}/invites/tier/${standby}/delete`, {}, cookie);
    await settle(async () => (await rowFor(fixtureId, joinerId))?.status === "in");

    expect((await rowFor(fixtureId, joinerId))?.status).toBe("in");
    await drainSends();
  });

  it("does nothing of the sort in an ungated game (BR-39)", async () => {
    // No order, nothing to release, and the member was never gated in the
    // first place — a reconcile here must not invent a promotion.
    const { cookie } = await signIn();
    const [viewer] = await db.select().from(players).where(eq(players.email, ALLOWED));
    const gameId = await insertGame(db, { gatedInvitesEnabled: false });
    await insertMembership(db, gameId, viewer!.id, { role: "owner" });
    const tier = await insertInviteTier(db, gameId, { name: "Regulars", position: 1 });
    const fixtureId = await insertFixture(db, gameId, { kicksOffAt: kickoffIn(30), minPlayers: 1 });
    await openFixture(db, fixtureId, NOW);

    const response = await appPost(`/g/${gameId}/invites`, { [`tier-${viewer!.id}`]: tier }, cookie);

    expect(response.status).toBe(303);
    // Nothing to wait for, which is the assertion: drain whatever the request
    // did start, and the stamp must still be absent afterwards.
    await drainSends();
    expect((await rowFor(fixtureId, viewer!.id))?.invitedAt).toBeNull();
  });
});

describe("head starts and the schedule preview (M69)", () => {
  /**
   * Regulars (the owner), Standby (one player, 12 hours) and Everyone else
   * (one player), against a game kicking off at 19:00 a week out and opening
   * at 09:00 the day before — so the cut-off is 16:00 on the day.
   */
  async function orderedGame() {
    const { cookie, ownerId, gameId } = await ownedGatedGame();
    const regulars = await insertInviteTier(db, gameId, { name: "Regulars", position: 1 });
    const standby = await insertInviteTier(db, gameId, { name: "Standby", position: 2, askAfterHours: 12 });
    await db.update(memberships).set({ inviteTierId: regulars }).where(eq(memberships.playerId, ownerId));
    const sub = await insertPlayer(db, { name: "Sam Sub", email: "sam@example.com" });
    await insertMembership(db, gameId, sub, { inviteTierId: standby });
    const other = await insertPlayer(db, { name: "Olly Other", email: "olly@example.com" });
    await insertMembership(db, gameId, other);
    await insertFixture(db, gameId, { kicksOffAt: kickoffIn(24 * 7) });
    return { cookie, gameId, standby };
  }

  const page = async (gameId: string, cookie: string) =>
    (await SELF.fetch(`${ORIGIN}/g/${gameId}/invites`, { headers: { cookie } })).text();

  it("lays out when each group is asked, pausing overnight", async () => {
    const { cookie, gameId } = await orderedGame();

    const html = await page(gameId, cookie);

    expect(html).toContain("When each group is asked");
    expect(html).toContain("09:00 · when the game opens");
    expect(html).toContain("21:00</span>");
    // 21:00 + 12 waking hours: two before 23:00, ten from 06:00.
    expect(html).toContain("16:00 · paused overnight");
    expect(html).toContain("every timed group asked by 16:00");
  });

  it("saves a head start, and a final group asked only when needed", async () => {
    const { cookie, gameId, standby } = await orderedGame();

    const response = await appPost(
      `/g/${gameId}/invites`,
      { [`after-${standby}`]: "6", "everyone-mode": "needed", "after-everyone": "12" },
      cookie,
    );

    expect(response.status).toBe(303);
    const [tier] = await db.select().from(inviteTiers).where(eq(inviteTiers.id, standby));
    expect(tier?.askAfterHours).toBe(6);
    const [game] = await db.select().from(games).where(eq(games.id, gameId));
    expect(game?.everyoneElseAskAfterHours).toBeNull();
    expect(await page(gameId, cookie)).toContain("only if the groups above can&#39;t fill the game");
  });

  it("shows the proposed times on Check schedule, and saves nothing", async () => {
    const { cookie, gameId, standby } = await orderedGame();

    const response = await appPost(
      `/g/${gameId}/invites`,
      { [`after-${standby}`]: "2", "everyone-mode": "timed", "after-everyone": "2", intent: "preview" },
      cookie,
    );

    expect(response.status).toBe(200);
    const html = await response.text();
    // The ripple: Standby at 11:00 moves Everyone else to 13:00.
    expect(html).toContain("11:00</span>");
    expect(html).toContain("13:00</span>");
    expect(html).toContain('value="2"');
    const [tier] = await db.select().from(inviteTiers).where(eq(inviteTiers.id, standby));
    expect(tier?.askAfterHours).toBe(12);
  });

  it("refuses a schedule that asks a group after the cut-off, naming what fits", async () => {
    const { cookie, gameId, standby } = await orderedGame();

    const response = await appPost(
      `/g/${gameId}/invites`,
      { [`after-${standby}`]: "12", "everyone-mode": "timed", "after-everyone": "20" },
      cookie,
    );

    expect(response.status).toBe(422);
    const html = await response.text();
    expect(html).toContain("Everyone else would be asked");
    expect(html).toContain("The longest head start that fits is 12 hours.");
    expect(html).toContain('value="20"');
    const [game] = await db.select().from(games).where(eq(games.id, gameId));
    expect(game?.everyoneElseAskAfterHours).toBe(12);
  });

  it("refuses a head start that is not a whole number of hours", async () => {
    const { cookie, gameId, standby } = await orderedGame();

    const response = await appPost(`/g/${gameId}/invites`, { [`after-${standby}`]: "1.5" }, cookie);

    expect(response.status).toBe(422);
    expect(await response.text()).toContain("Give Standby a head start in whole hours");
  });
});

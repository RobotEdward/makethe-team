import { SELF, env } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../src/db/client.js";
import { auditLog, fixtures, memberships, players, responses } from "../../src/db/schema.js";
import { openFixture } from "../../src/domain/open-fixture.js";
import type { PickerMode } from "../../src/domain/picker.js";
import {
  insertFixture,
  insertGame,
  insertMembership,
  insertPlayer,
  resetDatabase,
} from "../support/factories.js";
import { kickoffIn, NOW } from "../support/clock.js";
import { ALLOWED, ORIGIN, signIn } from "../support/sign-in.js";

const db = getDb(env.DB);
const KICKOFF = kickoffIn(9);

beforeEach(resetDatabase);

/**
 * A game the signed-in identity is an ordinary member of, with one open
 * fixture, an owner who is somebody else, and a second member so an
 * organiser's hand-over control has more than one name in it.
 */
async function seed(mode: PickerMode, options: { delegate?: "viewer" | "other" } = {}) {
  const { cookie } = await signIn();
  const [viewer] = await db.select().from(players).where(eq(players.email, ALLOWED));
  const viewerId = viewer!.id;

  const gameId = await insertGame(db, { maxPlayers: 14, minPlayers: 1 });
  const ownerId = await insertPlayer(db, { name: "Olive Owner" });
  const otherId = await insertPlayer(db, { name: "Otto Other" });
  await insertMembership(db, gameId, ownerId, { role: "owner" });
  await insertMembership(db, gameId, viewerId);
  await insertMembership(db, gameId, otherId);

  const fixtureId = await insertFixture(db, gameId, { kicksOffAt: KICKOFF, minPlayers: 1 });
  await openFixture(db, fixtureId, NOW);

  const delegateId = options.delegate === "other" ? otherId : viewerId;
  await db
    .update(fixtures)
    .set({
      pickerMode: mode,
      teamPickerPlayerId: mode === "delegate" ? delegateId : null,
      teamPickerSetAt: mode === "delegate" ? NOW : null,
    })
    .where(eq(fixtures.id, fixtureId));

  return { gameId, fixtureId, cookie, viewerId, ownerId, otherId };
}

/**
 * Put two people `in` so there is a pick worth making.
 *
 * An update, not an insert: `openFixture` has already written a `pending` row
 * for every member, and `responses` is unique on (fixture, player).
 */
async function twoPlayersIn(fixtureId: string, first: string, second: string) {
  for (const playerId of [first, second]) {
    await db
      .update(responses)
      .set({ status: "in", respondedAt: NOW })
      .where(and(eq(responses.fixtureId, fixtureId), eq(responses.playerId, playerId)));
  }
}

function get(path: string, cookie: string) {
  return SELF.fetch(`${ORIGIN}${path}`, { headers: { cookie }, redirect: "manual" });
}

function post(path: string, cookie: string, fields: Record<string, string>) {
  return SELF.fetch(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, cookie },
    body: new URLSearchParams(fields),
    redirect: "manual",
  });
}

describe("who may open the picker page", () => {
  it("shows it to the named delegate", async () => {
    const { gameId, fixtureId, cookie, viewerId, otherId } = await seed("delegate");
    await twoPlayersIn(fixtureId, viewerId, otherId);

    const response = await get(`/g/${gameId}/f/${fixtureId}/teams`, cookie);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("The organiser has asked you to pick the teams");
    expect(html).toContain(`action="/g/${gameId}/f/${fixtureId}/teams"`);
    expect(html).toContain("Otto Other");
  });

  it("shows it to any member when the pick is open", async () => {
    const { gameId, fixtureId, cookie, viewerId, otherId } = await seed("open");
    await twoPlayersIn(fixtureId, viewerId, otherId);

    const response = await get(`/g/${gameId}/f/${fixtureId}/teams`, cookie);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("going spare");
  });

  it("404s a member on a fixture the organiser has kept", async () => {
    const { gameId, fixtureId, cookie } = await seed("organiser");

    const response = await get(`/g/${gameId}/f/${fixtureId}/teams`, cookie);

    expect(response.status).toBe(404);
  });

  it("404s a member who is not the named delegate", async () => {
    const { gameId, fixtureId, cookie } = await seed("delegate", { delegate: "other" });

    const response = await get(`/g/${gameId}/f/${fixtureId}/teams`, cookie);

    expect(response.status).toBe(404);
  });

  /**
   * The delegation pointer is deliberately not cleared when somebody leaves
   * (`src/db/schema.ts`), so this is the check that actually enforces it:
   * membership is re-read on every request.
   */
  it("404s a delegate who has left the squad", async () => {
    const { gameId, fixtureId, cookie, viewerId } = await seed("delegate");
    await db
      .update(memberships)
      .set({ active: false, leftAt: NOW })
      .where(eq(memberships.playerId, viewerId));

    const response = await get(`/g/${gameId}/f/${fixtureId}/teams`, cookie);

    expect(response.status).toBe(404);
  });

  it("404s a signed-in stranger to the game", async () => {
    const { fixtureId, cookie } = await seed("open");
    const otherGameId = await insertGame(db, {});

    const response = await get(`/g/${otherGameId}/f/${fixtureId}/teams`, cookie);

    expect(response.status).toBe(404);
  });
});

describe("a delegate picking and publishing", () => {
  it("saves a pick and comes back to the picker page, not the organiser's", async () => {
    const { gameId, fixtureId, cookie, viewerId, otherId } = await seed("delegate");
    await twoPlayersIn(fixtureId, viewerId, otherId);

    const response = await post(`/g/${gameId}/f/${fixtureId}/teams`, cookie, {
      [viewerId]: "a",
      [otherId]: "b",
    });

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`/g/${gameId}/f/${fixtureId}/teams`);

    // The two who are `in`, not every row on the fixture: the organiser has a
    // `pending` row of their own, and a `pending` player is never given a side.
    const saved = await db.select().from(responses).where(eq(responses.fixtureId, fixtureId));
    const sides = new Map(saved.map((row) => [row.playerId, row.team]));
    expect(sides.get(viewerId)).toBe("a");
    expect(sides.get(otherId)).toBe("b");
  });

  it("publishes, exactly as the organiser would", async () => {
    const { gameId, fixtureId, cookie, viewerId, otherId } = await seed("delegate");
    await twoPlayersIn(fixtureId, viewerId, otherId);
    await post(`/g/${gameId}/f/${fixtureId}/teams`, cookie, {
      [viewerId]: "a",
      [otherId]: "b",
    });

    const response = await post(`/g/${gameId}/f/${fixtureId}/teams/publish`, cookie, {});

    expect(response.status).toBe(303);
    const [fixture] = await db.select().from(fixtures).where(eq(fixtures.id, fixtureId));
    expect(fixture!.teamsPublishedAt).not.toBeNull();
  });

  it("keeps publishing after the first announcement", async () => {
    const { gameId, fixtureId, cookie, viewerId, otherId } = await seed("delegate");
    await twoPlayersIn(fixtureId, viewerId, otherId);
    await post(`/g/${gameId}/f/${fixtureId}/teams`, cookie, {
      [viewerId]: "a",
      [otherId]: "b",
    });
    await post(`/g/${gameId}/f/${fixtureId}/teams/publish`, cookie, {});

    const again = await post(`/g/${gameId}/f/${fixtureId}/teams/publish`, cookie, {});

    expect(again.status).toBe(303);
  });
});

describe("open mode: first publish wins", () => {
  it("lets any member make the first announcement", async () => {
    const { gameId, fixtureId, cookie, viewerId, otherId } = await seed("open");
    await twoPlayersIn(fixtureId, viewerId, otherId);
    await post(`/g/${gameId}/f/${fixtureId}/teams`, cookie, {
      [viewerId]: "a",
      [otherId]: "b",
    });

    const response = await post(`/g/${gameId}/f/${fixtureId}/teams/publish`, cookie, {});

    expect(response.status).toBe(303);
  });

  it("refuses a second announcement from a member, on their own page", async () => {
    const { gameId, fixtureId, cookie, viewerId, otherId } = await seed("open");
    await twoPlayersIn(fixtureId, viewerId, otherId);
    await post(`/g/${gameId}/f/${fixtureId}/teams`, cookie, {
      [viewerId]: "a",
      [otherId]: "b",
    });
    await post(`/g/${gameId}/f/${fixtureId}/teams/publish`, cookie, {});

    const again = await post(`/g/${gameId}/f/${fixtureId}/teams/publish`, cookie, {});
    const html = await again.text();

    expect(again.status).toBe(422);
    expect(html).toContain("already been sent out");
    // The refusal lands on the picker page — the only page this person has
    // seen — and not on the organiser's fixture page.
    expect(html).not.toContain("Add a guest");
  });

  it("still lets a member save a correction after publication", async () => {
    const { gameId, fixtureId, cookie, viewerId, otherId } = await seed("open");
    await twoPlayersIn(fixtureId, viewerId, otherId);
    await post(`/g/${gameId}/f/${fixtureId}/teams`, cookie, {
      [viewerId]: "a",
      [otherId]: "b",
    });
    await post(`/g/${gameId}/f/${fixtureId}/teams/publish`, cookie, {});

    const save = await post(`/g/${gameId}/f/${fixtureId}/teams`, cookie, {
      [viewerId]: "b",
      [otherId]: "a",
    });

    expect(save.status).toBe(303);
    const page = await (await get(`/g/${gameId}/f/${fixtureId}/teams`, cookie)).text();
    expect(page).toContain("Save teams");
    expect(page).not.toContain("Publish again");
    expect(page).toContain("only the organiser can send the squad a fresh message");
  });
});

describe("the organiser's hand-over control", () => {
  /** Sign in as the game's owner rather than as a member. */
  async function seedAsOwner() {
    const { cookie } = await signIn();
    const [viewer] = await db.select().from(players).where(eq(players.email, ALLOWED));
    const ownerId = viewer!.id;

    const gameId = await insertGame(db, { maxPlayers: 14, minPlayers: 1 });
    const memberId = await insertPlayer(db, { name: "Mo Member" });
    await insertMembership(db, gameId, ownerId, { role: "owner" });
    await insertMembership(db, gameId, memberId);

    const fixtureId = await insertFixture(db, gameId, { kicksOffAt: KICKOFF, minPlayers: 1 });
    await openFixture(db, fixtureId, NOW);
    return { gameId, fixtureId, cookie, ownerId, memberId };
  }

  it("offers the squad, and not the organiser themselves", async () => {
    const { gameId, fixtureId, cookie } = await seedAsOwner();

    const html = await (await get(`/g/${gameId}/f/${fixtureId}`, cookie)).text();

    expect(html).toContain("Who picks the teams?");
    expect(html).toContain(`action="/g/${gameId}/f/${fixtureId}/picker"`);
    expect(html).toContain("Mo Member");
    expect(html).toContain("Anyone in the squad");
  });

  it("hands one fixture to one player, and files an audit row", async () => {
    const { gameId, fixtureId, cookie, memberId } = await seedAsOwner();

    const response = await post(`/g/${gameId}/f/${fixtureId}/picker`, cookie, {
      mode: "delegate",
      delegate: memberId,
    });

    expect(response.status).toBe(303);
    const [fixture] = await db.select().from(fixtures).where(eq(fixtures.id, fixtureId));
    expect(fixture!.pickerMode).toBe("delegate");
    expect(fixture!.teamPickerPlayerId).toBe(memberId);
    expect(fixture!.teamPickerSetAt).not.toBeNull();

    const rows = await db.select().from(auditLog).where(eq(auditLog.entityId, fixtureId));
    expect(rows.map((row) => row.action)).toContain("fixture.picker_changed");
  });

  it("does not re-stamp the hand-over when the same form is submitted twice", async () => {
    const { gameId, fixtureId, cookie, memberId } = await seedAsOwner();
    await post(`/g/${gameId}/f/${fixtureId}/picker`, cookie, { mode: "delegate", delegate: memberId });
    const [first] = await db.select().from(fixtures).where(eq(fixtures.id, fixtureId));

    await post(`/g/${gameId}/f/${fixtureId}/picker`, cookie, { mode: "delegate", delegate: memberId });
    const [second] = await db.select().from(fixtures).where(eq(fixtures.id, fixtureId));

    expect(second!.teamPickerSetAt?.getTime()).toBe(first!.teamPickerSetAt?.getTime());
  });

  it("clears the delegate when the pick is opened to everyone", async () => {
    const { gameId, fixtureId, cookie, memberId } = await seedAsOwner();
    await post(`/g/${gameId}/f/${fixtureId}/picker`, cookie, { mode: "delegate", delegate: memberId });

    await post(`/g/${gameId}/f/${fixtureId}/picker`, cookie, { mode: "open", delegate: memberId });

    const [fixture] = await db.select().from(fixtures).where(eq(fixtures.id, fixtureId));
    expect(fixture!.pickerMode).toBe("open");
    expect(fixture!.teamPickerPlayerId).toBeNull();
    expect(fixture!.teamPickerSetAt).toBeNull();
  });

  it("refuses a delegate who is not in the squad", async () => {
    const { gameId, fixtureId, cookie } = await seedAsOwner();
    const strangerId = await insertPlayer(db, { name: "Stan Stranger" });

    const response = await post(`/g/${gameId}/f/${fixtureId}/picker`, cookie, {
      mode: "delegate",
      delegate: strangerId,
    });
    const html = await response.text();

    expect(response.status).toBe(422);
    expect(html).toContain("currently in the squad");
    const [fixture] = await db.select().from(fixtures).where(eq(fixtures.id, fixtureId));
    expect(fixture!.pickerMode).toBe("organiser");
  });

  it("refuses a guest, who could never sign in to use it", async () => {
    const { gameId, fixtureId, cookie } = await seedAsOwner();
    const guestId = await insertPlayer(db, { name: "Gus Guest", isGuest: true, email: null });
    await insertMembership(db, gameId, guestId);

    const response = await post(`/g/${gameId}/f/${fixtureId}/picker`, cookie, {
      mode: "delegate",
      delegate: guestId,
    });

    expect(response.status).toBe(422);
    const [fixture] = await db.select().from(fixtures).where(eq(fixtures.id, fixtureId));
    expect(fixture!.teamPickerPlayerId).toBeNull();
  });

  it("400s a mode this application never rendered", async () => {
    const { gameId, fixtureId, cookie } = await seedAsOwner();

    const response = await post(`/g/${gameId}/f/${fixtureId}/picker`, cookie, { mode: "everyone" });

    expect(response.status).toBe(400);
  });

  it("403s a request from another origin", async () => {
    const { gameId, fixtureId, cookie, memberId } = await seedAsOwner();

    const response = await SELF.fetch(`${ORIGIN}/g/${gameId}/f/${fixtureId}/picker`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example", cookie },
      body: new URLSearchParams({ mode: "delegate", delegate: memberId }),
      redirect: "manual",
    });

    expect(response.status).toBe(403);
  });
});

describe("the player's fixture page", () => {
  it("links a delegate to the picker", async () => {
    const { gameId, fixtureId, cookie } = await seed("delegate");

    const html = await (await get(`/g/${gameId}/f/${fixtureId}`, cookie)).text();

    expect(html).toContain("The organiser has asked you to pick the teams");
    expect(html).toContain(`href="/g/${gameId}/f/${fixtureId}/teams"`);
  });

  it("links any member when the pick is open", async () => {
    const { gameId, fixtureId, cookie } = await seed("open");

    const html = await (await get(`/g/${gameId}/f/${fixtureId}`, cookie)).text();

    expect(html).toContain("open for anyone in the squad to pick");
  });

  it("says nothing to a member on a fixture the organiser has kept", async () => {
    const { gameId, fixtureId, cookie } = await seed("organiser");

    const html = await (await get(`/g/${gameId}/f/${fixtureId}`, cookie)).text();

    expect(html).not.toContain("Pick the teams");
  });
});

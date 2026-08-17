import { SELF } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
// `notificationLog` serves two purposes here. The first is draining: a row
// landing *after* the next test's `resetDatabase()` breaks that reset's
// `DELETE FROM players` on the table's foreign key, exactly the race
// `test/routes/join.test.ts` documents on `waitForNotificationRows`, which is
// why `settleNotifications` exists. The second is assertion — see "sends N-7
// to the removed player and N-2 to whoever it promoted" below. `settleNotifications`
// is a drain and returns whether or not it settled, so it can never fail a
// test; every claim about email must be an explicit assertion after it.
import { auditLog, memberships, notificationLog, players, responses } from "../../src/db/schema.js";
import {
  insertFixture,
  insertGame,
  insertMembership,
  insertPlayer,
  insertResponse,
  resetDatabase,
  testDb,
} from "../support/factories.js";
import { ALLOWED, ORIGIN, signIn } from "../support/sign-in.js";

/**
 * Drains the N-7 `waitUntil` so it cannot land after the next test's
 * `resetDatabase()`. Never asserted on — see the import comment above.
 */
async function settleNotifications(atLeast: number, timeoutMs = 3000) {
  const db = testDb();
  const deadline = Date.now() + timeoutMs;
  const settled = (rows: Array<{ status: string }>) =>
    rows.length >= atLeast && rows.every((row) => row.status !== "queued");

  let rows = await db.select().from(notificationLog);
  while (!settled(rows) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    rows = await db.select().from(notificationLog);
  }
}

async function post(path: string, cookie: string, fields: Record<string, string> = {}) {
  return SELF.fetch(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, cookie },
    body: new URLSearchParams(fields),
    redirect: "manual",
  });
}

/** A game owned by the signed-in player, plus one ordinary member. */
async function ownedGame() {
  const { cookie } = await signIn();
  const db = testDb();
  const [viewer] = await db.select().from(players).where(eq(players.email, ALLOWED));
  const gameId = await insertGame(db, { name: "Thursday 7-a-side" });
  await insertMembership(db, gameId, viewer!.id, { role: "owner" });
  const memberId = await insertPlayer(db, { name: "Sam Okafor", email: "sam@example.com" });
  await insertMembership(db, gameId, memberId);
  return { cookie, gameId, ownerId: viewer!.id, memberId, db };
}

describe("GET /g/:id/squad/:playerId/remove", () => {
  beforeEach(resetDatabase);

  it("shows the confirmation with the member's commitments", async () => {
    const { cookie, gameId, memberId, db } = await ownedGame();
    const fixtureId = await insertFixture(db, gameId, { lifecycle: "open", inCount: 1 });
    await insertResponse(db, fixtureId, memberId, { status: "in" });

    const response = await SELF.fetch(`${ORIGIN}/g/${gameId}/squad/${memberId}/remove`, { headers: { cookie } });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Sam Okafor");
    expect(html).toContain("1 upcoming fixture");
  });

  it("404s for a game the viewer does not own", async () => {
    const { cookie } = await signIn();
    const db = testDb();
    const gameId = await insertGame(db);
    const memberId = await insertPlayer(db);
    await insertMembership(db, gameId, memberId);

    // 404, not 403: a 403 confirms the game exists (TR-18).
    const response = await SELF.fetch(`${ORIGIN}/g/${gameId}/squad/${memberId}/remove`, { headers: { cookie } });
    expect(response.status).toBe(404);
  });

  it("404s for a player who is in another game's squad", async () => {
    const { cookie, gameId } = await ownedGame();
    const db = testDb();
    const stranger = await insertPlayer(db);
    await insertMembership(db, await insertGame(db), stranger);

    const response = await SELF.fetch(`${ORIGIN}/g/${gameId}/squad/${stranger}/remove`, { headers: { cookie } });
    expect(response.status).toBe(404);
  });

  it("redirects an anonymous visitor to sign in", async () => {
    const db = testDb();
    const gameId = await insertGame(db);
    const response = await SELF.fetch(`${ORIGIN}/g/${gameId}/squad/${crypto.randomUUID()}/remove`, {
      redirect: "manual",
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/sign-in");
  });
});

describe("POST /g/:id/squad/:playerId/remove", () => {
  beforeEach(resetDatabase);

  it("removes the member, frees their place and redirects", async () => {
    const { cookie, gameId, memberId, db } = await ownedGame();
    const fixtureId = await insertFixture(db, gameId, { lifecycle: "open", inCount: 1 });
    await insertResponse(db, fixtureId, memberId, { status: "in" });

    const response = await post(`/g/${gameId}/squad/${memberId}/remove`, cookie);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`/g/${gameId}`);

    const [membership] = await db.select().from(memberships).where(eq(memberships.playerId, memberId));
    expect(membership!.active).toBe(false);
    const [row] = await db.select().from(responses).where(eq(responses.playerId, memberId));
    expect(row!.status).toBe("withdrawn");
    await settleNotifications(1);
  });

  it("redirects a self-removing owner to the dashboard, not to a page they can no longer see", async () => {
    const { cookie, gameId, ownerId, db } = await ownedGame();
    await insertMembership(db, gameId, await insertPlayer(db), { role: "owner" });

    const response = await post(`/g/${gameId}/squad/${ownerId}/remove`, cookie);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/app");
    await settleNotifications(1);
  });

  it("refuses to remove the last organiser, with the reason on the page", async () => {
    const { cookie, gameId, ownerId, db } = await ownedGame();

    const response = await post(`/g/${gameId}/squad/${ownerId}/remove`, cookie);
    expect(response.status).toBe(422);
    expect((await response.text()).toLowerCase()).toContain("at least one organiser");
    const [membership] = await db.select().from(memberships).where(eq(memberships.playerId, ownerId));
    expect(membership!.active).toBe(true);
  });

  it("rejects a cross-site post", async () => {
    const { cookie, gameId, memberId } = await ownedGame();
    const response = await SELF.fetch(`${ORIGIN}/g/${gameId}/squad/${memberId}/remove`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example", cookie },
      body: new URLSearchParams(),
      redirect: "manual",
    });
    expect(response.status).toBe(403);
  });

  it("404s for a member of another game", async () => {
    const { cookie, gameId } = await ownedGame();
    const db = testDb();
    const stranger = await insertPlayer(db);
    await insertMembership(db, await insertGame(db), stranger);

    expect((await post(`/g/${gameId}/squad/${stranger}/remove`, cookie)).status).toBe(404);
  });

  it("demotes an organiser on the way out, so a rejoin cannot restore ownership", async () => {
    const { cookie, gameId, db } = await ownedGame();
    const coOrganiser = await insertPlayer(db, { name: "Ada Byron", email: "ada@example.com" });
    await insertMembership(db, gameId, coOrganiser, { role: "owner" });

    expect((await post(`/g/${gameId}/squad/${coOrganiser}/remove`, cookie)).status).toBe(303);

    const [membership] = await db.select().from(memberships).where(eq(memberships.playerId, coOrganiser));
    expect(membership!.active).toBe(false);
    // The half `active: false` alone did not do. A row left reading `owner`
    // is what `/j/:token`'s reactivation path would hand straight back.
    expect(membership!.role).toBe("player");
    await settleNotifications(1);
  });

  /**
   * The email leg, end to end through the route.
   *
   * Both sends live in `waitUntil` callbacks, so nothing about them is
   * observable from the response — the only durable evidence is
   * `notification_log`, and until this test existed no assertion touched it:
   * deleting either `waitUntil` from `src/routes/games.ts` left the suite
   * green. The waitlisted player is what makes the promotion leg run at all;
   * with an empty waiting list `result.promotions` is `[]` and the N-2 loop
   * is dead code.
   */
  it("sends N-7 to the removed player and N-2 to whoever it promoted", async () => {
    const { cookie, gameId, memberId, db } = await ownedGame();
    const waiter = await insertPlayer(db, { name: "Ada Byron", email: "ada@example.com" });
    await insertMembership(db, gameId, waiter);
    // `maxPlayers: 1` with one `in` and one `waitlisted`: removing the member
    // frees the only place, so the waiting list is drawn on (BR-7).
    const fixtureId = await insertFixture(db, gameId, {
      lifecycle: "open",
      maxPlayers: 1,
      inCount: 1,
      waitlistCount: 1,
    });
    await insertResponse(db, fixtureId, memberId, { status: "in" });
    await insertResponse(db, fixtureId, waiter, { status: "waitlisted", waitlistPosition: 1 });

    expect((await post(`/g/${gameId}/squad/${memberId}/remove`, cookie)).status).toBe(303);

    // Two rows expected, so drain until both have settled before asserting —
    // otherwise a slow send reads as a missing one.
    await settleNotifications(2);
    const log = await db.select().from(notificationLog);

    const n7 = log.filter((row) => row.notificationType === "n7");
    expect(n7).toHaveLength(1);
    expect(n7[0]!.playerId).toBe(memberId);
    expect(n7[0]!.status).toBe("sent");

    const n2 = log.filter((row) => row.notificationType === "n2");
    expect(n2).toHaveLength(1);
    expect(n2[0]!.playerId).toBe(waiter);
    expect(n2[0]!.status).toBe("sent");
  });

  it("finishes a removal that failed partway through, on a re-submitted POST", async () => {
    const { cookie, gameId, memberId, db } = await ownedGame();
    const fixtureId = await insertFixture(db, gameId, { lifecycle: "open", inCount: 1 });
    await insertResponse(db, fixtureId, memberId, { status: "in" });
    // The state a removal leaves when the per-fixture loop throws after the
    // membership batch has landed: membership out, response row untouched.
    // Written directly because there is no way to make the Durable Object
    // fail from here, and it is the *state* the retry has to cope with.
    const leftAt = new Date("2026-08-13T12:00:00Z");
    await db
      .update(memberships)
      .set({ active: false, leftAt, role: "player" })
      .where(eq(memberships.playerId, memberId));

    // The retry the design promises. A 404 here — which is what
    // `loadSquadTarget` used to answer — would mean recovery needed a hand
    // edit of D1.
    const response = await post(`/g/${gameId}/squad/${memberId}/remove`, cookie);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`/g/${gameId}`);

    const [row] = await db.select().from(responses).where(eq(responses.playerId, memberId));
    expect(row!.status).toBe("withdrawn");
    // No second `membership.removed` row: the batch is skipped on a resume,
    // and a second audit row would assert a removal that never happened.
    expect(await db.select().from(auditLog).where(eq(auditLog.action, "membership.removed"))).toHaveLength(0);
    await settleNotifications(1);
  });

  /**
   * The claim the resume path rests on, checked rather than assumed: N-7's
   * dedupe key is `n7:<membershipId>:<leftAt>`, and a resume reuses the
   * original `leftAt` (`memberships.left_at` is `timestamp_ms`, so the
   * round-trip is exact to the millisecond and the key is byte-identical). The
   * second send therefore hits `notification_log`'s unique index, returns
   * `already-logged`, and never reaches a provider. If it did not, a retry
   * would email someone their removal twice.
   */
  it("does not email the removed player twice when the removal is re-submitted", async () => {
    const { cookie, gameId, memberId, db } = await ownedGame();

    expect((await post(`/g/${gameId}/squad/${memberId}/remove`, cookie)).status).toBe(303);
    await settleNotifications(1);
    // The browser reload of a POST that appeared to fail.
    expect((await post(`/g/${gameId}/squad/${memberId}/remove`, cookie)).status).toBe(303);
    await settleNotifications(1);

    const n7 = (await db.select().from(notificationLog)).filter((row) => row.notificationType === "n7");
    expect(n7).toHaveLength(1);
  });

  it("still 404s the confirmation page for an already-removed member", async () => {
    const { cookie, gameId, memberId, db } = await ownedGame();
    await db.update(memberships).set({ active: false }).where(eq(memberships.playerId, memberId));

    // Only the POST is resumable. There is nothing useful to confirm about a
    // membership that is already over.
    const response = await SELF.fetch(`${ORIGIN}/g/${gameId}/squad/${memberId}/remove`, { headers: { cookie } });
    expect(response.status).toBe(404);
  });
});

describe("POST /g/:id/squad/:playerId/role", () => {
  beforeEach(resetDatabase);

  it("promotes a player to organiser", async () => {
    const { cookie, gameId, memberId, db } = await ownedGame();

    const response = await post(`/g/${gameId}/squad/${memberId}/role`, cookie, { role: "owner" });
    expect(response.status).toBe(303);
    const [membership] = await db.select().from(memberships).where(eq(memberships.playerId, memberId));
    expect(membership!.role).toBe("owner");
    const [audit] = await db.select().from(auditLog).where(eq(auditLog.action, "membership.role_changed"));
    expect(audit).toBeDefined();
  });

  it("refuses to demote the last organiser", async () => {
    const { cookie, gameId, ownerId, db } = await ownedGame();

    const response = await post(`/g/${gameId}/squad/${ownerId}/role`, cookie, { role: "player" });
    expect(response.status).toBe(422);
    const [membership] = await db.select().from(memberships).where(eq(memberships.playerId, ownerId));
    expect(membership!.role).toBe("owner");
  });

  it("400s on a role it did not offer", async () => {
    const { cookie, gameId, memberId } = await ownedGame();
    expect((await post(`/g/${gameId}/squad/${memberId}/role`, cookie, { role: "admin" })).status).toBe(400);
  });

  // Spec §8 requires the 404-not-403 pair on all three squad routes. This one
  // shares `loadSquadTarget` and `wrongOrigin` with the remove route, so it is
  // correct today by construction — these pin it, so a future change that
  // gives this route its own loading or its own origin check cannot quietly
  // drop either guarantee.
  it("404s for a game the viewer does not own", async () => {
    const { cookie } = await signIn();
    const db = testDb();
    const gameId = await insertGame(db);
    const memberId = await insertPlayer(db);
    await insertMembership(db, gameId, memberId);

    // 404, not 403: a 403 confirms the game exists (TR-18).
    expect((await post(`/g/${gameId}/squad/${memberId}/role`, cookie, { role: "owner" })).status).toBe(404);
  });

  it("404s for a player who is in another game's squad", async () => {
    const { cookie, gameId } = await ownedGame();
    const db = testDb();
    const stranger = await insertPlayer(db);
    await insertMembership(db, await insertGame(db), stranger);

    expect((await post(`/g/${gameId}/squad/${stranger}/role`, cookie, { role: "owner" })).status).toBe(404);
  });

  it("rejects a cross-site post", async () => {
    const { cookie, gameId, memberId } = await ownedGame();
    const response = await SELF.fetch(`${ORIGIN}/g/${gameId}/squad/${memberId}/role`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example", cookie },
      body: new URLSearchParams({ role: "owner" }),
      redirect: "manual",
    });
    expect(response.status).toBe(403);
  });
});

describe("GET /g/:id/squad/:playerId", () => {
  beforeEach(resetDatabase);

  it("shows the member's name, email, role and joined date", async () => {
    const { cookie, gameId, memberId } = await ownedGame();

    const response = await SELF.fetch(`${ORIGIN}/g/${gameId}/squad/${memberId}`, {
      headers: { cookie },
    });

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("Sam Okafor");
    expect(body).toContain("sam@example.com");
  });

  it("reads the email and the role out with captions, not inside the empty-state box", async () => {
    const { cookie, gameId, memberId } = await ownedGame();

    const body = await (
      await SELF.fetch(`${ORIGIN}/g/${gameId}/squad/${memberId}`, { headers: { cookie } })
    ).text();

    expect(body).toContain(`<p class="readout-label">Email</p>`);
    expect(body).toContain(`<p class="readout-label">In this squad</p>`);
    // The dashed box means "nothing here to act on". Both of these are values
    // the page is reading out, so neither may wear it.
    expect(body).not.toMatch(/<p class="read-only">[^<]*@/);
    expect(body).not.toMatch(/<p class="read-only">Player, since/);
    // Still text and never a field: an organiser has no business editing
    // somebody else's address, and this route has no POST to take it.
    expect(body).not.toContain(`name="email"`);
    expect(body).toContain("sam@example.com");
  });

  it("puts both facts under exactly one heading", async () => {
    const { cookie, gameId, memberId } = await ownedGame();

    const body = await (
      await SELF.fetch(`${ORIGIN}/g/${gameId}/squad/${memberId}`, { headers: { cookie } })
    ).text();

    // Counted, not merely present. One heading is the answer; two one-line
    // headings — the stack of dividers the captions replaced — and none at
    // all, which leaves a screen-reader user nothing below the <h1> to
    // navigate by, are both failures, and only a count tells all three apart.
    const headings = [...body.matchAll(/<h2>([^<]*)<\/h2>/g)].map((match) => match[1]);
    expect(headings).toEqual(["What we have for them"]);
  });

  it("keeps the dashed box for a member who has no email at all", async () => {
    // The absence, not a value — nothing here for the organiser to act on,
    // which is exactly what the box says. Paired with the test above, so
    // stripping .read-only from the page wholesale fails here.
    const { cookie, gameId, db } = await ownedGame();
    const guestId = await insertPlayer(db, { name: "Jo Guest", email: null, isGuest: true });
    await insertMembership(db, gameId, guestId);

    const body = await (
      await SELF.fetch(`${ORIGIN}/g/${gameId}/squad/${guestId}`, { headers: { cookie } })
    ).text();

    expect(body).toContain(`<p class="read-only">No email address —`);
  });

  it("shows no fixture history, not even from this game", async () => {
    const { cookie, gameId, memberId, db } = await ownedGame();
    const fixtureId = await insertFixture(db, gameId, { lifecycle: "played" });
    await insertResponse(db, fixtureId, memberId, { status: "in" });

    const body = await (
      await SELF.fetch(`${ORIGIN}/g/${gameId}/squad/${memberId}`, { headers: { cookie } })
    ).text();

    // The class the account page's history uses. Its absence is the property
    // most likely to be broken by a later refactor that "shares" the two views.
    expect(body).not.toContain("fixture-card");
  });

  it("is linked from the game overview's per-member disclosure", async () => {
    const { cookie, gameId, memberId } = await ownedGame();

    const body = await (await SELF.fetch(`${ORIGIN}/g/${gameId}`, { headers: { cookie } })).text();
    expect(body).toContain(`href="/g/${gameId}/squad/${memberId}"`);
  });

  it("404s for a signed-in player who merely belongs to the game", async () => {
    const { cookie } = await signIn();
    const db = testDb();
    const [viewer] = await db.select().from(players).where(eq(players.email, ALLOWED));
    const gameId = await insertGame(db, { name: "Thursday 7-a-side" });
    // The viewer is an ordinary member, not an organiser.
    await insertMembership(db, gameId, viewer!.id, { role: "player" });
    const owner = await insertPlayer(db, { name: "Sam Okafor", email: "sam@example.com" });
    await insertMembership(db, gameId, owner, { role: "owner" });

    const response = await SELF.fetch(`${ORIGIN}/g/${gameId}/squad/${owner}`, {
      headers: { cookie },
    });
    expect(response.status).toBe(404);
  });

  it("404s for an organiser of a different game", async () => {
    const { cookie } = await ownedGame();
    const db = testDb();
    const otherGameId = await insertGame(db, { name: "Somebody else's game" });
    const stranger = await insertPlayer(db, { name: "Priya Raman", email: "priya@example.com" });
    await insertMembership(db, otherGameId, stranger);

    const response = await SELF.fetch(`${ORIGIN}/g/${otherGameId}/squad/${stranger}`, {
      headers: { cookie },
    });
    expect(response.status).toBe(404);
  });

  it("404s for a player who is not in this squad", async () => {
    const { cookie, gameId } = await ownedGame();
    const db = testDb();
    const stranger = await insertPlayer(db, { name: "Priya Raman", email: "priya@example.com" });

    const response = await SELF.fetch(`${ORIGIN}/g/${gameId}/squad/${stranger}`, {
      headers: { cookie },
    });
    expect(response.status).toBe(404);
  });
});

describe("the game page's squad controls", () => {
  beforeEach(resetDatabase);

  it("renders a remove link and a role form for each member", async () => {
    const { cookie, gameId, memberId } = await ownedGame();
    const html = await (await SELF.fetch(`${ORIGIN}/g/${gameId}`, { headers: { cookie } })).text();
    expect(html).toContain(`/g/${gameId}/squad/${memberId}/remove`);
    expect(html).toContain(`/g/${gameId}/squad/${memberId}/role`);
  });
});

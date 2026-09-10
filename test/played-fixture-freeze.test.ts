import { SELF, env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { fixtures, players, responses } from "../src/db/schema.js";
import { and, ne } from "drizzle-orm";
import { signResponseToken } from "../src/domain/token.js";
import {
  insertFixture,
  insertGame,
  insertMembership,
  insertPlayer,
  insertResponse,
  insertResultClaim,
  resetDatabase,
  testDb,
} from "./support/factories.js";
import { kickoffIn } from "./support/clock.js";
import { ALLOWED, ORIGIN, signIn } from "./support/sign-in.js";

/**
 * The freeze M25 §12 rests on, as amended by M64: once a fixture's **result
 * has locked**, nothing may change who was in it or which side they were on.
 *
 * `announcementOutstanding` is a pure predicate over exactly these four
 * columns, which is why the results milestone stores no `teams_were_accurate`
 * flag — the answer is computable forever. That is only true while this test
 * passes. If it fails, a result's teams-accuracy figure is a lie about a
 * fixture whose rosters moved after the fact, and the design needs the column
 * back.
 *
 * Until the result locks, M64 lets the organiser — and only the organiser —
 * correct the record: the drop-out replaced by a guest at the venue, the
 * sides re-balanced on the pitch. The second half of this file enumerates
 * that window: every owner path accepts, every player path still refuses
 * (BR-15), and publishing stays refused because it would email a squad about
 * a game that is over.
 */
const KICKOFF = new Date("2026-08-13T18:00:00Z");

describe("a played fixture whose result has locked is frozen", () => {
  let gameId: string;
  let fixtureId: string;
  let ownerId: string;
  let playerId: string;
  let cookie: string;

  beforeEach(async () => {
    await resetDatabase();
    const db = testDb();

    // `signIn` only ever authenticates the address the test bindings
    // allowlist (`ALLOWED`, from `test/support/sign-in.ts`); a session for any
    // other address cannot exist in this suite. Signing in first is what
    // creates that player's row, exactly as `test/routes/team-publish.test.ts`
    // does via its `ownerSession` helper.
    ({ cookie } = await signIn());
    const [owner] = await db.select().from(players).where(eq(players.email, ALLOWED));
    ownerId = owner!.id;

    playerId = await insertPlayer(db, { email: "player@example.com" });
    gameId = await insertGame(db);
    await insertMembership(db, gameId, ownerId, { role: "owner" });
    await insertMembership(db, gameId, playerId);
    fixtureId = await insertFixture(db, gameId, {
      kicksOffAt: KICKOFF,
      lifecycle: "played",
      teamsSavedAt: KICKOFF,
      teamsPublishedAt: KICKOFF,
    });
    await insertResponse(db, fixtureId, playerId, { status: "in", team: "a" });
    // What locks it: a claim on file, and the deadline (full time plus the
    // default day) long past by the time this suite runs.
    await insertResultClaim(db, fixtureId, playerId, { filedAt: KICKOFF });
  });

  it("refuses an owner override of a response", async () => {
    const response = await SELF.fetch(
      `${ORIGIN}/g/${gameId}/f/${fixtureId}/response/${playerId}`,
      {
        method: "POST",
        headers: { cookie, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ intent: "out" }),
      },
    );
    expect(response.status).not.toBe(303);

    const [row] = await testDb().select().from(responses).where(eq(responses.fixtureId, fixtureId));
    expect(row?.status).toBe("in");
    expect(row?.team).toBe("a");
  });

  it("refuses a team save", async () => {
    const before = await testDb().select().from(fixtures).where(eq(fixtures.id, fixtureId));
    const response = await SELF.fetch(`${ORIGIN}/g/${gameId}/f/${fixtureId}/teams`, {
      method: "POST",
      headers: { cookie, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ [playerId]: "b" }),
    });
    expect(response.status).not.toBe(303);

    const [after] = await testDb().select().from(fixtures).where(eq(fixtures.id, fixtureId));
    expect(after?.teamsSavedAt?.getTime()).toBe(before[0]?.teamsSavedAt?.getTime());
    const [row] = await testDb().select().from(responses).where(eq(responses.fixtureId, fixtureId));
    expect(row?.team).toBe("a");
  });

  it("refuses a publish", async () => {
    const before = await testDb().select().from(fixtures).where(eq(fixtures.id, fixtureId));
    const response = await SELF.fetch(`${ORIGIN}/g/${gameId}/f/${fixtureId}/teams/publish`, {
      method: "POST",
      headers: { cookie, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({}),
    });
    expect(response.status).not.toBe(303);

    const [after] = await testDb().select().from(fixtures).where(eq(fixtures.id, fixtureId));
    expect(after?.teamsPublishedAt?.getTime()).toBe(before[0]?.teamsPublishedAt?.getTime());
  });

  it("refuses adding a guest", async () => {
    const response = await SELF.fetch(`${ORIGIN}/g/${gameId}/f/${fixtureId}/guest`, {
      method: "POST",
      headers: { cookie, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ name: "Sam Whitlock" }),
    });
    expect(response.status).not.toBe(303);

    const rows = await testDb().select().from(responses).where(eq(responses.fixtureId, fixtureId));
    expect(rows).toHaveLength(1);
  });

  it("refuses removing a guest", async () => {
    const db = testDb();
    const guestId = await insertPlayer(db, { email: null, isGuest: true, name: "Sam Whitlock" });
    await insertResponse(db, fixtureId, guestId, { status: "in", team: "b" });

    const response = await SELF.fetch(`${ORIGIN}/g/${gameId}/f/${fixtureId}/guest/${guestId}/remove`, {
      method: "POST",
      headers: { cookie, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({}),
    });
    expect(response.status).not.toBe(303);

    const [row] = await db.select().from(responses).where(and(eq(responses.fixtureId, fixtureId), eq(responses.playerId, guestId)));
    expect(row?.status).toBe("in");
  });

  it("refuses a response through the token route", async () => {
    // Expiry is checked against the real wall clock (`src/routes/respond.ts`),
    // not against this fixture's stored (fixed, and by now historical)
    // `kicksOffAt` — a token built from `KICKOFF` would already read as
    // expired and never reach the lifecycle check at all. `kickoffIn` keeps
    // the signed expiry live relative to whenever the suite actually runs;
    // see its doc comment in test/support/clock.ts for why a fixed date here
    // is a "ticking bomb".
    const token = await signResponseToken(
      { playerId, fixtureId, expiresAt: kickoffIn(9).getTime() + 86_400_000 },
      env.RESPONSE_TOKEN_SECRET,
    );

    const response = await SELF.fetch(`${ORIGIN}/r/${token}`, {
      method: "POST",
      body: new URLSearchParams({ intent: "out" }),
    });

    // A bare 200 is also what the generic expired/malformed-token page
    // returns, so it cannot tell a lifecycle refusal from the token simply
    // being rejected before ever reaching that check. This wording
    // (`src/views/fixture.ts`) is produced only by the played/cancelled
    // branch, so it is what actually proves this request got there.
    expect(response.status).toBe(200);
    expect(await response.text()).toMatch(/already been played/i);

    const [row] = await testDb().select().from(responses).where(eq(responses.fixtureId, fixtureId));
    expect(row?.status).toBe("in");
    expect(row?.team).toBe("a");
  });
});

/**
 * M64's window. Same seed as above with no claim on file, so the result is
 * still writable — and with it, the record.
 */
describe("a played fixture can be corrected until the result locks", () => {
  let gameId: string;
  let fixtureId: string;
  let ownerId: string;
  let playerId: string;
  let cookie: string;

  const post = (path: string, body: Record<string, string>) =>
    SELF.fetch(`${ORIGIN}${path}`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body),
    });

  beforeEach(async () => {
    await resetDatabase();
    const db = testDb();
    ({ cookie } = await signIn());
    const [owner] = await db.select().from(players).where(eq(players.email, ALLOWED));
    ownerId = owner!.id;
    playerId = await insertPlayer(db, { email: "player@example.com" });
    gameId = await insertGame(db);
    await insertMembership(db, gameId, ownerId, { role: "owner" });
    await insertMembership(db, gameId, playerId);
    fixtureId = await insertFixture(db, gameId, {
      kicksOffAt: KICKOFF,
      lifecycle: "played",
      teamsSavedAt: KICKOFF,
      teamsPublishedAt: KICKOFF,
      inCount: 1,
    });
    await insertResponse(db, fixtureId, playerId, { status: "in", team: "a" });
  });

  it("accepts an owner override of a response", async () => {
    const response = await post(`/g/${gameId}/f/${fixtureId}/response/${playerId}`, { intent: "out" });
    expect(response.status).toBe(303);

    const [row] = await testDb().select().from(responses).where(eq(responses.fixtureId, fixtureId));
    expect(row?.status).toBe("out");
  });

  it("accepts a team save from the owner", async () => {
    const before = await testDb().select().from(fixtures).where(eq(fixtures.id, fixtureId));
    const response = await post(`/g/${gameId}/f/${fixtureId}/teams`, { [playerId]: "b" });
    expect(response.status).toBe(303);

    const [after] = await testDb().select().from(fixtures).where(eq(fixtures.id, fixtureId));
    expect(after?.teamsSavedAt?.getTime()).toBeGreaterThan(before[0]!.teamsSavedAt!.getTime());
    const [row] = await testDb().select().from(responses).where(eq(responses.fixtureId, fixtureId));
    expect(row?.team).toBe("b");
  });

  it("accepts adding a guest", async () => {
    const response = await post(`/g/${gameId}/f/${fixtureId}/guest`, { name: "Sam Whitlock" });
    expect(response.status).toBe(303);

    const rows = await testDb().select().from(responses).where(eq(responses.fixtureId, fixtureId));
    expect(rows).toHaveLength(2);
  });

  it("accepts removing a guest", async () => {
    const db = testDb();
    const guestId = await insertPlayer(db, { email: null, isGuest: true, name: "Sam Whitlock" });
    await insertResponse(db, fixtureId, guestId, { status: "in", team: "b" });

    const response = await post(`/g/${gameId}/f/${fixtureId}/guest/${guestId}/remove`, {});
    expect(response.status).toBe(303);

    const rows = await db.select().from(responses).where(and(eq(responses.fixtureId, fixtureId), ne(responses.status, "withdrawn")));
    expect(rows.map((r) => r.playerId)).toEqual([playerId]);
  });

  it("shows the organiser the controls and says how long they have", async () => {
    const response = await SELF.fetch(`${ORIGIN}/g/${gameId}/f/${fixtureId}`, { headers: { cookie } });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('name="intent" value="out"');
    expect(html).toContain("until someone records a result");
  });

  it("still refuses a publish", async () => {
    const response = await post(`/g/${gameId}/f/${fixtureId}/teams/publish`, {});
    expect(response.status).not.toBe(303);

    const [after] = await testDb().select().from(fixtures).where(eq(fixtures.id, fixtureId));
    expect(after?.teamsPublishedAt?.getTime()).toBe(KICKOFF.getTime());
  });

  it("still refuses a player's own answer through the game page", async () => {
    // The player, not the owner: the allowlisted session is the owner's, so
    // this signs the player's membership in as the owner's *own* row by
    // making the owner a plain member of a second game — simpler to make the
    // owner answer for themselves on this fixture.
    const db = testDb();
    await insertResponse(db, fixtureId, ownerId, { status: "in", team: "b" });
    const response = await post(`/g/${gameId}/f/${fixtureId}/answer`, { intent: "out" });
    expect(response.status).not.toBe(303);

    const [row] = await db.select().from(responses).where(and(eq(responses.fixtureId, fixtureId), eq(responses.playerId, ownerId)));
    expect(row?.status).toBe("in");
  });

  it("still refuses a response through the token route", async () => {
    const token = await signResponseToken(
      { playerId, fixtureId, expiresAt: kickoffIn(9).getTime() + 86_400_000 },
      env.RESPONSE_TOKEN_SECRET,
    );
    const response = await SELF.fetch(`${ORIGIN}/r/${token}`, { method: "POST", body: new URLSearchParams({ intent: "out" }) });
    expect(response.status).toBe(200);

    const [row] = await testDb().select().from(responses).where(eq(responses.fixtureId, fixtureId));
    expect(row?.status).toBe("in");
  });
});

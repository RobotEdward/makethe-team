import { SELF, env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { fixtures, players, responses } from "../src/db/schema.js";
import { signResponseToken } from "../src/domain/token.js";
import {
  insertFixture,
  insertGame,
  insertMembership,
  insertPlayer,
  insertResponse,
  resetDatabase,
  testDb,
} from "./support/factories.js";
import { kickoffIn } from "./support/clock.js";
import { ALLOWED, ORIGIN, signIn } from "./support/sign-in.js";

/**
 * The freeze M25 §12 rests on: once a fixture is `played`, nothing may change
 * who was in it or which side they were on.
 *
 * `announcementOutstanding` is a pure predicate over exactly these four
 * columns, which is why the results milestone stores no `teams_were_accurate`
 * flag — the answer is computable forever. That is only true while this test
 * passes. If it fails, a result's teams-accuracy figure is a lie about a
 * fixture whose rosters moved after the fact, and the design needs the column
 * back.
 */
const KICKOFF = new Date("2026-08-13T18:00:00Z");

describe("a played fixture is frozen", () => {
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
      body: new URLSearchParams({ [`team:${playerId}`]: "b" }),
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

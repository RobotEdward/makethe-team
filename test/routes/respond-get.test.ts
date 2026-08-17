import { SELF, env } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../src/db/client.js";
import { fixtures, memberships, players, responses } from "../../src/db/schema.js";
import { openFixture } from "../../src/domain/open-fixture.js";
import { signResponseToken } from "../../src/domain/token.js";
import { SERVICE_WORKER_JS } from "../../src/views/scripts.js";
import { insertGame, resetDatabase } from "../support/factories.js";
import { kickoffIn, NOW } from "../support/clock.js";

const db = getDb(env.DB);
const SECRET = env.RESPONSE_TOKEN_SECRET;
// Relative to the real clock, not pinned to a date — the route verifies its
// token against the real wall clock, so a fixed kickoff eventually falls into
// the past and every token here reads as expired. See test/support/clock.ts.
const KICKOFF = kickoffIn(9);

interface SeedResult {
  gameId: string;
  fixtureId: string;
  playerId: string;
  /** A token for `playerId`, at the default expiry `tokenFor` would give it. */
  token: string;
}

/**
 * A second, distinct squad member ("Player 1"), always seeded alongside the
 * viewer so the squad-visibility tests below have someone else's name to
 * assert on or off the page.
 */
async function seedRespondableFixture(
  overrides: {
    lifecycle?: "open" | "played" | "cancelled";
    squadVisibleToPlayers?: boolean;
    /** The viewer's own membership of the game. Defaults to an active player. */
    viewerRole?: "player" | "owner";
    viewerActive?: boolean;
    /**
     * A team pick over this squad (BR-35): the viewer on "Reds", Player 1 on
     * "Blues", both `in`.
     *
     * `"saved"` writes the assignments and nothing else — the state an
     * organiser is in while they are still trying an arrangement out.
     * `"published"` additionally stamps `teams_published_at`, which is the
     * only thing that may make any of it visible to a player.
     */
    teams?: "saved" | "published";
  } = {},
): Promise<SeedResult> {
  const gameId = await insertGame(db, {
    maxPlayers: 14,
    teamAName: "Reds",
    teamBName: "Blues",
    ...(overrides.squadVisibleToPlayers === undefined ? {} : { squadVisibleToPlayers: overrides.squadVisibleToPlayers }),
  });
  const fixtureId = crypto.randomUUID();
  await db.insert(fixtures).values({
    id: fixtureId,
    gameId,
    kicksOffAt: KICKOFF,
    minPlayers: 10,
    maxPlayers: 14,
    prefersEvenNumbers: true,
    shortWarningOffsetHours: 12,
    durationMinutes: 60,
  });

  const playerId = crypto.randomUUID();
  await db.insert(players).values({ id: playerId, name: "Edward Cooper", email: "edward@example.com" });
  await db.insert(memberships).values({
    id: crypto.randomUUID(),
    gameId,
    playerId,
    active: true,
    role: overrides.viewerRole ?? "player",
  });

  const otherPlayerId = crypto.randomUUID();
  await db.insert(players).values({ id: otherPlayerId, name: "Player 1", email: "player1@example.com" });
  await db.insert(memberships).values({ id: crypto.randomUUID(), gameId, playerId: otherPlayerId, active: true });

  await openFixture(db, fixtureId, NOW);
  // openFixture already wrote a `pending` row for every active member,
  // including the one above — flip it to `in` rather than inserting a
  // second row, which would collide with the (fixture_id, player_id)
  // unique index.
  await db
    .update(responses)
    .set({ status: "in", respondedAt: NOW })
    .where(and(eq(responses.fixtureId, fixtureId), eq(responses.playerId, otherPlayerId)));

  if (overrides.teams) {
    await db
      .update(responses)
      .set({ status: "in", respondedAt: NOW, team: "a" })
      .where(and(eq(responses.fixtureId, fixtureId), eq(responses.playerId, playerId)));
    await db
      .update(responses)
      .set({ team: "b" })
      .where(and(eq(responses.fixtureId, fixtureId), eq(responses.playerId, otherPlayerId)));
    if (overrides.teams === "published") {
      await db.update(fixtures).set({ teamsPublishedAt: NOW }).where(eq(fixtures.id, fixtureId));
    }
  }

  if (overrides.viewerActive === false) {
    // Deactivated *after* the fixture opened, which is the only way a removed
    // member still holds a working link: they had a response row when it was
    // minted.
    await db
      .update(memberships)
      .set({ active: false, leftAt: NOW })
      .where(and(eq(memberships.gameId, gameId), eq(memberships.playerId, playerId)));
  }

  if (overrides.lifecycle && overrides.lifecycle !== "open") {
    await db.update(fixtures).set({ lifecycle: overrides.lifecycle }).where(eq(fixtures.id, fixtureId));
  }

  const token = await tokenFor(fixtureId, playerId);
  return { gameId, fixtureId, playerId, token };
}

async function tokenFor(fixtureId: string, playerId: string, expiresAt = KICKOFF.getTime() + 86_400_000) {
  return signResponseToken({ playerId, fixtureId, expiresAt }, SECRET);
}

/**
 * Flips one bit in the first byte of a base64url-encoded signature and
 * re-encodes, producing a genuinely different, still-canonical value.
 *
 * Not done by toggling the string's last character: a 32-byte HMAC's final
 * base64url character carries unused low-order padding bits, so two
 * different characters there can decode to byte-identical bytes — a no-op
 * "tamper" that verifies as valid and made this exact test flake (review
 * round 2). token.ts's own decoder now rejects any non-canonical encoding
 * outright, so a naive toggle would in fact be caught too, but flipping the
 * first byte is the direct fix: it changes real signature bytes, not just
 * a discarded padding bit, so the result is unambiguously a different
 * signature every time.
 */
function tamperSignature(signature: string): string {
  const padded = signature.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (signature.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  bytes[0] = (bytes[0] ?? 0) ^ 0x01;
  let flippedBinary = "";
  for (const b of bytes) flippedBinary += String.fromCharCode(b);
  return btoa(flippedBinary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function snapshotResponses(fixtureId: string) {
  return db.select().from(responses).where(eq(responses.fixtureId, fixtureId));
}

async function snapshotCounts(fixtureId: string) {
  const [fixture] = await db.select().from(fixtures).where(eq(fixtures.id, fixtureId));
  return { inCount: fixture?.inCount ?? -1, waitlistCount: fixture?.waitlistCount ?? -1 };
}

beforeEach(async () => {
  await resetDatabase();
});

describe("GET /r/:token — rendering", () => {
  it("renders the fixture page with 200 for a valid token", async () => {
    const { fixtureId, playerId } = await seedRespondableFixture();
    const token = await tokenFor(fixtureId, playerId);

    const response = await SELF.fetch(`https://makethe.team/r/${token}`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(body).toContain("Thursday 7-a-side");
    expect(body).toContain("Oxford Sports Park");
    // Every page carries the site-wide service worker registration (M13
    // Task 5), so it is stripped before checking that nothing else needing
    // script has crept onto this one.
    expect(body).toContain(`<script>${SERVICE_WORKER_JS}</script>`);
    expect(body.replace(`<script>${SERVICE_WORKER_JS}</script>`, "")).not.toContain("<script");
  });

  /**
   * `/r/:token` is reached by a signed token, not a session, so it sits
   * outside `AUTHENTICATED_PREFIX` — but it renders full names and every
   * player's current answer, state that changes on every tap, so it carries
   * `private, no-store` via its own `/r/*` mount in `src/app.ts` rather than
   * inheriting the dashboard's. See `test/routes/cache-control.test.ts` for
   * the guard that derives this from the route table.
   */
  it("carries private, no-store", async () => {
    const { fixtureId, playerId } = await seedRespondableFixture();
    const token = await tokenFor(fixtureId, playerId);

    const response = await SELF.fetch(`https://makethe.team/r/${token}`);

    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("shows two response buttons for an open fixture", async () => {
    const { fixtureId, playerId } = await seedRespondableFixture();
    const token = await tokenFor(fixtureId, playerId);

    const body = await (await SELF.fetch(`https://makethe.team/r/${token}`)).text();

    expect(body).toContain(`method="post"`);
    expect(body).toContain(`action="/r/${token}"`);
    expect(body).toContain(`name="intent" value="in"`);
    expect(body).toContain(`name="intent" value="out"`);
  });

  it("does not emphasise either button from ?intent= alone — it never records anything and no longer drives appearance", async () => {
    const { fixtureId, playerId } = await seedRespondableFixture();
    const token = await tokenFor(fixtureId, playerId);

    // The seeded viewer is still `pending`, so neither button should carry a
    // `chosen-*` class regardless of what `?intent=` claims.
    const body = await (await SELF.fetch(`https://makethe.team/r/${token}?intent=in`)).text();

    expect(body).not.toContain(`class="button chosen-`);
  });

  it("neither button is emphasised for a pending viewer, with or without ?intent=", async () => {
    const { fixtureId, playerId } = await seedRespondableFixture();
    const token = await tokenFor(fixtureId, playerId);

    const bare = await (await SELF.fetch(`https://makethe.team/r/${token}`)).text();
    const junk = await (await SELF.fetch(`https://makethe.team/r/${token}?intent=maybe`)).text();

    for (const body of [bare, junk]) {
      expect(body).not.toContain(`class="button chosen-`);
    }
  });

  it("shows the recorded answer in the button itself, driven by status not ?intent=", async () => {
    const { fixtureId, playerId } = await seedRespondableFixture();
    const token = await tokenFor(fixtureId, playerId);

    await db
      .update(responses)
      .set({ status: "in", respondedAt: NOW })
      .where(and(eq(responses.fixtureId, fixtureId), eq(responses.playerId, playerId)));

    // A stale/mismatched ?intent=out must not override what was recorded.
    const body = await (await SELF.fetch(`https://makethe.team/r/${token}?intent=out`)).text();

    expect(body).toMatch(/class="button chosen-in"[^>]*name="intent" value="in"/);
    expect(body).not.toMatch(/class="button chosen-out"/);
  });
});

describe("GET /r/:token — the GET records nothing (TR-14/TR-15)", () => {
  it("leaves every response row byte-identical for a bare GET", async () => {
    const { fixtureId, playerId } = await seedRespondableFixture();
    const token = await tokenFor(fixtureId, playerId);

    const before = await snapshotResponses(fixtureId);
    const countsBefore = await snapshotCounts(fixtureId);

    const response = await SELF.fetch(`https://makethe.team/r/${token}`);
    expect(response.status).toBe(200);

    expect(await snapshotResponses(fixtureId)).toEqual(before);
    expect(await snapshotCounts(fixtureId)).toEqual(countsBefore);
  });

  it("leaves every response row byte-identical for ?intent=in", async () => {
    const { fixtureId, playerId } = await seedRespondableFixture();
    const token = await tokenFor(fixtureId, playerId);

    const before = await snapshotResponses(fixtureId);
    const countsBefore = await snapshotCounts(fixtureId);

    await SELF.fetch(`https://makethe.team/r/${token}?intent=in`);

    expect(await snapshotResponses(fixtureId)).toEqual(before);
    expect(await snapshotCounts(fixtureId)).toEqual(countsBefore);
  });

  it("leaves every response row byte-identical for ?intent=out", async () => {
    const { fixtureId, playerId } = await seedRespondableFixture();
    const token = await tokenFor(fixtureId, playerId);

    const before = await snapshotResponses(fixtureId);
    const countsBefore = await snapshotCounts(fixtureId);

    await SELF.fetch(`https://makethe.team/r/${token}?intent=out`);

    expect(await snapshotResponses(fixtureId)).toEqual(before);
    expect(await snapshotCounts(fixtureId)).toEqual(countsBefore);
  });

  it("does not change respondedAt for a player who already responded", async () => {
    const { fixtureId, playerId } = await seedRespondableFixture();
    await env.FIXTURE_CAPACITY.getByName(fixtureId).setResponse({
      playerId, intent: "in", actorPlayerId: null, source: "token", whenFull: "waitlist", now: NOW.getTime(),
    });
    const token = await tokenFor(fixtureId, playerId);

    const before = await snapshotResponses(fixtureId);
    expect(before[0]?.respondedAt).not.toBeNull();

    await SELF.fetch(`https://makethe.team/r/${token}?intent=out`);

    expect(await snapshotResponses(fixtureId)).toEqual(before);
  });
});

describe("GET /r/:token — token failures render one friendly page (TR-14)", () => {
  it("renders a friendly page, not a 500, for an expired token", async () => {
    const { fixtureId, playerId } = await seedRespondableFixture();
    // The route verifies against the real wall clock, not the fictional `NOW`
    // used elsewhere in this file for fixture timing — so "expired" must be
    // in the past relative to it. Deliberately an absolute instant, not
    // `Date.now() - 1000`: workerd freezes `Date.now()` between I/O, so the
    // Worker isolate's clock and this test isolate's clock drift
    // independently, and after this test's seeding I/O a one-second margin
    // is easily eaten — the "expired" token then verifies as still valid and
    // the assertion flakes. An instant years in the past leaves no margin to
    // eat.
    const expired = await tokenFor(fixtureId, playerId, new Date("2020-01-01T00:00:00Z").getTime());

    const response = await SELF.fetch(`https://makethe.team/r/${expired}`);

    expect(response.status).not.toBe(500);
    expect([200, 410]).toContain(response.status);
    const body = await response.text();
    expect(body).toMatch(/isn.t working|expired|fresh link/i);
  });

  it("gives byte-identical copy for expired, tampered, wrong-fixture and malformed tokens", async () => {
    const { fixtureId, playerId } = await seedRespondableFixture();

    // Absolute past instant, not `Date.now() - 1000` — see the comment on
    // the identical construction above for the isolate-clock-skew mechanism
    // a relative margin is vulnerable to.
    const expired = await tokenFor(fixtureId, playerId, new Date("2020-01-01T00:00:00Z").getTime());

    const valid = await tokenFor(fixtureId, playerId);
    const [validBody, validSig] = valid.split(".");
    const tampered = `${validBody}.${tamperSignature(validSig ?? "")}`;

    const wrongFixture = await tokenFor("some-other-fixture-id", playerId);

    const malformed = "not-a-real-token";

    const bodies = await Promise.all(
      [expired, tampered, wrongFixture, malformed].map(async (token) => {
        const response = await SELF.fetch(`https://makethe.team/r/${encodeURIComponent(token)}`);
        expect(response.status).not.toBe(500);
        return response.text();
      }),
    );

    for (const body of bodies) {
      expect(body).toBe(bodies[0]);
    }
  });

  it("never leaks whether the fixture exists — an otherwise-valid token for a deleted fixture renders the same page", async () => {
    const { fixtureId, playerId } = await seedRespondableFixture();
    const token = await tokenFor(fixtureId, playerId);
    // Remove the fixture's responses and the fixture itself so the token still
    // verifies but the fixture is gone.
    await db.delete(responses).where(eq(responses.fixtureId, fixtureId));
    await db.delete(fixtures).where(eq(fixtures.id, fixtureId));

    const notFoundBody = await (await SELF.fetch(`https://makethe.team/r/${token}`)).text();
    const malformedBody = await (await SELF.fetch(`https://makethe.team/r/not-a-real-token`)).text();

    expect(notFoundBody).toBe(malformedBody);
  });

  it("does not mutate anything for a bad-signature token", async () => {
    const { fixtureId, playerId } = await seedRespondableFixture();
    const token = await tokenFor(fixtureId, playerId);
    const tampered = `${token.split(".")[0]}.wrongsignature`;

    const before = await snapshotResponses(fixtureId);

    await SELF.fetch(`https://makethe.team/r/${encodeURIComponent(tampered)}`);

    expect(await snapshotResponses(fixtureId)).toEqual(before);
  });
});

describe("GET /r/:token — a finished fixture renders read-only (BR-24)", () => {
  it("renders no buttons and an explanation for a played fixture", async () => {
    const { fixtureId, playerId } = await seedRespondableFixture({ lifecycle: "played" });
    const token = await tokenFor(fixtureId, playerId);

    const response = await SELF.fetch(`https://makethe.team/r/${token}`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).not.toContain(`method="post"`);
    expect(body).not.toContain(`name="intent"`);
    expect(body).toMatch(/already been played/i);
  });

  it("renders no buttons and an explanation for a cancelled fixture", async () => {
    const { fixtureId, playerId } = await seedRespondableFixture({ lifecycle: "cancelled" });
    const token = await tokenFor(fixtureId, playerId);

    const response = await SELF.fetch(`https://makethe.team/r/${token}`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).not.toContain(`method="post"`);
    expect(body).not.toContain(`name="intent"`);
    expect(body).toMatch(/cancelled/i);
  });

  it("still verifies the token for a finished fixture — it is not treated as a failure", async () => {
    const { fixtureId, playerId } = await seedRespondableFixture({ lifecycle: "played" });
    const token = await tokenFor(fixtureId, playerId);

    const body = await (await SELF.fetch(`https://makethe.team/r/${token}`)).text();

    expect(body).not.toMatch(/isn.t working/i);
    expect(body).toContain("Thursday 7-a-side");
  });
});

describe("GET /r/:token — a valid token for a player no longer on the squad", () => {
  it("renders read-only with a neutral explanation, not the generic failure page", async () => {
    const { fixtureId, playerId } = await seedRespondableFixture();
    const token = await tokenFor(fixtureId, playerId);
    // Simulate the player having been removed from the squad after their
    // link was sent: the token still verifies, but their response row is
    // gone.
    await db.delete(responses).where(eq(responses.playerId, playerId));

    const response = await SELF.fetch(`https://makethe.team/r/${token}`);
    const body = await response.text();

    expect(response.status).toBe(200);
    // Not the shared token-failure page — the token is legitimate.
    expect(body).not.toMatch(/isn.t working/i);
    // Still the real fixture page.
    expect(body).toContain("Thursday 7-a-side");
    // Read-only: no buttons, no live question.
    expect(body).not.toContain(`method="post"`);
    expect(body).not.toContain(`name="intent"`);
    expect(body).not.toMatch(/can you make it\?/i);
    expect(body).toMatch(/no longer on the squad|not on the squad/i);
  });

  it("does not mutate anything", async () => {
    const { fixtureId, playerId } = await seedRespondableFixture();
    const token = await tokenFor(fixtureId, playerId);
    await db.delete(responses).where(eq(responses.playerId, playerId));

    const before = await snapshotResponses(fixtureId);
    const countsBefore = await snapshotCounts(fixtureId);

    await SELF.fetch(`https://makethe.team/r/${token}`);

    expect(await snapshotResponses(fixtureId)).toEqual(before);
    expect(await snapshotCounts(fixtureId)).toEqual(countsBefore);
  });
});

describe("GET /r/:token — squad visibility (BR-33)", () => {
  it("hides other players when the game says so", async () => {
    const { token } = await seedRespondableFixture({ squadVisibleToPlayers: false });

    const html = await (await SELF.fetch(`https://makethe.team/r/${token}`)).text();

    expect(html).not.toContain("Player 1");
    expect(html).toContain("in so far");
  });

  it("shows other players when the game says so", async () => {
    const { token } = await seedRespondableFixture({ squadVisibleToPlayers: true });

    const html = await (await SELF.fetch(`https://makethe.team/r/${token}`)).text();

    expect(html).toContain("Player 1");
  });

  it("hides other players from an ordinary member when the setting is off", async () => {
    const { token } = await seedRespondableFixture({
      squadVisibleToPlayers: false,
      viewerRole: "player",
    });

    const html = await (await SELF.fetch(`https://makethe.team/r/${token}`)).text();

    expect(html).not.toContain("Player 1");
    expect(html).toContain("in so far");
  });

  it("shows the squad to an organiser following their own reminder link, setting off", async () => {
    const { token } = await seedRespondableFixture({
      squadVisibleToPlayers: false,
      viewerRole: "owner",
    });

    const html = await (await SELF.fetch(`https://makethe.team/r/${token}`)).text();

    expect(html).toContain("Player 1");
  });

  it("gives a removed organiser no more than any other outsider", async () => {
    const { token } = await seedRespondableFixture({
      squadVisibleToPlayers: false,
      viewerRole: "owner",
      viewerActive: false,
    });

    const html = await (await SELF.fetch(`https://makethe.team/r/${token}`)).text();

    expect(html).not.toContain("Player 1");
  });
});

/**
 * The player's half of BR-35 §5, end to end through the route that reads the
 * fixture — the same rule `test/notify/send-teams.test.ts` asserts of the
 * N-9 email, because a player holding that email and looking at this page
 * must not be able to find a contradiction between them.
 */
describe("GET /r/:token — published teams (BR-35 §5)", () => {
  /**
   * The case most likely to be got wrong, and the one that matters most: an
   * organiser must be able to try an arrangement without announcing it. The
   * assignments exist in the database throughout this test.
   */
  it("shows nothing at all when a pick has been saved but not published", async () => {
    const { token } = await seedRespondableFixture({ teams: "saved", squadVisibleToPlayers: true });

    const html = await (await SELF.fetch(`https://makethe.team/r/${token}`)).text();

    expect(html).not.toContain("Reds");
    expect(html).not.toContain("Blues");
    expect(html).not.toContain("<h2>Teams</h2>");
  });

  it("tells a player their own side once the teams are published", async () => {
    const { token } = await seedRespondableFixture({ teams: "published", squadVisibleToPlayers: true });

    const html = await (await SELF.fetch(`https://makethe.team/r/${token}`)).text();

    expect(html).toContain("You're on Reds.");
  });

  it("shows both line-ups when the game shows players to each other", async () => {
    const { token } = await seedRespondableFixture({ teams: "published", squadVisibleToPlayers: true });

    const html = await (await SELF.fetch(`https://makethe.team/r/${token}`)).text();

    const teamsSection = html.slice(html.indexOf("<h2>Teams</h2>"), html.indexOf("<h2>Squad</h2>"));
    expect(teamsSection).toContain("Edward Cooper");
    expect(teamsSection).toContain("Player 1");
  });

  it("keeps a player's own side when the squad is hidden, without naming anyone else", async () => {
    const { token } = await seedRespondableFixture({ teams: "published", squadVisibleToPlayers: false });

    const html = await (await SELF.fetch(`https://makethe.team/r/${token}`)).text();

    expect(html).toContain("You're on Reds.");
    expect(html).not.toContain("Player 1");
  });

  /**
   * Definition of Done #5 — *every* player can see their own side — and the
   * one viewer for whom that used to be silently untrue: someone promoted off
   * the waitlist after the announcement is `in` with no side, so the page gave
   * them a Teams heading, both full line-ups, and not one word about
   * themselves.
   */
  it("tells a player whose side is not picked yet that it is not picked yet", async () => {
    const { fixtureId, playerId, token } = await seedRespondableFixture({
      teams: "published",
      squadVisibleToPlayers: true,
    });
    // What a promotion into a published fixture leaves behind: `in`, no side.
    await db
      .update(responses)
      .set({ team: null })
      .where(and(eq(responses.fixtureId, fixtureId), eq(responses.playerId, playerId)));

    const html = await (await SELF.fetch(`https://makethe.team/r/${token}`)).text();

    expect(html).toContain("Your side hasn't been picked yet.");
    // The rest of the pick is still theirs to read — this is a missing line,
    // not a reason to hide the teams.
    expect(html).toContain("<h3>Blues");
  });

  it("says nothing at all when the published squad has since emptied", async () => {
    // Both picked players drop out after publication and a third member opens
    // their link. "Reds 0 / Nobody. / Blues 0 / Nobody." under a Teams heading
    // is an assertion about a pick, made to somebody it says nothing about.
    const { fixtureId, token } = await seedRespondableFixture({
      teams: "published",
      squadVisibleToPlayers: true,
    });
    await db.update(responses).set({ status: "out" }).where(eq(responses.fixtureId, fixtureId));

    const html = await (await SELF.fetch(`https://makethe.team/r/${token}`)).text();

    expect(html).not.toContain("<h2>Teams</h2>");
    expect(html).not.toContain("Nobody.");
  });

  it("does not publish a pick by hiding the squad — nothing shows before publication either way", async () => {
    const { token } = await seedRespondableFixture({ teams: "saved", squadVisibleToPlayers: false });

    const html = await (await SELF.fetch(`https://makethe.team/r/${token}`)).text();

    expect(html).not.toContain("You're on");
    expect(html).not.toContain("Reds");
  });
});

describe("vocabulary and safety", () => {
  it("never uses forbidden vocabulary on the failure page", async () => {
    // Scoped to the page's own copy, not its script — the site-wide service
    // worker registration (M13 Task 5) legitimately says "event" and
    // "addEventListener", and every page carries it now. This test's job was
    // always the product's *prose*, never implementation vocabulary inside a
    // <script> tag; stripping script first (the same technique
    // test/routes/team-publish.test.ts uses to separate "no script" from "no
    // domain vocabulary") is what keeps that property honest rather than
    // accidentally depending on this page happening to carry no script.
    const response = await SELF.fetch("https://makethe.team/r/not-a-real-token");
    const body = (await response.text()).replace(/<script[\s\S]*?<\/script>/g, "").toLowerCase();
    for (const word of ["rsvp", "event", "match", "user"]) expect(body).not.toContain(word);
  });

  it("is not indexable", async () => {
    const { fixtureId, playerId } = await seedRespondableFixture();
    const token = await tokenFor(fixtureId, playerId);
    const response = await SELF.fetch(`https://makethe.team/r/${token}`);
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });
});

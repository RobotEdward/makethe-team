import { SELF, env } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../src/db/client.js";
import { fixtures, memberships, players, responses } from "../../src/db/schema.js";
import { openFixture } from "../../src/domain/open-fixture.js";
import { signResponseToken } from "../../src/domain/token.js";
import { insertGame, resetDatabase } from "../support/factories.js";

const db = getDb(env.DB);
const SECRET = env.RESPONSE_TOKEN_SECRET;
const NOW = new Date("2026-08-13T09:00:00Z");
const KICKOFF = new Date("2026-08-13T18:00:00Z");

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
  } = {},
): Promise<SeedResult> {
  const gameId = await insertGame(db, {
    maxPlayers: 14,
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
    expect(body).not.toContain("<script");
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

  it("emphasises the 'in' button for ?intent=in but does not record anything", async () => {
    const { fixtureId, playerId } = await seedRespondableFixture();
    const token = await tokenFor(fixtureId, playerId);

    const body = await (await SELF.fetch(`https://makethe.team/r/${token}?intent=in`)).text();

    expect(body).toMatch(/class="button primary"[^>]*name="intent" value="in"/);
    // The other button is not emphasised.
    expect(body).not.toMatch(/class="button primary"[^>]*name="intent" value="out"/);
  });

  it("emphasises the 'out' button for ?intent=out", async () => {
    const { fixtureId, playerId } = await seedRespondableFixture();
    const token = await tokenFor(fixtureId, playerId);

    const body = await (await SELF.fetch(`https://makethe.team/r/${token}?intent=out`)).text();

    expect(body).toMatch(/class="button primary"[^>]*name="intent" value="out"/);
    expect(body).not.toMatch(/class="button primary"[^>]*name="intent" value="in"/);
  });

  it("neither button is emphasised for an absent or unrecognised intent", async () => {
    const { fixtureId, playerId } = await seedRespondableFixture();
    const token = await tokenFor(fixtureId, playerId);

    const bare = await (await SELF.fetch(`https://makethe.team/r/${token}`)).text();
    const junk = await (await SELF.fetch(`https://makethe.team/r/${token}?intent=maybe`)).text();

    for (const body of [bare, junk]) {
      expect(body).not.toMatch(/class="button primary"/);
    }
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

describe("vocabulary and safety", () => {
  it("never uses forbidden vocabulary on the failure page", async () => {
    const response = await SELF.fetch("https://makethe.team/r/not-a-real-token");
    const body = (await response.text()).toLowerCase();
    for (const word of ["rsvp", "event", "match", "user"]) expect(body).not.toContain(word);
  });

  it("is not indexable", async () => {
    const { fixtureId, playerId } = await seedRespondableFixture();
    const token = await tokenFor(fixtureId, playerId);
    const response = await SELF.fetch(`https://makethe.team/r/${token}`);
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });
});

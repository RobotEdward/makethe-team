import { SELF, env } from "cloudflare:test";
import { eq } from "drizzle-orm";
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
}

async function seedOpenFixture(overrides: { lifecycle?: "open" | "played" | "cancelled" } = {}): Promise<SeedResult> {
  const gameId = await insertGame(db, { maxPlayers: 14 });
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
  await db.insert(memberships).values({ id: crypto.randomUUID(), gameId, playerId, active: true });

  await openFixture(db, fixtureId, NOW);

  if (overrides.lifecycle && overrides.lifecycle !== "open") {
    await db.update(fixtures).set({ lifecycle: overrides.lifecycle }).where(eq(fixtures.id, fixtureId));
  }

  return { gameId, fixtureId, playerId };
}

async function tokenFor(fixtureId: string, playerId: string, expiresAt = KICKOFF.getTime() + 86_400_000) {
  return signResponseToken({ playerId, fixtureId, expiresAt }, SECRET);
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
    const { fixtureId, playerId } = await seedOpenFixture();
    const token = await tokenFor(fixtureId, playerId);

    const response = await SELF.fetch(`https://makethe.team/r/${token}`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(body).toContain("Thursday 7-a-side");
    expect(body).toContain("Oxford Sports Park");
    expect(body).not.toContain("<script");
  });

  it("shows two response buttons for an open fixture", async () => {
    const { fixtureId, playerId } = await seedOpenFixture();
    const token = await tokenFor(fixtureId, playerId);

    const body = await (await SELF.fetch(`https://makethe.team/r/${token}`)).text();

    expect(body).toContain(`method="post"`);
    expect(body).toContain(`action="/r/${token}"`);
    expect(body).toContain(`name="intent" value="in"`);
    expect(body).toContain(`name="intent" value="out"`);
  });

  it("emphasises the 'in' button for ?intent=in but does not record anything", async () => {
    const { fixtureId, playerId } = await seedOpenFixture();
    const token = await tokenFor(fixtureId, playerId);

    const body = await (await SELF.fetch(`https://makethe.team/r/${token}?intent=in`)).text();

    expect(body).toMatch(/class="button primary"[^>]*name="intent" value="in"/);
    // The other button is not emphasised.
    expect(body).not.toMatch(/class="button primary"[^>]*name="intent" value="out"/);
  });

  it("emphasises the 'out' button for ?intent=out", async () => {
    const { fixtureId, playerId } = await seedOpenFixture();
    const token = await tokenFor(fixtureId, playerId);

    const body = await (await SELF.fetch(`https://makethe.team/r/${token}?intent=out`)).text();

    expect(body).toMatch(/class="button primary"[^>]*name="intent" value="out"/);
    expect(body).not.toMatch(/class="button primary"[^>]*name="intent" value="in"/);
  });

  it("neither button is emphasised for an absent or unrecognised intent", async () => {
    const { fixtureId, playerId } = await seedOpenFixture();
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
    const { fixtureId, playerId } = await seedOpenFixture();
    const token = await tokenFor(fixtureId, playerId);

    const before = await snapshotResponses(fixtureId);
    const countsBefore = await snapshotCounts(fixtureId);

    const response = await SELF.fetch(`https://makethe.team/r/${token}`);
    expect(response.status).toBe(200);

    expect(await snapshotResponses(fixtureId)).toEqual(before);
    expect(await snapshotCounts(fixtureId)).toEqual(countsBefore);
  });

  it("leaves every response row byte-identical for ?intent=in", async () => {
    const { fixtureId, playerId } = await seedOpenFixture();
    const token = await tokenFor(fixtureId, playerId);

    const before = await snapshotResponses(fixtureId);
    const countsBefore = await snapshotCounts(fixtureId);

    await SELF.fetch(`https://makethe.team/r/${token}?intent=in`);

    expect(await snapshotResponses(fixtureId)).toEqual(before);
    expect(await snapshotCounts(fixtureId)).toEqual(countsBefore);
  });

  it("leaves every response row byte-identical for ?intent=out", async () => {
    const { fixtureId, playerId } = await seedOpenFixture();
    const token = await tokenFor(fixtureId, playerId);

    const before = await snapshotResponses(fixtureId);
    const countsBefore = await snapshotCounts(fixtureId);

    await SELF.fetch(`https://makethe.team/r/${token}?intent=out`);

    expect(await snapshotResponses(fixtureId)).toEqual(before);
    expect(await snapshotCounts(fixtureId)).toEqual(countsBefore);
  });

  it("does not change respondedAt for a player who already responded", async () => {
    const { fixtureId, playerId } = await seedOpenFixture();
    await env.FIXTURE_CAPACITY.getByName(fixtureId).setResponse({
      playerId, intent: "in", actorPlayerId: null, source: "token", now: NOW.getTime(),
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
    const { fixtureId, playerId } = await seedOpenFixture();
    // The route verifies against the real wall clock, not the fictional `NOW`
    // used elsewhere in this file for fixture timing — so "expired" must be
    // relative to `Date.now()`.
    const expired = await tokenFor(fixtureId, playerId, Date.now() - 1000);

    const response = await SELF.fetch(`https://makethe.team/r/${expired}`);

    expect(response.status).not.toBe(500);
    expect([200, 410]).toContain(response.status);
    const body = await response.text();
    expect(body).toMatch(/isn.t working|expired|fresh link/i);
  });

  it("gives byte-identical copy for expired, tampered, wrong-fixture and malformed tokens", async () => {
    const { fixtureId, playerId } = await seedOpenFixture();

    const expired = await tokenFor(fixtureId, playerId, Date.now() - 1000);

    const valid = await tokenFor(fixtureId, playerId);
    const [validBody, validSig] = valid.split(".");
    const tampered = `${validBody}.${(validSig ?? "").slice(0, -1)}${(validSig ?? "").endsWith("A") ? "B" : "A"}`;

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
    const { fixtureId, playerId } = await seedOpenFixture();
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
    const { fixtureId, playerId } = await seedOpenFixture();
    const token = await tokenFor(fixtureId, playerId);
    const tampered = `${token.split(".")[0]}.wrongsignature`;

    const before = await snapshotResponses(fixtureId);

    await SELF.fetch(`https://makethe.team/r/${encodeURIComponent(tampered)}`);

    expect(await snapshotResponses(fixtureId)).toEqual(before);
  });
});

describe("GET /r/:token — a finished fixture renders read-only (BR-24)", () => {
  it("renders no buttons and an explanation for a played fixture", async () => {
    const { fixtureId, playerId } = await seedOpenFixture({ lifecycle: "played" });
    const token = await tokenFor(fixtureId, playerId);

    const response = await SELF.fetch(`https://makethe.team/r/${token}`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).not.toContain(`method="post"`);
    expect(body).not.toContain(`name="intent"`);
    expect(body).toMatch(/already been played/i);
  });

  it("renders no buttons and an explanation for a cancelled fixture", async () => {
    const { fixtureId, playerId } = await seedOpenFixture({ lifecycle: "cancelled" });
    const token = await tokenFor(fixtureId, playerId);

    const response = await SELF.fetch(`https://makethe.team/r/${token}`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).not.toContain(`method="post"`);
    expect(body).not.toContain(`name="intent"`);
    expect(body).toMatch(/cancelled/i);
  });

  it("still verifies the token for a finished fixture — it is not treated as a failure", async () => {
    const { fixtureId, playerId } = await seedOpenFixture({ lifecycle: "played" });
    const token = await tokenFor(fixtureId, playerId);

    const body = await (await SELF.fetch(`https://makethe.team/r/${token}`)).text();

    expect(body).not.toMatch(/isn.t working/i);
    expect(body).toContain("Thursday 7-a-side");
  });
});

describe("GET /r/:token — a valid token for a player no longer on the squad", () => {
  it("renders read-only with a neutral explanation, not the generic failure page", async () => {
    const { fixtureId, playerId } = await seedOpenFixture();
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
    const { fixtureId, playerId } = await seedOpenFixture();
    const token = await tokenFor(fixtureId, playerId);
    await db.delete(responses).where(eq(responses.playerId, playerId));

    const before = await snapshotResponses(fixtureId);
    const countsBefore = await snapshotCounts(fixtureId);

    await SELF.fetch(`https://makethe.team/r/${token}`);

    expect(await snapshotResponses(fixtureId)).toEqual(before);
    expect(await snapshotCounts(fixtureId)).toEqual(countsBefore);
  });
});

describe("vocabulary and safety", () => {
  it("never uses forbidden vocabulary on the failure page", async () => {
    const response = await SELF.fetch("https://makethe.team/r/not-a-real-token");
    const body = (await response.text()).toLowerCase();
    for (const word of ["rsvp", "event", "match", "user"]) expect(body).not.toContain(word);
  });

  it("is not indexable", async () => {
    const { fixtureId, playerId } = await seedOpenFixture();
    const token = await tokenFor(fixtureId, playerId);
    const response = await SELF.fetch(`https://makethe.team/r/${token}`);
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });
});

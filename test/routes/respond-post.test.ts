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
  /** One squad member per requested count, in insertion order. */
  playerIds: string[];
}

/**
 * Seed a game and an opened fixture with `squadSize` players, all `pending`.
 * `maxPlayers` defaults large enough that ordinary tests never trip capacity
 * by accident; capacity tests override it explicitly.
 */
async function seedOpenFixture(
  overrides: { lifecycle?: "open" | "played" | "cancelled"; maxPlayers?: number; squadSize?: number } = {},
): Promise<SeedResult> {
  const maxPlayers = overrides.maxPlayers ?? 14;
  const squadSize = overrides.squadSize ?? 1;

  const gameId = await insertGame(db, { maxPlayers });
  const fixtureId = crypto.randomUUID();
  await db.insert(fixtures).values({
    id: fixtureId,
    gameId,
    kicksOffAt: KICKOFF,
    minPlayers: 1,
    maxPlayers,
    prefersEvenNumbers: true,
    shortWarningOffsetHours: 12,
    durationMinutes: 60,
  });

  const playerIds: string[] = [];
  for (let i = 0; i < squadSize; i++) {
    const playerId = crypto.randomUUID();
    await db.insert(players).values({ id: playerId, name: `Player ${i + 1}`, email: `p${i + 1}@example.com` });
    await db.insert(memberships).values({ id: crypto.randomUUID(), gameId, playerId, active: true });
    playerIds.push(playerId);
  }

  await openFixture(db, fixtureId, NOW);

  if (overrides.lifecycle && overrides.lifecycle !== "open") {
    await db.update(fixtures).set({ lifecycle: overrides.lifecycle }).where(eq(fixtures.id, fixtureId));
  }

  return { gameId, fixtureId, playerIds };
}

async function tokenFor(fixtureId: string, playerId: string, expiresAt = KICKOFF.getTime() + 86_400_000) {
  return signResponseToken({ playerId, fixtureId, expiresAt }, SECRET);
}

async function snapshotResponses(fixtureId: string) {
  return db.select().from(responses).where(eq(responses.fixtureId, fixtureId));
}

/** Record a response directly through the Durable Object, bypassing HTTP — for setting up scenario state. */
async function setResponse(fixtureId: string, playerId: string, intent: "in" | "out") {
  return env.FIXTURE_CAPACITY.getByName(fixtureId).setResponse({
    playerId,
    intent,
    actorPlayerId: null,
    source: "system",
    now: NOW.getTime(),
  });
}

async function postIntent(token: string, intent?: string) {
  const params = new URLSearchParams();
  if (intent !== undefined) params.set("intent", intent);
  return SELF.fetch(`https://makethe.team/r/${token}`, { method: "POST", body: params });
}

beforeEach(async () => {
  await resetDatabase();
});

describe("POST /r/:token — recording a plain response", () => {
  it("records 'in' and re-renders showing the player as in", async () => {
    const { fixtureId, playerIds } = await seedOpenFixture();
    const [playerId] = playerIds as [string];
    const token = await tokenFor(fixtureId, playerId);

    const response = await postIntent(token, "in");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("You're in.");

    const [row] = await db.select().from(responses).where(eq(responses.playerId, playerId));
    expect(row?.status).toBe("in");
    expect(row?.source).toBe("token");
    expect(row?.setByPlayerId).toBeNull();
  });

  it("records 'out' and re-renders showing the player as out", async () => {
    const { fixtureId, playerIds } = await seedOpenFixture();
    const [playerId] = playerIds as [string];
    const token = await tokenFor(fixtureId, playerId);

    const response = await postIntent(token, "out");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toMatch(/can.t make it/i);

    const [row] = await db.select().from(responses).where(eq(responses.playerId, playerId));
    expect(row?.status).toBe("out");
  });

  it("still shows response buttons afterwards, so the player can change their mind", async () => {
    const { fixtureId, playerIds } = await seedOpenFixture();
    const [playerId] = playerIds as [string];
    const token = await tokenFor(fixtureId, playerId);

    const body = await (await postIntent(token, "in")).text();

    expect(body).toContain(`method="post"`);
    expect(body).toContain(`name="intent" value="in"`);
    expect(body).toContain(`name="intent" value="out"`);
  });
});

describe("POST /r/:token — capacity goes through the Durable Object (TR-10, BR-9)", () => {
  it("waitlists rather than over-filling a full fixture", async () => {
    const { fixtureId, playerIds } = await seedOpenFixture({ maxPlayers: 1, squadSize: 2 });
    const [fillerId, latecomerId] = playerIds as [string, string];
    await setResponse(fixtureId, fillerId, "in");

    const token = await tokenFor(fixtureId, latecomerId);
    const response = await postIntent(token, "in");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toMatch(/waitlist/i);
    expect(body).toMatch(/1st in line/i);

    const [row] = await db.select().from(responses).where(eq(responses.playerId, latecomerId));
    expect(row?.status).toBe("waitlisted");
  });

  it("shows waitlist ranks without gaps after an earlier waitlisted player drops out", async () => {
    // Fill the one spot, then put three more players on the waitlist in order.
    const { fixtureId, playerIds } = await seedOpenFixture({ maxPlayers: 1, squadSize: 4 });
    const [fillerId, first, second, third] = playerIds as [string, string, string, string];
    await setResponse(fixtureId, fillerId, "in");
    await setResponse(fixtureId, first, "in"); // waitlist position 1
    await setResponse(fixtureId, second, "in"); // waitlist position 2
    await setResponse(fixtureId, third, "in"); // waitlist position 3

    // The first waitlisted player says they can't make it after all, opening a
    // gap at stored position 1 — the two behind them must not be shown as
    // "position 2" and "position 3", which is what the raw stored positions
    // would say.
    const firstToken = await tokenFor(fixtureId, first);
    const body = await (await postIntent(firstToken, "out")).text();

    expect(body).not.toMatch(/waitlisted \(3rd\)/i);
    expect(body).toMatch(/waitlisted \(1st\)/i);
    expect(body).toMatch(/waitlisted \(2nd\)/i);

    const [secondRow] = await db.select().from(responses).where(eq(responses.playerId, second));
    const [thirdRow] = await db.select().from(responses).where(eq(responses.playerId, third));
    // The stored positions are still the original, gappy ones — proof that the
    // rendered ranks above were recomputed, not read off these columns.
    expect(secondRow?.waitlistPosition).toBe(2);
    expect(thirdRow?.waitlistPosition).toBe(3);
  });
});

describe("POST /r/:token — bad intent (TR-4)", () => {
  it("returns 400 and records nothing when intent is missing", async () => {
    const { fixtureId, playerIds } = await seedOpenFixture();
    const [playerId] = playerIds as [string];
    const token = await tokenFor(fixtureId, playerId);

    const before = await snapshotResponses(fixtureId);
    const response = await postIntent(token);

    expect(response.status).toBe(400);
    expect(await snapshotResponses(fixtureId)).toEqual(before);
  });

  it("returns 400 and records nothing for an unrecognised intent value", async () => {
    const { fixtureId, playerIds } = await seedOpenFixture();
    const [playerId] = playerIds as [string];
    const token = await tokenFor(fixtureId, playerId);

    const before = await snapshotResponses(fixtureId);
    const response = await postIntent(token, "maybe");

    expect(response.status).toBe(400);
    expect(await snapshotResponses(fixtureId)).toEqual(before);
  });
});

describe("POST /r/:token — token failures record nothing (TR-14)", () => {
  it("renders the same friendly page as the GET for an expired token, and records nothing", async () => {
    const { fixtureId, playerIds } = await seedOpenFixture();
    const [playerId] = playerIds as [string];
    const expired = await tokenFor(fixtureId, playerId, Date.now() - 1000);

    const before = await snapshotResponses(fixtureId);
    const getBody = await (await SELF.fetch(`https://makethe.team/r/${expired}`)).text();
    const postResponse = await postIntent(expired, "in");
    const postBody = await postResponse.text();

    expect(postResponse.status).not.toBe(500);
    expect(postBody).toBe(getBody);
    expect(await snapshotResponses(fixtureId)).toEqual(before);
  });

  it("records nothing for a tampered token", async () => {
    const { fixtureId, playerIds } = await seedOpenFixture();
    const [playerId] = playerIds as [string];
    const token = await tokenFor(fixtureId, playerId);
    const tampered = `${token.split(".")[0]}.wrongsignature`;

    const before = await snapshotResponses(fixtureId);
    const response = await postIntent(tampered, "in");

    expect(response.status).not.toBe(500);
    expect(await snapshotResponses(fixtureId)).toEqual(before);
  });

  it("renders the friendly failure page for a malformed token", async () => {
    const response = await SELF.fetch(`https://makethe.team/r/not-a-real-token`, {
      method: "POST",
      body: new URLSearchParams({ intent: "in" }),
    });
    const body = await response.text();

    expect(response.status).not.toBe(500);
    expect(body).toMatch(/isn.t working/i);
  });
});

describe("POST /r/:token — a finished fixture records nothing (BR-15)", () => {
  it("records nothing for a played fixture and explains why", async () => {
    const { fixtureId, playerIds } = await seedOpenFixture({ lifecycle: "played" });
    const [playerId] = playerIds as [string];
    const token = await tokenFor(fixtureId, playerId);

    const before = await snapshotResponses(fixtureId);
    const response = await postIntent(token, "in");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toMatch(/already been played/i);
    expect(body).not.toContain(`method="post"`);
    expect(await snapshotResponses(fixtureId)).toEqual(before);
  });

  it("records nothing for a cancelled fixture and explains why", async () => {
    const { fixtureId, playerIds } = await seedOpenFixture({ lifecycle: "cancelled" });
    const [playerId] = playerIds as [string];
    const token = await tokenFor(fixtureId, playerId);

    const before = await snapshotResponses(fixtureId);
    const response = await postIntent(token, "in");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toMatch(/cancelled/i);
    expect(body).not.toContain(`method="post"`);
    expect(await snapshotResponses(fixtureId)).toEqual(before);
  });
});

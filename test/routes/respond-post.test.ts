import { SELF, env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../src/db/client.js";
import { auditLog, emailQuota, fixtures, memberships, notificationLog, players, responses } from "../../src/db/schema.js";
import { openFixture } from "../../src/domain/open-fixture.js";
import { signResponseToken } from "../../src/domain/token.js";
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

/**
 * A fixture that has never been opened: `scheduled` is the default lifecycle
 * and `openFixture` is deliberately never called, so — unlike
 * `seedOpenFixture` — no response rows exist for anyone. In practice a
 * response token should never be minted before a fixture opens, so this
 * models a stray or hand-crafted request rather than anything a real player
 * link can produce.
 */
async function seedScheduledFixture(): Promise<SeedResult> {
  const gameId = await insertGame(db, { maxPlayers: 14 });
  const fixtureId = crypto.randomUUID();
  await db.insert(fixtures).values({
    id: fixtureId,
    gameId,
    kicksOffAt: KICKOFF,
    minPlayers: 1,
    maxPlayers: 14,
    prefersEvenNumbers: true,
    shortWarningOffsetHours: 12,
    durationMinutes: 60,
  });

  const playerId = crypto.randomUUID();
  await db.insert(players).values({ id: playerId, name: "Player 1", email: "p1@example.com" });
  await db.insert(memberships).values({ id: crypto.randomUUID(), gameId, playerId, active: true });

  return { gameId, fixtureId, playerIds: [playerId] };
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
    whenFull: "waitlist",
    now: NOW.getTime(),
  });
}

async function postIntent(token: string, intent?: string) {
  const params = new URLSearchParams();
  if (intent !== undefined) params.set("intent", intent);
  return SELF.fetch(`https://makethe.team/r/${token}`, { method: "POST", body: params });
}

/**
 * The N-2 promotion email is handed to `ctx.waitUntil`, so it is still in
 * flight when the response arrives — every assertion about it has to wait for
 * the background task rather than read straight after the fetch.
 *
 * Polling on the durable side effect (the `notification_log` row) rather than
 * on a clock: this never asserts that two clocks agree, only that a row the
 * Worker will certainly write has appeared and reached a terminal status. The
 * deadline is a backstop against hanging the suite, not a timing assertion.
 *
 * Waiting for the status specifically matters: insert-before-send means a row
 * exists as `queued` for the whole duration of the send, so polling on
 * existence alone would sample the row mid-flight.
 */
async function waitForNotificationRows(atLeast: number, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  const settled = (rows: Array<{ status: string }>) =>
    rows.length >= atLeast && rows.every((row) => row.status !== "queued");

  let rows = await db.select().from(notificationLog);
  while (!settled(rows) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    rows = await db.select().from(notificationLog);
  }
  return rows;
}

/**
 * Give any background send a generous chance to write, then report what is
 * there. Used by the "nothing was sent" assertions, where the absence of a
 * row is the whole point and reading immediately would pass even if a send
 * *had* been started.
 */
async function notificationRowsAfterSettling() {
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    const rows = await db.select().from(notificationLog);
    if (rows.length > 0) return rows;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return db.select().from(notificationLog);
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
    expect(body).toContain("You&#39;re in.");

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

    // M10 §3.5: the player-facing squad renders waitlist rank inside a chip
    // ("Name · 1st"), not the old row wording ("Waitlisted (1st)").
    expect(body).not.toMatch(/· 3rd/);
    expect(body).toMatch(/· 1st/);
    expect(body).toMatch(/· 2nd/);

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

describe("POST /r/:token — a scheduled fixture is refused with an explanation, not a silent no-op (fix round 1, finding 2)", () => {
  it("records nothing and renders read-only, rather than re-showing 'Can you make it?' after a vanished tap", async () => {
    const { fixtureId, playerIds } = await seedScheduledFixture();
    const [playerId] = playerIds as [string];
    const token = await tokenFor(fixtureId, playerId);

    const response = await postIntent(token, "in");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).not.toContain(`method="post"`);
    expect(body).not.toMatch(/can you make it\?/i);
    // Pins the escaped apostrophe exactly, same reasoning as
    // test/views/fixture.test.ts — a regex accepting either `'` or
    // `&#39;` would pass regardless of whether escapeHtml escapes `'`.
    expect(body).toContain("Responses for this fixture aren&#39;t open yet.");

    // No response row exists at all for a fixture that was never opened —
    // the Durable Object refused the write (fixture-not-open) before ever
    // reaching a squad lookup.
    const rows = await snapshotResponses(fixtureId);
    expect(rows).toEqual([]);
  });
});

describe("POST /r/:token — the promoted player is told (N-2, BR-7, J4)", () => {
  /**
   * One `in` slot, taken; one player waiting. When the holder drops out the
   * Durable Object promotes the waiting player inside the capacity lock, and
   * the route is what has to tell them.
   */
  async function seedPromotionReady() {
    const { fixtureId, playerIds } = await seedOpenFixture({ maxPlayers: 1, squadSize: 2 });
    const [holderId, waiterId] = playerIds as [string, string];
    await setResponse(fixtureId, holderId, "in");
    await setResponse(fixtureId, waiterId, "in"); // waitlisted, position 1
    return { fixtureId, holderId, waiterId };
  }

  it("emails the promoted player, and nobody else", async () => {
    const { fixtureId, holderId, waiterId } = await seedPromotionReady();

    const token = await tokenFor(fixtureId, holderId);
    const response = await postIntent(token, "out");

    expect(response.status).toBe(200);

    const rows = await waitForNotificationRows(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      notificationType: "n2",
      fixtureId,
      playerId: waiterId,
      channel: "email",
      status: "sent",
    });
    // Keyed to this promotion, not merely to this player (§2.8).
    expect(rows[0]?.dedupeKey).toMatch(new RegExp(`^n2:${fixtureId}:${waiterId}:.+`));
    // Nothing at all was sent to the player who dropped out.
    expect(rows.some((row) => row.playerId === holderId)).toBe(false);
  });

  it("still confirms the dropping player's own response on their own page", async () => {
    const { fixtureId, holderId } = await seedPromotionReady();

    const token = await tokenFor(fixtureId, holderId);
    const body = await (await postIntent(token, "out")).text();

    expect(body).toMatch(/can.t make it/i);
    await waitForNotificationRows(1);
  });

  it("sends nothing when the response promoted nobody", async () => {
    // Plenty of room and an empty waitlist: dropping out frees a slot nobody
    // was waiting for, so there is no N-2 to send.
    const { fixtureId, playerIds } = await seedOpenFixture({ maxPlayers: 14, squadSize: 2 });
    const [holderId] = playerIds as [string, string];
    await setResponse(fixtureId, holderId, "in");

    const token = await tokenFor(fixtureId, holderId);
    const response = await postIntent(token, "out");

    expect(response.status).toBe(200);
    // Insert-before-send: a row lands *before* any message is handed to the
    // notifier, so no row after settling means no send was ever attempted.
    expect(await notificationRowsAfterSettling()).toEqual([]);
  });

  it("sends nothing when a response takes a slot rather than freeing one", async () => {
    const { fixtureId, playerIds } = await seedOpenFixture({ maxPlayers: 14, squadSize: 2 });
    const [playerId] = playerIds as [string, string];

    const token = await tokenFor(fixtureId, playerId);
    const response = await postIntent(token, "in");

    expect(response.status).toBe(200);
    expect(await notificationRowsAfterSettling()).toEqual([]);
  });

  it("still renders the dropping player's page when the send fails outright", async () => {
    const { fixtureId, holderId, waiterId } = await seedPromotionReady();

    // Point the Worker at the real provider for this one request. Outbound
    // network access is blocked repo-wide (`vitest.config.ts` answers 599), so
    // `ResendNotifier` reports a provider failure — the ambiguous case, which
    // must leave the row `failed` and must not touch the response at all.
    const previousNotifier = env.NOTIFIER;
    const previousKey = env.RESEND_API_KEY;
    env.NOTIFIER = "resend";
    env.RESEND_API_KEY = "test-only-not-a-real-key";
    try {
      const token = await tokenFor(fixtureId, holderId);
      const response = await postIntent(token, "out");
      const body = await response.text();

      expect(response.status).toBe(200);
      expect(body).toMatch(/can.t make it/i);

      const rows = await waitForNotificationRows(1);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ notificationType: "n2", playerId: waiterId, status: "failed" });
      // A provider error is ambiguous, so the row stays `failed` forever
      // rather than being deleted for a retry — the message may have landed.
      expect(rows[0]?.error).toBeTruthy();
    } finally {
      env.NOTIFIER = previousNotifier;
      env.RESEND_API_KEY = previousKey;
    }

    // And the promotion itself is untouched by the email having failed.
    const [promotedRow] = await db.select().from(responses).where(eq(responses.playerId, waiterId));
    expect(promotedRow?.status).toBe("in");
  });

  it("records an audit row when the daily send ceiling stops the promoted player being told (TR-31)", async () => {
    // `MAX_EMAILS_PER_DAY` is "50" (wrangler.jsonc); pre-filling today's
    // quota to the ceiling makes QuotaNotifier refuse the N-2. The refusal
    // deletes the `notification_log` row, which keeps a retry *possible* —
    // but nothing retries it, and it could not be retried faithfully anyway,
    // because `promotedAt` (which `promotionKey` needs) is persisted nowhere.
    // Task 4's review accepted the delete on the condition that this row
    // exists; this is that row.
    const { fixtureId, holderId, waiterId } = await seedPromotionReady();
    await db.insert(emailQuota).values({ day: new Date(Date.now()).toISOString().slice(0, 10), sentCount: 50 });

    const token = await tokenFor(fixtureId, holderId);
    expect((await postIntent(token, "out")).status).toBe(200);

    const deadline = Date.now() + 3000;
    let rows = await db.select().from(auditLog);
    while (rows.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      rows = await db.select().from(auditLog);
    }

    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe("fixture.promotion_email_deferred");
    expect(rows[0]?.entityId).toBe(fixtureId);
    expect(rows[0]?.actorPlayerId).toBeNull();
    expect(JSON.parse(rows[0]?.afterJson ?? "{}")).toEqual({ notificationType: "n2", playerIds: [waiterId] });

    // The row was deleted, not left `failed` — the asymmetry is unchanged.
    expect(await db.select().from(notificationLog)).toEqual([]);
  });

  it("writes no log row at all when the promoted player is a guest with no address (BR-32)", async () => {
    const { fixtureId, holderId, waiterId } = await seedPromotionReady();
    // The waiting player is a guest with no address — the promotion still
    // happens in the Durable Object, but there is nobody to email, and unlike
    // a ceiling refusal there is nothing here worth recording and retrying.
    await db.update(players).set({ isGuest: true, email: null }).where(eq(players.id, waiterId));

    const token = await tokenFor(fixtureId, holderId);
    const response = await postIntent(token, "out");

    expect(response.status).toBe(200);
    expect(await notificationRowsAfterSettling()).toEqual([]);
    // The promotion itself still happened — only the email was skipped.
    const [promotedRow] = await db.select().from(responses).where(eq(responses.playerId, waiterId));
    expect(promotedRow?.status).toBe("in");
  });
});

describe("POST /r/:token — a waitlisted viewer never reads as confirmed (BR-5, fix round 1, finding 1)", () => {
  it("renders the warn-treated headline above the badge, with no confirmed-green 'I'm in', through the real route", async () => {
    const { fixtureId, playerIds } = await seedOpenFixture({ maxPlayers: 1, squadSize: 2 });
    const [fillerId, latecomerId] = playerIds as [string, string];
    await setResponse(fixtureId, fillerId, "in");

    const token = await tokenFor(fixtureId, latecomerId);
    const body = await (await postIntent(token, "in")).text();

    // The waitlist placement is unmissable...
    expect(body).toMatch(/on the waitlist.*1st in line/i);
    // ...and visually distinct from a confirmation: warn-coloured headline,
    // positioned before the fixture's own (still green/"confirmed") badge...
    expect(body).toMatch(/class="viewer-headline warn"/);
    const headlineIndex = body.indexOf('<p class="viewer-headline');
    const badgeIndex = body.indexOf('<p class="status-badge');
    expect(headlineIndex).toBeGreaterThan(-1);
    expect(badgeIndex).toBeGreaterThan(-1);
    expect(headlineIndex).toBeLessThan(badgeIndex);
    // ...and the "I'm in" button the player just tapped is not shown as the
    // confirmed-green state, which would read as a confirmation that
    // contradicts the headline — it gets the amber waiting state instead
    // (M10 §3.1), a positive signal rather than the mere absence of one.
    expect(body).not.toMatch(/class="button chosen-in"[^>]*name="intent" value="in"/);
    expect(body).toMatch(/class="button chosen-waiting"[^>]*name="intent" value="in"/);
  });
});

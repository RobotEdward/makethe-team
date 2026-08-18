import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { chunk, INSERT_CHUNK_SIZE } from "../../src/db/chunk.js";
import { getDb } from "../../src/db/client.js";
import { fixtures, memberships, notificationLog, players, responses } from "../../src/db/schema.js";
import type { BroadcastAudience } from "../../src/domain/broadcast-audience.js";
import { verifyLeaveToken, verifyResponseToken } from "../../src/domain/token.js";
import { broadcastKey, pushKey } from "../../src/notify/dedupe-key.js";
import type { Message, Notifier, SendResult } from "../../src/notify/notifier.js";
import { DAILY_CEILING_REASON } from "../../src/notify/quota.js";
import { sendBroadcast } from "../../src/notify/send-broadcast.js";
import { insertGame, insertSubscription, requireEmailMessage, resetDatabase } from "../support/factories.js";

const db = getDb(env.DB);
const SECRET = "test-secret";
const NOW = new Date("2026-08-12T09:00:00Z");
const KICKOFF = new Date("2026-08-13T18:00:00Z");
/** Long enough past that `responseTokenExpiry` is behind `NOW` (BR-24 gives a token 24h past kick-off). */
const PAST_KICKOFF = new Date("2026-08-01T18:00:00Z");

/**
 * Records every message it was sent, in order, so a test can assert on it.
 * Copied in shape from `send-teams.test.ts`'s notifier — same fake, same
 * `failFor`/`ceilingFor` switches, keyed on `Message.to` (an address for
 * email, a player id for push).
 */
class RecordingNotifier implements Notifier {
  readonly sent: Message[][] = [];
  readonly failFor = new Set<string>();
  readonly ceilingFor = new Set<string>();

  get all(): Message[] {
    return this.sent.flat();
  }

  send(messages: readonly Message[]): Promise<SendResult[]> {
    this.sent.push([...messages]);
    return Promise.resolve(
      messages.map((m): SendResult => {
        if (this.ceilingFor.has(m.to)) return { ok: false, error: DAILY_CEILING_REASON };
        if (this.failFor.has(m.to)) return { ok: false, error: "simulated-provider-failure" };
        return { ok: true, providerMessageId: `prov-${m.dedupeKey}` };
      }),
    );
  }
}

interface SquadMember {
  id: string;
  name: string;
  email: string | null;
  isGuest?: boolean;
  /** `null` seeds an active member with no response row for the fixture at all. */
  status?: string | null;
  device?: boolean;
}

/** One game, one fixture, and a squad of members with or without a response and a device. */
async function seed(
  squad: SquadMember[],
  overrides: { kicksOffAt?: Date } = {},
): Promise<{ gameId: string; fixtureId: string }> {
  const gameId = await insertGame(db, { name: "Thursday 7-a-side", venueName: "Oxford Sports Park" });
  const fixtureId = crypto.randomUUID();
  await db.insert(fixtures).values({
    id: fixtureId,
    gameId,
    kicksOffAt: overrides.kicksOffAt ?? KICKOFF,
    lifecycle: "open",
    minPlayers: 2,
    maxPlayers: 14,
    prefersEvenNumbers: true,
    shortWarningOffsetHours: 12,
    durationMinutes: 60,
  });

  for (const member of squad) {
    await db
      .insert(players)
      .values({ id: member.id, name: member.name, email: member.email, isGuest: member.isGuest ?? false });
    await db.insert(memberships).values({ id: `m-${member.id}`, gameId, playerId: member.id, active: true });
    const status = member.status === undefined ? "in" : member.status;
    if (status !== null) {
      // `as never` is how `test/stored-lookups.test.ts` seeds a status this
      // build has never heard of: the column is `text NOT NULL` with no CHECK
      // constraint, so the Drizzle enum is a claim rather than a guarantee.
      await db
        .insert(responses)
        .values({ id: `r-${member.id}`, fixtureId, playerId: member.id, status: status as never, source: "token" });
    }
    if (member.device) await insertSubscription(db, member.id, `https://push.example.com/${member.id}`);
  }

  return { gameId, fixtureId };
}

interface SendOverrides {
  broadcastId?: string;
  fixtureId?: string | null;
  audience?: BroadcastAudience;
  channels?: { email: boolean; push: boolean };
}

async function send(
  gameId: string,
  fixtureId: string | null,
  notifier: Notifier,
  overrides: SendOverrides = {},
) {
  return sendBroadcast({
    db,
    notifier,
    broadcastId: overrides.broadcastId ?? "bc-1",
    gameId,
    fixtureId: overrides.fixtureId === undefined ? fixtureId : overrides.fixtureId,
    audience: overrides.audience ?? (fixtureId === null ? "everyone" : "playing"),
    subject: "Pitch has moved",
    message: "We're on the 3G pitch this week.",
    organiserName: "Jamie",
    channels: overrides.channels ?? { email: true, push: true },
    now: NOW,
    responseTokenSecret: SECRET,
  });
}

async function logRows() {
  return db.select().from(notificationLog);
}

function pushMessages(notifier: RecordingNotifier) {
  return notifier.all.filter((m) => m.channel === "push");
}

function emailMessages(notifier: RecordingNotifier) {
  return notifier.all.filter((m) => m.channel === "email");
}

beforeEach(async () => {
  await resetDatabase();
});

describe("sendBroadcast (N-10)", () => {
  it("sends on both channels, counting email and push separately", async () => {
    const { gameId, fixtureId } = await seed([
      { id: "alice", name: "Alice", email: "alice@example.com", device: true },
      { id: "bob", name: "Bob", email: "bob@example.com", device: true },
      { id: "cara", name: "Cara", email: "cara@example.com" },
    ]);
    const notifier = new RecordingNotifier();

    const result = await send(gameId, fixtureId, notifier);

    expect(result).toEqual({
      sent: 3,
      failed: 0,
      deferred: 0,
      deferredPlayerIds: [],
      pushSent: 2,
      pushFailed: 0,
      skipped: 0,
    });
    expect(emailMessages(notifier).map((m) => m.to).sort()).toEqual([
      "alice@example.com",
      "bob@example.com",
      "cara@example.com",
    ]);
    expect(pushMessages(notifier).map((m) => m.to).sort()).toEqual(["alice", "bob"]);

    const rows = await logRows();
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      expect(row).toMatchObject({ notificationType: "n10", fixtureId, status: "sent" });
    }
    const email = requireEmailMessage(emailMessages(notifier)[0]!);
    expect(email.subject).toBe("Pitch has moved");
    expect(email.html).toContain("Jamie");
    // The fixture line, formatted in the game's timezone by
    // `formatLocalDateTime` (TR-5). "19:00" is the London local time of an
    // 18:00Z kick-off in August, and "13 August" is a formatted date — a raw
    // `toISOString()` would satisfy neither.
    expect(email.text).toContain("13 August");
    expect(email.text).toContain("19:00");
    expect(email.text).toContain("Oxford Sports Park");
  });

  it("carries a leave link scoped to the game (BR-22)", async () => {
    const { gameId, fixtureId } = await seed([{ id: "alice", name: "Alice", email: "alice@example.com" }]);
    const notifier = new RecordingNotifier();

    await send(gameId, fixtureId, notifier);

    const match = requireEmailMessage(notifier.all[0]!).html.match(/\/leave\/([^"]+)"/);
    expect(match?.[1]).toBeTruthy();
    expect(await verifyLeaveToken(match![1]!, SECRET, NOW)).toMatchObject({
      ok: true,
      payload: { gameId, playerId: "alice" },
    });
  });

  it("builds no push message at all when only email was asked for", async () => {
    const { gameId, fixtureId } = await seed([
      { id: "alice", name: "Alice", email: "alice@example.com", device: true },
    ]);
    const notifier = new RecordingNotifier();

    const result = await send(gameId, fixtureId, notifier, { channels: { email: true, push: false } });

    expect(pushMessages(notifier)).toHaveLength(0);
    expect(result).toMatchObject({ sent: 1, pushSent: 0, pushFailed: 0, skipped: 0 });
    expect((await logRows()).map((r) => r.channel)).toEqual(["email"]);
  });

  it("builds no email at all when only push was asked for, and does not count a deviceless player as skipped", async () => {
    const { gameId, fixtureId } = await seed([
      { id: "alice", name: "Alice", email: "alice@example.com", device: true },
      { id: "cara", name: "Cara", email: "cara@example.com" },
    ]);
    const notifier = new RecordingNotifier();

    const result = await send(gameId, fixtureId, notifier, { channels: { email: false, push: true } });

    expect(emailMessages(notifier)).toHaveLength(0);
    expect(notifier.all.map((m) => m.to)).toEqual(["alice"]);
    // Cara was addressable — the organiser simply picked a channel she has no
    // device for. `skipped` counts exclusions (§2.1), not channel misses.
    expect(result).toEqual({
      sent: 0,
      failed: 0,
      deferred: 0,
      deferredPlayerIds: [],
      pushSent: 1,
      pushFailed: 0,
      skipped: 0,
    });
  });

  it("gives a player with no registered device exactly one message, on email", async () => {
    const { gameId, fixtureId } = await seed([{ id: "cara", name: "Cara", email: "cara@example.com" }]);
    const notifier = new RecordingNotifier();

    await send(gameId, fixtureId, notifier);

    expect(notifier.all).toHaveLength(1);
    expect((await logRows()).map((r) => r.channel)).toEqual(["email"]);
  });

  it("skips a guest, with no message and no log row (BR-32)", async () => {
    const { gameId, fixtureId } = await seed([
      { id: "alice", name: "Alice", email: "alice@example.com" },
      { id: "guest", name: "Guest", email: null, isGuest: true },
    ]);
    const notifier = new RecordingNotifier();

    const result = await send(gameId, fixtureId, notifier);

    expect(result).toMatchObject({ sent: 1, skipped: 1 });
    expect(notifier.all.map((m) => m.to)).toEqual(["alice@example.com"]);
    expect(await logRows()).toHaveLength(1);
  });

  it("skips a blank-address player with no device, with no message and no log row", async () => {
    const { gameId, fixtureId } = await seed([
      { id: "alice", name: "Alice", email: "alice@example.com" },
      { id: "blank", name: "Blank", email: "   " },
    ]);
    const notifier = new RecordingNotifier();

    const result = await send(gameId, fixtureId, notifier);

    expect(result).toMatchObject({ sent: 1, skipped: 1 });
    expect(notifier.all.map((m) => m.to)).toEqual(["alice@example.com"]);
    expect(await logRows()).toHaveLength(1);
  });

  it("reaches a blank-address player on push alone, without ever building a blank-addressed email", async () => {
    const { gameId, fixtureId } = await seed([{ id: "blank", name: "Blank", email: "   ", device: true }]);
    const notifier = new RecordingNotifier();

    const result = await send(gameId, fixtureId, notifier);

    expect(notifier.all.map((m) => m.channel)).toEqual(["push"]);
    expect(result).toMatchObject({ sent: 0, pushSent: 1, skipped: 0 });
  });

  it("sends nothing to a response row whose status this build cannot name, under every fixture audience", async () => {
    const { gameId, fixtureId } = await seed([
      { id: "odd", name: "Odd", email: "odd@example.com", status: "cancelled", device: true },
    ]);

    // The four fixture-scoped audiences are the whole of the loop on purpose:
    // `everyone` resolves from `memberships` and reads no status at all, so it
    // reaches this player regardless — see the game-scoped cases below.
    for (const audience of ["playing", "waitlisted", "pending", "unavailable"] as const) {
      const notifier = new RecordingNotifier();
      const result = await send(gameId, fixtureId, notifier, { audience });
      expect(notifier.all).toEqual([]);
      expect(result).toMatchObject({ sent: 0, pushSent: 0, skipped: 0 });
    }
    expect(await logRows()).toHaveLength(0);
  });

  it("selects exactly the audience's statuses", async () => {
    const { gameId, fixtureId } = await seed([
      { id: "alice", name: "Alice", email: "alice@example.com", status: "in" },
      { id: "wait", name: "Wait", email: "wait@example.com", status: "waitlisted" },
      { id: "outy", name: "Outy", email: "outy@example.com", status: "out" },
      { id: "gone", name: "Gone", email: "gone@example.com", status: "withdrawn" },
    ]);

    const waitlisted = new RecordingNotifier();
    await send(gameId, fixtureId, waitlisted, { audience: "waitlisted", channels: { email: true, push: false } });
    expect(waitlisted.all.map((m) => m.to)).toEqual(["wait@example.com"]);

    const unavailable = new RecordingNotifier();
    await send(gameId, fixtureId, unavailable, {
      broadcastId: "bc-2",
      audience: "unavailable",
      channels: { email: true, push: false },
    });
    // `out` and `withdrawn` differ only in how the slot was released (BR-3).
    expect(unavailable.all.map((m) => m.to).sort()).toEqual(["gone@example.com", "outy@example.com"]);
  });

  it("reaches an active member with no response row when the audience is everyone", async () => {
    const { gameId } = await seed([
      { id: "alice", name: "Alice", email: "alice@example.com", status: "in" },
      { id: "never", name: "Never", email: "never@example.com", status: null },
    ]);
    const notifier = new RecordingNotifier();

    const result = await send(gameId, null, notifier, { channels: { email: true, push: false } });

    expect(notifier.all.map((m) => m.to).sort()).toEqual(["alice@example.com", "never@example.com"]);
    expect(result).toMatchObject({ sent: 2 });
    // Game-scoped: no fixture, so no fixture id on the row and no kick-off
    // line in the copy.
    const rows = await logRows();
    expect(rows.map((r) => r.fixtureId)).toEqual([null, null]);
    expect(requireEmailMessage(notifier.all[0]!).text).not.toContain("Oxford Sports Park");
  });

  it("keys every row on the broadcast id, so a second send with the same words still goes out", async () => {
    const { gameId, fixtureId } = await seed([
      { id: "alice", name: "Alice", email: "alice@example.com", device: true },
    ]);
    const notifier = new RecordingNotifier();

    await send(gameId, fixtureId, notifier, { broadcastId: "bc-1" });
    const rows = await logRows();
    expect(rows.map((r) => r.dedupeKey).sort()).toEqual(
      [broadcastKey("bc-1", "alice"), pushKey(broadcastKey("bc-1", "alice"))].sort(),
    );

    await send(gameId, fixtureId, notifier, { broadcastId: "bc-2" });
    expect(await logRows()).toHaveLength(4);
  });

  it("defers an email refused by the daily ceiling and names the player, while a push refusal is only a push failure", async () => {
    const { gameId, fixtureId } = await seed([
      { id: "alice", name: "Alice", email: "alice@example.com", device: true },
      { id: "bob", name: "Bob", email: "bob@example.com" },
    ]);
    const notifier = new RecordingNotifier();
    notifier.ceilingFor.add("alice@example.com");
    // Keyed by player id, so this hits Alice's push and nothing else.
    notifier.ceilingFor.add("alice");

    const result = await send(gameId, fixtureId, notifier);

    expect(result).toEqual({
      sent: 1,
      failed: 0,
      deferred: 1,
      deferredPlayerIds: ["alice"],
      pushSent: 0,
      pushFailed: 1,
      skipped: 0,
    });
    // A ceiling refusal deletes its row, so only Bob's email survives.
    const rows = await logRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ playerId: "bob", channel: "email", status: "sent" });
  });

  it("leaves an email failed after a provider error, counted apart from push", async () => {
    const { gameId, fixtureId } = await seed([
      { id: "alice", name: "Alice", email: "alice@example.com", device: true },
    ]);
    const notifier = new RecordingNotifier();
    notifier.failFor.add("alice@example.com");

    const result = await send(gameId, fixtureId, notifier);

    expect(result).toMatchObject({ sent: 0, failed: 1, pushSent: 1, pushFailed: 0 });
    const rows = await logRows();
    expect(rows.find((r) => r.channel === "email")).toMatchObject({
      status: "failed",
      error: "simulated-provider-failure",
    });
  });

  it("points a push at the fixture's own response page while its token would still work", async () => {
    const { gameId, fixtureId } = await seed([
      { id: "alice", name: "Alice", email: "alice@example.com", device: true },
    ]);
    const notifier = new RecordingNotifier();

    await send(gameId, fixtureId, notifier, { channels: { email: false, push: true } });

    const push = pushMessages(notifier)[0];
    expect(push?.channel).toBe("push");
    if (push?.channel !== "push") throw new Error("expected a push message");
    expect(push.url).toContain(`https://makethe.team/r/`);
    const token = push.url.slice(push.url.lastIndexOf("/") + 1);
    expect(await verifyResponseToken(token, SECRET, NOW)).toMatchObject({
      ok: true,
      payload: { playerId: "alice", fixtureId },
    });
  });

  it("points a push at the game page when the fixture's response token would already have expired", async () => {
    const { gameId, fixtureId } = await seed(
      [{ id: "alice", name: "Alice", email: "alice@example.com", device: true }],
      { kicksOffAt: PAST_KICKOFF },
    );
    const notifier = new RecordingNotifier();

    await send(gameId, fixtureId, notifier, { channels: { email: false, push: true } });

    const push = pushMessages(notifier)[0];
    if (push?.channel !== "push") throw new Error("expected a push message");
    expect(push.url).toBe(`https://makethe.team/g/${gameId}`);
  });

  it("points a game-scoped push at the game page", async () => {
    const { gameId } = await seed([
      { id: "alice", name: "Alice", email: "alice@example.com", status: null, device: true },
    ]);
    const notifier = new RecordingNotifier();

    await send(gameId, null, notifier, { channels: { email: false, push: true } });

    const push = pushMessages(notifier)[0];
    if (push?.channel !== "push") throw new Error("expected a push message");
    expect(push.url).toBe(`https://makethe.team/g/${gameId}`);
  });

  it("ignores a fixture id handed in alongside the everyone audience", async () => {
    const { gameId, fixtureId } = await seed([
      { id: "alice", name: "Alice", email: "alice@example.com", status: null, device: true },
    ]);
    const notifier = new RecordingNotifier();

    // `everyone` resolves from `memberships` and describes no fixture. The
    // routes cannot produce this pair, and the sender makes it harmless rather
    // than trusting them to (review, Important 1).
    const result = await send(gameId, fixtureId, notifier, { audience: "everyone" });

    expect(result).toMatchObject({ sent: 1, pushSent: 1 });
    // No fixture line in the copy, no fixture id on the rows, and the push
    // points at the game rather than at a response page for a fixture this
    // player was never asked about.
    expect(requireEmailMessage(emailMessages(notifier)[0]!).text).not.toContain("13 August");
    expect((await logRows()).map((r) => r.fixtureId)).toEqual([null, null]);
    const push = pushMessages(notifier)[0];
    if (push?.channel !== "push") throw new Error("expected a push message");
    expect(push.url).toBe(`https://makethe.team/g/${gameId}`);
  });

  it("messages a squad past D1's 100-bound-parameter ceiling", async () => {
    // The counterpart of `send-teams.test.ts`'s case of the same name, and
    // seeded the same way. `MAX_PLAYERS_CEILING` (src/domain/game-form.ts)
    // allows 200; 110 is comfortably past the limit `src/db/chunk.ts`
    // documents, and the inserts below are chunked because a single 110-row
    // insert would trip the very limit this test exists to prove the *read*
    // path does not trip. Both channels are on, so the id list handed to
    // `playersWithPushSubscriptions` is all 110 — the one place this sender
    // builds an `IN (...)` of player ids at all.
    const SQUAD_SIZE = 110;
    const gameId = await insertGame(db, { name: "Big Thursday", venueName: "Oxford Sports Park" });
    const fixtureId = crypto.randomUUID();
    await db.insert(fixtures).values({
      id: fixtureId,
      gameId,
      kicksOffAt: KICKOFF,
      lifecycle: "open",
      minPlayers: 2,
      maxPlayers: 200,
      prefersEvenNumbers: true,
      shortWarningOffsetHours: 12,
      durationMinutes: 60,
    });

    const playerRows = [];
    const membershipRows = [];
    const responseRows = [];
    for (let i = 0; i < SQUAD_SIZE; i++) {
      const id = `p${i}`;
      playerRows.push({ id, name: `Player ${i}`, email: `p${i}@example.com` });
      membershipRows.push({ id: `m-${id}`, gameId, playerId: id, active: true });
      responseRows.push({ id: `r-${id}`, fixtureId, playerId: id, status: "in" as const, source: "token" as const });
    }
    for (const batch of chunk(playerRows, INSERT_CHUNK_SIZE)) await db.insert(players).values(batch);
    for (const batch of chunk(membershipRows, INSERT_CHUNK_SIZE)) await db.insert(memberships).values(batch);
    for (const batch of chunk(responseRows, INSERT_CHUNK_SIZE)) await db.insert(responses).values(batch);
    // Two devices, not 110: the chunked lookup takes every id regardless of
    // how many come back, and generating 110 key pairs would only slow this.
    await insertSubscription(db, "p0", "https://push.example.com/p0");
    await insertSubscription(db, "p7", "https://push.example.com/p7");

    const notifier = new RecordingNotifier();

    const result = await send(gameId, fixtureId, notifier);

    expect(result).toEqual({
      sent: SQUAD_SIZE,
      failed: 0,
      deferred: 0,
      deferredPlayerIds: [],
      pushSent: 2,
      pushFailed: 0,
      skipped: 0,
    });
    expect(await logRows()).toHaveLength(SQUAD_SIZE + 2);
  });

  it("tags each broadcast with its own id, so two sends never collapse in the tray", async () => {
    const { gameId, fixtureId } = await seed([
      { id: "alice", name: "Alice", email: "alice@example.com", device: true },
    ]);
    const notifier = new RecordingNotifier();

    await send(gameId, fixtureId, notifier, { broadcastId: "bc-1", channels: { email: false, push: true } });
    await send(gameId, fixtureId, notifier, { broadcastId: "bc-2", channels: { email: false, push: true } });

    const tags = pushMessages(notifier).map((m) => (m.channel === "push" ? m.tag : ""));
    expect(tags).toEqual(["n10:bc-1", "n10:bc-2"]);
  });
});

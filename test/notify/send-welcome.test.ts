import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../src/db/client.js";
import { fixtures, memberships, notificationLog, players } from "../../src/db/schema.js";
import { welcomeKey } from "../../src/notify/dedupe-key.js";
import type { Message, Notifier, SendResult } from "../../src/notify/notifier.js";
import { DAILY_CEILING_REASON } from "../../src/notify/quota.js";
import { sendWelcomeEmail } from "../../src/notify/send-welcome.js";
import { insertGame, resetDatabase } from "../support/factories.js";

const db = getDb(env.DB);
const NOW = new Date("2026-08-12T09:00:00Z");
const JOINED_AT = NOW;
/** A week out, and deliberately later than the already-open fixture below. */
const NEXT_SCHEDULED = new Date("2026-08-20T18:00:00Z");
/** Already open when the player joined, so BR-2 says they are not in it. */
const ALREADY_OPEN = new Date("2026-08-13T18:00:00Z");

/** Records every message it was sent, in order, so a test can assert on it. */
class RecordingNotifier implements Notifier {
  readonly sent: Message[][] = [];
  /** Recipients this instance should report a provider failure for. */
  readonly failFor = new Set<string>();
  /** Recipients this instance should report as refused by the daily ceiling. */
  readonly ceilingFor = new Set<string>();

  /** Every message this notifier was ever handed, flattened across batches. */
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

/** Rejects outright, the way `QuotaNotifier.reserve()` does when D1 errors mid-batch. */
class RejectingNotifier implements Notifier {
  readonly sent: Message[][] = [];
  send(messages: readonly Message[]): Promise<SendResult[]> {
    this.sent.push([...messages]);
    return Promise.reject(new Error("simulated D1 failure inside QuotaNotifier.reserve()"));
  }
}

interface Joined {
  gameId: string;
  playerId: string;
  membershipId: string;
}

async function insertFixture(gameId: string, kicksOffAt: Date, lifecycle: "scheduled" | "open" | "cancelled") {
  await db.insert(fixtures).values({
    id: crypto.randomUUID(),
    gameId,
    kicksOffAt,
    lifecycle,
    minPlayers: 2,
    maxPlayers: 10,
    prefersEvenNumbers: true,
    shortWarningOffsetHours: 12,
    durationMinutes: 60,
  });
}

/**
 * One game the player has just joined. Mirrors what `joinSquad` leaves behind:
 * a `players` row, an active `memberships` row with `joinedAt`, and — unless
 * `withFixtures` says otherwise — a fixture already `open` (which BR-2 says
 * they are *not* in) plus the next `scheduled` one, which is their first.
 */
async function seedJoin(
  options: { email?: string | null; withFixtures?: boolean; joinedAt?: Date } = {},
): Promise<Joined> {
  const { email = "joiner@example.com", withFixtures = true, joinedAt = JOINED_AT } = options;

  const gameId = await insertGame(db, { name: "Thursday 7-a-side", venueName: "Oxford Sports Park" });
  const playerId = crypto.randomUUID();
  const membershipId = crypto.randomUUID();

  await db.insert(players).values({ id: playerId, name: "Alex", email });
  await db.insert(memberships).values({ id: membershipId, gameId, playerId, active: true, joinedAt });

  if (withFixtures) {
    await insertFixture(gameId, ALREADY_OPEN, "open");
    await insertFixture(gameId, NEXT_SCHEDULED, "scheduled");
  }

  return { gameId, playerId, membershipId };
}

function send(joined: Joined, notifier: Notifier, joinedAt: Date = JOINED_AT) {
  return sendWelcomeEmail({
    db,
    notifier,
    gameId: joined.gameId,
    playerId: joined.playerId,
    membershipId: joined.membershipId,
    joinedAt,
    now: NOW,
  });
}

async function logRows() {
  return db.select().from(notificationLog);
}

beforeEach(async () => {
  await resetDatabase();
});

describe("sendWelcomeEmail (N-6)", () => {
  it("sends once and records the log row", async () => {
    const joined = await seedJoin();
    const notifier = new RecordingNotifier();

    const outcome = await send(joined, notifier);

    expect(outcome).toEqual({ kind: "sent" });
    expect(notifier.all).toHaveLength(1);
    expect(notifier.all[0]?.to).toBe("joiner@example.com");
    expect(notifier.all[0]?.subject).toContain("Thursday 7-a-side");

    const rows = await logRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      notificationType: "n6",
      playerId: joined.playerId,
      channel: "email",
      status: "sent",
      dedupeKey: welcomeKey(joined.membershipId, JOINED_AT.toISOString()),
    });
  });

  it("names the next *scheduled* fixture, not the one already open (BR-2)", async () => {
    const joined = await seedJoin();
    const notifier = new RecordingNotifier();

    await send(joined, notifier);

    const message = notifier.all[0];
    // 20 August is the next `scheduled` fixture; 13 August is already `open`,
    // and the joiner has no `pending` response row for it.
    expect(message?.text).toContain("20 August");
    expect(message?.text).not.toContain("13 August");
    expect(message?.html).toContain("https://makethe.team/app");
  });

  it("stays honest, and still sends, when the game has no scheduled fixture yet", async () => {
    const joined = await seedJoin({ withFixtures: false });
    const notifier = new RecordingNotifier();

    const outcome = await send(joined, notifier);

    expect(outcome).toEqual({ kind: "sent" });
    expect(notifier.all[0]?.text).not.toContain("null");
    expect(notifier.all[0]?.html).not.toContain("null");
  });

  it("returns already-logged for a repeated send with the same joinedAt", async () => {
    const joined = await seedJoin();
    const notifier = new RecordingNotifier();

    await send(joined, notifier);
    const second = await send(joined, notifier);

    expect(second).toEqual({ kind: "already-logged" });
    expect(notifier.all).toHaveLength(1);
    expect(await logRows()).toHaveLength(1);
  });

  it("sends again after a rejoin, because joinedAt differs (§4.4)", async () => {
    const joined = await seedJoin();
    const notifier = new RecordingNotifier();

    await send(joined, notifier);

    // What `joinSquad` does on reactivation: the *same* membership row —
    // UNIQUE (game_id, player_id) forbids a second one — with a fresh
    // `joined_at`. The membership id alone would collide here and the unique
    // index on `dedupe_key` would silently drop this second welcome.
    const rejoinedAt = new Date(JOINED_AT.getTime() + 86_400_000);
    const second = await send(joined, notifier, rejoinedAt);

    expect(second).toEqual({ kind: "sent" });
    expect(notifier.all).toHaveLength(2);
    const rows = await logRows();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.dedupeKey).sort()).toEqual(
      [
        welcomeKey(joined.membershipId, JOINED_AT.toISOString()),
        welcomeKey(joined.membershipId, rejoinedAt.toISOString()),
      ].sort(),
    );
  });

  it("writes a notification_log row with a null fixture_id", async () => {
    const joined = await seedJoin();

    await send(joined, new RecordingNotifier());

    const rows = await logRows();
    expect(rows).toHaveLength(1);
    // N-6 is the only notification in the catalogue that is not about a
    // fixture, which is why this column has always been nullable (§2.8).
    expect(rows[0]?.fixtureId).toBeNull();
  });

  it("skips a player with no usable address without writing a row (BR-32)", async () => {
    const joined = await seedJoin({ email: null });
    const notifier = new RecordingNotifier();

    const outcome = await send(joined, notifier);

    expect(outcome).toEqual({ kind: "skipped-no-recipient" });
    expect(notifier.sent).toEqual([]);
    expect(await logRows()).toEqual([]);
  });

  it("skips a player whose address is blank whitespace, for the same reason", async () => {
    const joined = await seedJoin({ email: "   " });
    const notifier = new RecordingNotifier();

    const outcome = await send(joined, notifier);

    expect(outcome).toEqual({ kind: "skipped-no-recipient" });
    expect(notifier.sent).toEqual([]);
    expect(await logRows()).toEqual([]);
  });

  it("defers rather than failing when the daily ceiling refuses it", async () => {
    const joined = await seedJoin();
    const notifier = new RecordingNotifier();
    notifier.ceilingFor.add("joiner@example.com");

    const outcome = await send(joined, notifier);

    expect(outcome).toEqual({ kind: "deferred" });
    // Nothing reached an inbox, so the row is removed and a later attempt is
    // still possible — unlike the provider-error case below.
    expect(await logRows()).toEqual([]);
  });

  it("leaves the row failed after a provider error — never retried, because it may have been delivered", async () => {
    const joined = await seedJoin();
    const notifier = new RecordingNotifier();
    notifier.failFor.add("joiner@example.com");

    const outcome = await send(joined, notifier);

    expect(outcome).toEqual({ kind: "failed", reason: "simulated-provider-failure" });
    const rows = await logRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "failed", error: "simulated-provider-failure" });
  });

  it("does not throw when the notifier itself rejects, and leaves the row failed", async () => {
    const joined = await seedJoin();

    const outcome = await send(joined, new RejectingNotifier());

    expect(outcome.kind).toBe("failed");
    const rows = await logRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("failed");
  });

  it("reports, rather than throws, when the game or player has disappeared underneath it", async () => {
    const joined = await seedJoin();
    const notifier = new RecordingNotifier();

    const missingPlayer = await send({ ...joined, playerId: "nobody-by-that-id" }, notifier);
    expect(missingPlayer).toEqual({ kind: "skipped-no-recipient" });

    const missingGame = await send({ ...joined, gameId: "no-such-game" }, notifier);
    expect(missingGame.kind).toBe("failed");

    expect(notifier.sent).toEqual([]);
    expect(await logRows()).toEqual([]);
  });
});

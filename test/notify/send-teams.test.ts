import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { chunk, INSERT_CHUNK_SIZE } from "../../src/db/chunk.js";
import { getDb } from "../../src/db/client.js";
import { fixtures, memberships, notificationLog, players, responses } from "../../src/db/schema.js";
import { verifyLeaveToken } from "../../src/domain/token.js";
import { teamsKey } from "../../src/notify/dedupe-key.js";
import type { Message, Notifier, SendResult } from "../../src/notify/notifier.js";
import { DAILY_CEILING_REASON } from "../../src/notify/quota.js";
import { sendTeamsEmails } from "../../src/notify/send-teams.js";
import { insertGame, requireEmailMessage, resetDatabase } from "../support/factories.js";

const db = getDb(env.DB);
const SECRET = "test-secret";
const NOW = new Date("2026-08-12T09:00:00Z");
const KICKOFF = new Date("2026-08-13T18:00:00Z");
const PUBLISHED_AT = new Date("2026-08-12T09:05:00Z");

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

interface SquadMember {
  id: string;
  name: string;
  email: string | null;
  isGuest?: boolean;
  team?: "a" | "b" | null;
  status?: "in" | "out" | "waitlisted" | "pending" | "withdrawn";
}

/** One fixture, with an already-picked squad — as it would be right after `POST /g/:id/f/:fixtureId/teams`. */
async function seedFixture(
  squad: SquadMember[],
  gameOverrides: Partial<{ squadVisibleToPlayers: boolean; teamAName: string; teamBName: string }> = {},
): Promise<{ gameId: string; fixtureId: string }> {
  const gameId = await insertGame(db, {
    name: "Thursday 7-a-side",
    venueName: "Oxford Sports Park",
    ...gameOverrides,
  });
  const fixtureId = crypto.randomUUID();
  await db.insert(fixtures).values({
    id: fixtureId,
    gameId,
    kicksOffAt: KICKOFF,
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
    await db.insert(responses).values({
      id: `r-${member.id}`,
      fixtureId,
      playerId: member.id,
      status: member.status ?? "in",
      source: "token",
      team: member.team === undefined ? "a" : member.team,
    });
  }

  return { gameId, fixtureId };
}

async function send(fixtureId: string, notifier: Notifier, publishedAt = PUBLISHED_AT) {
  return sendTeamsEmails({ db, notifier, fixtureId, publishedAt, now: NOW, responseTokenSecret: SECRET });
}

async function logRows() {
  return db.select().from(notificationLog);
}

/** Pulls the token out of a `/leave/<token>` URL embedded in a message's HTML. */
function leaveTokenFrom(message: Message | undefined): string {
  const match = message && requireEmailMessage(message).html.match(/\/leave\/([^"]+)"/);
  if (!match?.[1]) throw new Error("no /leave/ link found in message html");
  return match[1];
}

beforeEach(async () => {
  await resetDatabase();
});

describe("sendTeamsEmails (N-9)", () => {
  it("emails every `in` player once, with an n9 row carrying the fixture id", async () => {
    const { fixtureId } = await seedFixture([
      { id: "alice", name: "Alice", email: "alice@example.com", team: "a" },
      { id: "bob", name: "Bob", email: "bob@example.com", team: "b" },
    ]);
    const notifier = new RecordingNotifier();

    const result = await send(fixtureId, notifier);

    expect(result).toEqual({ sent: 2, failed: 0, deferred: 0, deferredPlayerIds: [], guestsSkipped: 0 });
    expect(notifier.all.map((m) => m.to).sort()).toEqual(["alice@example.com", "bob@example.com"]);

    const rows = await logRows();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toMatchObject({ notificationType: "n9", fixtureId, channel: "email", status: "sent" });
    }
    const dedupeKeys = rows.map((r) => r.dedupeKey).sort();
    expect(dedupeKeys).toEqual(
      [
        teamsKey(fixtureId, "alice", PUBLISHED_AT.toISOString()),
        teamsKey(fixtureId, "bob", PUBLISHED_AT.toISOString()),
      ].sort(),
    );
  });

  it("carries a leave link scoped to the game", async () => {
    const { gameId, fixtureId } = await seedFixture([
      { id: "alice", name: "Alice", email: "alice@example.com", team: "a" },
    ]);
    const notifier = new RecordingNotifier();

    await send(fixtureId, notifier);

    const token = leaveTokenFrom(notifier.all[0]);
    const verified = await verifyLeaveToken(token, SECRET, NOW);

    expect(verified).toMatchObject({ ok: true, payload: { gameId, playerId: "alice" } });
  });

  it("skips a guest on a side, and a blank-address player, with no row for either (BR-32)", async () => {
    const { fixtureId } = await seedFixture([
      { id: "alice", name: "Alice", email: "alice@example.com", team: "a" },
      { id: "guest", name: "Guest", email: null, isGuest: true, team: "b" },
      { id: "blank", name: "Blank", email: "   ", team: "b" },
    ]);
    const notifier = new RecordingNotifier();

    const result = await send(fixtureId, notifier);

    expect(result).toEqual({ sent: 1, failed: 0, deferred: 0, deferredPlayerIds: [], guestsSkipped: 2 });
    expect(notifier.all).toHaveLength(1);
    expect(notifier.all[0]?.to).toBe("alice@example.com");
    const rows = await logRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.playerId).toBe("alice");
  });

  it("does not email a player who has withdrawn since being given a side", async () => {
    const { fixtureId } = await seedFixture([
      { id: "alice", name: "Alice", email: "alice@example.com", team: "a" },
      { id: "left", name: "Left", email: "left@example.com", team: "b", status: "withdrawn" },
    ]);
    const notifier = new RecordingNotifier();

    const result = await send(fixtureId, notifier);

    expect(result.sent).toBe(1);
    expect(notifier.all.map((m) => m.to)).toEqual(["alice@example.com"]);
  });

  it("re-publishing at a later instant sends again, rather than being swallowed as already-logged", async () => {
    const { fixtureId } = await seedFixture([
      { id: "alice", name: "Alice", email: "alice@example.com", team: "a" },
    ]);
    const notifier = new RecordingNotifier();

    const first = await send(fixtureId, notifier, PUBLISHED_AT);
    const second = await send(fixtureId, notifier, new Date(PUBLISHED_AT.getTime() + 60_000));

    expect(first).toEqual({ sent: 1, failed: 0, deferred: 0, deferredPlayerIds: [], guestsSkipped: 0 });
    expect(second).toEqual({ sent: 1, failed: 0, deferred: 0, deferredPlayerIds: [], guestsSkipped: 0 });
    expect(notifier.all).toHaveLength(2);

    const rows = await logRows();
    expect(rows).toHaveLength(2);
    const [firstKey, secondKey] = rows.map((r) => r.dedupeKey);
    expect(firstKey).not.toBe(secondKey);
  });

  it("re-publishing with the exact same instant is swallowed by the unique dedupe key", async () => {
    const { fixtureId } = await seedFixture([
      { id: "alice", name: "Alice", email: "alice@example.com", team: "a" },
    ]);
    const notifier = new RecordingNotifier();

    await send(fixtureId, notifier, PUBLISHED_AT);
    const second = await send(fixtureId, notifier, PUBLISHED_AT);

    expect(second).toEqual({ sent: 0, failed: 0, deferred: 0, deferredPlayerIds: [], guestsSkipped: 0 });
    expect(notifier.all).toHaveLength(1);
    expect(await logRows()).toHaveLength(1);
  });

  it("names the recipient's own side and omits the other side's names when the game hides the squad (BR-33)", async () => {
    const { fixtureId } = await seedFixture(
      [
        { id: "alice", name: "Alice", email: "alice@example.com", team: "a" },
        { id: "bob", name: "Bob", email: "bob@example.com", team: "b" },
      ],
      { squadVisibleToPlayers: false, teamAName: "Bibs", teamBName: "Skins" },
    );
    const notifier = new RecordingNotifier();

    await send(fixtureId, notifier);

    const aliceMessage = requireEmailMessage(notifier.all.find((m) => m.to === "alice@example.com")!);
    expect(aliceMessage.html).toContain("Bibs");
    expect(aliceMessage.text).toContain("Bibs");
    // Alice's own side is always named, but nobody else's name reaches her copy.
    expect(aliceMessage.html).not.toContain("Bob");
    expect(aliceMessage.text).not.toContain("Bob");
  });

  it("shows both full line-ups, including the recipient's own name, when the game shares the squad", async () => {
    const { fixtureId } = await seedFixture(
      [
        { id: "alice", name: "Alice", email: "alice@example.com", team: "a" },
        { id: "bob", name: "Bob", email: "bob@example.com", team: "b" },
      ],
      { squadVisibleToPlayers: true, teamAName: "Bibs", teamBName: "Skins" },
    );
    const notifier = new RecordingNotifier();

    await send(fixtureId, notifier);

    const aliceMessage = requireEmailMessage(notifier.all.find((m) => m.to === "alice@example.com")!);
    expect(aliceMessage.html).toContain("Bibs");
    expect(aliceMessage.html).toContain("Skins");
    expect(aliceMessage.html).toContain("Alice");
    expect(aliceMessage.html).toContain("Bob");
  });

  it("removes the row after a daily-ceiling refusal, so a later publish can retry", async () => {
    const { fixtureId } = await seedFixture([
      { id: "alice", name: "Alice", email: "alice@example.com", team: "a" },
      { id: "bob", name: "Bob", email: "bob@example.com", team: "b" },
    ]);
    const notifier = new RecordingNotifier();
    notifier.ceilingFor.add("bob@example.com");

    const result = await send(fixtureId, notifier);

    // Named, not counted: these ids are all that survives a ceiling refusal,
    // and the publish route writes them into `audit_log`.
    expect(result).toEqual({ sent: 1, failed: 0, deferred: 1, deferredPlayerIds: ["bob"], guestsSkipped: 0 });
    const rows = await logRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.playerId).toBe("alice");
  });

  it("leaves a row failed after a provider error — never retried", async () => {
    const { fixtureId } = await seedFixture([
      { id: "alice", name: "Alice", email: "alice@example.com", team: "a" },
    ]);
    const notifier = new RecordingNotifier();
    notifier.failFor.add("alice@example.com");

    const result = await send(fixtureId, notifier);

    expect(result).toEqual({ sent: 0, failed: 1, deferred: 0, deferredPlayerIds: [], guestsSkipped: 0 });
    const rows = await logRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "failed", error: "simulated-provider-failure" });
  });

  it("emails a squad past D1's 100-bound-parameter ceiling — the address lookup must not build an IN-list of player ids", async () => {
    // MAX_PLAYERS_CEILING (src/domain/game-form.ts) allows up to 200. 110 is
    // comfortably past the 100-bound-parameter limit `src/db/chunk.ts`
    // documents, and small enough to keep the test fast. Seeded with
    // chunked inserts, exactly as production code seeds any table this size
    // (INSERT_CHUNK_SIZE, same module) — a single unchunked insert of 110
    // rows would trip the very limit this test exists to prove the *read*
    // path no longer trips.
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
      responseRows.push({
        id: `r-${id}`,
        fixtureId,
        playerId: id,
        status: "in" as const,
        source: "token" as const,
        team: i % 2 === 0 ? ("a" as const) : ("b" as const),
      });
    }
    for (const batch of chunk(playerRows, INSERT_CHUNK_SIZE)) await db.insert(players).values(batch);
    for (const batch of chunk(membershipRows, INSERT_CHUNK_SIZE)) await db.insert(memberships).values(batch);
    for (const batch of chunk(responseRows, INSERT_CHUNK_SIZE)) await db.insert(responses).values(batch);

    const notifier = new RecordingNotifier();

    const result = await send(fixtureId, notifier);

    expect(result).toEqual({ sent: SQUAD_SIZE, failed: 0, deferred: 0, deferredPlayerIds: [], guestsSkipped: 0 });
    expect(notifier.all).toHaveLength(SQUAD_SIZE);
    const rows = await logRows();
    expect(rows).toHaveLength(SQUAD_SIZE);
  });
});

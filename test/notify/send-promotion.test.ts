import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../src/db/client.js";
import { fixtures, memberships, notificationLog, players, responses } from "../../src/db/schema.js";
import { promotionKey } from "../../src/notify/dedupe-key.js";
import type { Message, Notifier, SendResult } from "../../src/notify/notifier.js";
import { DAILY_CEILING_REASON } from "../../src/notify/quota.js";
import { sendPromotionEmail } from "../../src/notify/send-promotion.js";
import { insertGame, resetDatabase } from "../support/factories.js";

const db = getDb(env.DB);
const SECRET = "test-secret";
const NOW = new Date("2026-08-12T09:00:00Z");
const KICKOFF = new Date("2026-08-13T18:00:00Z");

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

interface SquadMember {
  id: string;
  name: string;
  email: string | null;
  isGuest?: boolean;
}

/**
 * One open fixture whose squad is `squad`, everyone `in`. Only the shape the
 * promotion send path reads matters here — it never re-derives capacity, and
 * the promotion itself has already happened inside the Durable Object by the
 * time this code runs.
 */
async function seedFixture(squad: SquadMember[]): Promise<{ gameId: string; fixtureId: string }> {
  const gameId = await insertGame(db, { name: "Thursday 7-a-side", venueName: "Oxford Sports Park" });
  const fixtureId = crypto.randomUUID();
  await db.insert(fixtures).values({
    id: fixtureId,
    gameId,
    kicksOffAt: KICKOFF,
    lifecycle: "open",
    minPlayers: 2,
    maxPlayers: 2,
    prefersEvenNumbers: true,
    shortWarningOffsetHours: 12,
    durationMinutes: 60,
  });

  for (const member of squad) {
    await db
      .insert(players)
      .values({ id: member.id, name: member.name, email: member.email, isGuest: member.isGuest ?? false });
    await db.insert(memberships).values({ id: `m-${member.id}`, gameId, playerId: member.id, active: true });
    await db
      .insert(responses)
      .values({ id: `r-${member.id}`, fixtureId, playerId: member.id, status: "in", source: "token" });
  }

  return { gameId, fixtureId };
}

function promotion(playerId: string, promotedAt = NOW.getTime()) {
  return { playerId, previousWaitlistPosition: 1, promotedAt };
}

async function send(
  fixtureId: string,
  notifier: Notifier,
  promoted: { playerId: string; previousWaitlistPosition: number; promotedAt: number },
) {
  return sendPromotionEmail({
    db,
    notifier,
    fixtureId,
    promoted,
    now: NOW,
    responseTokenSecret: SECRET,
  });
}

async function logRows() {
  return db.select().from(notificationLog);
}

beforeEach(async () => {
  await resetDatabase();
});

describe("sendPromotionEmail (N-2)", () => {
  it("emails the promoted player, and nobody else", async () => {
    const { fixtureId } = await seedFixture([
      { id: "dropper", name: "Dropper", email: "dropper@example.com" },
      { id: "promoted", name: "Promoted", email: "promoted@example.com" },
      { id: "bystander", name: "Bystander", email: "bystander@example.com" },
    ]);
    const notifier = new RecordingNotifier();

    const outcome = await send(fixtureId, notifier, promotion("promoted"));

    expect(outcome).toEqual({ kind: "sent" });
    expect(notifier.all).toHaveLength(1);
    expect(notifier.all[0]?.to).toBe("promoted@example.com");
    // N-2 goes to exactly one person (J4): the squad's other addresses are
    // never handed to the notifier at all.
    const recipients = notifier.all.map((m) => m.to);
    expect(recipients).not.toContain("dropper@example.com");
    expect(recipients).not.toContain("bystander@example.com");
  });

  it("sends the promotion template, addressed and dedupe-keyed to this promotion", async () => {
    const { fixtureId } = await seedFixture([{ id: "promoted", name: "Promoted", email: "promoted@example.com" }]);
    const notifier = new RecordingNotifier();

    await send(fixtureId, notifier, promotion("promoted"));

    const message = notifier.all[0];
    expect(message?.subject).toContain("Thursday 7-a-side");
    expect(message?.subject.toLowerCase()).toMatch(/you.re in/);
    expect(message?.html).toContain("Oxford Sports Park");
    expect(message?.text).toContain("Oxford Sports Park");
    expect(message?.dedupeKey).toBe(promotionKey(fixtureId, "promoted", NOW.toISOString()));
    // Every link is server-built against the site's own origin — nothing in
    // this path takes a URL from a request.
    expect(message?.html).toContain("https://makethe.team/r/");
    expect(message?.html).toContain("https://makethe.team/leave/");
  });

  it("records the send in notification_log as an n2 row for the promoted player", async () => {
    const { fixtureId } = await seedFixture([{ id: "promoted", name: "Promoted", email: "promoted@example.com" }]);

    await send(fixtureId, new RecordingNotifier(), promotion("promoted"));

    const rows = await logRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      notificationType: "n2",
      fixtureId,
      playerId: "promoted",
      channel: "email",
      status: "sent",
      dedupeKey: promotionKey(fixtureId, "promoted", NOW.toISOString()),
    });
  });

  it("skips a promoted guest with no email — no error, no message, and no log row (BR-32)", async () => {
    const { fixtureId } = await seedFixture([{ id: "promoted", name: "Guest", email: null, isGuest: true }]);
    const notifier = new RecordingNotifier();

    const outcome = await send(fixtureId, notifier, promotion("promoted"));

    expect(outcome).toEqual({ kind: "skipped-no-recipient" });
    expect(notifier.sent).toEqual([]);
    // Deliberately unlike the ceiling case, which *does* write a row and then
    // removes it: there is nothing to retry here, ever, so nothing is written.
    expect(await logRows()).toEqual([]);
  });

  it("skips a promoted player whose email is blank whitespace, for the same reason", async () => {
    const { fixtureId } = await seedFixture([{ id: "promoted", name: "Blank", email: "   " }]);
    const notifier = new RecordingNotifier();

    const outcome = await send(fixtureId, notifier, promotion("promoted"));

    expect(outcome).toEqual({ kind: "skipped-no-recipient" });
    expect(notifier.sent).toEqual([]);
    expect(await logRows()).toEqual([]);
  });

  it("leaves the row `failed` after a provider error — never retried, because it may have been delivered", async () => {
    const { fixtureId } = await seedFixture([{ id: "promoted", name: "Promoted", email: "promoted@example.com" }]);
    const notifier = new RecordingNotifier();
    notifier.failFor.add("promoted@example.com");

    const outcome = await send(fixtureId, notifier, promotion("promoted"));

    expect(outcome).toEqual({ kind: "failed", reason: "simulated-provider-failure" });
    const rows = await logRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "failed", error: "simulated-provider-failure" });
  });

  it("removes the row after a daily-ceiling refusal — nothing reached an inbox, so it stays retryable", async () => {
    const { fixtureId } = await seedFixture([{ id: "promoted", name: "Promoted", email: "promoted@example.com" }]);
    const notifier = new RecordingNotifier();
    notifier.ceilingFor.add("promoted@example.com");

    const outcome = await send(fixtureId, notifier, promotion("promoted"));

    expect(outcome).toEqual({ kind: "deferred" });
    expect(await logRows()).toEqual([]);
  });

  it("does not throw when the notifier itself rejects, and leaves the row failed", async () => {
    const { fixtureId } = await seedFixture([{ id: "promoted", name: "Promoted", email: "promoted@example.com" }]);

    const outcome = await send(fixtureId, new RejectingNotifier(), promotion("promoted"));

    expect(outcome.kind).toBe("failed");
    const rows = await logRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("failed");
  });

  it("sends nothing a second time for the same promotion — the unique dedupe_key is the guarantee", async () => {
    const { fixtureId } = await seedFixture([{ id: "promoted", name: "Promoted", email: "promoted@example.com" }]);
    const notifier = new RecordingNotifier();

    await send(fixtureId, notifier, promotion("promoted"));
    const second = await send(fixtureId, notifier, promotion("promoted"));

    expect(second).toEqual({ kind: "already-logged" });
    expect(notifier.all).toHaveLength(1);
    expect(await logRows()).toHaveLength(1);
  });

  it("does send again for a *later* promotion of the same player (N-2 is keyed per promotion, unlike N-4)", async () => {
    const { fixtureId } = await seedFixture([{ id: "promoted", name: "Promoted", email: "promoted@example.com" }]);
    const notifier = new RecordingNotifier();

    await send(fixtureId, notifier, promotion("promoted"));
    const second = await send(fixtureId, notifier, promotion("promoted", NOW.getTime() + 60_000));

    expect(second).toEqual({ kind: "sent" });
    expect(notifier.all).toHaveLength(2);
    expect(await logRows()).toHaveLength(2);
  });

  it("reports, rather than throws, when the fixture has disappeared underneath it", async () => {
    const { fixtureId } = await seedFixture([{ id: "promoted", name: "Promoted", email: "promoted@example.com" }]);
    await db.delete(responses).where(eq(responses.fixtureId, fixtureId));
    await db.delete(fixtures).where(eq(fixtures.id, fixtureId));
    const notifier = new RecordingNotifier();

    const outcome = await send(fixtureId, notifier, promotion("promoted"));

    expect(outcome.kind).toBe("fixture-not-found");
    expect(notifier.sent).toEqual([]);
    expect(await logRows()).toEqual([]);
  });

  it("reports, rather than throws, when the promoted player has disappeared underneath it", async () => {
    const { fixtureId } = await seedFixture([{ id: "promoted", name: "Promoted", email: "promoted@example.com" }]);
    const notifier = new RecordingNotifier();

    const outcome = await send(fixtureId, notifier, promotion("nobody-by-that-id"));

    expect(outcome.kind).toBe("player-not-found");
    expect(notifier.sent).toEqual([]);
    expect(await logRows()).toEqual([]);
  });
});

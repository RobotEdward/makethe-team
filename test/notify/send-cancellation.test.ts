import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../src/db/client.js";
import { fixtures, memberships, notificationLog, players } from "../../src/db/schema.js";
import { verifyLeaveToken } from "../../src/domain/token.js";
import { cancellationKey } from "../../src/notify/dedupe-key.js";
import type { Message, Notifier, SendResult } from "../../src/notify/notifier.js";
import { DAILY_CEILING_REASON } from "../../src/notify/quota.js";
import { sendCancellationEmails } from "../../src/notify/send-cancellation.js";
import { insertGame, requireEmailMessage, resetDatabase } from "../support/factories.js";

const db = getDb(env.DB);
const SECRET = "test-secret";
const NOW = new Date("2026-08-12T09:00:00Z");
const KICKOFF = new Date("2026-08-13T18:00:00Z");

/** Records every message it was sent, in order, so a test can assert on it. */
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

interface Recipient {
  playerId: string;
  name: string;
  email: string | null;
  status: "in" | "waitlisted";
}

async function seedFixture(recipients: Recipient[]): Promise<{ gameId: string; fixtureId: string }> {
  const gameId = await insertGame(db, { name: "Thursday 7-a-side", venueName: "Oxford Sports Park" });
  const fixtureId = crypto.randomUUID();
  await db.insert(fixtures).values({
    id: fixtureId,
    gameId,
    kicksOffAt: KICKOFF,
    lifecycle: "cancelled",
    minPlayers: 2,
    maxPlayers: 14,
    prefersEvenNumbers: true,
    shortWarningOffsetHours: 12,
    durationMinutes: 60,
  });

  for (const recipient of recipients) {
    await db.insert(players).values({ id: recipient.playerId, name: recipient.name, email: recipient.email });
    await db
      .insert(memberships)
      .values({ id: `m-${recipient.playerId}`, gameId, playerId: recipient.playerId, active: true });
  }

  return { gameId, fixtureId };
}

async function send(fixtureId: string, gameId: string, notifier: Notifier, recipients: Recipient[]) {
  return sendCancellationEmails({
    db,
    notifier,
    fixture: { id: fixtureId, kicksOffAt: KICKOFF, venueOverride: null },
    game: { id: gameId, name: "Thursday 7-a-side", venueName: "Oxford Sports Park", timezone: "Europe/London" },
    recipients,
    reason: "Pitch flooded",
    now: NOW,
    responseTokenSecret: SECRET,
  });
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

describe("sendCancellationEmails (N-3)", () => {
  it("carries a leave link scoped to the game, not the fixture", async () => {
    const recipients: Recipient[] = [
      { playerId: "p-in", name: "In Player", email: "in@example.com", status: "in" },
    ];
    const { gameId, fixtureId } = await seedFixture(recipients);
    const notifier = new RecordingNotifier();

    await send(fixtureId, gameId, notifier, recipients);

    const token = leaveTokenFrom(notifier.all[0]);
    const verified = await verifyLeaveToken(token, SECRET, NOW);

    expect(verified).toMatchObject({ ok: true, payload: { gameId, playerId: "p-in" } });
  });

  it("emails every recipient handed to it, addressed and dedupe-keyed per player", async () => {
    const recipients: Recipient[] = [
      { playerId: "p-in", name: "In Player", email: "in@example.com", status: "in" },
      { playerId: "p-wait", name: "Wait Player", email: "wait@example.com", status: "waitlisted" },
    ];
    const { gameId, fixtureId } = await seedFixture(recipients);
    const notifier = new RecordingNotifier();

    const summary = await send(fixtureId, gameId, notifier, recipients);

    expect(summary.sent).toBe(2);
    expect(notifier.all.map((m) => m.to).sort()).toEqual(["in@example.com", "wait@example.com"]);
    const rows = await logRows();
    expect(rows.map((r) => r.dedupeKey).sort()).toEqual(
      [cancellationKey(fixtureId, "p-in"), cancellationKey(fixtureId, "p-wait")].sort(),
    );
  });

  it("skips a recipient with no usable address, without writing a row (BR-32)", async () => {
    const recipients: Recipient[] = [{ playerId: "p-blank", name: "Blank", email: "   ", status: "in" }];
    const { gameId, fixtureId } = await seedFixture(recipients);
    const notifier = new RecordingNotifier();

    const summary = await send(fixtureId, gameId, notifier, recipients);

    expect(summary.skippedNoRecipient).toBe(1);
    expect(summary.sent).toBe(0);
    expect(notifier.sent).toEqual([]);
    expect(await logRows()).toEqual([]);
  });
});

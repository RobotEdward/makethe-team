import { beforeEach, describe, expect, it } from "vitest";
import { notificationLog } from "../../src/db/schema.js";
import { pushKey, removalKey } from "../../src/notify/dedupe-key.js";
import { sendRemovedEmail } from "../../src/notify/send-removed.js";
import type { Message, Notifier } from "../../src/notify/notifier.js";
import {
  insertGame,
  insertPlayer,
  insertSubscription,
  requireEmailMessage,
  resetDatabase,
  testDb,
} from "../support/factories.js";

const NOW = new Date("2026-08-13T12:00:00Z");
const LEFT_AT = new Date("2026-08-13T11:59:00Z");

function recordingNotifier(): Notifier & { sent: Message[] } {
  const sent: Message[] = [];
  return {
    sent,
    async send(messages: readonly Message[]) {
      sent.push(...messages);
      return messages.map(() => ({ ok: true as const, providerMessageId: null }));
    },
  };
}

describe("sendRemovedEmail", () => {
  beforeEach(resetDatabase);

  it("sends the email and records a sent log row with no fixture", async () => {
    const db = testDb();
    const gameId = await insertGame(db, { name: "Thursday 7-a-side" });
    const playerId = await insertPlayer(db, { name: "Sam Okafor", email: "sam@example.com" });
    const notifier = recordingNotifier();

    const outcome = await sendRemovedEmail({
      db, notifier, gameId, playerId, membershipId: "m-1", leftAt: LEFT_AT, now: NOW,
    });

    expect(outcome).toEqual({ kind: "sent" });
    expect(notifier.sent[0]).toMatchObject({ to: "sam@example.com" });
    expect(requireEmailMessage(notifier.sent[0]!).subject).toContain("Thursday 7-a-side");

    const [row] = await db.select().from(notificationLog);
    expect(row).toMatchObject({
      notificationType: "n7",
      // Null, like N-6: a removal is not fixture-scoped, and naming a fixture
      // would make the row a lie.
      fixtureId: null,
      playerId,
      status: "sent",
      dedupeKey: `n7:m-1:${LEFT_AT.toISOString()}`,
    });
  });

  it("queues a push alongside the email for a player with a device", async () => {
    const db = testDb();
    const gameId = await insertGame(db, { name: "Thursday 7-a-side" });
    const playerId = await insertPlayer(db, { name: "Sam Okafor", email: "sam@example.com" });
    await insertSubscription(db, playerId, "https://push.example.com/sam");
    const notifier = recordingNotifier();

    const outcome = await sendRemovedEmail({
      db, notifier, gameId, playerId, membershipId: "m-1", leftAt: LEFT_AT, now: NOW,
    });

    expect(outcome).toEqual({ kind: "sent" });
    const rows = await db.select().from(notificationLog);
    expect(rows.map((r) => r.channel).sort()).toEqual(["email", "push"]);
    const emailKey = removalKey("m-1", LEFT_AT.toISOString());
    expect(rows.find((r) => r.channel === "push")?.dedupeKey).toBe(pushKey(emailKey));
    const pushMessage = notifier.sent.find((m) => m.channel === "push");
    expect(pushMessage).toMatchObject({ channel: "push", to: playerId });
  });

  it("still emails a player with no device at all", async () => {
    const db = testDb();
    const gameId = await insertGame(db, { name: "Thursday 7-a-side" });
    const playerId = await insertPlayer(db, { name: "Sam Okafor", email: "sam@example.com" });
    const notifier = recordingNotifier();

    await sendRemovedEmail({ db, notifier, gameId, playerId, membershipId: "m-1", leftAt: LEFT_AT, now: NOW });

    const rows = await db.select().from(notificationLog);
    expect(rows.map((r) => r.channel)).toEqual(["email"]);
  });

  it("skips a player with no address and writes no row at all (BR-32)", async () => {
    const db = testDb();
    const gameId = await insertGame(db);
    const playerId = await insertPlayer(db, { name: "Ringer", email: null, isGuest: true });
    const notifier = recordingNotifier();

    expect(
      await sendRemovedEmail({ db, notifier, gameId, playerId, membershipId: "m-1", leftAt: LEFT_AT, now: NOW }),
    ).toEqual({ kind: "skipped-no-recipient" });
    expect(notifier.sent).toHaveLength(0);
    // Not a failure and not retryable, so not a row — a row here would be
    // noise that something later has to clean up.
    expect(await db.select().from(notificationLog)).toHaveLength(0);
  });

  it("skips a blank address, which is truthy but unusable", async () => {
    const db = testDb();
    const gameId = await insertGame(db);
    const playerId = await insertPlayer(db, { email: "   " });
    const notifier = recordingNotifier();

    expect(
      await sendRemovedEmail({ db, notifier, gameId, playerId, membershipId: "m-1", leftAt: LEFT_AT, now: NOW }),
    ).toEqual({ kind: "skipped-no-recipient" });
  });

  it("does not send twice for the same removal", async () => {
    const db = testDb();
    const gameId = await insertGame(db);
    const playerId = await insertPlayer(db);
    const notifier = recordingNotifier();
    const args = { db, notifier, gameId, playerId, membershipId: "m-1", leftAt: LEFT_AT, now: NOW };

    await sendRemovedEmail(args);
    // The unique index on `dedupe_key`, not any cleverness here, is what makes
    // this safe under concurrency.
    expect(await sendRemovedEmail(args)).toEqual({ kind: "already-logged" });
    expect(notifier.sent).toHaveLength(1);
  });

  it("sends again after a rejoin and a second removal", async () => {
    const db = testDb();
    const gameId = await insertGame(db);
    const playerId = await insertPlayer(db);
    const notifier = recordingNotifier();
    const base = { db, notifier, gameId, playerId, membershipId: "m-1", now: NOW };

    await sendRemovedEmail({ ...base, leftAt: LEFT_AT });
    await sendRemovedEmail({ ...base, leftAt: new Date("2026-09-01T09:00:00Z") });

    expect(notifier.sent).toHaveLength(2);
  });

  it("reports a game that has vanished, without writing a row", async () => {
    const db = testDb();
    const playerId = await insertPlayer(db);
    const notifier = recordingNotifier();

    expect(
      await sendRemovedEmail({
        db, notifier, gameId: crypto.randomUUID(), playerId, membershipId: "m-1", leftAt: LEFT_AT, now: NOW,
      }),
    ).toEqual({ kind: "failed", reason: "game-not-found" });
    expect(await db.select().from(notificationLog)).toHaveLength(0);
  });
});

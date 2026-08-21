import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../src/db/client.js";
import { auditLog, notificationLog } from "../../src/db/schema.js";
import { pushKey, resultNudgeKey } from "../../src/notify/dedupe-key.js";
import { DAILY_CEILING_REASON } from "../../src/notify/quota.js";
import type { Message, Notifier, PushMessage, SendResult } from "../../src/notify/notifier.js";
import { RESULT_NUDGE_WINDOW_MS, sendResultNudges } from "../../src/notify/send-result-nudge.js";
import { requireEmailMessage, insertFixture, insertGame, insertMembership, insertPlayer, insertResponse, insertSubscription, resetDatabase } from "../support/factories.js";

const db = getDb(env.DB);

const KICKOFF = new Date("2026-08-13T19:00:00Z");
const DURATION_MINUTES = 60;
const FULL_TIME = new Date(KICKOFF.getTime() + DURATION_MINUTES * 60_000);

/** Just inside the twelve-hour window: full time was 1 hour ago. */
const WITHIN_WINDOW_NOW = new Date(FULL_TIME.getTime() + 60 * 60 * 1000);
/** Exactly at the window's edge: full time was 12h and 1ms ago — excluded. */
const JUST_OUTSIDE_WINDOW_NOW = new Date(FULL_TIME.getTime() + RESULT_NUDGE_WINDOW_MS + 1);

/**
 * A `Notifier` test double that records every message it is asked to send
 * and lets a test script a per-recipient ceiling refusal or failure — the
 * same shape `RecordingNotifier` takes in `test/notify/send-teams.test.ts`
 * and `test/sweep/group-nudge.test.ts`.
 *
 * This is not the fetch-injection trap the milestone brief warns about:
 * `sendResultNudges` never touches `fetch` itself, it calls `notifier.send`,
 * an ordinary method call on an object this class controls. The "ordinary
 * function that checks its receiver" stub belongs to `PushNotifier`'s own
 * suite (`test/notify/push-notifier.test.ts`), which stubs the *global*
 * `fetch` a class field injects and later calls as `this.fetchImpl(...)`.
 * `Notifier.send` here has no such indirection to hide a lost receiver
 * behind, so an arrow-free ordinary class method is the correct and
 * sufficient double.
 */
class RecordingNotifier implements Notifier {
  readonly all: Message[] = [];
  readonly ceilingFor = new Set<string>();
  readonly failFor = new Set<string>();

  send(messages: readonly Message[]): Promise<SendResult[]> {
    this.all.push(...messages);
    return Promise.resolve(
      messages.map((m): SendResult => {
        if (this.ceilingFor.has(m.to)) return { ok: false, error: DAILY_CEILING_REASON };
        if (this.failFor.has(m.to)) return { ok: false, error: "simulated-provider-failure" };
        return { ok: true, providerMessageId: `prov-${m.dedupeKey}` };
      }),
    );
  }

  pushes(): PushMessage[] {
    return this.all.filter((m): m is PushMessage => m.channel === "push");
  }
}

async function logRows() {
  return db.select().from(notificationLog);
}

beforeEach(resetDatabase);

describe("sendResultNudges", () => {
  it("nudges everyone who was in, once", async () => {
    const gameId = await insertGame(db);
    const alice = await insertPlayer(db, { name: "Alice", email: "alice@example.com" });
    const bob = await insertPlayer(db, { name: "Bob", email: "bob@example.com" });
    await insertMembership(db, gameId, alice);
    await insertMembership(db, gameId, bob);
    const fixtureId = await insertFixture(db, gameId, {
      lifecycle: "played",
      kicksOffAt: KICKOFF,
      durationMinutes: DURATION_MINUTES,
    });
    await insertResponse(db, fixtureId, alice, { status: "in" });
    await insertResponse(db, fixtureId, bob, { status: "in" });

    const notifier = new RecordingNotifier();
    const result = await sendResultNudges(db, notifier, WITHIN_WINDOW_NOW);

    expect(result.fixturesConsidered).toBe(1);
    expect(result.emailSent).toBe(2);
    expect(result.failures).toHaveLength(0);
    const emails = notifier.all.map((m) => requireEmailMessage(m).to).sort();
    expect(emails).toEqual(["alice@example.com", "bob@example.com"]);
  });

  it("nudges an active organiser who did not play", async () => {
    const gameId = await insertGame(db);
    const owner = await insertPlayer(db, { name: "Owner", email: "owner@example.com" });
    await insertMembership(db, gameId, owner, { role: "owner" });
    await insertFixture(db, gameId, {
      lifecycle: "played",
      kicksOffAt: KICKOFF,
      durationMinutes: DURATION_MINUTES,
    });
    // No response row at all: the organiser never answered, but
    // `resultElectorate` still counts every active owner.

    const notifier = new RecordingNotifier();
    const result = await sendResultNudges(db, notifier, WITHIN_WINDOW_NOW);

    expect(result.emailSent).toBe(1);
    expect(requireEmailMessage(notifier.all[0]!).to).toBe("owner@example.com");
  });

  it("never nudges a guest", async () => {
    const gameId = await insertGame(db);
    const guest = await insertPlayer(db, { name: "Guest", email: null, isGuest: true });
    const fixtureId = await insertFixture(db, gameId, {
      lifecycle: "played",
      kicksOffAt: KICKOFF,
      durationMinutes: DURATION_MINUTES,
    });
    await insertResponse(db, fixtureId, guest, { status: "in" });

    const notifier = new RecordingNotifier();
    const result = await sendResultNudges(db, notifier, WITHIN_WINDOW_NOW);

    // `resultElectorate` excludes guests from `eligibleIds` itself, so this
    // fixture has nobody to nudge at all.
    expect(result.emailSent).toBe(0);
    expect(result.pushSent).toBe(0);
    expect(result.skippedNoAddress).toBe(0);
    expect(notifier.all).toHaveLength(0);
  });

  it("never nudges a player with no email and no device (BR-32)", async () => {
    const gameId = await insertGame(db);
    const noAddress = await insertPlayer(db, { name: "No Address", email: null });
    await insertMembership(db, gameId, noAddress);
    const fixtureId = await insertFixture(db, gameId, {
      lifecycle: "played",
      kicksOffAt: KICKOFF,
      durationMinutes: DURATION_MINUTES,
    });
    await insertResponse(db, fixtureId, noAddress, { status: "in" });

    const notifier = new RecordingNotifier();
    const result = await sendResultNudges(db, notifier, WITHIN_WINDOW_NOW);

    expect(result.skippedNoAddress).toBe(1);
    expect(notifier.all).toHaveLength(0);
    expect(await logRows()).toHaveLength(0);
  });

  it("falls back to push for a player with a device but no email", async () => {
    const gameId = await insertGame(db);
    const pushOnly = await insertPlayer(db, { name: "Push Only", email: null });
    await insertMembership(db, gameId, pushOnly);
    await insertSubscription(db, pushOnly, "https://push.example/device-1");
    const fixtureId = await insertFixture(db, gameId, {
      lifecycle: "played",
      kicksOffAt: KICKOFF,
      durationMinutes: DURATION_MINUTES,
    });
    await insertResponse(db, fixtureId, pushOnly, { status: "in" });

    const notifier = new RecordingNotifier();
    const result = await sendResultNudges(db, notifier, WITHIN_WINDOW_NOW);

    expect(result.emailSent).toBe(0);
    expect(result.pushSent).toBe(1);
    const push = notifier.pushes()[0]!;
    expect(push.to).toBe(pushOnly);
    expect(push.title).toBe("How did it go?");
  });

  it("does not nudge twice across two sweep runs", async () => {
    const gameId = await insertGame(db);
    const alice = await insertPlayer(db, { name: "Alice", email: "alice@example.com" });
    await insertMembership(db, gameId, alice);
    const fixtureId = await insertFixture(db, gameId, {
      lifecycle: "played",
      kicksOffAt: KICKOFF,
      durationMinutes: DURATION_MINUTES,
    });
    await insertResponse(db, fixtureId, alice, { status: "in" });

    const notifier = new RecordingNotifier();
    const first = await sendResultNudges(db, notifier, WITHIN_WINDOW_NOW);
    expect(first.emailSent).toBe(1);

    const secondTick = new Date(WITHIN_WINDOW_NOW.getTime() + 60 * 60 * 1000);
    const second = await sendResultNudges(db, notifier, secondTick);

    expect(second.emailSent).toBe(0);
    expect(second.alreadyNudged).toBe(1);
    expect(notifier.all).toHaveLength(1);
    expect(await logRows()).toHaveLength(1);
  });

  it("ignores a fixture whose full time was more than twelve hours ago", async () => {
    const gameId = await insertGame(db);
    const alice = await insertPlayer(db, { name: "Alice", email: "alice@example.com" });
    await insertMembership(db, gameId, alice);
    const fixtureId = await insertFixture(db, gameId, {
      lifecycle: "played",
      kicksOffAt: KICKOFF,
      durationMinutes: DURATION_MINUTES,
    });
    await insertResponse(db, fixtureId, alice, { status: "in" });

    const notifier = new RecordingNotifier();
    const result = await sendResultNudges(db, notifier, JUST_OUTSIDE_WINDOW_NOW);

    expect(result.fixturesConsidered).toBe(0);
    expect(notifier.all).toHaveLength(0);
  });

  it("ignores a cancelled fixture", async () => {
    const gameId = await insertGame(db);
    const alice = await insertPlayer(db, { name: "Alice", email: "alice@example.com" });
    await insertMembership(db, gameId, alice);
    const fixtureId = await insertFixture(db, gameId, {
      lifecycle: "cancelled",
      kicksOffAt: KICKOFF,
      durationMinutes: DURATION_MINUTES,
      cancelledAt: FULL_TIME,
    });
    await insertResponse(db, fixtureId, alice, { status: "in" });

    const notifier = new RecordingNotifier();
    const result = await sendResultNudges(db, notifier, WITHIN_WINDOW_NOW);

    expect(result.fixturesConsidered).toBe(0);
    expect(notifier.all).toHaveLength(0);
  });

  it("records fixture.result_nudge_email_deferred when the ceiling refuses", async () => {
    const gameId = await insertGame(db);
    const alice = await insertPlayer(db, { name: "Alice", email: "alice@example.com" });
    await insertMembership(db, gameId, alice);
    const fixtureId = await insertFixture(db, gameId, {
      lifecycle: "played",
      kicksOffAt: KICKOFF,
      durationMinutes: DURATION_MINUTES,
    });
    await insertResponse(db, fixtureId, alice, { status: "in" });

    const notifier = new RecordingNotifier();
    notifier.ceilingFor.add("alice@example.com");

    const result = await sendResultNudges(db, notifier, WITHIN_WINDOW_NOW);

    expect(result.emailDeferred).toBe(1);
    expect(result.emailSent).toBe(0);
    // The ceiling deletes the `notification_log` row so a retry stays
    // possible (`applySendResult`) — the audit row is the only durable trace
    // that Alice was ever owed this prompt.
    expect(await logRows()).toHaveLength(0);
    const rows = await db.select().from(auditLog).where(eq(auditLog.entityId, fixtureId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe("fixture.result_nudge_email_deferred");
  });

  it("links to the fixture page", async () => {
    const gameId = await insertGame(db);
    const alice = await insertPlayer(db, { name: "Alice", email: "alice@example.com" });
    await insertMembership(db, gameId, alice);
    const fixtureId = await insertFixture(db, gameId, {
      lifecycle: "played",
      kicksOffAt: KICKOFF,
      durationMinutes: DURATION_MINUTES,
    });
    await insertResponse(db, fixtureId, alice, { status: "in" });

    const notifier = new RecordingNotifier();
    await sendResultNudges(db, notifier, WITHIN_WINDOW_NOW);

    const email = requireEmailMessage(notifier.all[0]!);
    expect(email.html).toContain(`https://makethe.team/g/${gameId}/f/${fixtureId}`);
  });

  it("writes an n1 (email) and n12 (push) dedupe key that never collides across notification types", async () => {
    // Not one of the brief's named cases, but the cheapest possible guard
    // against a copy-paste of an existing key builder that forgot to change
    // its prefix — the unique index on `dedupe_key` would otherwise silently
    // drop this notification for anyone who had already had an unrelated
    // one.
    expect(resultNudgeKey("fix-1", "ply-1")).toBe("n12:fix-1:ply-1");
    expect(pushKey(resultNudgeKey("fix-1", "ply-1"))).toBe("push:n12:fix-1:ply-1");
  });
});

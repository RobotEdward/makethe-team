import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../src/db/client.js";
import { auditLog, notificationLog } from "../../src/db/schema.js";
import { pushKey, resultNudgeKey } from "../../src/notify/dedupe-key.js";
import { DAILY_CEILING_REASON } from "../../src/notify/quota.js";
import type { Message, Notifier, PushMessage, SendResult } from "../../src/notify/notifier.js";
import { RESULT_NUDGE_WINDOW_MS, sendResultNudges } from "../../src/notify/send-result-nudge.js";
import {
  requireEmailMessage,
  insertFixture,
  insertGame,
  insertMembership,
  insertPlayer,
  insertResponse,
  insertSubscription,
  resetDatabase,
} from "../support/factories.js";

const db = getDb(env.DB);

/** Any non-empty string satisfies `signLeaveToken` — nothing here inspects the token, only that a link was minted. */
const SECRET = "test-response-token-secret";

const KICKOFF = new Date("2026-08-13T19:00:00Z");
const DURATION_MINUTES = 60;
const FULL_TIME = new Date(KICKOFF.getTime() + DURATION_MINUTES * 60_000);

/** Just inside the twelve-hour window: full time was 1 hour ago. */
const WITHIN_WINDOW_NOW = new Date(FULL_TIME.getTime() + 60 * 60 * 1000);
/** Exactly at the window's edge: full time was exactly `RESULT_NUDGE_WINDOW_MS` ago — excluded, since the filter is a strict `<`. */
const EXACTLY_AT_WINDOW_EDGE_NOW = new Date(FULL_TIME.getTime() + RESULT_NUDGE_WINDOW_MS);
/** One past the edge: full time was 12h and 1ms ago — excluded, same as the exact-edge instant. */
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
    const result = await sendResultNudges(db, notifier, WITHIN_WINDOW_NOW, SECRET);

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
    const result = await sendResultNudges(db, notifier, WITHIN_WINDOW_NOW, SECRET);

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
    const result = await sendResultNudges(db, notifier, WITHIN_WINDOW_NOW, SECRET);

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
    const result = await sendResultNudges(db, notifier, WITHIN_WINDOW_NOW, SECRET);

    expect(result.skippedNoAddress).toBe(1);
    expect(notifier.all).toHaveLength(0);
    expect(await logRows()).toHaveLength(0);
  });

  it("falls back to email for a player with no registered device", async () => {
    const gameId = await insertGame(db);
    const emailOnly = await insertPlayer(db, { name: "Email Only", email: "email-only@example.com" });
    await insertMembership(db, gameId, emailOnly);
    const fixtureId = await insertFixture(db, gameId, {
      lifecycle: "played",
      kicksOffAt: KICKOFF,
      durationMinutes: DURATION_MINUTES,
    });
    await insertResponse(db, fixtureId, emailOnly, { status: "in" });

    const notifier = new RecordingNotifier();
    const result = await sendResultNudges(db, notifier, WITHIN_WINDOW_NOW, SECRET);

    expect(result.pushSent).toBe(0);
    expect(result.emailSent).toBe(1);
    expect(requireEmailMessage(notifier.all[0]!).to).toBe("email-only@example.com");
  });

  it("prefers push over email for a player with both, because the daily ceiling is email-only (TR-31)", async () => {
    const gameId = await insertGame(db);
    const both = await insertPlayer(db, { name: "Both Channels", email: "both@example.com" });
    await insertMembership(db, gameId, both);
    await insertSubscription(db, both, "https://push.example/device-1");
    const fixtureId = await insertFixture(db, gameId, {
      lifecycle: "played",
      kicksOffAt: KICKOFF,
      durationMinutes: DURATION_MINUTES,
    });
    await insertResponse(db, fixtureId, both, { status: "in" });

    const notifier = new RecordingNotifier();
    const result = await sendResultNudges(db, notifier, WITHIN_WINDOW_NOW, SECRET);

    expect(result.pushSent).toBe(1);
    expect(result.emailSent).toBe(0);
    const push = notifier.pushes()[0]!;
    expect(push.to).toBe(both);
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
    const first = await sendResultNudges(db, notifier, WITHIN_WINDOW_NOW, SECRET);
    expect(first.emailSent).toBe(1);

    const secondTick = new Date(WITHIN_WINDOW_NOW.getTime() + 60 * 60 * 1000);
    const second = await sendResultNudges(db, notifier, secondTick, SECRET);

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
    const result = await sendResultNudges(db, notifier, JUST_OUTSIDE_WINDOW_NOW, SECRET);

    expect(result.fixturesConsidered).toBe(0);
    expect(notifier.all).toHaveLength(0);
  });

  it("ignores a fixture at the exact twelve-hour boundary (now - fullTime === WINDOW_MS)", async () => {
    // The filter is `now - fullTime < RESULT_NUDGE_WINDOW_MS`, a strict
    // less-than — so the instant exactly `RESULT_NUDGE_WINDOW_MS` after full
    // time is the first excluded tick, not the last included one. Distinct
    // from the "more than twelve hours ago" case above, which is one
    // millisecond further out and would pass even a `<=` comparison too —
    // this is the one instant that tells the two operators apart.
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
    const result = await sendResultNudges(db, notifier, EXACTLY_AT_WINDOW_EDGE_NOW, SECRET);

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
    const result = await sendResultNudges(db, notifier, WITHIN_WINDOW_NOW, SECRET);

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

    const result = await sendResultNudges(db, notifier, WITHIN_WINDOW_NOW, SECRET);

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
    await sendResultNudges(db, notifier, WITHIN_WINDOW_NOW, SECRET);

    const email = requireEmailMessage(notifier.all[0]!);
    expect(email.html).toContain(`https://makethe.team/g/${gameId}/f/${fixtureId}`);
  });

  it("carries a BR-22 leave link scoped to the game, not the fixture", async () => {
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
    await sendResultNudges(db, notifier, WITHIN_WINDOW_NOW, SECRET);

    const email = requireEmailMessage(notifier.all[0]!);
    // A working `/leave/:token` link, same as every other game-scoped email
    // in the catalogue (BR-22) — N-12's recipients are current squad
    // members, so the N-7 exception (recipient already gone by send time)
    // does not reach this notification.
    expect(email.html).toContain("/leave/");
    expect(email.html).toContain("Leave this game");
    expect(email.text).toContain("Leave this game:");
  });

  it("carries no leave link on the push leg", async () => {
    // N-9 and N-11 never put a leave link on their push messages either —
    // there is no room for one in a title/body pair, and the tray action is
    // the fixture link itself.
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
    await sendResultNudges(db, notifier, WITHIN_WINDOW_NOW, SECRET);

    const push = notifier.pushes()[0]!;
    expect(push.url).not.toContain("/leave/");
  });

  it("writes an n12 dedupe key that never collides with another notification type's push key", () => {
    // Not one of the brief's named cases, but the cheapest possible guard
    // against a copy-paste of an existing key builder that forgot to change
    // its prefix — the unique index on `dedupe_key` would otherwise silently
    // drop this notification for anyone who had already had an unrelated
    // one.
    expect(resultNudgeKey("fix-1", "ply-1")).toBe("n12:fix-1:ply-1");
    expect(pushKey(resultNudgeKey("fix-1", "ply-1"))).toBe("push:n12:fix-1:ply-1");
  });
});

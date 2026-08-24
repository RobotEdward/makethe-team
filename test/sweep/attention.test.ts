import { env } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../src/db/client.js";
import { auditLog, fixtures, memberships, notificationLog, players, responses } from "../../src/db/schema.js";
import { attentionKey, pushKey } from "../../src/notify/dedupe-key.js";
import type { Message, Notifier, SendResult } from "../../src/notify/notifier.js";
import { verifyCancelToken } from "../../src/domain/token.js";
import { sendOwnerAttention } from "../../src/sweep/attention.js";
import { insertGame, insertSubscription, requireEmailMessage, resetDatabase } from "../support/factories.js";

const db = getDb(env.DB);
const SECRET = "test-cancel-secret";

/**
 * Every time is constructed explicitly rather than derived from the clock:
 * `Date.now()` is frozen between I/O in workerd and the test isolate's clock
 * drifts, and the warning window is exactly the kind of boundary that turns
 * that into a flake.
 */
const NOW = new Date("2026-08-13T09:00:00Z");
/** 12 hours before kickoff is the default `shortWarningOffsetHours`. */
const KICKOFF_INSIDE_WINDOW = new Date("2026-08-13T18:00:00Z"); // NOW + 9h
const KICKOFF_OUTSIDE_WINDOW = new Date("2026-08-14T18:00:00Z"); // NOW + 33h

class RecordingNotifier implements Notifier {
  readonly sent: Message[][] = [];
  readonly ceilingFor = new Set<string>();
  readonly failFor = new Set<string>();

  send(messages: readonly Message[]): Promise<SendResult[]> {
    this.sent.push([...messages]);
    return Promise.resolve(
      messages.map((m): SendResult => {
        if (this.ceilingFor.has(m.to)) return { ok: false, error: "daily-ceiling-reached" };
        if (this.failFor.has(m.to)) return { ok: false, error: "simulated-provider-failure" };
        return { ok: true, providerMessageId: `prov-${m.dedupeKey}` };
      }),
    );
  }
}

/** Rejects outright for one fixture — the shape of a D1 error inside `QuotaNotifier.reserve()`. */
class RejectingNotifier implements Notifier {
  readonly sent: Message[][] = [];
  readonly rejectForFixture = new Set<string>();

  send(messages: readonly Message[]): Promise<SendResult[]> {
    this.sent.push([...messages]);
    const first = messages[0];
    if (first && this.rejectForFixture.has(first.dedupeKey.split(":")[1] ?? "")) {
      return Promise.reject(new Error("simulated D1 failure inside QuotaNotifier.reserve()"));
    }
    return Promise.resolve(messages.map((m): SendResult => ({ ok: true, providerMessageId: `prov-${m.dedupeKey}` })));
  }
}

interface SeedOptions {
  kicksOffAt: Date;
  /** How many players hold a slot. Drives both `fixtures.in_count` and the `in` response rows. */
  inCount: number;
  minPlayers?: number;
  maxPlayers?: number;
  prefersEvenNumbers?: boolean;
  lifecycle?: "scheduled" | "open" | "cancelled" | "played";
  owners?: Array<{ name: string; email: string | null; isGuest?: boolean; active?: boolean }>;
  /** Squad members with no answer yet, listed in the email. */
  pending?: number;
  durationMinutes?: number;
  /** Defaults to the factory's own default ("Europe/London"). Overridden only to make `formatLocalDateTime` throw for one fixture in isolation tests. */
  timezone?: string;
  /** The owner's N-4 switch (M26). Defaults on, as a real game does. */
  shortWarningEnabled?: boolean;
  /** The Game's gating switch (M34, BR-39). Defaults off, as every pre-M34 game is. */
  gatedInvitesEnabled?: boolean;
  /** Hours before kickoff the fallback release starts (BR-44). Defaults to the factory's null — never. */
  gatedFallbackHoursBefore?: number | null;
  /**
   * Stamped on every response row this seed writes, so a gated fixture can be
   * described as "everyone who holds a row has been asked". Left null — the
   * pre-M34 state of every row — unless given.
   */
  invitedAt?: Date;
  /**
   * Active squad members holding a live `pending` row with a null `invited_at`:
   * a tier that has not been released yet. These are what BR-45 suppresses on.
   */
  heldBack?: number;
}

let seq = 0;
function nextId(kind: string): string {
  seq += 1;
  return `${kind}-${seq}`;
}

async function seed(opts: SeedOptions): Promise<{ gameId: string; fixtureId: string; ownerIds: string[] }> {
  const gameId = await insertGame(db, {
    prefersEvenNumbers: opts.prefersEvenNumbers ?? true,
    minPlayers: opts.minPlayers ?? 10,
    maxPlayers: opts.maxPlayers ?? 14,
    shortWarningEnabled: opts.shortWarningEnabled ?? true,
    gatedInvitesEnabled: opts.gatedInvitesEnabled ?? false,
    ...(opts.gatedFallbackHoursBefore !== undefined
      ? { gatedFallbackHoursBefore: opts.gatedFallbackHoursBefore }
      : {}),
    ...(opts.timezone !== undefined ? { timezone: opts.timezone } : {}),
  });
  const fixtureId = nextId("fixture");

  await db.insert(fixtures).values({
    id: fixtureId,
    gameId,
    kicksOffAt: opts.kicksOffAt,
    lifecycle: opts.lifecycle ?? "open",
    minPlayers: opts.minPlayers ?? 10,
    maxPlayers: opts.maxPlayers ?? 14,
    prefersEvenNumbers: opts.prefersEvenNumbers ?? true,
    shortWarningOffsetHours: 12,
    durationMinutes: opts.durationMinutes ?? 60,
    inCount: opts.inCount,
  });

  for (let i = 0; i < opts.inCount; i++) {
    const playerId = nextId("in");
    await db.insert(players).values({ id: playerId, name: `In ${i}`, email: `${playerId}@example.com` });
    await db.insert(memberships).values({ id: nextId("m"), gameId, playerId, role: "player", active: true });
    await db.insert(responses).values({
      id: nextId("r"),
      fixtureId,
      playerId,
      status: "in",
      source: "token",
      ...(opts.invitedAt !== undefined ? { invitedAt: opts.invitedAt } : {}),
    });
  }

  for (let i = 0; i < (opts.pending ?? 0); i++) {
    const playerId = nextId("pending");
    await db.insert(players).values({ id: playerId, name: `Pending ${i}`, email: `${playerId}@example.com` });
    await db.insert(memberships).values({ id: nextId("m"), gameId, playerId, role: "player", active: true });
    await db.insert(responses).values({
      id: nextId("r"),
      fixtureId,
      playerId,
      status: "pending",
      source: "system",
      ...(opts.invitedAt !== undefined ? { invitedAt: opts.invitedAt } : {}),
    });
  }

  for (let i = 0; i < (opts.heldBack ?? 0); i++) {
    const playerId = nextId("held");
    await db.insert(players).values({ id: playerId, name: `Held ${i}`, email: `${playerId}@example.com` });
    await db.insert(memberships).values({ id: nextId("m"), gameId, playerId, role: "player", active: true });
    // Null `invited_at` is the whole signal: a row exists (BR-2 backfills one
    // for every member when the fixture opens) but nobody has asked them yet.
    await db.insert(responses).values({ id: nextId("r"), fixtureId, playerId, status: "pending", source: "system" });
  }

  const ownerIds: string[] = [];
  for (const owner of opts.owners ?? [{ name: "Olive Owner", email: "owner@example.com" }]) {
    const playerId = nextId("owner");
    ownerIds.push(playerId);
    await db
      .insert(players)
      .values({ id: playerId, name: owner.name, email: owner.email, isGuest: owner.isGuest ?? false });
    await db.insert(memberships).values({
      id: nextId("m"),
      gameId,
      playerId,
      role: "owner",
      active: owner.active ?? true,
    });
  }

  return { gameId, fixtureId, ownerIds };
}

function run(notifier: Notifier, now: Date = NOW, ceilingReached = false) {
  return sendOwnerAttention({ db, notifier, now, cancelTokenSecret: SECRET, ceilingReached });
}

async function attentionRows(fixtureId: string) {
  return db
    .select()
    .from(notificationLog)
    .where(and(eq(notificationLog.fixtureId, fixtureId), eq(notificationLog.notificationType, "n4")));
}

beforeEach(async () => {
  await resetDatabase();
});

describe("sendOwnerAttention (N-4, BR-31)", () => {
  it("emails the owner when a fixture is short inside the warning window", async () => {
    const notifier = new RecordingNotifier();
    const { fixtureId, ownerIds } = await seed({ kicksOffAt: KICKOFF_INSIDE_WINDOW, inCount: 8, pending: 3 });

    const result = await run(notifier);

    expect(result.attentionSent).toBe(1);
    expect(notifier.sent.flat()).toHaveLength(1);
    const message = requireEmailMessage(notifier.sent.flat()[0]!);
    expect(message.to).toBe("owner@example.com");
    expect(message.dedupeKey).toBe(`n4:${fixtureId}:${ownerIds[0]}`);
    expect(message.text).toContain("2 players short");

    const rows = await attentionRows(fixtureId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("sent");
  });

  it("queues a push alongside the email for an owner with a device", async () => {
    const notifier = new RecordingNotifier();
    const { fixtureId, ownerIds } = await seed({ kicksOffAt: KICKOFF_INSIDE_WINDOW, inCount: 8, pending: 3 });
    await insertSubscription(db, ownerIds[0]!, "https://push.example.com/owner");

    const result = await run(notifier);

    // `attentionSent` stays a pure email count (review fix, Critical 2) —
    // `src/cron/handler.ts` logs it as one — with the push leg's own count
    // reported separately.
    expect(result.attentionSent).toBe(1);
    expect(result.pushAttentionSent).toBe(1);
    const rows = await attentionRows(fixtureId);
    expect(rows.map((r) => r.channel).sort()).toEqual(["email", "push"]);
    const emailKey = attentionKey(fixtureId, ownerIds[0]!);
    expect(rows.find((r) => r.channel === "push")?.dedupeKey).toBe(pushKey(emailKey));
    const pushMessage = notifier.sent.flat().find((m) => m.channel === "push");
    expect(pushMessage).toMatchObject({ channel: "push", to: ownerIds[0], tag: `n4:${fixtureId}` });
    // Not `cancelUrl` (review fix, Important 4): "you're 2 short" must not
    // tap through to "call off this fixture".
    if (pushMessage?.channel === "push") {
      expect(pushMessage.url).not.toContain("/cancel/");
      expect(pushMessage.url).toContain(fixtureId);
    }
  });

  it("still emails an owner with no device at all", async () => {
    const notifier = new RecordingNotifier();
    const { fixtureId } = await seed({ kicksOffAt: KICKOFF_INSIDE_WINDOW, inCount: 8, pending: 3 });

    await run(notifier);

    const rows = await attentionRows(fixtureId);
    expect(rows.map((r) => r.channel)).toEqual(["email"]);
  });

  it("does not email while the fixture is still outside the warning window", async () => {
    const notifier = new RecordingNotifier();
    const { fixtureId } = await seed({ kicksOffAt: KICKOFF_OUTSIDE_WINDOW, inCount: 8 });

    const result = await run(notifier);

    expect(result.attentionSent).toBe(0);
    expect(notifier.sent).toHaveLength(0);
    expect(await attentionRows(fixtureId)).toHaveLength(0);
  });

  it("does not email a fixture that is merely below its minimum, when the window has not opened", async () => {
    // Distinct from the case above in intent: this pins that being below
    // `minPlayers` is *not* on its own enough. The same fixture, moved inside
    // the window by nothing but the clock, does fire — asserted second so the
    // first assertion cannot pass because the fixture was unfireable for some
    // unrelated reason.
    const notifier = new RecordingNotifier();
    await seed({ kicksOffAt: KICKOFF_OUTSIDE_WINDOW, inCount: 3, minPlayers: 10 });

    expect((await run(notifier)).attentionSent).toBe(0);

    const insideWindow = new Date(KICKOFF_OUTSIDE_WINDOW.getTime() - 11 * 3_600_000);
    expect((await run(notifier, insideWindow)).attentionSent).toBe(1);
  });

  it("emails the owner about an odd number, in different words from being short", async () => {
    const notifier = new RecordingNotifier();
    await seed({ kicksOffAt: KICKOFF_INSIDE_WINDOW, inCount: 11, minPlayers: 10, prefersEvenNumbers: true });

    const result = await run(notifier);

    expect(result.attentionSent).toBe(1);
    const message = requireEmailMessage(notifier.sent.flat()[0]!);
    expect(message.text).toContain("odd number");
    expect(message.text).not.toContain("short");
  });

  it("does not email an even, sufficient fixture inside the window", async () => {
    const notifier = new RecordingNotifier();
    await seed({ kicksOffAt: KICKOFF_INSIDE_WINDOW, inCount: 12, minPlayers: 10 });

    expect((await run(notifier)).attentionSent).toBe(0);
  });

  it("does not email a game that does not care about even numbers", async () => {
    const notifier = new RecordingNotifier();
    await seed({ kicksOffAt: KICKOFF_INSIDE_WINDOW, inCount: 11, minPlayers: 10, prefersEvenNumbers: false });

    expect((await run(notifier)).attentionSent).toBe(0);
  });

  it("sends exactly one email across short, then fixed, then uneven", async () => {
    const notifier = new RecordingNotifier();
    const { fixtureId } = await seed({ kicksOffAt: KICKOFF_INSIDE_WINDOW, inCount: 8, minPlayers: 10 });

    // Short: fires.
    expect((await run(notifier)).attentionSent).toBe(1);

    // Fixed: nothing to say, and nothing to send.
    await db.update(fixtures).set({ inCount: 12 }).where(eq(fixtures.id, fixtureId));
    expect((await run(notifier)).attentionSent).toBe(0);

    // Uneven: a *new* problem — but the owner has already been told once, and
    // BR-31 says once per owner per fixture, ever.
    await db.update(fixtures).set({ inCount: 11 }).where(eq(fixtures.id, fixtureId));
    const third = await run(notifier);
    expect(third.attentionSent).toBe(0);
    expect(third.alreadyLogged).toBe(1);

    expect(notifier.sent.flat()).toHaveLength(1);
    expect(await attentionRows(fixtureId)).toHaveLength(1);
  });

  it("goes to owners only, never to ordinary players", async () => {
    const notifier = new RecordingNotifier();
    await seed({ kicksOffAt: KICKOFF_INSIDE_WINDOW, inCount: 8, pending: 4 });

    await run(notifier);

    const recipients = notifier.sent.flat().map((m) => m.to);
    expect(recipients).toEqual(["owner@example.com"]);
    expect(recipients.some((to) => to.startsWith("in-") || to.startsWith("pending-"))).toBe(false);
  });

  it("emails both owners of a game with two, exactly once each", async () => {
    const notifier = new RecordingNotifier();
    const { fixtureId } = await seed({
      kicksOffAt: KICKOFF_INSIDE_WINDOW,
      inCount: 8,
      owners: [
        { name: "Owner One", email: "one@example.com" },
        { name: "Owner Two", email: "two@example.com" },
      ],
    });

    const result = await run(notifier);
    // A second run must add nothing.
    await run(notifier);

    expect(result.attentionSent).toBe(2);
    expect(notifier.sent.flat().map((m) => m.to).sort()).toEqual(["one@example.com", "two@example.com"]);
    expect(await attentionRows(fixtureId)).toHaveLength(2);
  });

  it("skips an owner who is no longer active on the squad", async () => {
    const notifier = new RecordingNotifier();
    await seed({
      kicksOffAt: KICKOFF_INSIDE_WINDOW,
      inCount: 8,
      owners: [
        { name: "Current", email: "current@example.com" },
        { name: "Former", email: "former@example.com", active: false },
      ],
    });

    await run(notifier);

    expect(notifier.sent.flat().map((m) => m.to)).toEqual(["current@example.com"]);
  });

  it("skips an owner with no usable address without writing a log row (BR-32)", async () => {
    const notifier = new RecordingNotifier();
    const { fixtureId } = await seed({
      kicksOffAt: KICKOFF_INSIDE_WINDOW,
      inCount: 8,
      owners: [
        { name: "Reachable", email: "reachable@example.com" },
        { name: "Blank", email: "   " },
        { name: "Guest Owner", email: "guest@example.com", isGuest: true },
      ],
    });

    const result = await run(notifier);

    expect(result.attentionSent).toBe(1);
    expect(result.ownersSkippedNoRecipient).toBe(2);
    expect(await attentionRows(fixtureId)).toHaveLength(1);
  });

  it("ignores fixtures that are not open", async () => {
    const notifier = new RecordingNotifier();
    for (const lifecycle of ["scheduled", "cancelled", "played"] as const) {
      await seed({
        kicksOffAt: KICKOFF_INSIDE_WINDOW,
        inCount: 8,
        lifecycle,
        owners: [{ name: "Olive Owner", email: `${lifecycle}-owner@example.com` }],
      });
    }

    expect((await run(notifier)).attentionSent).toBe(0);
  });

  it("ignores a fixture that has already ended", async () => {
    const notifier = new RecordingNotifier();
    await seed({
      kicksOffAt: new Date(NOW.getTime() - 2 * 3_600_000),
      inCount: 8,
      durationMinutes: 60,
    });

    expect((await run(notifier)).attentionSent).toBe(0);
  });

  it("carries a working cancel link scoped to that owner and fixture", async () => {
    const notifier = new RecordingNotifier();
    const { fixtureId, ownerIds } = await seed({ kicksOffAt: KICKOFF_INSIDE_WINDOW, inCount: 8 });

    await run(notifier);

    const firstSent = notifier.sent.flat()[0];
    const text = firstSent ? requireEmailMessage(firstSent).text : "";
    const match = /https:\/\/makethe\.team\/cancel\/([\w.-]+)/.exec(text);
    expect(match).not.toBeNull();

    const verified = await verifyCancelToken(match?.[1] ?? "", SECRET, NOW);
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.payload.fixtureId).toBe(fixtureId);
      expect(verified.payload.ownerPlayerId).toBe(ownerIds[0]);
    }
  });

  it("records a failure naming CANCEL_TOKEN_SECRET when it is unset, and mails nobody", async () => {
    const notifier = new RecordingNotifier();
    const { fixtureId } = await seed({ kicksOffAt: KICKOFF_INSIDE_WINDOW, inCount: 8 });

    const result = await sendOwnerAttention({
      db,
      notifier,
      now: NOW,
      // Exactly what an unset Worker secret binding arrives as at runtime,
      // despite `Bindings` declaring it a `string`.
      cancelTokenSecret: undefined as unknown as string,
      ceilingReached: false,
    });

    expect(result.attentionSent).toBe(0);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.message).toContain("CANCEL_TOKEN_SECRET");
    expect(result.failures[0]?.fixtureId).toBe(fixtureId);
    expect(notifier.sent).toHaveLength(0);
    // Nothing was queued for a message that could never be built.
    expect(await attentionRows(fixtureId)).toHaveLength(0);
  });

  it("keeps going for other fixtures when one fixture's send rejects", async () => {
    const notifier = new RejectingNotifier();
    const broken = await seed({ kicksOffAt: KICKOFF_INSIDE_WINDOW, inCount: 8 });
    await seed({
      kicksOffAt: KICKOFF_INSIDE_WINDOW,
      inCount: 8,
      owners: [{ name: "Healthy Owner", email: "healthy@example.com" }],
    });
    notifier.rejectForFixture.add(broken.fixtureId);

    const result = await run(notifier);

    expect(result.failures.map((f) => f.fixtureId)).toEqual([broken.fixtureId]);
    expect(result.attentionSent).toBe(1);
    expect(notifier.sent.flat().map((m) => m.to)).toContain("healthy@example.com");
    // The rejected fixture's row is left `failed`, never retried (BR-19).
    const brokenRows = await attentionRows(broken.fixtureId);
    expect(brokenRows).toHaveLength(1);
    expect(brokenRows[0]?.status).toBe("failed");
  });

  it("keeps going for other fixtures when one fixture's prepare stage throws", async () => {
    // Distinct from "keeps going ... when one fixture's send rejects" above:
    // that test breaks the *send* boundary (`notifier.send` rejecting). This
    // one breaks *prepare* — `formatLocalDateTime` throwing on a malformed
    // timezone inside `processFixture`, before any token is signed or message
    // built — the per-fixture `try` in `sendOwnerAttention` itself, which
    // nothing else in the suite exercised with two fixtures in play.
    const notifier = new RecordingNotifier();
    const broken = await seed({ kicksOffAt: KICKOFF_INSIDE_WINDOW, inCount: 8, timezone: "Not/AZone" });
    const healthy = await seed({
      kicksOffAt: KICKOFF_INSIDE_WINDOW,
      inCount: 8,
      owners: [{ name: "Healthy Owner", email: "healthy@example.com" }],
    });

    const result = await run(notifier);

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.fixtureId).toBe(broken.fixtureId);
    expect(result.failures[0]?.stage).toBe("prepare");
    expect(result.attentionSent).toBe(1);
    expect(notifier.sent.flat().map((m) => m.to)).toEqual(["healthy@example.com"]);
    expect(await attentionRows(broken.fixtureId)).toHaveLength(0);
    expect(await attentionRows(healthy.fixtureId)).toHaveLength(1);
  });

  it("reports a provider failure as a failure without touching the other owner", async () => {
    const notifier = new RecordingNotifier();
    const { fixtureId } = await seed({
      kicksOffAt: KICKOFF_INSIDE_WINDOW,
      inCount: 8,
      owners: [
        { name: "Owner One", email: "one@example.com" },
        { name: "Owner Two", email: "two@example.com" },
      ],
    });
    notifier.failFor.add("one@example.com");

    const result = await run(notifier);

    expect(result.attentionSent).toBe(1);
    expect(result.attentionFailed).toBe(1);
    expect(result.failures).toHaveLength(1);

    const rows = await attentionRows(fixtureId);
    expect(rows.filter((r) => r.status === "failed")).toHaveLength(1);
    expect(rows.filter((r) => r.status === "sent")).toHaveLength(1);
  });
});

describe("sendOwnerAttention and the daily send ceiling (TR-31)", () => {
  it("retries a ceiling-deferred email on the next tick even though the owner's push already sent (review fix, Critical 1)", async () => {
    // Same failure mode as N-1's regression test in
    // test/sweep/open-and-remind.test.ts: the push leg has no daily
    // ceiling, so a subscribed owner's push can succeed on the very tick
    // their email is refused by the ceiling. `ownersAlreadyTold` must not
    // mistake the surviving push row for "this owner has been told" — BR-31
    // is "once per fixture, ever", and if a surviving push row satisfied it,
    // the deleted (ceiling-refused) email row would never be retried.
    const notifier = new RecordingNotifier();
    notifier.ceilingFor.add("owner@example.com");
    const { fixtureId, ownerIds } = await seed({ kicksOffAt: KICKOFF_INSIDE_WINDOW, inCount: 8 });
    await insertSubscription(db, ownerIds[0]!, "https://push.example.com/owner");

    const first = await run(notifier);
    expect(first.attentionSent).toBe(0);
    expect(first.pushAttentionSent).toBe(1); // the push
    expect(first.attentionDeferred).toBe(1); // the email

    const afterFirst = await attentionRows(fixtureId);
    expect(afterFirst.map((r) => r.channel)).toEqual(["push"]);

    notifier.ceilingFor.clear();
    const second = await run(notifier);

    expect(second.attentionSent).toBe(1);
    expect(second.attentionDeferred).toBe(0);

    const afterSecond = await attentionRows(fixtureId);
    expect(afterSecond.map((r) => r.channel).sort()).toEqual(["email", "push"]);
    expect(afterSecond.every((r) => r.status === "sent")).toBe(true);
    expect(notifier.sent.flat().filter((m) => m.channel === "push")).toHaveLength(1);
  });

  it("deletes the log row on a ceiling refusal so the next run retries it", async () => {
    const notifier = new RecordingNotifier();
    notifier.ceilingFor.add("owner@example.com");
    const { fixtureId } = await seed({ kicksOffAt: KICKOFF_INSIDE_WINDOW, inCount: 8 });

    const result = await run(notifier);

    expect(result.attentionDeferred).toBe(1);
    expect(result.attentionFailed).toBe(0);
    expect(result.failures).toHaveLength(0);
    expect(await attentionRows(fixtureId)).toHaveLength(0);

    // The ceiling lifts; the next run gets it out.
    notifier.ceilingFor.clear();
    expect((await run(notifier)).attentionSent).toBe(1);
  });

  it("records a durable audit row for every ceiling-refused attention email", async () => {
    const notifier = new RecordingNotifier();
    notifier.ceilingFor.add("owner@example.com");
    const { fixtureId, ownerIds } = await seed({ kicksOffAt: KICKOFF_INSIDE_WINDOW, inCount: 8 });

    await run(notifier);

    const rows = await db.select().from(auditLog).where(eq(auditLog.entityId, fixtureId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe("fixture.attention_email_deferred");
    expect(rows[0]?.actorPlayerId).toBeNull();
    expect(JSON.parse(rows[0]?.afterJson ?? "{}")).toEqual({
      notificationType: "n4",
      playerIds: [ownerIds[0]],
    });
  });

  it("collapses repeated N-4 ceiling deferrals for the same fixture within the collapse window, but writes a fresh row once it elapses", async () => {
    // Unlike N-2/N-3, a deferred N-4 retries every sweep tick (the deleted
    // log row lets it try again). Without a bound, a sustained ceiling would
    // write one audit row per tick forever; the collapse window bounds it
    // while still proving the condition is ongoing via a fresh row per window.
    const notifier = new RecordingNotifier();
    notifier.ceilingFor.add("owner@example.com");
    const { fixtureId } = await seed({ kicksOffAt: KICKOFF_INSIDE_WINDOW, inCount: 8 });

    await run(notifier, NOW);
    expect(await db.select().from(auditLog).where(eq(auditLog.entityId, fixtureId))).toHaveLength(1);

    // Five minutes later — the sweep's real cadence, well inside the one-hour
    // collapse window — the retry is refused again. No second row.
    const fiveMinutesLater = new Date(NOW.getTime() + 5 * 60 * 1000);
    await run(notifier, fiveMinutesLater);
    expect(await db.select().from(auditLog).where(eq(auditLog.entityId, fixtureId))).toHaveLength(1);

    // An hour and a minute after the first row, the window has elapsed and a
    // fresh row is written.
    const afterWindow = new Date(NOW.getTime() + 61 * 60 * 1000);
    await run(notifier, afterWindow);
    expect(await db.select().from(auditLog).where(eq(auditLog.entityId, fixtureId))).toHaveLength(2);
  });

  it("writes no audit row when nothing was refused", async () => {
    const notifier = new RecordingNotifier();
    await seed({ kicksOffAt: KICKOFF_INSIDE_WINDOW, inCount: 8 });

    await run(notifier);

    expect(await db.select().from(auditLog)).toHaveLength(0);
  });

  it("tells the owner the daily email limit is biting when it is", async () => {
    const notifier = new RecordingNotifier();
    await seed({ kicksOffAt: KICKOFF_INSIDE_WINDOW, inCount: 8 });

    await run(notifier, NOW, true);

    expect(requireEmailMessage(notifier.sent.flat()[0]!).text).toContain("daily email limit");
  });

  it("says nothing about the limit when it is not biting", async () => {
    const notifier = new RecordingNotifier();
    await seed({ kicksOffAt: KICKOFF_INSIDE_WINDOW, inCount: 8 });

    await run(notifier, NOW, false);

    expect(requireEmailMessage(notifier.sent.flat()[0]!).text).not.toContain("daily email limit");
  });

});

describe("sendOwnerAttention and the owner's warning switch (M26)", () => {
/**
 * The owner's warning switch (M26). Read live from `games`, unlike
 * `shortWarningOffsetHours`, which each fixture snapshots at
 * materialisation: turning the warning off has to silence the fixtures that
 * already exist, since nothing re-materialises them.
 */
it("sends nothing for a game whose short/uneven warning is switched off", async () => {
  const { fixtureId } = await seed({
    kicksOffAt: KICKOFF_INSIDE_WINDOW,
    inCount: 4,
    shortWarningEnabled: false,
    owners: [{ name: "Owner", email: "owner@example.com" }],
  });
  const notifier = new RecordingNotifier();

  const result = await sendOwnerAttention({
    db,
    notifier,
    now: NOW,
    cancelTokenSecret: SECRET,
    ceilingReached: false,
  });

  expect(result.fixturesNeedingAttention).toBe(0);
  expect(result.attentionSent).toBe(0);
  expect(notifier.sent).toHaveLength(0);
  // N-4 is once per fixture per owner *ever*, so an unsent warning must also
  // be an unlogged one — otherwise switching it back on would never send.
  const rows = await db
    .select()
    .from(notificationLog)
    .where(and(eq(notificationLog.fixtureId, fixtureId), eq(notificationLog.notificationType, "n4")));
  expect(rows).toHaveLength(0);
});
});

describe("sendOwnerAttention and gated invites (M34)", () => {
  /**
   * Everyone the seed has already asked. Any instant before `NOW` will do —
   * `invited_at` is only ever read for null-ness here — but it is a real past
   * instant so a row can never look invited "in the future".
   */
  const INVITED = new Date(NOW.getTime() - 3_600_000);

  /**
   * Gating changes nothing about N-4, and these are the guard on that.
   *
   * An earlier draft of M34 suppressed the warning while a gated fixture still
   * had tiers held back, on the reasoning that such a fixture is short on
   * purpose. That was reverted by decision on 24 August 2026: an organiser
   * wants to know their numbers are short whether or not the invite order
   * explains why, and a warning they can reason about beats one the product
   * withholds on their behalf. `docs/known-issues.md` records it so nobody
   * re-litigates it from first principles.
   */
  it("warns about a gated fixture with tiers still held back", async () => {
    const notifier = new RecordingNotifier();
    const { fixtureId } = await seed({
      kicksOffAt: KICKOFF_INSIDE_WINDOW,
      inCount: 8,
      minPlayers: 10,
      gatedInvitesEnabled: true,
      gatedFallbackHoursBefore: null,
      invitedAt: INVITED,
      heldBack: 3,
    });

    const result = await run(notifier);

    expect(result.attentionSent).toBe(1);
    expect(requireEmailMessage(notifier.sent.flat()[0]!).text).toContain("2 players short");
    expect(await attentionRows(fixtureId)).toHaveLength(1);
  });

  it("warns about a gated fixture whose tiers have all been released", async () => {
    const notifier = new RecordingNotifier();
    const { fixtureId } = await seed({
      kicksOffAt: KICKOFF_INSIDE_WINDOW,
      inCount: 8,
      minPlayers: 10,
      gatedInvitesEnabled: true,
      gatedFallbackHoursBefore: null,
      invitedAt: INVITED,
      pending: 3,
      heldBack: 0,
    });

    const result = await run(notifier);

    expect(result.attentionSent).toBe(1);
    expect(await attentionRows(fixtureId)).toHaveLength(1);
  });

  it("warns about an ungated short fixture exactly as before (BR-39)", async () => {
    const notifier = new RecordingNotifier();
    const { fixtureId } = await seed({
      kicksOffAt: KICKOFF_INSIDE_WINDOW,
      inCount: 8,
      minPlayers: 10,
      gatedInvitesEnabled: false,
      heldBack: 3,
    });

    const result = await run(notifier);

    expect(result.attentionSent).toBe(1);
    expect(requireEmailMessage(notifier.sent.flat()[0]!).text).toContain("2 players short");
    expect(await attentionRows(fixtureId)).toHaveLength(1);
  });
});

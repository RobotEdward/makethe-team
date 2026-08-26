import { env } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../src/db/client.js";
import { fixtures, memberships, notificationLog, players } from "../../src/db/schema.js";
import { groupNudgeKey, pushKey } from "../../src/notify/dedupe-key.js";
import type { Message, Notifier, PushMessage, SendResult } from "../../src/notify/notifier.js";
import { sendGroupNudges } from "../../src/sweep/group-nudge.js";
import { insertGame, insertNotificationSetting, insertSubscription, resetDatabase } from "../support/factories.js";

const db = getDb(env.DB);

/** 2026-08-13 is a Thursday; the game's reminder is "1 day before at 09:00 Europe/London". */
const KICKOFF = new Date("2026-08-13T18:00:00Z");
/** Past the reminder instant (2026-08-12T08:00Z) and well before kickoff. */
const DUE_NOW = new Date("2026-08-12T10:00:00Z");
/** Before the reminder instant: open early (BR-11), nothing due yet. */
const EARLY_NOW = new Date("2026-08-11T10:00:00Z");

class RecordingNotifier implements Notifier {
  readonly sent: Message[][] = [];
  readonly failFor = new Set<string>();
  reject = false;

  send(messages: readonly Message[]): Promise<SendResult[]> {
    this.sent.push([...messages]);
    if (this.reject) return Promise.reject(new Error("simulated push service outage"));
    return Promise.resolve(
      messages.map((m): SendResult =>
        this.failFor.has(m.to)
          ? { ok: false, error: "simulated-provider-failure" }
          : { ok: true, providerMessageId: `prov-${m.dedupeKey}` },
      ),
    );
  }

  pushes(): PushMessage[] {
    return this.sent.flat().filter((m): m is PushMessage => m.channel === "push");
  }
}

let seq = 0;
const nextId = (kind: string) => `${kind}-${++seq}`;

async function seedFixture(opts: { lifecycle?: "scheduled" | "open"; inCount?: number } = {}) {
  const gameId = await insertGame(db, { name: "Thursday 7-a-side" });
  const fixtureId = nextId("fixture");
  await db.insert(fixtures).values({
    id: fixtureId,
    gameId,
    kicksOffAt: KICKOFF,
    lifecycle: opts.lifecycle ?? "open",
    minPlayers: 10,
    maxPlayers: 14,
    prefersEvenNumbers: true,
    shortWarningOffsetHours: 12,
    durationMinutes: 60,
    inCount: opts.inCount ?? 7,
  });
  return { gameId, fixtureId };
}

async function addMember(gameId: string, role: "owner" | "player", opts: { push?: boolean; active?: boolean } = {}) {
  const playerId = nextId(role);
  await db.insert(players).values({ id: playerId, name: `${role} ${playerId}`, email: `${playerId}@example.com` });
  await db.insert(memberships).values({
    id: nextId("m"),
    gameId,
    playerId,
    role,
    active: opts.active ?? true,
  });
  if (opts.push) await insertSubscription(db, playerId, `https://push.example.com/${playerId}`);
  return playerId;
}

async function n11Rows(fixtureId: string) {
  return db
    .select()
    .from(notificationLog)
    .where(and(eq(notificationLog.fixtureId, fixtureId), eq(notificationLog.notificationType, "n11")));
}

describe("sendGroupNudges (N-11, M22)", () => {
  beforeEach(resetDatabase);

  it("pushes each subscribed organiser once, with the headcount, landing on the WhatsApp card", async () => {
    const { gameId, fixtureId } = await seedFixture({ inCount: 7 });
    const owner = await addMember(gameId, "owner", { push: true });
    const notifier = new RecordingNotifier();

    const result = await sendGroupNudges(db, notifier, DUE_NOW);

    expect(result.fixturesConsidered).toBe(1);
    expect(result.nudgesSent).toBe(1);
    expect(result.nudgesFailed).toBe(0);
    expect(result.failures).toEqual([]);

    const pushes = notifier.pushes();
    expect(pushes).toHaveLength(1);
    const push = pushes[0]!;
    expect(push.to).toBe(owner);
    expect(push.title).toBe("Post it to the group?");
    expect(push.body).toBe("Thursday 7-a-side, Thursday 13 August at 19:00: 7 in so far.");
    expect(push.url).toBe(`https://makethe.team/g/${gameId}/f/${fixtureId}#whatsapp`);
    expect(push.tag).toBe(`n11:${fixtureId}`);
    expect(push.dedupeKey).toBe(pushKey(groupNudgeKey(fixtureId, owner)));

    const rows = await n11Rows(fixtureId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("sent");
    expect(rows[0]?.playerId).toBe(owner);
    // Push only: no email row for this type, ever.
    expect(notifier.sent.flat().some((m) => m.channel === "email")).toBe(false);
  });

  it("never nudges twice, however many ticks pass", async () => {
    const { gameId, fixtureId } = await seedFixture();
    await addMember(gameId, "owner", { push: true });
    const notifier = new RecordingNotifier();

    await sendGroupNudges(db, notifier, DUE_NOW);
    const second = await sendGroupNudges(db, notifier, new Date(DUE_NOW.getTime() + 3_600_000));
    const third = await sendGroupNudges(db, notifier, new Date(DUE_NOW.getTime() + 7_200_000));

    expect(notifier.pushes()).toHaveLength(1);
    expect(second.nudgesSent).toBe(0);
    expect(second.ownersAlreadyTold).toBe(1);
    expect(third.ownersAlreadyTold).toBe(1);
    expect(await n11Rows(fixtureId)).toHaveLength(1);
  });

  it("nudges only active organisers with a device — not players, not removed owners, not owners without push", async () => {
    const { gameId, fixtureId } = await seedFixture();
    const withPush = await addMember(gameId, "owner", { push: true });
    await addMember(gameId, "owner"); // no device
    await addMember(gameId, "owner", { push: true, active: false }); // removed
    await addMember(gameId, "player", { push: true }); // not an organiser
    const notifier = new RecordingNotifier();

    const result = await sendGroupNudges(db, notifier, DUE_NOW);

    expect(notifier.pushes().map((p) => p.to)).toEqual([withPush]);
    expect(result.ownersWithoutPush).toBe(1);
    expect((await n11Rows(fixtureId)).map((r) => r.playerId)).toEqual([withPush]);
  });

  it("waits for the reminder instant: a fixture opened early is not nudged yet, and a scheduled one never is", async () => {
    const { gameId } = await seedFixture({ lifecycle: "open" });
    await addMember(gameId, "owner", { push: true });
    const scheduled = await seedFixture({ lifecycle: "scheduled" });
    await addMember(scheduled.gameId, "owner", { push: true });
    const notifier = new RecordingNotifier();

    const early = await sendGroupNudges(db, notifier, EARLY_NOW);
    expect(early.fixturesConsidered).toBe(0);
    expect(notifier.pushes()).toHaveLength(0);

    const due = await sendGroupNudges(db, notifier, DUE_NOW);
    expect(due.fixturesConsidered).toBe(1);
    expect(notifier.pushes()).toHaveLength(1);
  });

  it("counts a refused push as failed without failing the run, and leaves the row failed, never retried", async () => {
    const { gameId, fixtureId } = await seedFixture();
    const owner = await addMember(gameId, "owner", { push: true });
    const notifier = new RecordingNotifier();
    notifier.failFor.add(owner);

    const result = await sendGroupNudges(db, notifier, DUE_NOW);
    expect(result.nudgesSent).toBe(0);
    expect(result.nudgesFailed).toBe(1);
    expect(result.failures).toEqual([]);
    const rows = await n11Rows(fixtureId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("failed");

    notifier.failFor.clear();
    const again = await sendGroupNudges(db, notifier, DUE_NOW);
    expect(again.nudgesSent).toBe(0);
    expect(notifier.pushes()).toHaveLength(1);
  });

  it("marks every row failed when the notifier rejects outright, and stays healthy", async () => {
    const { gameId, fixtureId } = await seedFixture();
    await addMember(gameId, "owner", { push: true });
    await addMember(gameId, "owner", { push: true });
    const notifier = new RecordingNotifier();
    notifier.reject = true;

    const result = await sendGroupNudges(db, notifier, DUE_NOW);
    expect(result.nudgesFailed).toBe(2);
    expect(result.failures).toEqual([]);
    const rows = await n11Rows(fixtureId);
    expect(rows.map((r) => r.status)).toEqual(["failed", "failed"]);
    expect(rows.every((r) => r.error === "simulated push service outage")).toBe(true);
  });

  it("skips a fixture whose reminder instant cannot be computed — step 2 already reported it — and nudges the others", async () => {
    const broken = await insertGame(db, { timezone: "Not/AZone" });
    await db.insert(fixtures).values({
      id: "broken-fixture",
      gameId: broken,
      kicksOffAt: KICKOFF,
      lifecycle: "open",
      minPlayers: 10,
      maxPlayers: 14,
      prefersEvenNumbers: true,
      shortWarningOffsetHours: 12,
      durationMinutes: 60,
      inCount: 3,
    });
    await addMember(broken, "owner", { push: true });
    const { gameId } = await seedFixture();
    await addMember(gameId, "owner", { push: true });
    const notifier = new RecordingNotifier();

    const result = await sendGroupNudges(db, notifier, DUE_NOW);
    expect(result.failures).toEqual([]);
    expect(result.fixturesConsidered).toBe(1);
    expect(result.nudgesSent).toBe(1);
    expect((await n11Rows("broken-fixture")).length).toBe(0);
  });

  it("nudges nobody for a game whose group nudge is switched off", async () => {
    const { gameId, fixtureId } = await seedFixture();
    await insertNotificationSetting(db, gameId, "n11", "push", false);
    await addMember(gameId, "owner", { push: true });
    const notifier = new RecordingNotifier();

    const result = await sendGroupNudges(db, notifier, DUE_NOW);

    // Not merely "sent nothing": the fixture is not considered at all, so the
    // counter keeps meaning "fixtures this step could have nudged for".
    expect(result.fixturesConsidered).toBe(0);
    expect(result.nudgesSent).toBe(0);
    expect(notifier.pushes()).toHaveLength(0);
    expect(await n11Rows(fixtureId)).toHaveLength(0);
  });

});

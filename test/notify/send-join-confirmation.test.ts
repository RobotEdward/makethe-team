import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../src/db/client.js";
import { joinConfirmations } from "../../src/db/schema.js";
import { verifyJoinToken } from "../../src/domain/token.js";
import type { Message, Notifier, SendResult } from "../../src/notify/notifier.js";
import { DAILY_CEILING_REASON } from "../../src/notify/quota.js";
import { renderJoinConfirmationEmail } from "../../src/notify/templates/join-confirmation.js";
import { sendJoinConfirmation, utcDay } from "../../src/notify/send-join-confirmation.js";
import { insertGame, requireEmailMessage, resetDatabase, setAdminSwitch } from "../support/factories.js";

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

const db = getDb(env.DB);
const SECRET = env.RESPONSE_TOKEN_SECRET;
const NOW = new Date("2026-08-27T09:00:00Z");

async function seed() {
  const gameId = await insertGame(db, { name: "Thursday 7-a-side", inviteToken: "inv-abc" });
  return gameId;
}
function params(gameId: string, notifier: RecordingNotifier, overrides = {}) {
  return {
    db,
    notifier,
    gameId,
    gameName: "Thursday 7-a-side",
    inviteToken: "inv-abc",
    email: "jack@example.com",
    name: "Jack Hart",
    now: NOW,
    responseTokenSecret: SECRET,
    ...overrides,
  };
}

describe("sendJoinConfirmation (N-14)", () => {
  beforeEach(resetDatabase);

  it("emails a working confirmation link and records the day", async () => {
    const gameId = await seed();
    const notifier = new RecordingNotifier();
    expect(await sendJoinConfirmation(params(gameId, notifier))).toEqual({ kind: "sent" });

    const message = requireEmailMessage(notifier.all[0]!);
    expect(message.to).toBe("jack@example.com");
    const url = new URL(message.text.match(/https?:\/\/\S+\/join\/\S+/)![0]);
    const jtoken = url.pathname.split("/").pop()!;
    const verified = await verifyJoinToken(jtoken, SECRET, NOW);
    expect(verified).toMatchObject({
      ok: true,
      payload: { gameId, inviteToken: "inv-abc", email: "jack@example.com", name: "Jack Hart" },
    });

    const rows = await db.select().from(joinConfirmations);
    expect(rows).toEqual([expect.objectContaining({ gameId, email: "jack@example.com", day: "2026-08-27" })]);
  });

  it("sends at most one per address per game per UTC day (BR-53)", async () => {
    const gameId = await seed();
    const notifier = new RecordingNotifier();
    await sendJoinConfirmation(params(gameId, notifier));
    expect(await sendJoinConfirmation(params(gameId, notifier, { name: "Different Name" }))).toEqual({
      kind: "already-sent-today",
    });
    expect(notifier.all).toHaveLength(1);
    // The next day is a new message.
    const tomorrow = new Date("2026-08-28T00:00:01Z");
    expect(await sendJoinConfirmation(params(gameId, notifier, { now: tomorrow }))).toEqual({ kind: "sent" });
  });

  it("prunes rows older than yesterday on every insert", async () => {
    const gameId = await seed();
    await db.insert(joinConfirmations).values([
      { gameId, email: "old@example.com", day: "2026-08-20", createdAt: NOW },
      { gameId, email: "yesterday@example.com", day: "2026-08-26", createdAt: NOW },
    ]);
    await sendJoinConfirmation(params(gameId, new RecordingNotifier()));
    const days = (await db.select().from(joinConfirmations)).map((r) => r.day).sort();
    expect(days).toEqual(["2026-08-26", "2026-08-27"]);
  });

  it("is masked by the administrator's n14 email switch, writing nothing", async () => {
    const gameId = await seed();
    await setAdminSwitch(db, "n14", "email", false);
    const notifier = new RecordingNotifier();
    expect(await sendJoinConfirmation(params(gameId, notifier))).toEqual({ kind: "switched-off" });
    expect(notifier.all).toHaveLength(0);
    expect(await db.select().from(joinConfirmations)).toHaveLength(0);
  });

  it("reports a daily-ceiling refusal as deferred and releases the day, so a retry can send", async () => {
    const gameId = await seed();
    const notifier = new RecordingNotifier();
    notifier.ceilingFor.add("jack@example.com");
    expect(await sendJoinConfirmation(params(gameId, notifier))).toEqual({ kind: "deferred" });
    expect(await db.select().from(joinConfirmations)).toHaveLength(0);
  });

  it("reports a provider failure and keeps the day (it may have been delivered)", async () => {
    const gameId = await seed();
    const notifier = new RecordingNotifier();
    notifier.failFor.add("jack@example.com");
    expect(await sendJoinConfirmation(params(gameId, notifier))).toEqual({
      kind: "failed",
      reason: "simulated-provider-failure",
    });
    expect(await db.select().from(joinConfirmations)).toHaveLength(1);
  });
});

describe("renderJoinConfirmationEmail (BR-51)", () => {
  const rendered = renderJoinConfirmationEmail({
    name: "Jack <b>Hart</b>",
    gameName: "Thursday & Friday",
    confirmUrl: "https://makethe.team/join/tok",
  });

  it("names the game and the typed name, escaped", () => {
    expect(rendered.subject).toBe("Confirm you want to join Thursday & Friday");
    expect(rendered.html).toContain("Jack &lt;b&gt;Hart&lt;/b&gt;");
    expect(rendered.html).toContain("Thursday &amp; Friday");
    expect(rendered.html).not.toContain("<b>Hart</b>");
  });

  it("carries the confirmation link and nothing else a stranger could use", () => {
    for (const body of [rendered.html, rendered.text]) {
      expect(body).toContain("https://makethe.team/join/tok");
      expect(body).not.toMatch(/\/r\/|\/j\/|\/leave\/|\/cancel\//);
      expect(body).not.toMatch(/\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*day\b.*\d{1,2}:\d{2}/);
    }
    expect(rendered.text).toContain("If you didn't ask for this, ignore it");
  });
});

describe("utcDay", () => {
  it("is the UTC calendar date", () => {
    expect(utcDay(new Date("2026-08-27T23:59:59Z"))).toBe("2026-08-27");
    expect(utcDay(new Date("2026-08-28T00:00:00Z"))).toBe("2026-08-28");
  });
});

import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { putPotmVote } from "../../src/db/potm-queries.js";
import { notificationLog } from "../../src/db/schema.js";
import type { Message, Notifier, SendResult } from "../../src/notify/notifier.js";
import { POTM_NOTIFY_WINDOW_MS, sendPotmAwards } from "../../src/notify/send-potm.js";
import {
  insertFixture,
  insertGame,
  insertMembership,
  insertPlayer,
  insertResponse,
  insertSubscription,
  resetDatabase,
  testDb,
} from "../support/factories.js";

const SECRET = "test-secret";
const KICKOFF = new Date("2026-08-13T18:00:00Z");
/** 60 minutes, default 24-hour window. */
const CLOSES = new Date("2026-08-14T19:00:00Z");
const HOUR = 60 * 60 * 1000;

function recording(): { notifier: Notifier; sent: Message[] } {
  const sent: Message[] = [];
  return {
    sent,
    notifier: {
      send(messages: readonly Message[]): Promise<SendResult[]> {
        sent.push(...messages);
        return Promise.resolve(messages.map((): SendResult => ({ ok: true, providerMessageId: null })));
      },
    },
  };
}

async function seed(options: { squadVisibleToPlayers?: boolean; domain?: string } = {}) {
  const db = testDb();
  const gameId = await insertGame(db, {
    name: "Thursday 5s",
    squadVisibleToPlayers: options.squadVisibleToPlayers ?? true,
  });
  const fixtureId = await insertFixture(db, gameId, { lifecycle: "played", kicksOffAt: KICKOFF });
  const ids: Record<string, string> = {};
  for (const name of ["Ann", "Bo", "Cy", "Di"]) {
    ids[name] = await insertPlayer(db, { name, email: `${name.toLowerCase()}@${options.domain ?? "example.com"}` });
    await insertMembership(db, gameId, ids[name]!);
    await insertResponse(db, fixtureId, ids[name]!, { status: "in" });
  }
  ids["Gus"] = await insertPlayer(db, { name: "Gus", email: null, isGuest: true });
  await insertResponse(db, fixtureId, ids["Gus"], { status: "in" });
  const vote = (voter: string, candidate: string) =>
    putPotmVote(db, { fixtureId, voterId: ids[voter]!, candidateId: ids[candidate]!, now: KICKOFF });
  return { db, gameId, fixtureId, ids, vote };
}

describe("sendPotmAwards (M68, N-15)", () => {
  beforeEach(resetDatabase);

  it("tells the winner by email and by push once voting has closed, and only once", async () => {
    const { db, ids, vote } = await seed();
    await insertSubscription(db, ids["Ann"]!, "https://push.example.com/ann");
    await vote("Bo", "Ann");
    await vote("Cy", "Ann");
    await vote("Ann", "Bo");

    const first = recording();
    const result = await sendPotmAwards(db, first.notifier, new Date(CLOSES.getTime() + HOUR), SECRET);
    expect(result).toMatchObject({ emailSent: 1, pushSent: 1, failures: [] });
    const email = first.sent.find((m) => m.channel === "email");
    expect(email).toMatchObject({ to: "ann@example.com", subject: expect.stringContaining("You're player of the match: Thursday 5s") });
    expect(email?.channel === "email" && email.text).toContain("with 2 votes");
    expect(first.sent.find((m) => m.channel === "push")).toMatchObject({ to: ids["Ann"], title: "You're player of the match" });

    const second = recording();
    await sendPotmAwards(db, second.notifier, new Date(CLOSES.getTime() + 2 * HOUR), SECRET);
    expect(second.sent).toHaveLength(0);
  });

  it("sends nothing before voting closes or after the catch-up window", async () => {
    const { db, vote } = await seed();
    await vote("Bo", "Ann");
    await vote("Cy", "Ann");
    const early = recording();
    await sendPotmAwards(db, early.notifier, new Date(CLOSES.getTime() - 1), SECRET);
    const late = recording();
    await sendPotmAwards(db, late.notifier, new Date(CLOSES.getTime() + POTM_NOTIFY_WINDOW_MS), SECRET);
    expect([...early.sent, ...late.sent]).toHaveLength(0);
  });

  it("tells every tied winner it was joint", async () => {
    const { db, vote } = await seed();
    await vote("Bo", "Ann");
    await vote("Cy", "Bo");
    const run = recording();
    await sendPotmAwards(db, run.notifier, new Date(CLOSES.getTime() + HOUR), SECRET);
    const emails = run.sent.filter((m) => m.channel === "email");
    expect(emails.map((m) => m.to).sort()).toEqual(["ann@example.com", "bo@example.com"]);
    for (const m of emails) expect(m.channel === "email" && m.text).toContain("joint player of the match");
  });

  it("tells nobody below two votes, a guest winner, or a game with the squad hidden", async () => {
    const lonely = await seed();
    await lonely.vote("Bo", "Ann");
    const guest = await seed({ domain: "guest.example.com" });
    await guest.vote("Bo", "Gus");
    await guest.vote("Cy", "Gus");
    const hidden = await seed({ squadVisibleToPlayers: false, domain: "hidden.example.com" });
    await hidden.vote("Bo", "Ann");
    await hidden.vote("Cy", "Ann");

    const run = recording();
    await sendPotmAwards(testDb(), run.notifier, new Date(CLOSES.getTime() + HOUR), SECRET);
    expect(run.sent).toHaveLength(0);
    expect(await testDb().select().from(notificationLog).where(eq(notificationLog.notificationType, "n15"))).toHaveLength(0);
  });
});

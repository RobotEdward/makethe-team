import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../src/db/client.js";
import { fixtures } from "../../src/db/schema.js";
import { retirePastFixtures } from "../../src/sweep/retire.js";
import { insertGame, resetDatabase } from "../support/factories.js";

const db = getDb(env.DB);

const KICKOFF = new Date("2026-08-13T19:00:00Z");
const DURATION_MINUTES = 60;
const END = new Date(KICKOFF.getTime() + DURATION_MINUTES * 60_000);

async function seedFixture(overrides: {
  lifecycle?: "scheduled" | "open" | "cancelled" | "played";
  kicksOffAt?: Date;
  durationMinutes?: number;
}): Promise<string> {
  const gameId = await insertGame(db);
  const id = crypto.randomUUID();
  await db.insert(fixtures).values({
    id,
    gameId,
    kicksOffAt: overrides.kicksOffAt ?? KICKOFF,
    lifecycle: overrides.lifecycle ?? "open",
    minPlayers: 10,
    maxPlayers: 14,
    prefersEvenNumbers: true,
    shortWarningOffsetHours: 12,
    durationMinutes: overrides.durationMinutes ?? DURATION_MINUTES,
  });
  return id;
}

async function lifecycleOf(id: string): Promise<string | undefined> {
  const [row] = await db.select({ lifecycle: fixtures.lifecycle }).from(fixtures).where(eq(fixtures.id, id));
  return row?.lifecycle;
}

beforeEach(async () => {
  await resetDatabase();
});

describe("retirePastFixtures", () => {
  it("retires an open fixture once kickoff plus duration has passed", async () => {
    const id = await seedFixture({ lifecycle: "open" });

    const result = await retirePastFixtures(db, new Date(END.getTime() + 1));

    expect(result.retired).toBe(1);
    expect(await lifecycleOf(id)).toBe("played");
  });

  it("leaves an open fixture still in progress alone", async () => {
    const id = await seedFixture({ lifecycle: "open" });

    const result = await retirePastFixtures(db, new Date(END.getTime() - 1));

    expect(result.retired).toBe(0);
    expect(await lifecycleOf(id)).toBe("open");
  });

  it("is exact at the boundary: one millisecond before is still open, at the instant it retires", async () => {
    const id = await seedFixture({ lifecycle: "open" });

    const before = await retirePastFixtures(db, new Date(END.getTime() - 1));
    expect(before.retired).toBe(0);
    expect(await lifecycleOf(id)).toBe("open");

    const at = await retirePastFixtures(db, END);
    expect(at.retired).toBe(1);
    expect(await lifecycleOf(id)).toBe("played");
  });

  it("does not touch a cancelled fixture even if it is long past kickoff", async () => {
    const id = await seedFixture({ lifecycle: "cancelled" });

    const result = await retirePastFixtures(db, new Date(END.getTime() + 86_400_000));

    expect(result.retired).toBe(0);
    expect(await lifecycleOf(id)).toBe("cancelled");
  });

  it("does not touch a scheduled fixture, even one whose kickoff-plus-duration has passed", async () => {
    const id = await seedFixture({ lifecycle: "scheduled" });

    const result = await retirePastFixtures(db, new Date(END.getTime() + 1));

    expect(result.retired).toBe(0);
    expect(await lifecycleOf(id)).toBe("scheduled");
  });

  it("is idempotent: running it twice changes nothing the second time", async () => {
    const id = await seedFixture({ lifecycle: "open" });
    const now = new Date(END.getTime() + 1);

    const first = await retirePastFixtures(db, now);
    const second = await retirePastFixtures(db, now);

    expect(first.retired).toBe(1);
    expect(second.retired).toBe(0);
    expect(await lifecycleOf(id)).toBe("played");
  });

  it("processes several due fixtures across chunk boundaries", async () => {
    const now = new Date(END.getTime() + 60_000);
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      ids.push(await seedFixture({ lifecycle: "open", kicksOffAt: new Date(KICKOFF.getTime() + i * 1000) }));
    }

    const result = await retirePastFixtures(db, now);

    expect(result.retired).toBe(10);
    for (const id of ids) {
      expect(await lifecycleOf(id)).toBe("played");
    }
  });
});

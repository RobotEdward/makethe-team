import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { fixtures } from "../../src/db/schema.js";
import {
  CRON_DAILY_MATERIALISE,
  CRON_HOURLY_SWEEP,
  handleScheduled,
} from "../../src/cron/handler.js";
import { insertGame, resetDatabase, testDb } from "../support/factories.js";

const db = testDb();
const NOW = new Date("2026-08-10T03:15:00Z");

beforeEach(async () => {
  await resetDatabase();
  await insertGame(db, { id: "game-1", inviteToken: "invite-1" });
});

describe("handleScheduled", () => {
  it("materialises fixtures on the daily schedule", async () => {
    await handleScheduled(CRON_DAILY_MATERIALISE, env, NOW);

    const rows = await db.select().from(fixtures);
    expect(rows).toHaveLength(5);
  });

  it("does not materialise on the hourly schedule", async () => {
    await handleScheduled(CRON_HOURLY_SWEEP, env, NOW);

    const rows = await db.select().from(fixtures);
    expect(rows).toHaveLength(0);
  });

  it("throws on an unrecognised schedule rather than failing silently", async () => {
    await expect(handleScheduled("*/5 * * * *", env, NOW)).rejects.toThrow(/Unrecognised cron/);
  });

  it("is safe to run twice", async () => {
    await handleScheduled(CRON_DAILY_MATERIALISE, env, NOW);
    await handleScheduled(CRON_DAILY_MATERIALISE, env, NOW);

    const rows = await db.select().from(fixtures);
    expect(rows).toHaveLength(5);
  });

  it("rejects when a game fails to materialise, naming the counts", async () => {
    await insertGame(db, { recurrenceRule: "FREQ=MONTHLY;BYDAY=TH" });

    await expect(handleScheduled(CRON_DAILY_MATERIALISE, env, NOW)).rejects.toThrow(
      /materialise failed for 1 of 2 games/,
    );
  });

  it("still materialises the healthy games before rejecting", async () => {
    await insertGame(db, { recurrenceRule: "FREQ=MONTHLY;BYDAY=TH" });

    await expect(handleScheduled(CRON_DAILY_MATERIALISE, env, NOW)).rejects.toThrow();

    // The rejection must not have short-circuited the sweep: game-1 is healthy
    // and its fixtures have to exist regardless of the other game's bad rule.
    const rows = await db.select().from(fixtures);
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.gameId === "game-1")).toBe(true);
  });
});

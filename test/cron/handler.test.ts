import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../src/db/client.js";
import { fixtures, games } from "../../src/db/schema.js";
import {
  CRON_DAILY_MATERIALISE,
  CRON_HOURLY_SWEEP,
  handleScheduled,
} from "../../src/cron/handler.js";

const db = getDb(env.DB);
const NOW = new Date("2026-08-10T03:15:00Z");

beforeEach(async () => {
  await env.DB.exec("DELETE FROM fixtures");
  await env.DB.exec("DELETE FROM games");

  await db.insert(games).values({
    id: "game-1",
    name: "Thursday 7-a-side",
    venueName: "Oxford Sports Park",
    timezone: "Europe/London",
    recurrenceRule: "FREQ=WEEKLY;INTERVAL=1;BYDAY=TH",
    recurrenceStartDate: "2026-08-13",
    kickoffTime: "19:00",
    durationMinutes: 60,
    minPlayers: 10,
    maxPlayers: 14,
    inviteToken: "invite-1",
  });
});

describe("handleScheduled", () => {
  it("materialises fixtures on the daily schedule", async () => {
    await handleScheduled(CRON_DAILY_MATERIALISE, env, NOW);

    const rows = await db.select().from(fixtures);
    expect(rows).toHaveLength(4);
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
    expect(rows).toHaveLength(4);
  });
});

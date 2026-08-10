import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { fixtures } from "../src/db/schema.js";
import { CRON_DAILY_MATERIALISE } from "../src/cron/handler.js";
import worker from "../src/index.js";
import { insertGame, resetDatabase, testDb } from "./support/factories.js";

const db = testDb();
const SCHEDULED_TIME = Date.parse("2026-08-10T03:15:00Z");

/**
 * The exported `scheduled` handler, exercised end to end.
 *
 * These tests exist because the handler is where the Worker decides whether the
 * runtime is told an invocation failed. A `ctx.waitUntil(...)` here would make
 * every one of them pass on the resolve side and none on the reject side — a
 * total materialisation outage would be indistinguishable from a healthy run.
 */
function scheduledEvent(cron: string): ScheduledController {
  return {
    cron,
    scheduledTime: SCHEDULED_TIME,
    noRetry: () => undefined,
  };
}

async function runScheduled(cron: string): Promise<void> {
  const ctx = createExecutionContext();
  try {
    await worker.scheduled?.(scheduledEvent(cron), env, ctx);
  } finally {
    await waitOnExecutionContext(ctx);
  }
}

beforeEach(async () => {
  await resetDatabase();
});

describe("the exported scheduled handler", () => {
  it("resolves and creates fixtures on a healthy run", async () => {
    await insertGame(db, { id: "healthy-1", inviteToken: "invite-healthy-1" });

    await expect(runScheduled(CRON_DAILY_MATERIALISE)).resolves.toBeUndefined();

    const rows = await db.select().from(fixtures);
    expect(rows).toHaveLength(5);
  });

  it("rejects when a game has an unparseable recurrence rule", async () => {
    await insertGame(db, {
      id: "broken-1",
      inviteToken: "invite-broken-1",
      recurrenceRule: "FREQ=MONTHLY;BYDAY=TH",
    });

    await expect(runScheduled(CRON_DAILY_MATERIALISE)).rejects.toThrow(/materialise failed/);
  });

  it("still materialises the healthy games in a run that rejects", async () => {
    await insertGame(db, { id: "healthy-1", inviteToken: "invite-healthy-1" });
    await insertGame(db, {
      id: "broken-1",
      inviteToken: "invite-broken-1",
      recurrenceRule: "FREQ=MONTHLY;BYDAY=TH",
    });

    await expect(runScheduled(CRON_DAILY_MATERIALISE)).rejects.toThrow(
      /materialise failed for 1 of 2 games/,
    );

    const rows = await db.select().from(fixtures);
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.gameId === "healthy-1")).toBe(true);
  });

  it("rejects on an unrecognised schedule", async () => {
    await expect(runScheduled("*/5 * * * *")).rejects.toThrow(/Unrecognised cron/);
  });
});

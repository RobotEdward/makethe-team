import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { gameNotificationSettings } from "../../src/db/schema.js";
import { insertGame, resetDatabase, testDb } from "../support/factories.js";

// Vite `?raw` imports need a literal path, so the file name is resolved by a
// glob import instead: exactly one migration mentions the new table's backfill.
// `node:fs` (readdirSync) does not resolve under the workers pool — same
// mechanism noted in test/stored-lookups.test.ts and test/views/layout.test.ts
// — so the "exactly one file" check below runs against the glob's own keys
// rather than a directory listing.
const migrations = import.meta.glob("../../migrations/0024_*.sql", { query: "?raw", import: "default", eager: true });
const MIGRATION_SQL = Object.values(migrations)[0] as string;

/** The backfill statements, verbatim from the migration, retargeted at the scratch table. */
function backfillStatements(): string[] {
  return MIGRATION_SQL.split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.startsWith("INSERT INTO `game_notification_settings`"))
    .map((s) => s.replace("FROM `games`", "FROM `games_before_m37`"));
}

async function seedLegacy(id: string, columns: Record<string, 0 | 1>): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO games_before_m37 (id, reminder_enabled, short_warning_enabled, group_nudge_enabled,
       result_prompt_enabled, teams_published_email_enabled, team_picker_email_enabled)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  )
    .bind(
      id,
      columns["reminder_enabled"] ?? 1,
      columns["short_warning_enabled"] ?? 1,
      columns["group_nudge_enabled"] ?? 1,
      columns["result_prompt_enabled"] ?? 1,
      columns["teams_published_email_enabled"] ?? 1,
      columns["team_picker_email_enabled"] ?? 1,
    )
    .run();
}

async function cellsFor(gameId: string): Promise<Record<string, boolean>> {
  const rows = await testDb()
    .select()
    .from(gameNotificationSettings)
    .where(eq(gameNotificationSettings.gameId, gameId));
  return Object.fromEntries(rows.map((r) => [`${r.notificationType}.${r.channel}`, r.enabled]));
}

describe("migration 0024's backfill", () => {
  beforeEach(async () => {
    await resetDatabase();
    await env.DB.exec("DROP TABLE IF EXISTS games_before_m37");
    await env.DB.exec(
      "CREATE TABLE games_before_m37 (id text primary key, reminder_enabled integer, short_warning_enabled integer, group_nudge_enabled integer, result_prompt_enabled integer, teams_published_email_enabled integer, team_picker_email_enabled integer)",
    );
  });

  it("finds the nine backfill statements in the migration file", () => {
    expect(Object.keys(migrations)).toHaveLength(1);
    expect(backfillStatements()).toHaveLength(9);
  });

  it("writes no rows for a game with everything on", async () => {
    const gameId = await insertGame(testDb());
    await seedLegacy(gameId, {});
    // env.DB.exec rejects multi-line SQL ("incomplete input"); each backfill
    // statement spans an INSERT and a SELECT line, so run it via prepare instead.
    for (const statement of backfillStatements()) await env.DB.prepare(statement).run();
    expect(await cellsFor(gameId)).toEqual({});
  });

  it("maps the three whole-notification switches to both channels", async () => {
    const gameId = await insertGame(testDb());
    await seedLegacy(gameId, { reminder_enabled: 0, short_warning_enabled: 0, result_prompt_enabled: 0 });
    for (const statement of backfillStatements()) await env.DB.prepare(statement).run();
    expect(await cellsFor(gameId)).toEqual({
      "n1.email": false, "n1.push": false,
      "n4.email": false, "n4.push": false,
      "n12.email": false, "n12.push": false,
    });
  });

  it("maps the group nudge to push only", async () => {
    const gameId = await insertGame(testDb());
    await seedLegacy(gameId, { group_nudge_enabled: 0 });
    for (const statement of backfillStatements()) await env.DB.prepare(statement).run();
    expect(await cellsFor(gameId)).toEqual({ "n11.push": false });
  });

  it("maps the two email-only switches to email only — pushes being delivered today stay on", async () => {
    // The single highest-risk line of the milestone (spec §4). n9's and n13's
    // push legs are ungated in the current code; a row for (n9, push) here
    // would silently switch off pushes owners never asked to lose.
    const gameId = await insertGame(testDb());
    await seedLegacy(gameId, { teams_published_email_enabled: 0, team_picker_email_enabled: 0 });
    for (const statement of backfillStatements()) await env.DB.prepare(statement).run();
    const cells = await cellsFor(gameId);
    expect(cells).toEqual({ "n9.email": false, "n13.email": false });
    expect(cells["n9.push"]).toBeUndefined();
    expect(cells["n13.push"]).toBeUndefined();
  });
});

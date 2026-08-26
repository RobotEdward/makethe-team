# M37 Notification Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-game, per-channel switches for every automated notification, masked by a global administrator switch an owner cannot override.

**Architecture:** The catalogue of what is switchable becomes typed data (`NOTIFICATION_CONTROLS`). Owner settings move from six boolean columns on `games` to a normalised `game_notification_settings` table; administrator settings are `app_settings` rows. One resolver (`loadNotificationSettings`) loads both in a fixed number of queries and answers `isEnabled(gameId, type, channel)` with no I/O; each send path consults it **before** `insertQueuedLogRows` and builds only the enabled legs.

**Tech Stack:** Cloudflare Workers, D1 (SQLite) via Drizzle ORM, Hono, Vitest (`@cloudflare/vitest-pool-workers`), Playwright.

**Spec:** `docs/superpowers/specs/2026-08-25-notification-controls-design.md`

## Global Constraints

- Work in the sibling worktree `../maketheteam-m37` (branch `m37-notification-controls`); it needs its own `npm install`. Never add an `allowScripts` block to `package.json`.
- **Stage explicit paths.** Never `git add -A` / `git add .`. Run `git status` before every commit.
- **Pushing `main` deploys to production.** Do not push `main` from this plan; the branch is merged fast-forward at the end (Task 12).
- Every interpolation goes through `escapeHtml`, including `href`, `name`, `value`, `for`, `id` and `class` attributes.
- No `style="…"` attributes; no `'unsafe-inline'` / `'unsafe-hashes'` in CSP. Every new `<style>` block is exported from `src/views/styles.ts` **and** listed in `PAGE_STYLE_BLOCKS` there (that array is what `STYLE_BLOCKS` and therefore `src/security/csp.ts` hash).
- A refused entitlement is a **404**, never a 403 (TR-18). Entitlement is re-asked in every handler.
- Comments name the failure a rule prevents; they never restate the code.
- The disabled-by-administrator sentence, verbatim, on the owner form:
  `Email is switched off for everyone by the site administrator. Your own setting is kept and comes back if they turn it on again.` (with `Push` in place of `Email` for the push column).
- Stored `text NOT NULL` values with no CHECK are claims, not guarantees: every reader of `game_notification_settings.notification_type` / `.channel` and of the `app_settings` value drops what it does not recognise.
- `npm test` takes >120s — run it in the foreground and wait. `npx vitest run <path>` for a scoped run.

### Two deviations from the spec, decided here

1. **Two migrations, not one.** §4 says one migration creates the table, backfills and drops the six columns. Dropping the columns from `src/db/schema.ts` breaks typecheck at every site that still reads them, and those sites are converted across five tasks. So `0024` (Task 1) creates the table and backfills; `0025` (Task 11) drops the columns once nothing reads them. Both ship in the same release, so the spec's safety argument holds unchanged.
2. **The query count is "one plus a chunked one", not "exactly two".** §5 says `loadNotificationSettings` runs exactly two queries. D1 bounds a statement at 100 parameters, and `src/db/chunk.ts` exists for that reason; the `inArray(gameIds)` query is chunked at `INSERT_CHUNK_SIZE`. What §5 actually protects — no query per fixture, no I/O in `isEnabled` — is kept and tested.

Also: §7 says both new screens join the browser suite. Admin pages are excluded from `test/browser/catalogue.ts` by design (`NOT_CATALOGUED`, "reachable only with user.is_admin, which no UI sets"). The owner form is already catalogued as `edit-game`; the admin grid joins `NOT_CATALOGUED` with the same reason as the other four admin pages, and is pinned by a route test instead.

---

## File map

| File | Responsibility |
|---|---|
| `src/notify/notification-controls.ts` (new) | `NOTIFICATION_CONTROLS`: scope and channels per type; helpers to enumerate cells. Pure data, no I/O. |
| `src/domain/app-settings.ts` | Administrator layer: `loadAdminNotificationSwitches`, `isAdminChannelOn`, `setAdminNotificationChannel`. Fail-**open** reader. |
| `src/notify/notification-settings.ts` (new) | `loadNotificationSettings(db, gameIds)` → `EffectiveSettings`. Owner rows + admin rows, resolved as `admin AND owner`. |
| `src/db/schema.ts` | `gameNotificationSettings` table (Task 1); the six boolean columns removed (Task 11). |
| `migrations/0024_*.sql`, `migrations/0025_*.sql` | Create + backfill; drop columns. |
| `src/sweep/open-and-remind.ts`, `src/notify/reminder-messages.ts`, `src/sweep/group-nudge.ts` | n1, n11 enforcement. |
| `src/sweep/attention.ts` | n4. |
| `src/routes/games.ts`, `src/notify/send-teams.ts`, `src/notify/send-picker-handover.ts` | n9, n13. |
| `src/notify/send-result-nudge.ts` | n12, with the new `skippedSwitchedOff` counter. |
| `src/notify/send-welcome.ts`, `src/notify/send-removed.ts`, `src/routes/join.ts` | n6, n7 (admin only). |
| `src/routes/broadcast.ts`, `src/views/broadcast.ts` | n10: the administrator gates what the form offers; the handler refuses regardless. |
| `src/domain/game-form.ts`, `src/views/game-form.ts`, `src/routes/games.ts` | Owner matrix: parse, render, load, save. |
| `src/views/styles.ts` | `NOTIFY_MATRIX_CSS`, registered in `PAGE_STYLE_BLOCKS`. |
| `src/auth/paths.ts`, `src/routes/admin.ts`, `src/views/admin-notifications.ts` (new), `src/views/admin-index.ts` | Administrator grid. |
| `test/support/factories.ts` | `insertNotificationSetting`, `setAdminSwitch`; the new table in `RESET_TABLES`. |
| `test/notify/notification-controls.test.ts`, `test/notify/notification-settings.test.ts`, `test/db/notification-settings-migration.test.ts`, `test/notify/notification-invariants.test.ts`, `test/routes/admin-notifications.test.ts`, `test/views/game-form-notifications.test.ts` | New tests. |

---

### Task 0: Worktree and the catalogue as typed data

**Files:**
- Create: `src/notify/notification-controls.ts`
- Test: `test/notify/notification-controls.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type ControlScope = "owner" | "admin" | "none";
  export interface Control { scope: ControlScope; channels: readonly Channel[] }
  export const NOTIFICATION_CONTROLS: Record<NotificationType, Control>;
  export interface ControlCell { type: NotificationType; channel: Channel }
  /** Every (type, channel) whose scope is `scope`, in catalogue order. */
  export function cellsWithScope(scope: "owner" | "admin"): ControlCell[];
  /** `${type}.${channel}` — the shape used by app_settings keys and form field names. */
  export function cellKey(type: NotificationType, channel: Channel): string;
  export function isNotificationType(value: string): value is NotificationType;
  export function isChannel(value: string): value is Channel;
  ```

- [ ] **Step 1: Create the worktree**

```bash
cd /home/edward/src/maketheteam
git worktree add ../maketheteam-m37 -b m37-notification-controls main
cd ../maketheteam-m37 && npm install
git config core.hooksPath .githooks
```

- [ ] **Step 2: Write the failing test**

`test/notify/notification-controls.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { NOTIFICATION_TYPES } from "../../src/notify/dedupe-key.js";
import {
  NOTIFICATION_CONTROLS,
  cellKey,
  cellsWithScope,
  isChannel,
  isNotificationType,
} from "../../src/notify/notification-controls.js";

describe("NOTIFICATION_CONTROLS", () => {
  it("names every notification type exactly once", () => {
    // A Record over the union makes a missing type a typecheck error; this
    // is the runtime half, so a stray extra key cannot hide either.
    expect(Object.keys(NOTIFICATION_CONTROLS).sort()).toEqual([...NOTIFICATION_TYPES].sort());
  });

  it("splits the catalogue as the spec does", () => {
    const byScope = (scope: "owner" | "admin" | "none") =>
      NOTIFICATION_TYPES.filter((t) => NOTIFICATION_CONTROLS[t].scope === scope);
    expect(byScope("owner")).toEqual(["n1", "n4", "n9", "n11", "n12", "n13"]);
    expect(byScope("admin")).toEqual(["n6", "n7", "n10"]);
    expect(byScope("none")).toEqual(["n2", "n3", "n5", "n8"]);
  });

  it("gives a never-switchable type no channels, so no control can be rendered for it", () => {
    for (const type of ["n2", "n3", "n5", "n8"] as const) {
      expect(NOTIFICATION_CONTROLS[type].channels).toEqual([]);
    }
  });

  it("keeps n11 push-only (src/sweep/group-nudge.ts records why)", () => {
    expect(NOTIFICATION_CONTROLS.n11.channels).toEqual(["push"]);
  });

  it("enumerates owner cells in catalogue order", () => {
    expect(cellsWithScope("owner").map((c) => cellKey(c.type, c.channel))).toEqual([
      "n1.email", "n1.push",
      "n4.email", "n4.push",
      "n9.email", "n9.push",
      "n11.push",
      "n12.email", "n12.push",
      "n13.email", "n13.push",
    ]);
  });

  it("recognises only real types and channels", () => {
    expect(isNotificationType("n9")).toBe(true);
    expect(isNotificationType("n99")).toBe(false);
    expect(isChannel("push")).toBe(true);
    expect(isChannel("sms")).toBe(false);
  });
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `npx vitest run test/notify/notification-controls.test.ts`
Expected: FAIL — cannot resolve `../../src/notify/notification-controls.js`.

- [ ] **Step 4: Write the module**

`src/notify/notification-controls.ts`:

```ts
import { NOTIFICATION_TYPES, type NotificationType } from "./dedupe-key.js";
import type { Channel } from "./notifier.js";

/**
 * Who may switch a notification off, per channel (M37).
 *
 * `owner`: the game owner has a per-game switch and the administrator a
 * global one; effective = admin AND owner. `admin`: global switch only.
 * `none`: never switchable — absent from every settings screen by
 * construction, because a control that must never be used is better absent
 * than present-and-disabled (spec §2).
 *
 * A `Record` over the whole union, not a partial map: adding `n14` to
 * `NOTIFICATION_TYPES` is a typecheck error here until somebody says what it
 * is, the same discipline the `notification_type` column enum already buys.
 *
 * `channels` lists only the legs that exist in code. `n11` has no email leg
 * and is not getting one — `src/sweep/group-nudge.ts` records the reasoning,
 * reviewed and upheld in this design.
 */
export type ControlScope = "owner" | "admin" | "none";

export interface Control {
  scope: ControlScope;
  channels: readonly Channel[];
}

const BOTH: readonly Channel[] = ["email", "push"];
const NONE: readonly Channel[] = [];

export const NOTIFICATION_CONTROLS: Record<NotificationType, Control> = {
  n1: { scope: "owner", channels: BOTH },
  n2: { scope: "none", channels: NONE },
  n3: { scope: "none", channels: NONE },
  n4: { scope: "owner", channels: BOTH },
  n5: { scope: "none", channels: NONE },
  n6: { scope: "admin", channels: BOTH },
  n7: { scope: "admin", channels: BOTH },
  n8: { scope: "none", channels: NONE },
  n9: { scope: "owner", channels: BOTH },
  n10: { scope: "admin", channels: BOTH },
  n11: { scope: "owner", channels: ["push"] },
  n12: { scope: "owner", channels: BOTH },
  n13: { scope: "owner", channels: BOTH },
};

export interface ControlCell {
  type: NotificationType;
  channel: Channel;
}

/** Every (type, channel) with the given scope, in catalogue order. */
export function cellsWithScope(scope: "owner" | "admin"): ControlCell[] {
  const cells: ControlCell[] = [];
  for (const type of NOTIFICATION_TYPES) {
    const control = NOTIFICATION_CONTROLS[type];
    if (control.scope !== scope) continue;
    for (const channel of control.channels) cells.push({ type, channel });
  }
  return cells;
}

/** `n9.email` — the one spelling shared by `app_settings` keys and form field names. */
export function cellKey(type: NotificationType, channel: Channel): string {
  return `${type}.${channel}`;
}

export function isNotificationType(value: string): value is NotificationType {
  return (NOTIFICATION_TYPES as readonly string[]).includes(value);
}

const CHANNELS: readonly string[] = ["email", "push"];

export function isChannel(value: string): value is Channel {
  return CHANNELS.includes(value);
}
```

- [ ] **Step 5: Run the test and typecheck**

Run: `npx vitest run test/notify/notification-controls.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git status
git add src/notify/notification-controls.ts test/notify/notification-controls.test.ts
git commit -m "M37: the notification catalogue's switchability as typed data"
```

---

### Task 1: The `game_notification_settings` table, migration and backfill

**Files:**
- Modify: `src/db/schema.ts` (add the table after the `games` table; leave the six boolean columns in place — Task 11 removes them)
- Create: `migrations/0024_<generated>.sql` (generated, then edited)
- Modify: `test/support/factories.ts` (`RESET_TABLES`, `insertNotificationSetting`)
- Test: `test/db/notification-settings-migration.test.ts`

**Interfaces:**
- Produces: `gameNotificationSettings` Drizzle table with columns `gameId`, `notificationType`, `channel`, `enabled` (boolean mode), `updatedAt` (timestamp_ms).
- Produces (factories): `insertNotificationSetting(db, gameId, type: string, channel: string, enabled: boolean): Promise<void>` — `type`/`channel` are `string`, not the unions, so the stored-lookups test can write an unknown value.

- [ ] **Step 1: Add the table to the schema**

In `src/db/schema.ts`, find the `games` table's closing `);` and add immediately after it:

```ts
/**
 * Per-game notification switches, one row per (game, type, channel) (M37).
 *
 * **No row means on.** The owner form upserts a row for every cell it
 * renders, so a missing row means the game predates M37 or the type is newer
 * than the game's last save — both must behave as the product did before.
 *
 * `notification_type` and `channel` are bare `text NOT NULL` with no CHECK, so
 * a row can hold a string this build has never heard of. Readers drop such
 * rows rather than index `NOTIFICATION_CONTROLS` with them — the failure
 * class `test/stored-lookups.test.ts` exists for.
 *
 * Deliberately not `text(..., { enum })`: the enum is a type-level claim, and
 * the reader must be written as though it is not there.
 */
export const gameNotificationSettings = sqliteTable(
  "game_notification_settings",
  {
    gameId: text("game_id")
      .notNull()
      .references(() => games.id, { onDelete: "cascade" }),
    notificationType: text("notification_type").notNull(),
    channel: text("channel").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
  },
  (table) => [primaryKey({ columns: [table.gameId, table.notificationType, table.channel] })],
);
```

Add `primaryKey` to the `drizzle-orm/sqlite-core` import on line 2. Check that `nowMs` is the name the file already uses for `sql\`(unixepoch() * 1000)\`` (it is used by `appSettings.updatedAt`); if the file spells it differently, use the file's spelling.

- [ ] **Step 2: Generate the migration**

Run: `npm run db:generate`
Expected: `migrations/0024_<name>.sql` containing one `CREATE TABLE \`game_notification_settings\`` statement, and `migrations/meta/0024_snapshot.json` + journal entry. Open the SQL and confirm the primary key is composite and the FK has `ON DELETE cascade`.

- [ ] **Step 3: Append the backfill to the generated migration**

Append to `migrations/0024_<name>.sql`, after the CREATE TABLE and a `--> statement-breakpoint` line, exactly these six statements, each separated by `--> statement-breakpoint`:

```sql
--> statement-breakpoint
INSERT INTO `game_notification_settings` (`game_id`, `notification_type`, `channel`, `enabled`, `updated_at`)
SELECT `id`, 'n1', 'email', 0, (unixepoch() * 1000) FROM `games` WHERE `reminder_enabled` = 0;--> statement-breakpoint
INSERT INTO `game_notification_settings` (`game_id`, `notification_type`, `channel`, `enabled`, `updated_at`)
SELECT `id`, 'n1', 'push', 0, (unixepoch() * 1000) FROM `games` WHERE `reminder_enabled` = 0;--> statement-breakpoint
INSERT INTO `game_notification_settings` (`game_id`, `notification_type`, `channel`, `enabled`, `updated_at`)
SELECT `id`, 'n4', 'email', 0, (unixepoch() * 1000) FROM `games` WHERE `short_warning_enabled` = 0;--> statement-breakpoint
INSERT INTO `game_notification_settings` (`game_id`, `notification_type`, `channel`, `enabled`, `updated_at`)
SELECT `id`, 'n4', 'push', 0, (unixepoch() * 1000) FROM `games` WHERE `short_warning_enabled` = 0;--> statement-breakpoint
INSERT INTO `game_notification_settings` (`game_id`, `notification_type`, `channel`, `enabled`, `updated_at`)
SELECT `id`, 'n12', 'email', 0, (unixepoch() * 1000) FROM `games` WHERE `result_prompt_enabled` = 0;--> statement-breakpoint
INSERT INTO `game_notification_settings` (`game_id`, `notification_type`, `channel`, `enabled`, `updated_at`)
SELECT `id`, 'n12', 'push', 0, (unixepoch() * 1000) FROM `games` WHERE `result_prompt_enabled` = 0;--> statement-breakpoint
INSERT INTO `game_notification_settings` (`game_id`, `notification_type`, `channel`, `enabled`, `updated_at`)
SELECT `id`, 'n11', 'push', 0, (unixepoch() * 1000) FROM `games` WHERE `group_nudge_enabled` = 0;--> statement-breakpoint
INSERT INTO `game_notification_settings` (`game_id`, `notification_type`, `channel`, `enabled`, `updated_at`)
SELECT `id`, 'n9', 'email', 0, (unixepoch() * 1000) FROM `games` WHERE `teams_published_email_enabled` = 0;--> statement-breakpoint
INSERT INTO `game_notification_settings` (`game_id`, `notification_type`, `channel`, `enabled`, `updated_at`)
SELECT `id`, 'n13', 'email', 0, (unixepoch() * 1000) FROM `games` WHERE `team_picker_email_enabled` = 0;
```

Add this comment block at the top of the file (SQL comments survive `wrangler d1 migrations apply`):

```sql
-- M37. Owner switches move from six boolean columns on `games` to one row
-- per (game, type, channel). Rows are written only where the old column is
-- off; a game with everything on gets no rows and resolves to on by absence.
--
-- The backfill is NOT uniform. `reminder_enabled`, `short_warning_enabled`
-- and `result_prompt_enabled` gate the whole notification today — the send
-- path skips before either leg is built — so each maps to BOTH channels.
-- `teams_published_email_enabled` and `team_picker_email_enabled` gate the
-- email leg only; their push legs are ungated in `send-teams.ts` and
-- `send-picker-handover.ts`, and mapping them to push would silently switch
-- off pushes being delivered today, to owners who never asked for that.
-- `group_nudge_enabled` gates a push-only notification.
--
-- The six columns are dropped by migration 0025, once nothing reads them.
```

- [ ] **Step 4: Register the table in the factories**

In `test/support/factories.ts`:
- Add `"game_notification_settings",` to `RESET_TABLES` immediately before `"games",` (it references `games`, so it is a child).
- Add the import of `gameNotificationSettings` from `../../src/db/schema.js`.
- Add:

```ts
/**
 * One owner switch (M37). `type` and `channel` are plain strings so a test
 * can write a value this build does not recognise — the stored-lookups case.
 */
export async function insertNotificationSetting(
  db: Db,
  gameId: string,
  type: string,
  channel: string,
  enabled: boolean,
): Promise<void> {
  await db
    .insert(gameNotificationSettings)
    .values({ gameId, notificationType: type, channel, enabled })
    .onConflictDoUpdate({
      target: [gameNotificationSettings.gameId, gameNotificationSettings.notificationType, gameNotificationSettings.channel],
      set: { enabled },
    });
}
```

- [ ] **Step 5: Write the migration fidelity test**

The suite applies every migration before any test runs, so the backfill cannot be observed against the real `games` table. The test replays the migration's own INSERT statements — read from the file, not retyped — against a scratch table carrying the six old columns. This is the spec's "single highest-risk line" test.

`test/db/notification-settings-migration.test.ts`:

```ts
import { env } from "cloudflare:test";
import { readdirSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { gameNotificationSettings } from "../../src/db/schema.js";
import { insertGame, resetDatabase, testDb } from "../support/factories.js";

// Vite `?raw` imports need a literal path, so the file name is resolved by a
// glob import instead: exactly one migration mentions the new table's backfill.
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
    expect(readdirSync("migrations").filter((f) => f.startsWith("0024_"))).toHaveLength(1);
    expect(backfillStatements()).toHaveLength(9);
  });

  it("writes no rows for a game with everything on", async () => {
    const gameId = await insertGame(testDb());
    await seedLegacy(gameId, {});
    for (const statement of backfillStatements()) await env.DB.exec(statement);
    expect(await cellsFor(gameId)).toEqual({});
  });

  it("maps the three whole-notification switches to both channels", async () => {
    const gameId = await insertGame(testDb());
    await seedLegacy(gameId, { reminder_enabled: 0, short_warning_enabled: 0, result_prompt_enabled: 0 });
    for (const statement of backfillStatements()) await env.DB.exec(statement);
    expect(await cellsFor(gameId)).toEqual({
      "n1.email": false, "n1.push": false,
      "n4.email": false, "n4.push": false,
      "n12.email": false, "n12.push": false,
    });
  });

  it("maps the group nudge to push only", async () => {
    const gameId = await insertGame(testDb());
    await seedLegacy(gameId, { group_nudge_enabled: 0 });
    for (const statement of backfillStatements()) await env.DB.exec(statement);
    expect(await cellsFor(gameId)).toEqual({ "n11.push": false });
  });

  it("maps the two email-only switches to email only — pushes being delivered today stay on", async () => {
    // The single highest-risk line of the milestone (spec §4). n9's and n13's
    // push legs are ungated in the current code; a row for (n9, push) here
    // would silently switch off pushes owners never asked to lose.
    const gameId = await insertGame(testDb());
    await seedLegacy(gameId, { teams_published_email_enabled: 0, team_picker_email_enabled: 0 });
    for (const statement of backfillStatements()) await env.DB.exec(statement);
    const cells = await cellsFor(gameId);
    expect(cells).toEqual({ "n9.email": false, "n13.email": false });
    expect(cells["n9.push"]).toBeUndefined();
    expect(cells["n13.push"]).toBeUndefined();
  });
});
```

If `import.meta.glob` with `query: "?raw"` is not honoured under the workers pool, fall back to `import MIGRATION_SQL from "../../migrations/0024_<name>.sql?raw"` with the literal generated name, and keep the `readdirSync` assertion so a renamed file fails loudly.

- [ ] **Step 6: Run the test**

Run: `npx vitest run test/db/notification-settings-migration.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 7: Typecheck and lint, then commit**

Run: `npx tsc --noEmit && npm run lint`

```bash
git status
git add src/db/schema.ts migrations/0024_*.sql migrations/meta/0024_snapshot.json migrations/meta/_journal.json test/support/factories.ts test/db/notification-settings-migration.test.ts
git commit -m "M37: game_notification_settings table with a non-uniform backfill from the six switch columns"
```

---

### Task 2: Administrator layer and the resolver

**Files:**
- Modify: `src/domain/app-settings.ts`
- Create: `src/notify/notification-settings.ts`
- Modify: `test/support/factories.ts` (`setAdminSwitch`)
- Modify: `test/stored-lookups.test.ts` (two new cases)
- Test: `test/notify/notification-settings.test.ts`

**Interfaces:**
- Produces (`src/domain/app-settings.ts`):
  ```ts
  /** The `app_settings` keys of every administrator notification switch that is off. */
  export async function loadAdminNotificationSwitches(db: Db): Promise<AdminNotificationSwitches>;
  export interface AdminNotificationSwitches { isOn(type: NotificationType, channel: Channel): boolean }
  export async function setAdminNotificationChannel(db: Db, type: NotificationType, channel: Channel, on: boolean): Promise<void>;
  export function adminNotificationKey(type: NotificationType, channel: Channel): string; // `notify.n9.email`
  ```
- Produces (`src/notify/notification-settings.ts`):
  ```ts
  export interface EffectiveSettings {
    isEnabled(gameId: string, type: NotificationType, channel: Channel): boolean;
    /** The administrator's answer alone — what the owner form needs to render a masked cell. */
    adminAllows(type: NotificationType, channel: Channel): boolean;
    /** The owner's stored row alone, `true` when absent — what the owner form needs to render the tick. */
    ownerWants(gameId: string, type: NotificationType, channel: Channel): boolean;
  }
  export async function loadNotificationSettings(db: Db, gameIds: readonly string[]): Promise<EffectiveSettings>;
  export async function saveOwnerNotificationSettings(db: Db, gameId: string, cells: { type: NotificationType; channel: Channel; enabled: boolean }[]): Promise<void>;
  ```
- Produces (factories): `setAdminSwitch(db, type: string, channel: string, on: boolean)`.

- [ ] **Step 1: Write the failing tests**

`test/notify/notification-settings.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadNotificationSettings, saveOwnerNotificationSettings } from "../../src/notify/notification-settings.js";
import { cellsWithScope } from "../../src/notify/notification-controls.js";
import { insertGame, insertNotificationSetting, resetDatabase, setAdminSwitch, testDb } from "../support/factories.js";

const db = testDb();

describe("loadNotificationSettings", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("answers on for every owner cell of a game with no rows", async () => {
    const gameId = await insertGame(db);
    const settings = await loadNotificationSettings(db, [gameId]);
    for (const cell of cellsWithScope("owner")) {
      expect(settings.isEnabled(gameId, cell.type, cell.channel), `${cell.type}.${cell.channel}`).toBe(true);
    }
  });

  it("answers on for every admin cell when nothing has been written", async () => {
    const settings = await loadNotificationSettings(db, []);
    for (const cell of cellsWithScope("admin")) {
      expect(settings.adminAllows(cell.type, cell.channel), `${cell.type}.${cell.channel}`).toBe(true);
    }
  });

  it("honours an owner's off, per channel", async () => {
    const gameId = await insertGame(db);
    await insertNotificationSetting(db, gameId, "n9", "email", false);
    const settings = await loadNotificationSettings(db, [gameId]);
    expect(settings.isEnabled(gameId, "n9", "email")).toBe(false);
    expect(settings.isEnabled(gameId, "n9", "push")).toBe(true);
  });

  it("masks with the administrator's off, and keeps the owner's row underneath", async () => {
    const gameId = await insertGame(db);
    await insertNotificationSetting(db, gameId, "n9", "email", true);
    await setAdminSwitch(db, "n9", "email", false);
    const settings = await loadNotificationSettings(db, [gameId]);
    expect(settings.isEnabled(gameId, "n9", "email")).toBe(false);
    expect(settings.adminAllows("n9", "email")).toBe(false);
    expect(settings.ownerWants(gameId, "n9", "email")).toBe(true);
  });

  it("reads the administrator's off from the exact string 'off' only", async () => {
    // The opposite direction from `isOpenSignups`: an unknown value here
    // means on, because off would silence a notification nobody switched off.
    await setAdminSwitch(db, "n9", "email", false);
    const { appSettings } = await import("../../src/db/schema.js");
    const { eq } = await import("drizzle-orm");
    await db.update(appSettings).set({ value: "disabled" }).where(eq(appSettings.key, "notify.n9.email"));
    const settings = await loadNotificationSettings(db, []);
    expect(settings.adminAllows("n9", "email")).toBe(true);
  });

  it("drops an owner row whose type or channel it does not recognise", async () => {
    const gameId = await insertGame(db);
    await insertNotificationSetting(db, gameId, "n99", "email", false);
    await insertNotificationSetting(db, gameId, "n9", "sms", false);
    const settings = await loadNotificationSettings(db, [gameId]);
    expect(settings.isEnabled(gameId, "n9", "email")).toBe(true);
    expect(settings.isEnabled(gameId, "n9", "push")).toBe(true);
  });

  it("scopes owner rows to their own game", async () => {
    const a = await insertGame(db);
    const b = await insertGame(db);
    await insertNotificationSetting(db, a, "n1", "push", false);
    const settings = await loadNotificationSettings(db, [a, b]);
    expect(settings.isEnabled(a, "n1", "push")).toBe(false);
    expect(settings.isEnabled(b, "n1", "push")).toBe(true);
  });

  it("does no I/O in isEnabled, and no query per game", async () => {
    // The hourly sweep asks about every due fixture; a resolver that touched
    // D1 per fixture would be an N+1 on the hottest path in the product.
    const ids = await Promise.all(Array.from({ length: 30 }, () => insertGame(db)));
    const select = vi.spyOn(db, "select");
    const settings = await loadNotificationSettings(db, ids);
    const loadQueries = select.mock.calls.length;
    // One for app_settings plus ceil(30 / INSERT_CHUNK_SIZE) — far fewer than 30.
    expect(loadQueries).toBeLessThan(ids.length);
    for (const id of ids) settings.isEnabled(id, "n1", "email");
    expect(select.mock.calls.length).toBe(loadQueries);
    select.mockRestore();
  });
});

describe("saveOwnerNotificationSettings", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("upserts each cell and leaves cells it was not given alone", async () => {
    const gameId = await insertGame(db);
    await insertNotificationSetting(db, gameId, "n1", "push", false);
    await saveOwnerNotificationSettings(db, gameId, [
      { type: "n9", channel: "email", enabled: false },
      { type: "n9", channel: "email", enabled: true },
    ]);
    const settings = await loadNotificationSettings(db, [gameId]);
    expect(settings.ownerWants(gameId, "n9", "email")).toBe(true);
    expect(settings.ownerWants(gameId, "n1", "push")).toBe(false);
  });
});
```

Add to `test/stored-lookups.test.ts`, in a new `describe("game_notification_settings", …)` block at the end (imports: `loadNotificationSettings`, `insertNotificationSetting`, `setAdminSwitch`):

```ts
describe("game_notification_settings and the notify.* app settings", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("survives a notification_type and a channel it has never heard of", async () => {
    const db = getDb(env.DB);
    const gameId = await insertGame(db);
    await insertNotificationSetting(db, gameId, OUT_OF_UNION, "email", false);
    await insertNotificationSetting(db, gameId, "n9", OUT_OF_UNION, false);
    const settings = await loadNotificationSettings(db, [gameId]);
    expect(settings.isEnabled(gameId, "n9", "email")).toBe(true);
  });

  it("survives an app_settings value it has never heard of, reading it as on", async () => {
    const db = getDb(env.DB);
    await setAdminSwitch(db, "n9", "email", false);
    await db.update(appSettings).set({ value: OUT_OF_UNION }).where(eq(appSettings.key, "notify.n9.email"));
    const settings = await loadNotificationSettings(db, []);
    expect(settings.adminAllows("n9", "email")).toBe(true);
  });
});
```

(`appSettings` needs adding to the existing schema import in that file.)

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run test/notify/notification-settings.test.ts test/stored-lookups.test.ts`
Expected: FAIL — modules/exports missing.

- [ ] **Step 3: Add the administrator layer to `src/domain/app-settings.ts`**

Append (add `inArray`/`like` to the `drizzle-orm` import as used, plus `NotificationType` and `Channel` type imports from `../notify/dedupe-key.js` and `../notify/notifier.js`):

```ts
/** `app_settings.key` prefix for the administrator's notification switches (M37). */
const NOTIFY_PREFIX = "notify.";

/** The stored value that means off. Anything else means on — see `loadAdminNotificationSwitches`. */
const OFF = "off";

export function adminNotificationKey(type: NotificationType, channel: Channel): string {
  return `${NOTIFY_PREFIX}${type}.${channel}`;
}

export interface AdminNotificationSwitches {
  isOn(type: NotificationType, channel: Channel): boolean;
}

/**
 * Every administrator notification switch, in one query (M37).
 *
 * **Fails open — the opposite direction from `isOpenSignups` above, on
 * purpose.** There the safe direction is "refuse", because the row guards
 * sign-in. Here a missing row means nobody has ever touched the setting, and
 * defaulting that to off would mean deploying the migration silently stops
 * every notification in the product. So only the exact string `"off"` means
 * off; a missing row, or a value a later build wrote and this one has never
 * heard of, means on. Two readers, one table, opposite safe directions, each
 * saying why.
 */
export async function loadAdminNotificationSwitches(db: Db): Promise<AdminNotificationSwitches> {
  const rows = await db
    .select({ key: appSettings.key, value: appSettings.value })
    .from(appSettings)
    .where(like(appSettings.key, `${NOTIFY_PREFIX}%`));
  const off = new Set(rows.filter((row) => row.value === OFF).map((row) => row.key));
  return { isOn: (type, channel) => !off.has(adminNotificationKey(type, channel)) };
}

/** Upserts, as `setOpenSignups` does and for the same two-tabs reason. */
export async function setAdminNotificationChannel(
  db: Db,
  type: NotificationType,
  channel: Channel,
  on: boolean,
): Promise<void> {
  const value = on ? "on" : OFF;
  await db
    .insert(appSettings)
    .values({ key: adminNotificationKey(type, channel), value })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value, updatedAt: sql`(unixepoch() * 1000)` },
    });
}
```

- [ ] **Step 4: Write the resolver**

`src/notify/notification-settings.ts`:

```ts
import { inArray } from "drizzle-orm";
import { chunk, INSERT_CHUNK_SIZE } from "../db/chunk.js";
import type { Db } from "../db/client.js";
import { gameNotificationSettings } from "../db/schema.js";
import { loadAdminNotificationSwitches } from "../domain/app-settings.js";
import type { NotificationType } from "./dedupe-key.js";
import { NOTIFICATION_CONTROLS, cellKey, isChannel, isNotificationType } from "./notification-controls.js";
import type { Channel } from "./notifier.js";

/**
 * The answer to "may this notification go out on this channel for this game?"
 * (M37), resolved as `admin AND owner` for owner-scoped types and `admin`
 * alone for administrator-scoped ones.
 *
 * Loaded once for a set of games and then answered from memory: the hourly
 * sweep asks about every due fixture, and a resolver that touched D1 per
 * fixture would be an N+1 on the hottest path in the product. `isEnabled`
 * performs no I/O.
 *
 * Asked at the send path, before `insertQueuedLogRows`, never in a notifier
 * decorator: a `Message` carries no game id, and a message filtered after the
 * `queued` row is reserved leaves a row that never sends and never retries
 * (spec §5).
 */
export interface EffectiveSettings {
  isEnabled(gameId: string, type: NotificationType, channel: Channel): boolean;
  /** The administrator's answer alone. */
  adminAllows(type: NotificationType, channel: Channel): boolean;
  /** The owner's stored row alone, `true` when absent. */
  ownerWants(gameId: string, type: NotificationType, channel: Channel): boolean;
}

export async function loadNotificationSettings(db: Db, gameIds: readonly string[]): Promise<EffectiveSettings> {
  const admin = await loadAdminNotificationSwitches(db);

  // Only rows that say off are kept: absence means on, so an `enabled = 1`
  // row and no row are the same answer.
  const ownerOff = new Set<string>();
  const unique = [...new Set(gameIds)];
  for (const batch of chunk(unique, INSERT_CHUNK_SIZE)) {
    const rows = await db
      .select({
        gameId: gameNotificationSettings.gameId,
        type: gameNotificationSettings.notificationType,
        channel: gameNotificationSettings.channel,
        enabled: gameNotificationSettings.enabled,
      })
      .from(gameNotificationSettings)
      .where(inArray(gameNotificationSettings.gameId, batch));
    for (const row of rows) {
      // Both columns are bare text with no CHECK: a row this build does not
      // recognise is dropped, never used to index NOTIFICATION_CONTROLS.
      if (!isNotificationType(row.type) || !isChannel(row.channel)) continue;
      if (!row.enabled) ownerOff.add(`${row.gameId}:${cellKey(row.type, row.channel)}`);
    }
  }

  const ownerWants = (gameId: string, type: NotificationType, channel: Channel): boolean =>
    !ownerOff.has(`${gameId}:${cellKey(type, channel)}`);

  return {
    adminAllows: (type, channel) => admin.isOn(type, channel),
    ownerWants,
    isEnabled(gameId, type, channel) {
      const control = NOTIFICATION_CONTROLS[type];
      if (control.scope === "none") return true;
      if (!admin.isOn(type, channel)) return false;
      return control.scope === "admin" || ownerWants(gameId, type, channel);
    },
  };
}

/** Upsert the owner's cells for one game. Cells not passed are left as they were (mask, never overwrite). */
export async function saveOwnerNotificationSettings(
  db: Db,
  gameId: string,
  cells: readonly { type: NotificationType; channel: Channel; enabled: boolean }[],
): Promise<void> {
  for (const cell of cells) {
    await db
      .insert(gameNotificationSettings)
      .values({ gameId, notificationType: cell.type, channel: cell.channel, enabled: cell.enabled })
      .onConflictDoUpdate({
        target: [gameNotificationSettings.gameId, gameNotificationSettings.notificationType, gameNotificationSettings.channel],
        set: { enabled: cell.enabled, updatedAt: new Date() },
      });
  }
}
```

If `db.batch` is the file-local convention for multi-row writes (see `src/domain/update-game.ts:88`), it is fine to keep the loop: eleven upserts per owner save is not a hot path.

- [ ] **Step 5: Add `setAdminSwitch` to the factories**

```ts
/** One administrator switch (M37). Strings, not unions, for the stored-lookups case. */
export async function setAdminSwitch(db: Db, type: string, channel: string, on: boolean): Promise<void> {
  await db
    .insert(appSettings)
    .values({ key: `notify.${type}.${channel}`, value: on ? "on" : "off" })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: on ? "on" : "off" } });
}
```

- [ ] **Step 6: Run the tests, typecheck, commit**

Run: `npx vitest run test/notify/notification-settings.test.ts test/stored-lookups.test.ts && npx tsc --noEmit && npm run lint`
Expected: PASS.

```bash
git status
git add src/domain/app-settings.ts src/notify/notification-settings.ts test/support/factories.ts test/stored-lookups.test.ts test/notify/notification-settings.test.ts
git commit -m "M37: administrator switches and the admin-AND-owner resolver"
```

---

### Task 3: Task zero — the enumerating invariant tests

**Files:**
- Test: `test/notify/notification-invariants.test.ts`

These are spec §7's invariants 1 and 2, written **before** any send path is converted, driven off `NOTIFICATION_CONTROLS`. They fail now and go green one type at a time through Tasks 4–8. Invariant 3 (the disabled checkbox) needs the form and is written in Task 9.

**Interfaces:**
- Consumes: `loadNotificationSettings`, `insertNotificationSetting`, `setAdminSwitch`, `cellsWithScope`.
- Produces: a `DRIVERS` table mapping each owner- and admin-scoped type to a function that seeds the minimum state and runs that type's send path, returning the channels that reached the notifier.

- [ ] **Step 1: Write the test**

`test/notify/notification-invariants.test.ts`. The drivers reuse the seeding each existing suite already does; **read the named suite to copy its seeding**, do not invent it:

- `n1`: how `test/sweep/open-and-remind.test.ts` seeds an open fixture that is due and a player with an email and a push subscription, then calls `openAndRemind`.
- `n4`: how `test/sweep/attention.test.ts` seeds a short fixture and an owner with a subscription, then calls `sendOwnerAttention`.
- `n9`: how `test/notify/send-teams.test.ts` seeds a published fixture and calls `sendTeamsEmails`.
- `n11`: how `test/sweep/group-nudge.test.ts` seeds and calls `sendGroupNudges`.
- `n12`: how `test/notify/result-nudge.test.ts` seeds a played fixture and calls `sendResultNudges`.
- `n13`: how `test/notify/send-picker-handover.test.ts` calls `sendPickerHandover`.
- `n6`: how `test/notify/send-welcome.test.ts` calls `sendWelcomeEmail`.
- `n7`: how `test/notify/send-removed.test.ts` calls `sendRemovedEmail`.
- `n10`: how `test/notify/send-broadcast.test.ts` calls `sendBroadcast` with both channels.

Each driver has the shape:

```ts
interface Driver {
  /** Seeds a game, a recipient with both an email and a registered device, and whatever the send path needs. Returns the game id. */
  seed(db: Db): Promise<string>;
  /** Runs the send path once against a recording notifier; returns the channels of every message it was handed. */
  send(db: Db, gameId: string, notifier: Notifier): Promise<void>;
}
```

The notifier is a recording stub — find the one `test/notify/send-teams.test.ts` uses and reuse its shape; it must record `message.channel` for every message and answer `{ ok: true }`.

The test body:

```ts
describe("invariant 1: every owner cell is enforced, per channel", () => {
  for (const cell of cellsWithScope("owner")) {
    const control = NOTIFICATION_CONTROLS[cell.type];
    const other = control.channels.find((c) => c !== cell.channel);
    it(`${cell.type}: owner off on ${cell.channel} sends nothing on ${cell.channel}${other ? ` while ${other} still goes` : ""}`, async () => {
      const gameId = await DRIVERS[cell.type].seed(db);
      await insertNotificationSetting(db, gameId, cell.type, cell.channel, false);
      const sent = recording();
      await DRIVERS[cell.type].send(db, gameId, sent.notifier);
      expect(sent.channels).not.toContain(cell.channel);
      if (other) expect(sent.channels).toContain(other);
    });
  }
});

describe("invariant 2: the administrator masks, never overwrites", () => {
  for (const cell of [...cellsWithScope("owner"), ...cellsWithScope("admin")]) {
    it(`${cell.type}.${cell.channel}: admin off sends nothing on that channel whatever the owner says`, async () => {
      const gameId = await DRIVERS[cell.type].seed(db);
      if (NOTIFICATION_CONTROLS[cell.type].scope === "owner") {
        await insertNotificationSetting(db, gameId, cell.type, cell.channel, true);
      }
      await setAdminSwitch(db, cell.type, cell.channel, false);
      const sent = recording();
      await DRIVERS[cell.type].send(db, gameId, sent.notifier);
      expect(sent.channels).not.toContain(cell.channel);
    });
  }

  for (const cell of cellsWithScope("owner")) {
    it(`${cell.type}.${cell.channel}: the owner's row is byte-identical after admin off then on`, async () => {
      const gameId = await insertGame(db);
      await insertNotificationSetting(db, gameId, cell.type, cell.channel, false);
      const before = await db.select().from(gameNotificationSettings).where(eq(gameNotificationSettings.gameId, gameId));
      await setAdminSwitch(db, cell.type, cell.channel, false);
      await setAdminSwitch(db, cell.type, cell.channel, true);
      const after = await db.select().from(gameNotificationSettings).where(eq(gameNotificationSettings.gameId, gameId));
      expect(after).toEqual(before);
    });
  }
});
```

For `n12` the driver's recipient must have **both** an email and a device, and the "other channel still goes" assertion holds because push-off falls back to email and email-off with a device still pushes.

- [ ] **Step 2: Run it — expect the enforcement cases to fail**

Run: `npx vitest run test/notify/notification-invariants.test.ts`
Expected: the "byte-identical" cases PASS (they need only Task 2); every "sends nothing" case FAILS. Record the count of failures in the commit message.

- [ ] **Step 3: Commit the red test**

```bash
git status
git add test/notify/notification-invariants.test.ts
git commit -m "M37: enumerating invariants for owner and administrator switches (red until the send paths are converted)"
```

---

### Task 4: n1 and n11 — the reminder sweep and the group nudge

**Files:**
- Modify: `src/sweep/open-and-remind.ts` (`DueFixture.switches` removed; `sendDueReminders` consults the resolver)
- Modify: `src/notify/reminder-messages.ts` (`buildReminderMessages` takes `channels`)
- Modify: `src/sweep/group-nudge.ts`
- Modify: `test/sweep/open-and-remind.test.ts`, `test/sweep/group-nudge.test.ts` (seed via `insertNotificationSetting` instead of `insertGame({ reminderEnabled: false })`)

**Interfaces:**
- Consumes: `loadNotificationSettings`.
- Produces: `buildReminderMessages(params & { channels: { email: boolean; push: boolean } })`. `DueFixture` loses `switches`.

- [ ] **Step 1: Update the existing tests first**

In `test/sweep/open-and-remind.test.ts`, find every `reminderEnabled: false` / `groupNudgeEnabled: false` passed to `insertGame` and replace with `insertNotificationSetting(db, gameId, "n1", "email", false)` **and** `insertNotificationSetting(db, gameId, "n1", "push", false)` (both, because the old switch meant both). Same in `test/sweep/group-nudge.test.ts` with `"n11", "push"`. Add one new case to `open-and-remind.test.ts`:

```ts
it("sends the push leg alone when only email is switched off (M37)", async () => {
  // Seed as the "sends a reminder" case above does, with a subscribed player, then:
  await insertNotificationSetting(db, gameId, "n1", "email", false);
  const result = await openAndRemind(db, notifier, NOW, SECRET, env.FIXTURE_CAPACITY);
  expect(sent.map((m) => m.channel)).toEqual(["push"]);
  expect(result.remind.pushRemindersSent).toBe(1);
  expect(result.remind.remindersSent).toBe(0);
});
```

Run: `npx vitest run test/sweep/open-and-remind.test.ts test/sweep/group-nudge.test.ts` — expect the changed cases to FAIL.

- [ ] **Step 2: Convert `fixturesDueByLifecycle`**

In `src/sweep/open-and-remind.ts`: remove the `switches` field and its doc comment from `DueFixture`; remove `reminderEnabled`/`groupNudgeEnabled` from the select and the object literal. Replace the doc comment with:

```ts
  // Switches are not carried here (M37): the three callers share this query
  // and only two of them notify. Each of those loads `loadNotificationSettings`
  // over the due set's game ids once, so the answer is per channel and never
  // per-fixture I/O.
```

- [ ] **Step 3: Convert `sendDueReminders`**

At the top of `sendDueReminders`, after `due` is known:

```ts
  const settings = await loadNotificationSettings(db, due.map((fixture) => fixture.gameId));
```

Replace the `if (!fixture.switches.reminderEnabled) continue;` block with:

```ts
    // The owner's and administrator's switches (M37), per channel. Skipped
    // before the per-fixture query and before any `notification_log` row is
    // written, so switching back on later leaves the next due fixture still
    // eligible rather than already-logged.
    const channels = {
      email: settings.isEnabled(fixture.gameId, "n1", "email"),
      push: settings.isEnabled(fixture.gameId, "n1", "push"),
    };
    if (!channels.email && !channels.push) continue;
```

Pass `channels` into `buildReminderMessages({ …, channels })`.

The BR-32 guard (`candidate.isGuest || !candidate.email …`) currently skips a candidate with no email *before* building. With email off and push on, a guest with a device should still get the push. Change that guard so it only skips when `channels.email` is on **and** there is no address, or when `!channels.email` and the candidate has no subscription — simplest correct form: move the address check into `buildReminderMessages` per leg (below) and keep `guestsSkipped++` there only for the case where neither leg was built for the candidate. Keep the `.trim()` reasoning comment with the check wherever it lands.

- [ ] **Step 4: Convert `buildReminderMessages`**

Add `channels: { email: boolean; push: boolean }` to its params. Wrap the email `pending.push({ channel: "email" … })` in `if (channels.email && email !== "")` (where `email` is the trimmed address; today's guard) and the push block in `if (channels.push && subscribed.has(candidate.playerId))`. The push leg currently reuses `dedupeKey`/`emailPayload` built for the email; keep building `emailPayload` unconditionally (it is the push copy's input) and compute `dedupeKey` before either branch.

- [ ] **Step 5: Convert `sendGroupNudges`**

Replace `const due = allDue.filter((fixture) => fixture.switches.groupNudgeEnabled);` with:

```ts
  const settings = await loadNotificationSettings(db, allDue.map((fixture) => fixture.gameId));
  // The owner's and administrator's switches (M37). Filtered here rather than
  // skipped in the loop so `fixturesConsidered` keeps meaning "fixtures this
  // step could have nudged for".
  const due = allDue.filter((fixture) => settings.isEnabled(fixture.gameId, "n11", "push"));
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run test/sweep test/notify/notification-invariants.test.ts test/cron`
Expected: sweep and cron suites PASS; in the invariants suite the `n1` and `n11` cases now PASS; the rest still fail.

- [ ] **Step 7: Typecheck, lint, commit**

```bash
npx tsc --noEmit && npm run lint
git status
git add src/sweep/open-and-remind.ts src/notify/reminder-messages.ts src/sweep/group-nudge.ts test/sweep/open-and-remind.test.ts test/sweep/group-nudge.test.ts
git commit -m "M37: n1 and n11 consult the resolver per channel"
```

---

### Task 5: n4 — the owner attention warning

**Files:**
- Modify: `src/sweep/attention.ts`
- Modify: `test/sweep/attention.test.ts`

- [ ] **Step 1: Update the existing tests**

In `test/sweep/attention.test.ts`, replace `shortWarningEnabled: false` seeds with both `insertNotificationSetting(db, gameId, "n4", "email", false)` and `…"n4", "push", false)`. Add:

```ts
it("emails without pushing when push is switched off (M37)", async () => {
  // Seed as the "pushes the owner" case does, then:
  await insertNotificationSetting(db, gameId, "n4", "push", false);
  await sendOwnerAttention({ db, notifier, now: NOW, cancelTokenSecret: SECRET, ceilingReached: false });
  expect(sent.map((m) => m.channel)).toEqual(["email"]);
});
```

Run: `npx vitest run test/sweep/attention.test.ts` — expect FAIL.

- [ ] **Step 2: Convert `fixturesNeedingAttention` and `processFixture`**

Remove `shortWarningEnabled` from the select and the `if (!row.shortWarningEnabled) continue;` guard (and its comment). In `sendOwnerAttention`, after the candidates are known:

```ts
  const settings = await loadNotificationSettings(db, candidates.map((c) => c.gameId));
```

Filter candidates: keep those where `settings.isEnabled(gameId, "n4", "email") || settings.isEnabled(gameId, "n4", "push")`, with the comment:

```ts
  // The owner's and administrator's switches (M37). A fixture with both
  // channels off is skipped before any `notification_log` row exists for it.
```

Pass `channels: { email, push }` (from `settings.isEnabled` for that fixture's game) into `processFixture`, and guard the email `pending.push` with `channels.email` and the push one with `channels.push && subscribed.has(...)`. Where an owner has no usable email and email is the only enabled channel, treat as today's no-address path.

- [ ] **Step 3: Run, typecheck, commit**

Run: `npx vitest run test/sweep/attention.test.ts test/notify/notification-invariants.test.ts && npx tsc --noEmit && npm run lint`
Expected: attention PASS; `n4` invariant cases PASS.

```bash
git status
git add src/sweep/attention.ts test/sweep/attention.test.ts
git commit -m "M37: n4 consults the resolver per channel"
```

---

### Task 6: n9 and n13 — teams published, picker handed over

**Files:**
- Modify: `src/notify/send-teams.ts` (`SendTeamsEmailsParams.channels`)
- Modify: `src/notify/send-picker-handover.ts` (`SendPickerHandoverParams.channels`)
- Modify: `src/routes/games.ts` (the publish handler near the `teamsPublishedEmailEnabled` read, `publishTeams`, the picker handler near `teamPickerEmailEnabled`, `notifyPicker`, and the two `teamsEmailEnabled:` view params)
- Modify: `test/notify/send-teams.test.ts`, `test/notify/send-picker-handover.test.ts`, `test/routes/team-publish.test.ts`, `test/routes/games.test.ts`

**Interfaces:**
- Produces: both send functions take `channels: { email: boolean; push: boolean }` — "a ceiling on what is attempted", the same wording `SendBroadcastParams.channels` already uses. Callers resolve it; the senders do no settings I/O.

- [ ] **Step 1: Update the tests**

- `send-teams.test.ts` / `send-picker-handover.test.ts`: every call gains `channels: { email: true, push: true }`. Add one case each: `channels: { email: false, push: true }` sends only the push and writes only the push `notification_log` row; `{ email: true, push: false }` sends only the email.
- `team-publish.test.ts` and `games.test.ts`: find `teamsPublishedEmailEnabled: false` / `teamPickerEmailEnabled: false` seeds and replace with `insertNotificationSetting(db, gameId, "n9", "email", false)` / `("n13", "email", false)`. Where a test asserts "nothing sent" with the old switch off, it must now assert the push still goes if the test seeds a subscription — read each case and decide; the spec's rule is that the old column maps to email only.

Run the four files — expect FAIL.

- [ ] **Step 2: Convert the senders**

In `send-teams.ts` and `send-picker-handover.ts`: add `channels` to the params interface with the doc comment `/** Whether each channel may be attempted (M37). Resolved by the caller; a ceiling, never a promise. */`. Guard the email `pending.push` with `channels.email` and the push one with `channels.push && subscribed.has(...)`. The BR-32 "no address" skip applies only when `channels.email` is on. If `pending` ends up empty because both channels are off, return the existing "nothing to send" outcome shape the function already has for an empty squad.

- [ ] **Step 3: Convert the routes**

In the publish handler (`src/routes/games.ts`, the block commented "M26. The publish itself still happened"):

```ts
  const settings = await loadNotificationSettings(db, [target.game.id]);
  const channels = {
    email: settings.isEnabled(target.game.id, "n9", "email"),
    push: settings.isEnabled(target.game.id, "n9", "push"),
  };
  // M37. The publish itself still happened — `teams_published_at` is set
  // above and players can see their side — but with both channels off none
  // is sent and no `notification_log` row is written.
  if (channels.email || channels.push) {
    c.executionCtx.waitUntil(publishTeams(c.env, target.fixture.id, now, channels));
  }
```

Thread `channels` through `publishTeams` into `sendTeamsEmails`. Same shape for the picker handler and `notifyPicker` → `sendPickerHandover` with `"n13"`.

The two `teamsEmailEnabled: game.teamsPublishedEmailEnabled` view params (picker page and fixture page): replace with `settings.isEnabled(game.id, "n9", "email")`, loading settings once in each handler. Do not change the view.

- [ ] **Step 4: Run, typecheck, commit**

Run: `npx vitest run test/notify/send-teams.test.ts test/notify/send-picker-handover.test.ts test/routes/team-publish.test.ts test/routes/games.test.ts test/notify/notification-invariants.test.ts && npx tsc --noEmit && npm run lint`
Expected: PASS; `n9`, `n13` invariants PASS.

```bash
git status
git add src/notify/send-teams.ts src/notify/send-picker-handover.ts src/routes/games.ts test/notify/send-teams.test.ts test/notify/send-picker-handover.test.ts test/routes/team-publish.test.ts test/routes/games.test.ts
git commit -m "M37: n9 and n13 take resolved channels from their routes"
```

---

### Task 7: n12 — push preferred, email fallback, never a disabled channel

**Files:**
- Modify: `src/notify/send-result-nudge.ts`
- Modify: `src/cron/handler.ts` (log the new counter where the others are logged — find where `skippedNoAddress` is reported)
- Modify: `test/notify/result-nudge.test.ts`

**Interfaces:**
- Produces: `ResultNudgeResult.skippedSwitchedOff: number` — "an eligible, reachable player whose game has both N-12 channels off; not BR-32".

- [ ] **Step 1: Update the tests**

Replace `resultPromptEnabled: false` seeds with both `("n12", "email", false)` and `("n12", "push", false)`. Add:

```ts
it("falls back to email when push is switched off, even for a player with a device (M37)", async () => {
  // Seed a played fixture and a player with an email AND a subscription, as the push case does, then:
  await insertNotificationSetting(db, gameId, "n12", "push", false);
  const result = await sendResultNudges(db, notifier, NOW, SECRET);
  expect(sent.map((m) => m.channel)).toEqual(["email"]);
  expect(result.pushSent).toBe(0);
});

it("sends nothing, and does not count the player as unreachable, when both channels are off", async () => {
  await insertNotificationSetting(db, gameId, "n12", "email", false);
  await insertNotificationSetting(db, gameId, "n12", "push", false);
  const result = await sendResultNudges(db, notifier, NOW, SECRET);
  expect(sent).toEqual([]);
  expect(result.skippedNoAddress).toBe(0);
  expect(result.skippedSwitchedOff).toBe(1);
});

it("still counts a genuinely unreachable player under BR-32 when channels are on", async () => {
  // A player with no email and no device.
  const result = await sendResultNudges(db, notifier, NOW, SECRET);
  expect(result.skippedNoAddress).toBe(1);
  expect(result.skippedSwitchedOff).toBe(0);
});
```

Run: `npx vitest run test/notify/result-nudge.test.ts` — FAIL.

- [ ] **Step 2: Convert the sender**

- Remove `resultPromptEnabled` from the select and from the `due` filter.
- After `due` is computed: `const settings = await loadNotificationSettings(db, due.map((f) => f.gameId));` and pass `settings` into `nudgeOneFixture`.
- In `nudgeOneFixture`, before the player loop:
  ```ts
  const channels = {
    email: settings.isEnabled(fixture.gameId, "n12", "email"),
    push: settings.isEnabled(fixture.gameId, "n12", "push"),
  };
  ```
- Rewrite the per-player choice:
  ```ts
    // Push if push is enabled and the player has a device; otherwise email if
    // email is enabled; otherwise nothing (M37). A disabled channel is never
    // used, not even as the fallback.
    if (channels.push && subscribed.has(playerId)) { …push… continue; }
    const email = channels.email ? (player.email?.trim() ?? "") : "";
    if (email !== "") { …email… continue; }
    if (!channels.email && !channels.push) {
      // Reachable, but the owner or administrator switched both channels off.
      // Kept out of `skippedNoAddress`: that counter exists to surface players
      // nobody can reach, and a switched-off game would fill it with noise.
      result.skippedSwitchedOff++;
      continue;
    }
    if (!channels.email && subscribed.has(playerId)) { result.skippedSwitchedOff++; continue; } // push off, no email leg wanted — reachable, not counted as unreachable
    result.skippedNoAddress++;
  ```
  Simplify the last three branches into one clear rule: increment `skippedSwitchedOff` when the player *could* have been reached on a channel that is off (has a device but push is off, or has an email but email is off); increment `skippedNoAddress` only when the player has neither an address nor a device. Write it as two booleans `reachableByPush`, `reachableByEmail` computed before the branches.
- Add `skippedSwitchedOff` to `ResultNudgeResult`, `emptyResult`, and the doc comment.

- [ ] **Step 3: Log it in the cron handler**

In `src/cron/handler.ts`, find where the result-nudge step logs `skippedNoAddress` and add `skippedSwitchedOff` beside it in the same format.

- [ ] **Step 4: Run, typecheck, commit**

Run: `npx vitest run test/notify/result-nudge.test.ts test/cron test/notify/notification-invariants.test.ts && npx tsc --noEmit && npm run lint`

```bash
git status
git add src/notify/send-result-nudge.ts src/cron/handler.ts test/notify/result-nudge.test.ts
git commit -m "M37: n12 never uses a disabled channel, and a switched-off player is not 'unreachable'"
```

---

### Task 8: n6, n7 and n10 — the administrator-only types

**Files:**
- Modify: `src/notify/send-welcome.ts`, `src/notify/send-removed.ts`
- Modify: `src/routes/join.ts` (the `switch (result.kind)` after `sendWelcomeEmail` — add the new case), `src/routes/games.ts` (`notifyRemovedPlayer`'s result handling)
- Modify: `src/routes/broadcast.ts`, `src/views/broadcast.ts`
- Modify: `test/notify/send-welcome.test.ts`, `test/notify/send-removed.test.ts`, `test/routes/broadcast-post.test.ts`, plus the broadcast GET test file (find it with `grep -l "renderBroadcastPage\|/message" test/routes`)

**Interfaces:**
- Produces: `WelcomeSendOutcome` and `RemovedSendOutcome` gain `| { kind: "switched-off" }`.
- Produces: `BroadcastPageParams.offered: { email: boolean; push: boolean }` — which channel controls to render.

- [ ] **Step 1: Tests first**

- `send-welcome.test.ts` / `send-removed.test.ts`: add "admin email off sends only the push" (`setAdminSwitch(db, "n6", "email", false)`) and "both off returns `{ kind: "switched-off" }` and writes no `notification_log` row".
- Broadcast POST test: add

```ts
it("refuses an email broadcast the administrator has switched off, even though the box was never rendered (TR-18)", async () => {
  await setAdminSwitch(db, "n10", "email", false);
  // Post as the owner with email=on, push=on, a subject and a message — copy the happy-path body from this file.
  expect(response.status).toBe(404);
  expect(sent).toEqual([]);
});
it("still sends a push-only broadcast when email is switched off", async () => { /* email absent from body; expect 303 and one push */ });
```

- Broadcast GET test: "omits the email checkbox and says why when the administrator has it off" — assert `not.toContain('name="email"')` and `toContain("Email is switched off for everyone by the site administrator")`.

Run them — FAIL.

- [ ] **Step 2: Convert the two senders**

In each, after the player row is loaded and before any message is built:

```ts
  const admin = await loadAdminNotificationSwitches(db);
  const channels = { email: admin.isOn("n6", "email"), push: admin.isOn("n6", "push") };
  if (!channels.email && !channels.push) return { kind: "switched-off" };
```

(`"n7"` in `send-removed.ts`.) Guard each leg with its channel, as in Task 6. If the only enabled channel is email and the player has no address, keep returning `skipped-no-recipient`.

- [ ] **Step 3: Handle the new outcome in the callers**

`src/routes/join.ts`: add `case "switched-off": console.log(\`welcome email (N-6) switched off by the administrator: ${who}\`); return;` to the exhaustive switch. `src/routes/games.ts` `notifyRemovedPlayer`: add the matching `console.log` line beside the `skipped-no-recipient` one.

- [ ] **Step 4: Gate the broadcast form and handler**

`src/views/broadcast.ts`: add `offered: { email: boolean; push: boolean }` to `BroadcastPageParams`; in `channelFields`, render each `.switch-row` only if offered, and where one is not offered render instead:

```ts
<p class="hint notify-admin-off">${escapeHtml(`${label} is switched off for everyone by the site administrator.`)}</p>
```

with `label` = `"Email"` / `"Push"`. (The `.notify-admin-off` class is declared in Task 9's block; the broadcast page must add `NOTIFY_MATRIX_CSS` to its `pageStyles` in Task 9 — note it here, do it there, and add a presence assertion then.)

`src/routes/broadcast.ts`: in both GET handlers and in `handleSend`'s `rerender`, compute `const admin = await loadAdminNotificationSwitches(db); const offered = { email: admin.isOn("n10", "email"), push: admin.isOn("n10", "push") };` and pass `offered`. The empty form (`emptyBroadcastForm`, or whatever the fresh-GET builder is called at `src/routes/broadcast.ts:135`) must default each channel to `offered.x`, not `true`. In `handleSend`, immediately after `parseBroadcastForm` succeeds:

```ts
  // TR-18: hiding the control is not enforcement. A submission asking for a
  // channel the administrator has switched off is refused as a 404, exactly
  // as an entitlement the caller does not hold.
  if ((parsed.values.email && !offered.email) || (parsed.values.push && !offered.push)) {
    return c.text("Not found", 404);
  }
```

- [ ] **Step 5: Run, typecheck, commit**

Run: `npx vitest run test/notify/send-welcome.test.ts test/notify/send-removed.test.ts test/routes/broadcast-post.test.ts test/routes test/notify/notification-invariants.test.ts && npx tsc --noEmit && npm run lint`
Expected: PASS; **every** invariant case now PASS.

```bash
git status
git add src/notify/send-welcome.ts src/notify/send-removed.ts src/routes/join.ts src/routes/games.ts src/routes/broadcast.ts src/views/broadcast.ts test/notify/send-welcome.test.ts test/notify/send-removed.test.ts test/routes/broadcast-post.test.ts <the broadcast GET test file>
git commit -m "M37: administrator switches for n6, n7 and what the n10 form offers"
```

---

### Task 9: The owner's Notifications matrix

**Files:**
- Modify: `src/domain/game-form.ts` (remove the six switches from `NOTIFICATION_SWITCHES` and `GameFormValues`; add `parseNotificationCells`)
- Modify: `src/views/game-form.ts` (the `notification()` helper and the `notifications` fieldset)
- Modify: `src/views/styles.ts` (`NOTIFY_MATRIX_CSS`, in `PAGE_STYLE_BLOCKS`)
- Modify: `src/routes/games.ts` (edit GET loads settings; create/edit POST saves cells)
- Modify: `src/views/broadcast.ts` (add `NOTIFY_MATRIX_CSS` to `pageStyles`, from Task 8)
- Modify: `test/domain/game-form.test.ts`, `test/routes/games.test.ts`
- Test: `test/views/game-form-notifications.test.ts`
- Modify: `test/notify/notification-invariants.test.ts` (invariant 3)

**Interfaces:**
- Produces (`src/domain/game-form.ts`):
  ```ts
  export interface NotificationCellValue { type: NotificationType; channel: Channel; enabled: boolean }
  /** Field name of a cell's checkbox: `notify.n9.email`. Its marker is `notify.n9.email.seen`. */
  export function cellFieldName(type: NotificationType, channel: Channel): string;
  export function cellMarkerName(type: NotificationType, channel: Channel): string;
  /** Every owner cell whose marker was posted. A cell with no marker was not rendered (masked, or an older form) and is not returned. */
  export function parseNotificationCells(body: Record<string, unknown>): NotificationCellValue[];
  ```
- Produces (`src/views/game-form.ts`): `GameFormPageParams.notifications?: NotificationRowView[]` where
  ```ts
  export interface NotificationCellView { channel: Channel; ownerWants: boolean; adminAllows: boolean }
  export interface NotificationRowView { type: NotificationType; label: string; hint: string; cells: NotificationCellView[]; timings?: string }
  ```
  Only the six timing/label strings differ per row; keep `OWNER_NOTIFICATION_COPY: Record<OwnerType, { label; hint }>` in the view.

- [ ] **Step 1: Tests first**

`test/domain/game-form.test.ts`: remove the cases for the six old switches; add:

```ts
describe("parseNotificationCells", () => {
  it("returns only cells whose marker was posted, with their checkbox state", () => {
    const cells = parseNotificationCells({
      "notify.n9.email.seen": "1", "notify.n9.email": "on",
      "notify.n9.push.seen": "1",
      "notify.n1.email": "on", // no marker: an unrendered cell, ignored
    });
    expect(cells).toEqual([
      { type: "n9", channel: "email", enabled: true },
      { type: "n9", channel: "push", enabled: false },
    ]);
  });
  it("ignores a marker for a cell the catalogue does not have", () => {
    expect(parseNotificationCells({ "notify.n11.email.seen": "1", "notify.n2.email.seen": "1" })).toEqual([]);
  });
});
```

`test/views/game-form-notifications.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { renderGameFormPage } from "../../src/views/game-form.js";
import { FORM_CSS, NOTIFY_MATRIX_CSS } from "../../src/views/styles.js";
import { cellsWithScope } from "../../src/notify/notification-controls.js";

const BASE = { nav: { /* find the minimal PageNav other view tests build */ }, action: "/x", heading: "h", submitLabel: "s", values: {}, errors: [], warnings: [], showAdvanced: true, gameId: "g1" };

function rows(overrides: Partial<Record<string, { ownerWants?: boolean; adminAllows?: boolean }>> = {}) {
  // Build one NotificationRowView per owner type from cellsWithScope("owner"), all on, then apply overrides keyed "n9.email".
}

describe("the owner notifications matrix", () => {
  it("renders a header row naming both channels and one row per owner type", () => {
    const html = renderGameFormPage({ ...BASE, notifications: rows() });
    expect(html).toContain("<th>Email</th>");
    expect(html).toContain("<th>Push</th>");
    for (const type of ["n1", "n4", "n9", "n11", "n12", "n13"]) expect(html).toContain(`data-notification="${type}"`);
  });

  it("renders a dash, not a control, for a channel a notification has no version of", () => {
    const html = renderGameFormPage({ ...BASE, notifications: rows() });
    expect(html).not.toContain('name="notify.n11.email"');
    expect(html).not.toContain('name="notify.n11.email.seen"');
    expect(html).toMatch(/data-notification="n11"[\s\S]*?<td class="notify-cell notify-none">—<\/td>/);
  });

  it("renders an administrator-disabled cell unchecked, disabled, without its marker, and says why", () => {
    const html = renderGameFormPage({ ...BASE, notifications: rows({ "n9.email": { ownerWants: true, adminAllows: false } }) });
    expect(html).toMatch(/name="notify\.n9\.email"[^>]*disabled/);
    expect(html).not.toMatch(/name="notify\.n9\.email"[^>]*checked/);
    expect(html).not.toContain('name="notify.n9.email.seen"');
    expect(html).toContain("Email is switched off for everyone by the site administrator. Your own setting is kept and comes back if they turn it on again.");
  });

  it("ticks a cell from the owner's stored value", () => {
    const html = renderGameFormPage({ ...BASE, notifications: rows({ "n1.push": { ownerWants: false } }) });
    expect(html).not.toMatch(/name="notify\.n1\.push"[^>]*checked/);
    expect(html).toMatch(/name="notify\.n1\.email"[^>]*checked/);
  });

  it("does not put matrix rows under .switch-row, whose grid rules would misplace the checkboxes", () => {
    // FORM_CSS's `.switch-row input { grid-column: 2; grid-row: 1 / span 2 }`
    // is what broke the mockup's alignment as soon as a row had a third child.
    const html = renderGameFormPage({ ...BASE, notifications: rows() });
    expect(html).not.toMatch(/class="[^"]*switch-row[^"]*notify-row/);
  });

  it("ships NOTIFY_MATRIX_CSS after FORM_CSS", () => {
    const html = renderGameFormPage({ ...BASE, notifications: rows() });
    const form = html.indexOf(FORM_CSS);
    const matrix = html.indexOf(NOTIFY_MATRIX_CSS);
    expect(form).toBeGreaterThan(-1);
    expect(matrix).toBeGreaterThan(-1);
    expect(form).toBeLessThan(matrix);
  });

  it("uses no inline style attribute", () => {
    expect(renderGameFormPage({ ...BASE, notifications: rows() })).not.toMatch(/ style="/);
  });
});
```

Invariant 3, appended to `test/notify/notification-invariants.test.ts`:

```ts
describe("invariant 3: a disabled checkbox posts nothing, and that is not a choice", () => {
  it("leaves an owner's true untouched when the administrator has the cell off and the owner saves the form", async () => {
    // Sign in as an owner, create a game (find how test/routes/games.test.ts does it), then:
    await insertNotificationSetting(db, gameId, "n9", "email", true);
    await setAdminSwitch(db, "n9", "email", false);
    // GET the edit form, extract every input name/value inside the Notifications fieldset, and POST them back
    // together with the rest of the form's current values (copy the body-building helper games.test.ts uses for edits).
    const settings = await loadNotificationSettings(db, [gameId]);
    expect(settings.ownerWants(gameId, "n9", "email")).toBe(true);
    // And a cell the owner *could* see and unticked is saved:
    expect(settings.ownerWants(gameId, "n9", "push")).toBe(false); // after posting without notify.n9.push but with its marker
  });
});
```

Run all three — FAIL.

- [ ] **Step 2: The parser**

In `src/domain/game-form.ts`: delete the six entries from `NOTIFICATION_SWITCHES` (keep `gatedInvitesEnabled`), the six fields from `GameFormValues`, the six `switchValue` calls and their six lines in the returned `values`. Update the doc comment above `NOTIFICATION_SWITCHES` so it no longer says "all five/six notification switches" — it now describes the marker convention for `gatedInvitesEnabled` alone and points at `parseNotificationCells` for the matrix. Add:

```ts
const CELL_PREFIX = "notify.";

export function cellFieldName(type: NotificationType, channel: Channel): string {
  return `${CELL_PREFIX}${cellKey(type, channel)}`;
}

export function cellMarkerName(type: NotificationType, channel: Channel): string {
  return `${cellFieldName(type, channel)}.seen`;
}

/**
 * The owner's notification cells, from the posted body (M37).
 *
 * A browser sends nothing for an unticked box, so each rendered checkbox has
 * a hidden marker beside it, and only a cell whose marker arrived is
 * returned. A cell the form did not render — because the administrator has
 * it off, or because the form predates the type — has no marker and is left
 * exactly as stored. Without that, an owner's first save would write `false`
 * into every administrator-disabled cell, which surfaces as settings nobody
 * chose the moment the administrator re-enables the channel.
 *
 * Driven off the catalogue, never off the body's keys: a forged marker for a
 * cell that does not exist is ignored.
 */
export function parseNotificationCells(body: Record<string, unknown>): NotificationCellValue[] {
  const cells: NotificationCellValue[] = [];
  for (const cell of cellsWithScope("owner")) {
    if (body[cellMarkerName(cell.type, cell.channel)] === undefined) continue;
    cells.push({ type: cell.type, channel: cell.channel, enabled: typeof body[cellFieldName(cell.type, cell.channel)] === "string" });
  }
  return cells;
}
```

- [ ] **Step 3: The view**

In `src/views/game-form.ts`: delete the `notification()` helper and the six calls; keep `timing()`. Add `notifications?: NotificationRowView[]` to `GameFormPageParams` with the comment `/** The owner's matrix (M37). Absent on create — a game that does not exist has no rows to show. */`. Render, when `showAdvanced && notifications`:

```ts
  const CHANNEL_LABEL: Record<Channel, string> = { email: "Email", push: "Push" };

  const cell = (row: NotificationRowView, channel: Channel): string => {
    const found = row.cells.find((c) => c.channel === channel);
    if (!found) return `<td class="notify-cell notify-none">—</td>`;
    const name = cellFieldName(row.type, channel);
    if (!found.adminAllows) {
      return `<td class="notify-cell"><input id="${escapeHtml(name)}" name="${escapeHtml(name)}" type="checkbox" disabled aria-describedby="${escapeHtml(name)}-note"></td>`;
    }
    return `<td class="notify-cell">
        <input type="hidden" name="${escapeHtml(cellMarkerName(row.type, channel))}" value="1">
        <input id="${escapeHtml(name)}" name="${escapeHtml(name)}" type="checkbox"${found.ownerWants ? " checked" : ""} aria-label="${escapeHtml(`${row.label} — ${CHANNEL_LABEL[channel]}`)}">
      </td>`;
  };

  const adminNotes = (row: NotificationRowView): string =>
    row.cells
      .filter((c) => !c.adminAllows)
      .map((c) => `<p class="notify-admin-off" id="${escapeHtml(cellFieldName(row.type, c.channel))}-note">${escapeHtml(`${CHANNEL_LABEL[c.channel]} is switched off for everyone by the site administrator. Your own setting is kept and comes back if they turn it on again.`)}</p>`)
      .join("");

  const matrixRow = (row: NotificationRowView): string => `
      <tr class="notify-row" data-notification="${escapeHtml(row.type)}">
        <td class="notify-what">
          <span class="notify-label">${escapeHtml(row.label)}</span>
          <span class="hint">${escapeHtml(row.hint)}</span>
          ${adminNotes(row)}
          ${row.timings ?? ""}
        </td>
        ${cell(row, "email")}
        ${cell(row, "push")}
      </tr>`;

  const notifications = showAdvanced && params.notifications
    ? `
      <fieldset class="notify-group">
        <legend>Notifications</legend>
        <table class="notify-matrix">
          <thead><tr><th class="notify-what">Notification</th><th>Email</th><th>Push</th></tr></thead>
          <tbody>${params.notifications.map(matrixRow).join("")}</tbody>
        </table>
      </fieldset>`
    : "";
```

Label/hint copy and timings per type, as `OWNER_NOTIFICATION_COPY` in the view (the route passes only settings; the view owns words):

| type | label | hint | timings |
|---|---|---|---|
| n1 | Remind players before kickoff | The message that asks players if they are in. Fixtures still open on this schedule when it is off. | `reminderDaysBefore` + `reminderLocalTime` (as today) |
| n4 | Warn me when a fixture is short or uneven | Once per fixture. Only fixtures scheduled from now on take a changed warning time. | `shortWarningOffsetHours` |
| n9 | Tell players when I publish teams | Sent when you publish. Teams still appear on the fixture page. | — |
| n11 | Nudge me to post it to the group chat | A phone notification, sent with the reminder above. | — |
| n12 | Ask players how it went | Asks everyone who played for the score. Zero hours means as soon after full time as we can. | `resultPromptOffsetHours` |
| n13 | Tell a player when I hand them the team pick | Nothing is sent when you open the pick to the whole squad. | — |

The row-building is a view helper `ownerNotificationRows(gameId, settings): NotificationRowView[]` exported from `src/views/game-form.ts`, iterating `cellsWithScope("owner")` grouped by type and calling `settings.ownerWants` / `settings.adminAllows`. Timings keep the `.notify-timing` markup and its existing `timing()` inputs; the `.switch-row .notify-timing input` rules in `FORM_CSS` no longer apply (no `.switch-row`), so the block below restates the filled-field treatment under `.notify-matrix .notify-timing input`.

Add `NOTIFY_MATRIX_CSS` to this page's `pageStyles` **after** `FORM_CSS`, and to `src/views/broadcast.ts`'s `pageStyles`.

- [ ] **Step 4: The style block**

In `src/views/styles.ts`, after `INVITE_ORDER_CSS`:

```ts
/**
 * The owner's notification matrix (M37) — `src/views/game-form.ts`.
 *
 * A table, not a `.switch-row` grid. The design mockup put each row on
 * `.switch-row`, whose `input { grid-row: 1 / span 2 }` held the tick beside
 * the label only while a row had exactly a label, a hint and a box; the first
 * row with a timing strip or an administrator note pushed every checkbox out
 * of its column. Table cells align by construction whatever a row carries.
 * Namespaced under `.notify-matrix` so nothing here ties a FORM_CSS selector;
 * test/views/game-form-notifications.test.ts pins the block order regardless.
 */
export const NOTIFY_MATRIX_CSS = `
  table.notify-matrix { width: 100%; border-collapse: collapse; }
  table.notify-matrix th { text-align: center; font-size: var(--t-support); color: var(--mut); font-weight: 600; padding: 0.4rem 0; }
  table.notify-matrix th.notify-what { text-align: left; }
  table.notify-matrix td { padding: 0.6rem 0; border-top: 1px solid var(--line); vertical-align: top; }
  table.notify-matrix td.notify-what { padding-right: 1rem; }
  table.notify-matrix .notify-label { display: block; font-weight: 600; }
  table.notify-matrix .hint { display: block; font-size: var(--t-support); color: var(--mut); }
  /* 52px wide so the whole cell is the hit area, not the 1.4rem box (FORM_CSS's floor). */
  table.notify-matrix td.notify-cell { width: 52px; text-align: center; vertical-align: middle; }
  table.notify-matrix td.notify-cell input { width: 1.4rem; height: 1.4rem; accent-color: var(--accent); }
  table.notify-matrix td.notify-cell input:disabled { opacity: 0.45; }
  table.notify-matrix td.notify-none { color: var(--mut); }
  .notify-admin-off { margin: 0.3rem 0 0; font-size: var(--t-support); color: var(--warn); }
  table.notify-matrix .notify-timing { display: flex; flex-wrap: wrap; gap: 0.75rem; margin-top: 0.5rem; }
  table.notify-matrix .notify-timing label { font-weight: 400; font-size: var(--t-support); color: var(--mut); }
  /* The filled-field treatment .field input gives every other control, restated
     because these inputs sit in a table cell, not a .field. */
  table.notify-matrix .notify-timing input {
    max-width: 9rem; width: 100%; padding: 0.6rem 0.7rem; font: inherit;
    color: var(--fg); background: var(--field); border: none; border-radius: 0.75rem;
  }
  table.notify-matrix .notify-timing input:focus-visible { outline: 3px solid var(--accent); outline-offset: 1px; }
`;
```

Add `NOTIFY_MATRIX_CSS,` to `PAGE_STYLE_BLOCKS`. Check `var(--warn)`, `--field`, `--mut`, `--line`, `--accent`, `--t-support` all exist in `src/views/layout.ts`'s palette (they are used by neighbouring blocks). Remove from `FORM_CSS` the now-dead `.notify-row:last-of-type`, `.notify-timing`, `.notify-timing-field` and `.switch-row .notify-timing …` rules **only if** `grep -rn "notify-timing" src/views` shows no other user; if `timing()` still emits `.notify-timing-field`, keep that one rule and move it into `NOTIFY_MATRIX_CSS`.

- [ ] **Step 5: The routes**

`src/routes/games.ts`:
- Edit GET (the block building `values:` with `reminderEnabled: game.reminderEnabled ? "on" : ""`): delete those six lines; load `const settings = await loadNotificationSettings(db, [game.id]);` and pass `notifications: ownerNotificationRows(game.id, settings)`.
- Edit POST: after `updateGame(...)`, `await saveOwnerNotificationSettings(db, game.id, parseNotificationCells(form));`. On the 422 re-render, pass `notifications` built from settings too (find the re-render block and mirror the GET).
- Create POST: nothing to save — the create form has no matrix — but confirm `createGame` no longer receives the six booleans (they left `GameFormValues`).

- [ ] **Step 6: Run the tests**

Run: `npx vitest run test/domain/game-form.test.ts test/views test/routes/games.test.ts test/notify/notification-invariants.test.ts test/security && npx tsc --noEmit && npm run lint`
Expected: PASS, including `test/views/style-cascade.test.ts` and `test/security/csp.test.ts`.

- [ ] **Step 7: Look at the page**

This is the rendered-page check the spec demands. Run the browser capture for the edit-game screen (find the invocation in `package.json`'s `guide:capture` and `test/browser/capture.spec.ts`; capture just `edit-game`, or run the whole `--grep @guide` if it cannot be scoped), then **Read the PNG** under `test/browser/screenshots/` or `docs/guide/images/`. Confirm, by eye:
- both checkbox columns are vertically aligned down the whole table, including the rows carrying timing inputs;
- the header row names Email and Push above their columns;
- `n11`'s email cell is a dash;
- the timing inputs are filled, rounded fields, not thin-bordered browser defaults.

To see the disabled state, temporarily set an admin switch off in the world builder (`test/browser/world.ts`), capture, read, and revert. If anything is off, fix the CSS and capture again; do not reason about it.

- [ ] **Step 8: Commit**

```bash
git status
git add src/domain/game-form.ts src/views/game-form.ts src/views/styles.ts src/routes/games.ts src/views/broadcast.ts test/domain/game-form.test.ts test/routes/games.test.ts test/views/game-form-notifications.test.ts test/notify/notification-invariants.test.ts
git commit -m "M37: the owner's notifications matrix, masked by the administrator"
```

If the capture regenerated `docs/guide/images/*` for this page, stage that PNG too; if it regenerated others with no visible change, leave them unstaged.

---

### Task 10: The administrator's global grid

**Files:**
- Modify: `src/auth/paths.ts` (`ADMIN_NOTIFICATIONS_PATH`, `ADMIN_NOTIFICATIONS_SET_PATH`)
- Create: `src/views/admin-notifications.ts`
- Modify: `src/routes/admin.ts`, `src/views/admin-index.ts`, `src/views/styles.ts` (`ADMIN_NOTIFICATIONS_CSS` in `PAGE_STYLE_BLOCKS`)
- Modify: `test/browser/catalogue.ts` (`NOT_CATALOGUED`)
- Test: `test/routes/admin-notifications.test.ts`

**Interfaces:**
- Produces: `ADMIN_NOTIFICATIONS_PATH = \`${ADMIN_PATH}/notifications\``, `ADMIN_NOTIFICATIONS_SET_PATH = \`${ADMIN_NOTIFICATIONS_PATH}/set\``.
- Produces: `renderAdminNotificationsPage({ nav, switches: AdminNotificationSwitches })`.
- POST body: `type`, `channel`, `on` (`"on"` or absent) → 303 to the grid. Unknown `type`/`channel` → 404 (the resource does not exist).

- [ ] **Step 1: Tests first**

`test/routes/admin-notifications.test.ts`, following `test/routes/admin-usage.test.ts`'s `signInAs` shape:

```ts
describe("the admin notifications screen", () => {
  it("redirects an anonymous visitor to sign-in", …302 to SIGN_IN_PATH…);
  it("answers 404, not 403, to a signed-in non-admin", …);
  it("renders three bands: owner-controllable, administrator-only, never switchable", async () => {
    const html = …GET as admin…;
    expect(html).toContain("Owners can also switch these off per game");
    expect(html).toContain("Administrator only");
    expect(html).toContain("Never switched off");
    for (const t of ["n2", "n3", "n5", "n8"]) expect(html).toMatch(new RegExp(`data-notification="${t}"[^>]*>[\\s\\S]*?No control`));
    expect(html).not.toContain('name="type" value="n5"');
  });
  it("renders a dash for n11's email", …expect no form with type n11 channel email…);
  it("turns a channel off and back on", async () => {
    POST { type: "n9", channel: "email" } (no `on`) → 303; loadAdminNotificationSwitches(db).isOn("n9","email") === false
    POST { type: "n9", channel: "email", on: "on" } → 303; isOn === true
  });
  it("refuses an unknown type or channel with a 404", …POST type "n99" → 404; channel "sms" → 404…);
  it("refuses a cross-origin post", …403 with a foreign Origin header, as the allowlist tests do…);
});
```

- [ ] **Step 2: Paths and view**

`src/auth/paths.ts`: add the two constants next to `ADMIN_USAGE_PATH`.

`src/views/admin-notifications.ts`:

```ts
import { ADMIN_NOTIFICATIONS_SET_PATH } from "../auth/paths.js";
import type { AdminNotificationSwitches } from "../domain/app-settings.js";
import { NOTIFICATION_TYPES, type NotificationType } from "../notify/dedupe-key.js";
import { NOTIFICATION_CONTROLS } from "../notify/notification-controls.js";
import type { Channel } from "../notify/notifier.js";
import { escapeHtml, layout, type PageNav } from "./layout.js";
import { ADMIN_NOTIFICATIONS_CSS, ADMIN_TOOLS_CSS } from "./styles.js";

/** What each notification is, in the operator's words. The catalogue says what is switchable; this says what it is. */
const NAMES: Record<NotificationType, string> = {
  n1: "Fixture reminder", n2: "Promoted from the waitlist", n3: "Fixture cancelled",
  n4: "Fixture short or uneven (to the owner)", n5: "Sign-in link", n6: "Welcome to the squad",
  n7: "Removed from a squad", n8: "Erasure scheduled", n9: "Teams published",
  n10: "Organiser broadcast", n11: "Group-chat nudge (to the owner)", n12: "How did it go?",
  n13: "Team pick handed over",
};

const WHY_NEVER: Partial<Record<NotificationType, string>> = {
  n2: "A player moved into the team who is never told turns up to nothing.",
  n3: "The squad would turn up to a game that is off.",
  n5: "Switching it off locks every player out with no way back in.",
  n8: "The confirmation of a data-erasure request.",
};

export interface AdminNotificationsPageParams { nav: PageNav; switches: AdminNotificationSwitches }

export function renderAdminNotificationsPage(params: AdminNotificationsPageParams): string {
  const { switches } = params;
  const cell = (type: NotificationType, channel: Channel): string => {
    if (!NOTIFICATION_CONTROLS[type].channels.includes(channel)) return `<td class="notify-cell notify-none">—</td>`;
    const on = switches.isOn(type, channel);
    return `<td class="notify-cell">
      <form method="post" action="${escapeHtml(ADMIN_NOTIFICATIONS_SET_PATH)}">
        <input type="hidden" name="type" value="${escapeHtml(type)}">
        <input type="hidden" name="channel" value="${escapeHtml(channel)}">
        ${on ? "" : `<input type="hidden" name="on" value="on">`}
        <button class="button${on ? " danger" : ""}" type="submit" aria-label="${escapeHtml(`${NAMES[type]} by ${channel}: turn ${on ? "off" : "on"}`)}">${on ? "On" : "Off"}</button>
      </form>
    </td>`;
  };
  const row = (type: NotificationType): string => `
    <tr data-notification="${escapeHtml(type)}">
      <td class="notify-what"><span class="notify-label">${escapeHtml(NAMES[type])}</span> <span class="hint">${escapeHtml(type.toUpperCase())}</span></td>
      ${cell(type, "email")}${cell(type, "push")}
    </tr>`;
  const neverRow = (type: NotificationType): string => `
    <tr data-notification="${escapeHtml(type)}">
      <td class="notify-what"><span class="notify-label">${escapeHtml(NAMES[type])}</span> <span class="hint">${escapeHtml(WHY_NEVER[type] ?? "")}</span></td>
      <td class="notify-cell notify-none" colspan="2">No control</td>
    </tr>`;
  const band = (title: string, note: string, types: NotificationType[], render: (t: NotificationType) => string) => `
    <h2>${escapeHtml(title)}</h2>
    <p class="tool-note">${escapeHtml(note)}</p>
    <table class="admin-notify">
      <thead><tr><th class="notify-what">Notification</th><th>Email</th><th>Push</th></tr></thead>
      <tbody>${types.map(render).join("")}</tbody>
    </table>`;
  const of = (scope: "owner" | "admin" | "none") => NOTIFICATION_TYPES.filter((t) => NOTIFICATION_CONTROLS[t].scope === scope);

  return layout({
    nav: params.nav,
    title: "Notifications — Admin — Make The Team",
    pageStyles: [ADMIN_TOOLS_CSS, ADMIN_NOTIFICATIONS_CSS],
    body: `
      <h1>Notifications</h1>
      <p>Off here is off for every game. An owner's own setting is kept underneath and comes back when you turn a channel on again.</p>
      ${band("Owners can also switch these off per game", "Sent only when both you and the game's owner allow it.", of("owner"), row)}
      ${band("Administrator only", "No per-game setting. For the organiser broadcast, off removes that channel from the message form.", of("admin"), row)}
      ${band("Never switched off", "Absent from every settings screen on purpose.", of("none"), neverRow)}
    `,
  });
}
```

Button semantics: the button shows the **current** state and pressing it flips it. `danger` marks the press that switches something off, matching the allow-list's "the consequential press is the one that should give the operator pause". Use `<tr data-notification>` so the tests can find rows.

`ADMIN_NOTIFICATIONS_CSS` in `styles.ts` (register it in `PAGE_STYLE_BLOCKS`):

```ts
/** The administrator's notification grid (M37) — `src/views/admin-notifications.ts`. Namespaced under `.admin-notify`. */
export const ADMIN_NOTIFICATIONS_CSS = `
  table.admin-notify { width: 100%; border-collapse: collapse; margin: 0.6rem 0 1.4rem; }
  table.admin-notify th { text-align: center; font-size: var(--t-support); color: var(--mut); padding: 0.4rem 0; }
  table.admin-notify th.notify-what { text-align: left; }
  table.admin-notify td { padding: 0.5rem 0; border-top: 1px solid var(--line); vertical-align: middle; }
  table.admin-notify .notify-label { font-weight: 600; }
  table.admin-notify .hint { display: block; font-size: var(--t-support); color: var(--mut); }
  table.admin-notify td.notify-cell { width: 6rem; text-align: center; }
  table.admin-notify td.notify-cell form { display: inline; }
  table.admin-notify td.notify-none { color: var(--mut); }
`;
```

- [ ] **Step 3: Routes and index link**

`src/routes/admin.ts`:

```ts
admin.get(ADMIN_NOTIFICATIONS_PATH, requireSession, async (c) => {
  const db = await loadAdminDb(c);
  if (db === null) return c.text("Not found", 404);
  return c.html(renderAdminNotificationsPage({ nav: pageNav(c, "admin"), switches: await loadAdminNotificationSwitches(db) }));
});

admin.post(ADMIN_NOTIFICATIONS_SET_PATH, requireSession, async (c) => {
  if (wrongOrigin(c)) return c.text("Forbidden", 403);
  const db = await loadAdminDb(c);
  if (db === null) return c.text("Not found", 404);
  const form = await c.req.formData();
  const type = String(form.get("type") ?? "");
  const channel = String(form.get("channel") ?? "");
  // A cell the catalogue does not have is not a thing that can be set — 404,
  // the same answer as any other resource that does not exist.
  if (!isNotificationType(type) || !isChannel(channel)) return c.text("Not found", 404);
  if (NOTIFICATION_CONTROLS[type].scope === "none" || !NOTIFICATION_CONTROLS[type].channels.includes(channel)) {
    return c.text("Not found", 404);
  }
  await setAdminNotificationChannel(db, type, channel, String(form.get("on") ?? "") === "on");
  return c.redirect(ADMIN_NOTIFICATIONS_PATH, 303);
});
```

Check what `pageNav`'s second argument is on the other admin handlers in this file and use the same.

`src/views/admin-index.ts`: add an `<li>` linking `ADMIN_NOTIFICATIONS_PATH` with note `Which automated messages may go out at all, by email and by push, across every game.`

`test/browser/catalogue.ts`: add `ADMIN_NOTIFICATIONS_PATH` to `NOT_CATALOGUED` with the same "reachable only with user.is_admin…" reason and a pointer to `test/routes/admin-notifications.test.ts`.

- [ ] **Step 4: Run, typecheck, commit**

Run: `npx vitest run test/routes/admin-notifications.test.ts test/routes/admin.test.ts test/security test/views/style-cascade.test.ts && npx tsc --noEmit && npm run lint`
Also run the browser catalogue check if it is a unit test: `grep -l NOT_CATALOGUED test/browser/*.spec.ts` and run that spec if it is quick; otherwise it runs in Task 12.

```bash
git status
git add src/auth/paths.ts src/views/admin-notifications.ts src/routes/admin.ts src/views/admin-index.ts src/views/styles.ts test/browser/catalogue.ts test/routes/admin-notifications.test.ts
git commit -m "M37: the administrator's global notification grid"
```

---

### Task 11: Drop the six columns

**Files:**
- Modify: `src/db/schema.ts` (remove `reminderEnabled` … `teamPickerEmailEnabled` and their doc comments; keep `resultPromptOffsetHours`, `shortWarningOffsetHours`, `reminderDaysBefore`, `reminderLocalTime`)
- Create: `migrations/0025_<generated>.sql`
- Modify: `test/support/factories.ts` if `gameRow` sets any of the six; `docs/known-issues.md` if it names them (grep).

- [ ] **Step 1: Confirm nothing reads them**

Run: `grep -rn "reminderEnabled\|shortWarningEnabled\|groupNudgeEnabled\|resultPromptEnabled\|teamsPublishedEmailEnabled\|teamPickerEmailEnabled" src test --include=*.ts`
Expected: only `src/db/schema.ts`. Anything else is a site a previous task missed — fix it there first.

- [ ] **Step 2: Remove the columns and generate**

Delete the six column definitions and their comments from `src/db/schema.ts`. Run `npm run db:generate`. Expected: `migrations/0025_<name>.sql` with six `ALTER TABLE \`games\` DROP COLUMN …` statements. Prepend:

```sql
-- M37. The six owner switches now live in `game_notification_settings`
-- (migration 0024 backfilled them). Nothing reads these columns any more.
```

- [ ] **Step 3: Full suite**

Run: `npm test` (foreground; >120s). Then `npx tsc --noEmit && npm run lint`.
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git status
git add src/db/schema.ts migrations/0025_*.sql migrations/meta/0025_snapshot.json migrations/meta/_journal.json
git commit -m "M37: drop the six switch columns from games"
```

---

### Task 12: Docs, browser suite, and finishing the branch

**Files:**
- Modify: `docs/guide/05-running-your-squad.md`, `docs/guide/07-your-own-fixtures.md` (wherever they describe the Notifications section — say each notification now has an Email and a Push switch, and what a greyed-out box means)
- Modify: `docs/known-issues.md` — add an entry under whatever heading holds deliberate non-fixes: *"Owner notification switches cannot be set on the create form; the matrix appears on edit only, as the Advanced block always has."*
- Modify: the spec's header line `**Status:** approved design, implementation plan not yet written` → `**Status:** implemented in M37 (plan: docs/superpowers/plans/2026-08-26-m37-notification-controls.md)`, and add the two deviations from this plan's preamble as a short "Implementation notes" section at the end.

- [ ] **Step 1: Browser suite and guide images**

Run: `npx playwright test` (~5 min, foreground). Then `npm run guide:capture` and Read the regenerated edit-game PNG once more. Stage the guide images that changed for the pages this milestone touched (edit game; the broadcast page if its channel block moved).

- [ ] **Step 2: Docs edits and commit**

```bash
git status
git add docs/guide/05-running-your-squad.md docs/guide/07-your-own-fixtures.md docs/guide/images/<changed>.png docs/known-issues.md docs/superpowers/specs/2026-08-25-notification-controls-design.md
git commit -m "M37: guide and known-issues for the notification matrix"
```

- [ ] **Step 3: Finish the branch**

Use `superpowers:finishing-a-development-branch`. The merge is a fast-forward of `m37-notification-controls` onto `main` from the primary checkout; **pushing `main` deploys**, and deploy applies migrations 0024 and 0025 — confirm with the maintainer before the push, and check the production `notification_log` after the next hourly sweep for `n1` rows on a game known to have reminders on.

---

## Self-review

**Spec coverage.** §2 scope → Task 0. §3 catalogue/table/admin store → Tasks 0, 1, 2. §4 migration and the non-uniform backfill with its negative test → Task 1 (fidelity test), Task 11 (drop). §5 resolver, query shape, no-I/O `isEnabled`, why-not-a-decorator → Task 2 (module comment carries the reasoning). §6 every row: n1 T4, n4 T5, n9/n13 T6, n11 T4, n12 T7 (with the BR-32 counter), n6/n7/n10 T8 (handler refuses server-side). §7 invariants 1–2 → T3, invariant 3 → T9; stored-lookups → T2; CSS registered and the cascade test → T9/T10; migration fidelity → T1; n12 counter and n10 refusal → T7/T8; rendered page read from a PNG → T9 step 7; browser suite → T12 with the admin-page deviation stated. §8 owner matrix (header row, dash for a missing leg, disabled-and-noted cell, timing strips full width) → T9; admin three bands → T10. §9/§10 need no task.

**Placeholders.** Task 3's drivers and Task 9's invariant 3 say "find how `<named test file>` seeds X" rather than reproducing seeding code — that is CLAUDE.md rule 4 (do not put a detail in a brief you have not read from source), not a placeholder; each names the file and the case to copy. Task 8 names "the broadcast GET test file" by a grep because its name was not read.

**Type consistency.** `loadNotificationSettings(db, gameIds)` / `EffectiveSettings.{isEnabled, adminAllows, ownerWants}` are used identically in T2, T4–T9. `loadAdminNotificationSwitches(db).isOn(type, channel)` in T2, T8, T10. `channels: { email: boolean; push: boolean }` on `buildReminderMessages`, `sendTeamsEmails`, `sendPickerHandover`, and the `n10` view's `offered` — same shape, deliberately the one `SendBroadcastParams.channels` already has. `cellFieldName` / `cellMarkerName` / `parseNotificationCells` in T9 only. `insertNotificationSetting(db, gameId, type, channel, enabled)` and `setAdminSwitch(db, type, channel, on)` from T1/T2, used through T10.

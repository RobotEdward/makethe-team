# Delete My Data (BR-34) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A signed-in player can schedule the erasure of their own data 48 hours out, see it pending, and cancel it until it runs.

**Architecture:** Two nullable timestamp columns on `players` hold the whole state. `POST /app/delete` only sets a date — it removes nothing — because erasure ends memberships through `removeMember`, which frees fixture slots and promotes waitlisters irreversibly. The existing hourly sweep calls a single domain function, `erasePlayer`, which leaves every game and then anonymises the player row in place rather than deleting it.

**Tech Stack:** Cloudflare Workers, Hono, D1 + Drizzle, Durable Objects, Better Auth. Vitest via `@cloudflare/vitest-pool-workers` (runs inside workerd); Playwright against `wrangler dev`.

**Spec:** `docs/superpowers/specs/2026-08-15-delete-my-data-design.md`. Read it before Task 1 — it carries the reasoning this plan only implements.

## Global Constraints

- **Erasure anonymises in place. It never hard-deletes a `players`, `responses`, `audit_log` or `notification_log` row.** Past fixtures must keep an accurate count of who played.
- **The 48-hour window is inert.** `POST /app/delete` must not touch a membership, response, fixture, session, or capacity object. A test asserts this directly.
- **Both delete routes act on `c.get("player")!.id` only.** No player id in a path, a query string, or a form body. There must be no parameter to get wrong.
- **The erased name is the exact string `[erased player]`** — square brackets included. Views branch on `erased_at` and never render this string; it is a deliberately conspicuous fallback.
- **`new Date()` with no arguments is banned by an eslint rule** (`no-restricted-syntax` in `eslint.config.js`). Domain code takes `now: Date` as a parameter. The single permitted wall-clock read is `new Date(Date.now())` at a route or cron edge.
- **Never add `FORM_CSS` to the dashboard page.** It overrides `main` and `h1` and re-lays out the whole page — this was an M7a defect. Use the global `.nudge` class, which `renderDashboardPage` already uses.
- **Every new page is server-rendered with no `<script>`** (TR-4, TR-15).
- **Run test suites in the foreground.** Backgrounding `npx playwright test` has stalled several previous implementers indefinitely.
- Commands: `npm test` (server), `npx playwright test` (browser), `npm run lint`, `npm run typecheck`, `npm run db:generate` (migrations).

---

### Task 1: The erasure state and vocabulary

Adds the two columns, the window constant, and the three audit actions. Nothing uses them yet; every later task does.

**Files:**
- Modify: `src/db/schema.ts` (the `players` table, around line 26)
- Create: `migrations/0008_*.sql` (generated — do not hand-write)
- Create: `src/domain/erasure-window.ts`
- Modify: `src/domain/audit.ts` (`AUDIT_ENTITY_TYPES`, `AUDIT_ACTIONS`)
- Test: `test/domain/erasure-window.test.ts`

**Interfaces:**
- Produces: `ERASURE_WINDOW_MS: number`, `erasureDeadline(now: Date): Date`, `players.erasesAt` and `players.erasedAt` columns, and the audit actions `player.erasure_requested`, `player.erasure_cancelled`, `player.erased` under entity type `player`.

- [ ] **Step 1: Write the failing test**

Create `test/domain/erasure-window.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ERASURE_WINDOW_MS, erasureDeadline } from "../../src/domain/erasure-window.js";

describe("erasureDeadline", () => {
  it("is 48 hours after the request", () => {
    const now = new Date("2026-08-15T09:00:00Z");
    expect(erasureDeadline(now).toISOString()).toBe("2026-08-17T09:00:00.000Z");
  });

  it("does not mutate the date it is given", () => {
    const now = new Date("2026-08-15T09:00:00Z");
    erasureDeadline(now);
    expect(now.toISOString()).toBe("2026-08-15T09:00:00.000Z");
  });

  // Fixed hours, not calendar days: the confirmation page promises a precise
  // instant, and a DST boundary between request and deadline must not move it.
  it("is exactly the window, across a DST boundary", () => {
    const before = new Date("2026-10-24T23:00:00Z");
    expect(erasureDeadline(before).getTime() - before.getTime()).toBe(ERASURE_WINDOW_MS);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/domain/erasure-window.test.ts`
Expected: FAIL — cannot resolve `src/domain/erasure-window.js`.

- [ ] **Step 3: Write the module**

Create `src/domain/erasure-window.ts`:

```ts
/**
 * How long a requested erasure waits before the sweep performs it (§2).
 *
 * The window exists so a person who did not ask for this can stop it, and it
 * is *inert*: nothing about their memberships, responses or fixtures changes
 * until it elapses. That is not a simplification — erasure ends memberships
 * through `removeMember`, which frees each open fixture's slot and promotes
 * the longest-waiting replacement, and those promotions send email and cannot
 * be taken back. If requesting erasure removed the player immediately,
 * "cancel" would not be a cancel; it would be a rebuild of squads whose freed
 * places another player has already been told they hold.
 *
 * Fixed hours rather than calendar days: the confirmation page names a precise
 * instant, and a clock change between the request and the deadline must not
 * move it.
 */
export const ERASURE_WINDOW_MS = 48 * 60 * 60 * 1000;

/** When an erasure requested at `now` becomes due. */
export function erasureDeadline(now: Date): Date {
  return new Date(now.getTime() + ERASURE_WINDOW_MS);
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run test/domain/erasure-window.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Add the two columns**

In `src/db/schema.ts`, inside the `players` table definition, immediately after the `emailVerifiedAt` column, add:

```ts
    /**
     * When a requested erasure becomes due (§2.1). Set by `POST /app/delete`,
     * cleared by `POST /app/delete/cancel`, and read by the hourly sweep.
     *
     * Deliberately *kept* after erasure rather than cleared, so the row records
     * what was promised as well as what happened.
     */
    erasesAt: integer("erases_at", { mode: "timestamp_ms" }),
    /**
     * When this player was erased (§3). Non-null means the row is no longer a
     * person: `name` is the placeholder, and `email`, `auth_user_id` and
     * `email_verified_at` are all null.
     *
     * This column, not a name comparison, is what every renderer branches on.
     */
    erasedAt: integer("erased_at", { mode: "timestamp_ms" }),
```

- [ ] **Step 6: Generate the migration**

Run: `npm run db:generate`
Expected: a new `migrations/0008_<name>.sql` containing two `ALTER TABLE players ADD ...` statements. Do not edit it. Confirm it adds only those two columns — if it proposes anything else, stop and report, because that means the schema and migrations had already drifted.

- [ ] **Step 7: Apply it locally and confirm the columns exist**

Run: `npm run db:migrate:local`
Then: `npx wrangler d1 execute makethe-team --local --command "SELECT erases_at, erased_at FROM players LIMIT 1"`
Expected: succeeds (an empty result set is fine; a "no such column" error is not).

- [ ] **Step 8: Extend the audit vocabulary**

In `src/domain/audit.ts`, add `"player"` to `AUDIT_ENTITY_TYPES`:

```ts
export const AUDIT_ENTITY_TYPES = ["fixture", "game", "membership", "player"] as const;
```

and add these three to the end of `AUDIT_ACTIONS`, with the comment:

```ts
  // M7b (BR-34). The subject and the actor are always the same player: these
  // three are the only actions in this list nobody can perform on anyone else,
  // because both routes act on the session's own player id and take no
  // parameter naming a player.
  //
  // `player.erasure_requested` and `player.erasure_cancelled` are written by
  // the routes; `player.erased` by the sweep when the window elapses. The
  // erased row survives (anonymised), so `actor_player_id`'s foreign key still
  // resolves afterwards.
  "player.erasure_requested",
  "player.erasure_cancelled",
  "player.erased",
```

Both arrays are TypeScript-only narrowings — Drizzle's `text({ enum })` emits no SQL `CHECK` on SQLite — so neither needs a migration.

- [ ] **Step 9: Run the full server suite**

Run: `npm test`
Expected: all pass. Then `npm run lint && npm run typecheck`, both clean.

- [ ] **Step 10: Commit**

```bash
git add src/db/schema.ts src/domain/erasure-window.ts src/domain/audit.ts migrations/ test/domain/erasure-window.test.ts
git commit -m "feat: add erasure state columns and audit vocabulary (BR-34)"
```

---

### Task 2: `erasePlayer`

The whole erasure, as one domain function with no Workers binding of its own.

**Files:**
- Create: `src/domain/erase-player.ts`
- Modify: `src/db/queries.ts` (add `listActiveMemberships`)
- Test: `test/domain/erase-player.test.ts`

**Interfaces:**
- Consumes: `removeMember` from `src/domain/remove-member.ts` (`RemoveMemberParams`, `FixturePromotion`), `isLastActiveOwner` from `src/domain/last-owner.ts`, `WithdrawMemberOutcome` from `src/capacity/types.js`.
- Produces:
  - `listActiveMemberships(db: Db, playerId: string): Promise<Array<{ gameId: string; role: "player" | "owner" }>>`
  - `ERASED_NAME: string` (the exact value `"[erased player]"`)
  - `erasePlayer(params: ErasePlayerParams): Promise<ErasePlayerResult>`, where:
    ```ts
    export interface ErasePlayerParams {
      db: Db;
      playerId: string;
      now: Date;
      withdraw: (fixtureId: string) => Promise<WithdrawMemberOutcome>;
    }
    export type ErasePlayerResult =
      | { kind: "erased"; promotions: FixturePromotion[] }
      | { kind: "blocked"; gameIds: string[] }
      | { kind: "already-erased" }
      | { kind: "not-found" };
    ```

- [ ] **Step 1: Write the failing tests**

Create `test/domain/erase-player.test.ts`. Use the existing helpers in `test/support/factories.ts` (`testDb`, `resetDatabase`, `insertPlayer`, `insertGame`, `insertMembership`, `insertFixture`, `insertResponse`) — read that file first for their exact signatures.

```ts
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { erasePlayer, ERASED_NAME } from "../../src/domain/erase-player.js";
import { auditLog, notificationLog, players } from "../../src/db/schema.js";
import {
  insertGame,
  insertMembership,
  insertPlayer,
  resetDatabase,
  testDb,
} from "../support/factories.js";

const NOW = new Date("2026-08-17T09:00:00Z");

/** No open fixtures in these tests, so the callback must never be reached. */
const noWithdraw = async () => {
  throw new Error("withdraw should not have been called");
};

beforeEach(resetDatabase);

describe("erasePlayer", () => {
  it("anonymises the player row and records when", async () => {
    const db = testDb();
    const playerId = await insertPlayer(db, { name: "Edward Cooper", email: "edward@example.test" });

    const result = await erasePlayer({ db, playerId, now: NOW, withdraw: noWithdraw });
    expect(result.kind).toBe("erased");

    const [row] = await db.select().from(players).where(eq(players.id, playerId));
    expect(row?.name).toBe(ERASED_NAME);
    expect(row?.email).toBeNull();
    expect(row?.authUserId).toBeNull();
    expect(row?.emailVerifiedAt).toBeNull();
    expect(row?.erasedAt?.getTime()).toBe(NOW.getTime());
  });

  // The row must survive: `responses`, `audit_log` and `notification_log` all
  // hold foreign keys to it, and a past fixture that was ten-a-side must still
  // read as ten-a-side.
  it("keeps the player row rather than deleting it", async () => {
    const db = testDb();
    const playerId = await insertPlayer(db, { email: "edward@example.test" });

    await erasePlayer({ db, playerId, now: NOW, withdraw: noWithdraw });

    const rows = await db.select().from(players).where(eq(players.id, playerId));
    expect(rows).toHaveLength(1);
  });

  // `src/notify/resend-notifier.ts` stores up to 500 characters of the
  // provider's response body here on a non-2xx, and a provider's validation
  // errors quote the address they rejected. It is the only place in the schema
  // where an email address can appear outside `players.email`.
  it("nulls notification_log.error, which can quote the address", async () => {
    const db = testDb();
    const playerId = await insertPlayer(db, { email: "edward@example.test" });
    await db.insert(notificationLog).values({
      id: crypto.randomUUID(),
      dedupeKey: `test:${playerId}`,
      notificationType: "n1",
      playerId,
      status: "failed",
      error: 'resend batch failed: HTTP 422 {"message":"Invalid `to`: edward@example.test"}',
    });

    await erasePlayer({ db, playerId, now: NOW, withdraw: noWithdraw });

    const [row] = await db.select().from(notificationLog).where(eq(notificationLog.playerId, playerId));
    expect(row).toBeDefined();
    expect(row?.error).toBeNull();
  });

  it("writes one player.erased audit row attributed to the player themselves", async () => {
    const db = testDb();
    const playerId = await insertPlayer(db, { email: "edward@example.test" });

    await erasePlayer({ db, playerId, now: NOW, withdraw: noWithdraw });

    const rows = await db.select().from(auditLog).where(eq(auditLog.entityId, playerId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe("player.erased");
    expect(rows[0]?.entityType).toBe("player");
    expect(rows[0]?.actorPlayerId).toBe(playerId);
  });

  // The check runs before any removal, so a blocked erasure changes nothing at
  // all. Removing the first game and then discovering the second is blocked
  // would leave the person half-erased with no way to finish or undo it.
  it("refuses without touching anything when a game would lose its last organiser", async () => {
    const db = testDb();
    const playerId = await insertPlayer(db, { name: "Edward Cooper", email: "edward@example.test" });
    const soleOwned = await insertGame(db);
    await insertMembership(db, { gameId: soleOwned, playerId, role: "owner" });
    const ordinary = await insertGame(db);
    await insertMembership(db, { gameId: ordinary, playerId, role: "player" });

    const result = await erasePlayer({ db, playerId, now: NOW, withdraw: noWithdraw });

    expect(result).toEqual({ kind: "blocked", gameIds: [soleOwned] });

    const [row] = await db.select().from(players).where(eq(players.id, playerId));
    expect(row?.name).toBe("Edward Cooper");
    expect(row?.erasedAt).toBeNull();
    const memberships = await db.select().from(auditLog).where(eq(auditLog.entityId, playerId));
    expect(memberships).toHaveLength(0);
  });

  it("proceeds when the game has another active organiser", async () => {
    const db = testDb();
    const playerId = await insertPlayer(db, { email: "edward@example.test" });
    const coOwnerId = await insertPlayer(db, { email: "nadia@example.test" });
    const gameId = await insertGame(db);
    await insertMembership(db, { gameId, playerId, role: "owner" });
    await insertMembership(db, { gameId, playerId: coOwnerId, role: "owner" });

    const result = await erasePlayer({ db, playerId, now: NOW, withdraw: noWithdraw });

    expect(result.kind).toBe("erased");
  });

  it("is idempotent: a second call reports already-erased and writes nothing new", async () => {
    const db = testDb();
    const playerId = await insertPlayer(db, { email: "edward@example.test" });
    await erasePlayer({ db, playerId, now: NOW, withdraw: noWithdraw });

    const again = await erasePlayer({
      db,
      playerId,
      now: new Date("2026-08-18T09:00:00Z"),
      withdraw: noWithdraw,
    });

    expect(again).toEqual({ kind: "already-erased" });
    const [row] = await db.select().from(players).where(eq(players.id, playerId));
    expect(row?.erasedAt?.getTime()).toBe(NOW.getTime());
    const rows = await db.select().from(auditLog).where(eq(auditLog.entityId, playerId));
    expect(rows).toHaveLength(1);
  });

  it("reports not-found for a player id that does not resolve", async () => {
    const db = testDb();
    const result = await erasePlayer({
      db,
      playerId: crypto.randomUUID(),
      now: NOW,
      withdraw: noWithdraw,
    });
    expect(result).toEqual({ kind: "not-found" });
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run test/domain/erase-player.test.ts`
Expected: FAIL — cannot resolve `src/domain/erase-player.js`.

- [ ] **Step 3: Add the membership query**

In `src/db/queries.ts`, beside `listOwnedGames`, add:

```ts
/**
 * Every game this player is an *active* member of, with the role they hold
 * there (M7b). Erasure needs both halves at once: the list to leave, and the
 * roles to pre-check the last-organiser invariant against before it leaves
 * anything.
 */
export async function listActiveMemberships(
  db: Db,
  playerId: string,
): Promise<Array<{ gameId: string; role: "player" | "owner" }>> {
  return db
    .select({ gameId: memberships.gameId, role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.playerId, playerId), eq(memberships.active, true)))
    .orderBy(asc(memberships.gameId));
}
```

Check the file's existing imports — `and`, `eq` and `asc` may already be imported from `drizzle-orm`; add only what is missing.

- [ ] **Step 4: Write `erasePlayer`**

Create `src/domain/erase-player.ts`:

```ts
import { and, eq, like, sql } from "drizzle-orm";
import { buildAuditInsert } from "../db/audit.js";
import type { Db } from "../db/client.js";
import { listActiveMemberships } from "../db/queries.js";
import { account, notificationLog, passkey, players, session, user, verification } from "../db/schema.js";
import type { WithdrawMemberOutcome } from "../capacity/types.js";
import { isLastActiveOwner } from "./last-owner.js";
import { removeMember, type FixturePromotion } from "./remove-member.js";

/**
 * What `players.name` becomes (§4).
 *
 * Deliberately not a plausible name. Renderers branch on `erased_at` and show
 * their own label; this string is a fallback that should never reach a screen,
 * and making it conspicuous means a renderer that forgets the check produces
 * something visibly wrong the first time anyone looks, rather than a fake name
 * that survives review.
 *
 * `redactName` (`src/domain/redact-name.ts`, BR-26) is the specific hazard: it
 * reduces "Edward Cooper" to "Edward C." and returns a single-word name
 * unchanged, so a two-word placeholder would render as the redacted surname of
 * a person who does not exist. The brackets make that impossible to miss.
 */
export const ERASED_NAME = "[erased player]";

export interface ErasePlayerParams {
  db: Db;
  playerId: string;
  now: Date;
  /**
   * Applies BR-3 to one fixture, exactly as `removeMember` takes it. Injected
   * rather than reached for, so this module holds no Workers binding: the
   * sweep passes
   * `(id) => env.FIXTURE_CAPACITY.getByName(id).withdrawMember({...})`.
   */
  withdraw: (fixtureId: string) => Promise<WithdrawMemberOutcome>;
}

export type ErasePlayerResult =
  | { kind: "erased"; promotions: FixturePromotion[] }
  | {
      /**
       * At least one game would be left with no active organiser. **Nothing
       * has been written** — the check runs across every game before any
       * removal happens.
       */
      kind: "blocked";
      gameIds: string[];
    }
  | { kind: "already-erased" }
  | { kind: "not-found" };

/**
 * Escape a value for a `LIKE` pattern, so `_` and `%` in it match themselves.
 *
 * An email containing an underscore is ordinary, and without this a pattern
 * built from `a_b@example.com` would also match `axb@example.com` — deleting a
 * different person's pending magic link. The backslash must be escaped first,
 * or it would escape the escapes added after it.
 */
function escapeLike(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/**
 * Erase a player: leave every squad, then anonymise the row in place (§3).
 *
 * **In place, not deleted.** `responses`, `audit_log` and `notification_log`
 * all hold foreign keys here, and those rows are what keep a past fixture
 * honest — a fixture that was ten-a-side still reads as ten-a-side. What
 * survives is keyed by a random id no longer connected to a name, an address,
 * or any means of signing in.
 *
 * **The invariant is checked across every game before any of them is left.**
 * `removeMember` refuses to remove a game's last active organiser, and
 * discovering that on the third game after leaving the first two would leave
 * the person half-erased with no way to finish and no way to undo. So the
 * whole set is checked first and the operation either runs or reports
 * `blocked`, having written nothing.
 *
 * It sends nothing. Promotions are returned for the caller to notify, exactly
 * as `removeMember` returns them.
 */
export async function erasePlayer(params: ErasePlayerParams): Promise<ErasePlayerResult> {
  const { db, playerId, now, withdraw } = params;

  const [player] = await db
    .select({ email: players.email, authUserId: players.authUserId, erasedAt: players.erasedAt })
    .from(players)
    .where(eq(players.id, playerId));

  if (player === undefined) return { kind: "not-found" };
  // Already done. Re-running must not write a second audit row asserting a
  // second erasure that never happened, and must not move `erased_at`.
  if (player.erasedAt !== null) return { kind: "already-erased" };

  const memberships = await listActiveMemberships(db, playerId);

  const blocked: string[] = [];
  for (const membership of memberships) {
    if (await isLastActiveOwner(db, membership.gameId, { role: membership.role, active: true })) {
      blocked.push(membership.gameId);
    }
  }
  if (blocked.length > 0) return { kind: "blocked", gameIds: blocked };

  // Leave every squad. The player is their own actor, exactly as `POST
  // /leave/:token` treats a leaver, so the audit trail reads as "they left".
  const promotions: FixturePromotion[] = [];
  for (const membership of memberships) {
    const result = await removeMember({
      db,
      gameId: membership.gameId,
      playerId,
      actorPlayerId: playerId,
      now,
      withdraw,
    });
    if (result.kind === "removed" || result.kind === "resumed") {
      promotions.push(...result.promotions);
    }
  }

  // Better Auth's own rows. Hard-deleted, unlike everything above: nothing
  // references them, and a surviving session or passkey is a way back into an
  // account that no longer exists. Children before the parent — `session`,
  // `account` and `passkey` all carry a foreign key to `user`.
  if (player.authUserId !== null) {
    await db.delete(session).where(eq(session.userId, player.authUserId));
    await db.delete(account).where(eq(account.userId, player.authUserId));
    await db.delete(passkey).where(eq(passkey.userId, player.authUserId));
    await db.delete(user).where(eq(user.id, player.authUserId));
  }

  // Pending magic links. `verification.value` holds a JSON blob containing the
  // address, so these rows are residual personal data in their own right as
  // well as a live way in. Matched by `LIKE` because the address is embedded
  // in that blob rather than being the whole of it.
  const email = player.email?.trim() ?? "";
  if (email !== "") {
    await db
      .delete(verification)
      .where(like(verification.value, sql`${"%" + escapeLike(email) + "%"} ESCAPE '\\'`));
  }

  // See the test: this column can hold the provider's response body, which
  // quotes the address it rejected.
  await db
    .update(notificationLog)
    .set({ error: null })
    .where(and(eq(notificationLog.playerId, playerId), sql`${notificationLog.error} is not null`));

  await db.batch([
    db
      .update(players)
      .set({
        name: ERASED_NAME,
        email: null,
        authUserId: null,
        emailVerifiedAt: null,
        erasedAt: now,
      })
      .where(eq(players.id, playerId)),
    buildAuditInsert(db, {
      actorPlayerId: playerId,
      entityType: "player",
      entityId: playerId,
      action: "player.erased",
    }),
  ]);

  return { kind: "erased", promotions };
}
```

Read `src/db/audit.ts` for `buildAuditInsert`'s exact signature before writing this — match it rather than the shape sketched here, and pass `now` if it takes one.

**On nulling `email`:** this is load-bearing beyond the erasure. `src/auth/link-player.ts` claims an existing player row *by email* on first sign-in, so a row with no address can never be re-attached to a future account.

- [ ] **Step 5: Run the tests and watch them pass**

Run: `npx vitest run test/domain/erase-player.test.ts`
Expected: all pass. If the `LIKE ... ESCAPE` expression fails to compile against Drizzle's types, build it with a single `sql` template instead of `like()` — the escaping behaviour is the requirement, not the helper used.

- [ ] **Step 6: Run the full server suite**

Run: `npm test && npm run lint && npm run typecheck`
Expected: all clean.

- [ ] **Step 7: Commit**

```bash
git add src/domain/erase-player.ts src/db/queries.ts test/domain/erase-player.test.ts
git commit -m "feat: add erasePlayer, anonymising in place (BR-34)"
```

---

### Task 3: N-8, the erasure-scheduled email

**Files:**
- Modify: `src/notify/dedupe-key.ts` (`NOTIFICATION_TYPES`, new `erasureScheduledKey`)
- Create: `src/notify/templates/erasure-scheduled.ts`
- Create: `src/notify/send-erasure-scheduled.ts`
- Test: `test/notify/send-erasure-scheduled.test.ts`

**Interfaces:**
- Consumes: `insertQueuedLogRows`, `applySendResult`, `SITE_ORIGIN`, `PendingNotification` from `src/notify/delivery.ts`; `Notifier` from `src/notify/notifier.ts`.
- Produces:
  - `erasureScheduledKey(playerId: string, erasesAt: string): string` → `` `n8:${playerId}:${erasesAt}` ``
  - `renderErasureScheduledEmail(params: { playerName: string; whenLocal: string; signInUrl: string }): { subject: string; html: string; text: string }`
  - `sendErasureScheduledEmail(params): Promise<ErasureSendOutcome>` with the same outcome union `sendWelcomeEmail` uses.

**Read `src/notify/send-welcome.ts` first and follow it closely.** It is the only other non-fixture-scoped sender (N-6) and this one has the same shape: `fixtureId: null`, one recipient, the queued-row-then-send-then-apply ordering.

- [ ] **Step 1: Add the type and key**

In `src/notify/dedupe-key.ts`, extend the array:

```ts
export const NOTIFICATION_TYPES = ["n1", "n2", "n3", "n4", "n5", "n6", "n7", "n8"] as const;
```

and add:

```ts
/**
 * N-8 erasure scheduled: once per request (M7b, BR-34).
 *
 * Includes `erasesAt` deliberately, like N-2 and unlike N-4: someone who
 * requests erasure, cancels, and requests again has genuinely new information
 * both times, and each request has its own deadline. Keyed on the player
 * alone, the unique index on `dedupe_key` would silently drop the second
 * email and leave them with no record of the second, still-live request.
 */
export function erasureScheduledKey(playerId: string, erasesAt: string): string {
  return `n8:${playerId}:${erasesAt}`;
}
```

- [ ] **Step 2: Write the template**

Create `src/notify/templates/erasure-scheduled.ts`, modelled on `src/notify/templates/removed.ts` (read it for the house style, the shared escaping helper, and how it documents the absence of a leave link).

Required copy points, in this order:
1. Their data will be erased on `whenLocal`.
2. Everything they will lose: every squad they are in, their account, and their sign-in.
3. **"If this wasn't you, sign in and cancel it"**, linking `signInUrl`.
4. That erasure cannot be undone once it runs.

The module doc comment must state why it carries **no leave link**, matching how `removed.ts` documents the same absence:

```ts
/**
 * N-8: erasure scheduled (BR-34).
 *
 * **It carries no leave link, and that is not an oversight.** BR-22 is about
 * leaving a *game*, and this message is not about a game — it is about the
 * account, and its recipient is in the middle of leaving every game at once.
 * `removed.ts` (N-7) documents the same absence for its own reason.
 *
 * The cancel instruction points at sign-in, never at a token link. A token
 * would make cancellation reachable from a forwarded email, which is exactly
 * the opposite of what this message is for: the whole point is that only the
 * account's real owner can stop it.
 */
```

- [ ] **Step 3: Write the sender**

Create `src/notify/send-erasure-scheduled.ts`, following `send-welcome.ts`'s structure exactly: look the player up, skip on a guest or a blank address (BR-32), render, `insertQueuedLogRows(db, { fixtureId: null, notificationType: "n8" }, [pending])`, send inside a `try`/`catch` that marks the row `failed` on a rejection, then `applySendResult`.

Its params:

```ts
export interface SendErasureScheduledEmailParams {
  db: Db;
  /** Always the quota-wrapped notifier from `createNotifier`. */
  notifier: Notifier;
  playerId: string;
  /** The deadline just written to `players.erases_at`. Part of the dedupe key. */
  erasesAt: Date;
  now: Date;
}
```

Build the sign-in URL as `` `${SITE_ORIGIN}${SIGN_IN_PATH}` `` from `src/auth/paths.js` — never from anything in the request.

For `whenLocal`: this message is not scoped to a game, so there is no game timezone to use. Format `erasesAt` in `Europe/London` via `formatLocalDateTime` from `src/domain/time/zone.js`, and say so in a comment — the alternative, a bare UTC ISO string, is unreadable to a person.

- [ ] **Step 4: Write and run the tests**

Create `test/notify/send-erasure-scheduled.test.ts` covering: a successful send writing exactly one `n8` row with `fixture_id` null; a guest or blank address producing `skipped-no-recipient` with no row written; a second call with the same `erasesAt` returning `already-logged`; and a call with a *different* `erasesAt` for the same player sending again. Model the notifier stub on whatever `test/notify/` already uses.

Run: `npx vitest run test/notify/send-erasure-scheduled.test.ts`
Expected: all pass.

- [ ] **Step 5: Run the full suite and commit**

```bash
npm test && npm run lint && npm run typecheck
git add src/notify/ test/notify/send-erasure-scheduled.test.ts
git commit -m "feat: add N-8, the erasure-scheduled email (BR-34)"
```

---

### Task 4: The delete page and its three routes

**Files:**
- Create: `src/views/delete-account.ts`
- Create: `src/routes/account.ts`
- Modify: `src/auth/paths.ts` (two new path constants)
- Modify: `src/app.ts` (mount the new routes)
- Test: `test/routes/delete-account.test.ts`

**Interfaces:**
- Consumes: `erasureDeadline` (Task 1), `sendErasureScheduledEmail` (Task 3), `listActiveMemberships` and `isLastActiveOwner` (Task 2), `requirePlayer` from `src/auth/session.js`.
- Produces: `DELETE_ACCOUNT_PATH = "/app/delete"` and `DELETE_ACCOUNT_CANCEL_PATH = "/app/delete/cancel"` in `src/auth/paths.ts`; `renderDeleteAccountPage(params)` in `src/views/delete-account.ts`.

- [ ] **Step 1: Add the paths**

In `src/auth/paths.ts`, after `PASSKEYS_PATH`:

```ts
/**
 * Where a signed-in player erases themselves (BR-34, M7b).
 *
 * Under `DASHBOARD_PATH` so it sits behind the session mount and the
 * `private, no-store` header `AUTHENTICATED_PREFIX` carries. There is
 * deliberately no token-reached equivalent: leaving one game works from an
 * emailed link (M7a), but erasure is global and irreversible, and BR-25 draws
 * the line at cross-game actions needing a session.
 */
export const DELETE_ACCOUNT_PATH = `${DASHBOARD_PATH}/delete`;
export const DELETE_ACCOUNT_CANCEL_PATH = `${DELETE_ACCOUNT_PATH}/cancel`;
```

- [ ] **Step 2: Write the view**

Create `src/views/delete-account.ts`. Model it on `src/views/leave.ts` — same shape: one exported render function, a `state` discriminator, one body function per state, `FORM_CSS` in `pageStyles` (this is its own page, not the dashboard, so `FORM_CSS` is correct here).

```ts
export interface DeleteAccountPageParams {
  playerName: string;
  /**
   * - `offer` — nothing pending; renders the request button.
   * - `sole-organiser` — renders **no button**, and names the games.
   * - `pending` — an erasure is scheduled; renders the cancel button.
   */
  state: "offer" | "sole-organiser" | "pending";
  /** For `sole-organiser`. Each links to its own game page to hand over. */
  blockingGames?: readonly { gameId: string; gameName: string }[];
  /** For `pending`, already formatted by the caller. */
  erasesAtLocal?: string;
}
```

Copy requirements:

- The `offer` state states plainly what will be erased (name, address, sign-in, every squad) and what will survive (past fixtures still counting them, as an unnamed former player), and that it happens **two days from now** and can be cancelled until then.
- The `sole-organiser` state reuses M7a's wording pattern: the game needs an organiser and they are the only one; make someone else an organiser first. Each game links to `gamePath(gameId)`.
- Every state says that **an organiser cannot request or cancel this on anyone's behalf, and neither can we** — an organiser who wants to help will otherwise look for the control and not find it.
- The `pending` state names the date and carries a `<form method="post" action="${DELETE_ACCOUNT_CANCEL_PATH}">` with a "Keep my account" button.

- [ ] **Step 3: Write the routes**

Create `src/routes/account.ts`. Register all three on a `new Hono<AppEnv>()` named `account`, each behind `requirePlayer`, and copy the `originOf`/`Origin` check from `src/routes/dashboard.ts` onto **both** POSTs — these are same-origin forms on our own pages, unlike `POST /leave/:token`.

The three handlers:

**`GET /app/delete`** — writes nothing. Load the player, and:
1. If `player.erasesAt !== null`, render `state: "pending"` with the date formatted in `Europe/London` via `formatLocalDateTime`.
2. Otherwise call `listActiveMemberships` and `isLastActiveOwner` for each, exactly as `erasePlayer` does. Any blocking games → `state: "sole-organiser"` with their names (join to `games` for the names).
3. Otherwise `state: "offer"`.

**`POST /app/delete`** — re-runs the sole-organiser check (the page it came from could be stale), and on a block re-renders the page at 422 rather than redirecting, matching how `renderDashboard` handles its own refusal. On success:

```ts
const now = new Date(Date.now());
const erasesAt = erasureDeadline(now);
await db.update(players).set({ erasesAt }).where(eq(players.id, player.id));
await recordAudit(db, {
  actorPlayerId: player.id,
  entityType: "player",
  entityId: player.id,
  action: "player.erasure_requested",
  after: { erasesAt: erasesAt.toISOString() },
});
c.executionCtx.waitUntil(
  sendErasureScheduledEmail({ db, notifier: createNotifier(c.env, db, now), playerId: player.id, erasesAt, now }),
);
return c.redirect(DELETE_ACCOUNT_PATH, 303);
```

`waitUntil`, matching how the dashboard sends its promotion emails: no correctness property depends on the send, and a slow provider must not hold up the redirect.

**This handler must touch nothing else.** No membership, no response, no fixture, no capacity object, no session. That is the inertness guarantee of §2, and it has a test of its own below.

**`POST /app/delete/cancel`** — clears the flag and audits it:

```ts
await db.update(players).set({ erasesAt: null }).where(eq(players.id, player.id));
await recordAudit(db, {
  actorPlayerId: player.id,
  entityType: "player",
  entityId: player.id,
  action: "player.erasure_cancelled",
});
return c.redirect(DASHBOARD_PATH, 303);
```

Cancelling when nothing is pending is a no-op that still redirects — a double-submitted form must not produce an error page.

- [ ] **Step 4: Mount it**

In `src/app.ts`, beside `app.route("/", passkeys);`, add `app.route("/", account);` with its import. It sits under the existing `AUTHENTICATED_PREFIX` mount, so it inherits both the session middleware and `Cache-Control: private, no-store` — add no new middleware.

- [ ] **Step 5: Write the tests**

Create `test/routes/delete-account.test.ts`. Model the signed-in-request setup on `test/routes/dashboard.test.ts` — read it for how a session is established in this suite. Cover:

1. An anonymous `GET /app/delete` redirects to `/sign-in`.
2. `GET /app/delete` renders the offer for an ordinary player.
3. **The inertness guarantee**: seed a player with a membership, an open fixture and an `in` response; `POST /app/delete`; then assert the membership is still active, the response row is unchanged, the fixture's `in_count` is unchanged, and `erased_at` is still null. Comment it as the guarantee it is — this is the test most likely to be broken by a later refactor and the one whose failure matters most.
4. `POST /app/delete` sets `erases_at` to exactly 48 hours ahead and writes one `player.erasure_requested` audit row.
5. `GET /app/delete` then renders the pending state with the date.
6. `POST /app/delete/cancel` clears `erases_at` and writes one `player.erasure_cancelled` row.
7. A sole organiser gets the refusal page with **no submit button**, and their `POST /app/delete` is refused at 422 with `erases_at` still null.
8. A player who co-owns with another active organiser is offered the button.
9. Both POSTs return 403 for a cross-origin `Origin` header.

- [ ] **Step 6: Run and commit**

```bash
npx vitest run test/routes/delete-account.test.ts
npm test && npm run lint && npm run typecheck
git add src/views/delete-account.ts src/routes/account.ts src/auth/paths.ts src/app.ts test/routes/delete-account.test.ts
git commit -m "feat: add the delete-my-data page and its routes (BR-34)"
```

---

### Task 5: The dashboard banner and link

Without this the page exists and nothing links to it — the exact "built but nobody can get to it" failure `renderOwnedGamesSection`'s comment describes, and which M8 hit again.

**Files:**
- Modify: `src/views/dashboard.ts`
- Modify: `src/routes/dashboard.ts`
- Test: `test/routes/dashboard.test.ts` (extend)

**Interfaces:**
- Consumes: `DELETE_ACCOUNT_PATH`, `DELETE_ACCOUNT_CANCEL_PATH` (Task 4).
- Produces: an added optional field on `DashboardPageOptions`:
  ```ts
  /** Set when this player has an erasure pending — already formatted (M7b). */
  erasesAtLocal?: string;
  ```

- [ ] **Step 1: Write the failing tests**

Extend `test/routes/dashboard.test.ts` with: a player with no pending erasure sees a link to `/app/delete` and no banner; a player with `erases_at` set sees the date and a cancel form posting to `/app/delete/cancel`.

- [ ] **Step 2: Render the banner**

In `renderDashboardPage`, immediately after `problemNotice`, add a banner when `erasesAtLocal` is set: the date, and a `<form method="post" action="${DELETE_ACCOUNT_CANCEL_PATH}">` with a "Keep my account" button.

Use the existing `.nudge` class. **Do not add `FORM_CSS` to this page's `pageStyles`** — it overrides `main` and `h1` and re-lays out the whole dashboard. That was an M7a defect, fixed by using `.nudge`; do not reintroduce it.

Add the plain link to `DELETE_ACCOUNT_PATH` beside the existing passkeys link, wording it as "Delete my account and data".

The banner is on the dashboard and not only on the delete page for a reason worth a comment: a pending erasure visible only where it was requested is invisible to the person who did *not* request it.

- [ ] **Step 3: Pass the value through**

In `renderDashboard` (`src/routes/dashboard.ts`), read `erasesAt` for the current player and pass `erasesAtLocal` formatted in `Europe/London` when non-null. Prefer extending the existing player lookup over adding a query.

- [ ] **Step 4: Run and commit**

```bash
npm test && npm run lint && npm run typecheck
git add src/views/dashboard.ts src/routes/dashboard.ts test/routes/dashboard.test.ts
git commit -m "feat: surface a pending erasure on the dashboard (BR-34)"
```

---

### Task 6: The hourly sweep performs due erasures

**Files:**
- Create: `src/sweep/erasures.ts`
- Modify: `src/cron/handler.ts` (the `CRON_SWEEP` case)
- Test: `test/sweep/erasures.test.ts`

**Interfaces:**
- Consumes: `erasePlayer` (Task 2).
- Produces:
  ```ts
  export interface ErasureSweepResult {
    erased: number;
    blocked: number;
    failures: Array<{ playerId: string; message: string }>;
  }
  export async function runDueErasures(
    db: Db,
    now: Date,
    withdraw: (playerId: string) => (fixtureId: string) => Promise<WithdrawMemberOutcome>,
  ): Promise<ErasureSweepResult>;
  ```

- [ ] **Step 1: Write the failing tests**

Create `test/sweep/erasures.test.ts` covering:
1. A player whose `erases_at` is in the past is erased.
2. A player whose `erases_at` is in the future is **not** touched.
3. A player with `erases_at` null is not touched.
4. An already-erased player (`erased_at` set) is not re-erased and writes no second audit row.
5. A blocked player stays pending — `erases_at` unchanged, `erased_at` still null — and is counted in `blocked`, not `failures`.
6. One player throwing does not stop the others: two due players, the first's `withdraw` rejecting, and the second still erased.

- [ ] **Step 2: Write the sweep**

Create `src/sweep/erasures.ts`. Select players where `erases_at <= now` and `erased_at is null`, then call `erasePlayer` for each inside a `try`/`catch`, collecting failures rather than aborting.

That isolation is not optional — the module doc comment should say so:

```ts
/**
 * Perform every erasure whose window has elapsed (§2, BR-34).
 *
 * **One player's failure never stops another's.** This project has been bitten
 * twice by exactly that shape — one rejecting notifier aborting a whole sweep,
 * one bad timezone silencing every game's reminders — so each erasure is
 * isolated and its failure is collected, exactly as `openAndRemind` and
 * `materialiseFixtures` collect theirs.
 *
 * `blocked` is not a failure. A player who has become the last organiser of a
 * game since requesting erasure stays pending and is retried on the next run;
 * `erasePlayer` writes nothing in that case, so retrying costs one query and
 * can never half-complete. It is counted separately so a log reader can tell
 * "waiting on a handover" apart from "something is wrong".
 */
```

- [ ] **Step 3: Wire it into the cron**

In `src/cron/handler.ts`, inside the `CRON_SWEEP` case, after `retirePastFixtures` (erasure must not delay reminders, and retiring must not be delayed by an erasure):

```ts
const erasureResult = await runDueErasures(db, now, (playerId) => (fixtureId) =>
  env.FIXTURE_CAPACITY.getByName(fixtureId).withdrawMember({
    playerId,
    actorPlayerId: playerId,
    now: now.getTime(),
  }),
);
console.log("erasures", JSON.stringify(erasureResult));
for (const failure of erasureResult.failures) {
  console.error(`erasure failed for player ${failure.playerId}: ${failure.message}`);
}
```

Add `erasureResult.failures.length` to the `failed` count that decides whether the invocation throws, and name it in the thrown message alongside the existing counts.

`runDueErasures` takes a `withdraw` *factory* keyed by player id, rather than a plain `withdraw`, because each erasure withdraws a different player and the capacity object needs to be told which.

- [ ] **Step 4: Test the wiring**

Extend `test/cron/handler.test.ts` (read it first for how it invokes `handleScheduled`) with one case: a due erasure is performed by a `CRON_SWEEP` invocation.

- [ ] **Step 5: Run and commit**

```bash
npm test && npm run lint && npm run typecheck
git add src/sweep/erasures.ts src/cron/handler.ts test/sweep/erasures.test.ts test/cron/handler.test.ts
git commit -m "feat: perform due erasures from the hourly sweep (BR-34)"
```

---

### Task 7: Browser coverage, the guide, and the master spec

**Files:**
- Modify: `test/browser/catalogue.ts` (an entry for `/app/delete`)
- Modify: `test/browser/journeys.spec.ts` (one journey)
- Modify: `docs/guide/` chapter 04 (read the directory to find its real filename)
- Modify: `docs/superpowers/specs/2026-08-10-make-the-team-design.md` (BR-34, the GDPR row, the notification catalogue)
- Modify: `docs/known-issues.md`

- [ ] **Step 1: Add the catalogue entry**

Read `test/browser/catalogue.ts` for the shape of an existing entry, then add one for `/app/delete` in its `offer` state. The console gate loads every catalogue page, so this is what proves the page has no console errors and no CSP violation.

- [ ] **Step 2: Add the journey**

In `test/browser/journeys.spec.ts`, add one journey using `seedWorld`: sign in, follow the dashboard link to `/app/delete`, request erasure, land back on the page in its pending state, see the banner on the dashboard, cancel, and see it gone.

**Run it with JavaScript disabled**, as M7a's leave journey does — an erasure control that needs JavaScript is not a control everyone can reach.

- [ ] **Step 3: Update the guide**

Chapter 04 covers dropping out and leaving. Add erasure beside it: what it does, that it waits two days, that it can be cancelled, and that past games still show the right number of players without naming them. Match the chapter's existing voice — read it before writing.

Then run `npm run guide:capture` if the chapter references screenshots, and check `test/browser/guide-references.spec.ts` still passes.

- [ ] **Step 4: Update the master spec**

In `docs/superpowers/specs/2026-08-10-make-the-team-design.md`:

- Add **BR-34** after BR-33, stating: a player may erase themselves from a session of their own; the request waits 48 hours and is cancellable throughout; erasure anonymises in place so past fixtures keep an accurate count; it is refused while the player is the last active organiser of any game; and neither request nor cancellation can be performed by anyone else.
- Amend the GDPR decision row (§Decisions, item 7) to record that M7 built both paths — leaving in M7a and erasure in M7b.
- Add **N-8** to the notification catalogue table (around line 294) — "Erasure scheduled", to the player, once per request, email — and to the dedupe-key table (around line 518) as `n8:<player_id>:<erases_at>`.

- [ ] **Step 5: Record what erasure cannot reach**

Add a row to `docs/known-issues.md` under "Carry-forward for the next milestone" naming the three limits `/privacy` must state, since `/privacy` is the next milestone and this is the record that stops them being rediscovered:

1. Erasure is refused while the player is the last active organiser of a game, and a request blocked at execution stays pending indefinitely rather than half-completing.
2. During the trial, `SIGNIN_ALLOWLIST` fails closed, so a player who is not allowlisted cannot reach a session and therefore cannot reach the page. They must ask the author directly. This disappears when the allowlist is deleted at launch.
3. Free text another person wrote — a fixture's `notes`, a `venue_override`, a game's name — can name someone and cannot be found automatically.

- [ ] **Step 6: Run everything**

```bash
npm test
npx playwright test
npm run lint && npm run typecheck
```

Run the browser suite in the **foreground** and wait for it. Expected: the full server suite green, and the browser suite green with the new journey and catalogue entry (49 tests).

- [ ] **Step 7: Commit**

```bash
git add test/browser/ docs/
git commit -m "docs: cover erasure in the guide, master spec and browser suite (BR-34)"
```

---

## Self-review

**Spec coverage.** §2 scheduled/inert → Tasks 1, 4 (test 3 asserts inertness). §2.1 three states → Task 1, exercised in 4 and 6. §3 per-table erasure → Task 2. §3.1 what remains → Task 2's "keeps the player row" test. §4 placeholder → Task 2 (`ERASED_NAME`). §5 session-only, own id only → Task 4. §5.1 allowlist limit → Task 7 step 5. §6 checked twice → Task 2 (pre-check) and Task 4 (both GET and POST). §7 banner and N-8 → Tasks 5 and 3; three audit actions → Task 1. §8 out of reach → Task 7 step 5. §9 testing → each task's own tests plus Task 7. §10 not-in-this → nothing here builds `/privacy`, a guest erasure, or a data export. §11 definition of done → items 1–5 in Tasks 4–5, item 6 in Task 2, item 7 in Task 7.

**Type consistency.** `erasureDeadline(now: Date): Date` (Task 1) is called in Task 4. `ErasePlayerResult`'s four kinds (Task 2) are consumed in Task 6. `listActiveMemberships` (Task 2) is reused by Task 4's GET. `erasureScheduledKey(playerId, erasesAt)` (Task 3) takes the ISO string of the same `erasesAt` Task 4 writes. `ERASED_NAME` is defined once, in Task 2, and asserted from there.

**One deliberate deviation from the spec's letter.** The spec says the erasure sweep lives in `src/sweep/erasures.ts` and runs from `CRON_SWEEP`; this plan puts it *after* `retirePastFixtures` rather than at an unspecified point, so neither reminders nor retirement can be delayed by an erasure.

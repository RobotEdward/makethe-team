# Make The Team — M2–M3: Responses and Email Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A player receives one email the day before a game, taps a button, and is recorded as in or out — with no login, no JavaScript, and no possibility of two people taking the last slot.

**Architecture:** Response links carry an HMAC-signed token that identifies one player and one fixture. `GET` renders; only `POST` mutates. Every write that can affect capacity enters through a per-fixture Durable Object that holds no state of its own and serialises its critical section explicitly, doing all reads and writes against D1 so there is exactly one source of truth. Email goes through a `Notifier` interface with a real implementation, a console one, and a null one, behind a hard daily ceiling.

**Tech Stack:** TypeScript (strict), Hono, Cloudflare Workers, D1, Durable Objects, Drizzle ORM, Resend, Vitest with `@cloudflare/vitest-pool-workers`.

**Spec:** `docs/superpowers/specs/2026-08-10-make-the-team-design.md`. References below (§, BR-, TR-, SC-, N-) point at that document.

**Builds on:** `docs/superpowers/plans/2026-08-10-m0-m1-foundation.md`, delivered and deployed. Read its "Post-implementation corrections" section before starting — it records the dependency APIs that differ from their documentation.

## What exists already

Do not rebuild any of this. All of it is on `main`, deployed, and covered by 152 tests.

| Module | Exports you will use |
|---|---|
| `src/env.ts` | `Bindings`, `AppEnv`. You will extend `Bindings`. |
| `src/db/client.ts` | `getDb(d1): Db`, `type Db` |
| `src/db/schema.ts` | `players`, `games`, `memberships`, `fixtures` |
| `src/domain/lifecycle.ts` | `LIFECYCLES`, `type Lifecycle`, `INITIAL_LIFECYCLE`, `isTerminalLifecycle` |
| `src/domain/fixture-view.ts` | `fixtureView(facts, now)`, `FixtureFacts`, `FixtureView`, `FixtureStatus`, `FixtureFlag` |
| `src/domain/time/local.ts` | `LocalDate`, `LocalTime`, `LocalTimeError`, `parseLocalDate`, `parseLocalTime`, `formatLocalDate`, `formatLocalTime`, `addDays` |
| `src/domain/time/zone.ts` | `LocalParts`, `toLocalParts`, `toUtc`, `localWeekday`, `formatterCacheSize` |
| `src/domain/recurrence/*` | `parseRecurrenceRule`, `formatRecurrenceRule`, `expandWeekly`, `WEEKDAYS`, `RecurrenceError` |
| `src/domain/materialise.ts` | `materialiseFixtures`, `MATERIALISATION_HORIZON_DAYS`. **`INSERT_CHUNK_SIZE` and `chunk` exist but are private** — Task 1 extracts them. |
| `src/cron/handler.ts` | `handleScheduled`, `CRON_HOURLY_SWEEP`, `CRON_DAILY_MATERIALISE` |
| `src/views/layout.ts` | `layout({title, body})`, and an internal `escapeHtml` |
| `test/support/factories.ts` | `gameRow(overrides)`, **`insertGame(db, overrides)` — note `db` is the first argument**, `resetDatabase()`, `testDb()`. Task 1 extends `resetDatabase` to clear `responses`. |

## Global Constraints

- **Language:** TypeScript, `strict: true` with `noUncheckedIndexedAccess`. No `any` outside a documented type-guard boundary.
- **No JavaScript on any critical path** (TR-4). Every page must be fully usable with scripting disabled. **There is no auto-submit anywhere in this codebase** (TR-15) — the email link opens a page with two explicit buttons that POST.
- **`GET` must never mutate** (TR-15). Email scanners and link prefetchers follow every `GET` in an email. A `GET` that records a response causes phantom acceptances.
- **The word "team" is brand-only.** Never in a table, column, type, function or variable name. Product name and user-facing copy only.
- **Vocabulary is fixed** (§1.7): Game, Fixture, Player, Membership, Squad, Response, Reminder, Lifecycle, Display status, Short, Uneven. Never "event", "match", "user", or "RSVP" — including in user-facing copy, where the word is "response".
- **`lifecycle` is stored; `short`, `confirmed` and `uneven` are derived** (BR-12). Never persist a derived judgement.
- **Pure domain modules take `now: Date` as a parameter.** No module under `src/domain/` may call `Date.now()`, `new Date()` with no arguments, or read a binding. An ESLint rule enforces the zero-argument case project-wide.
- **Timezone conversion happens only in `src/domain/time/zone.ts`.** No other file may construct an `Intl.DateTimeFormat` with a `timeZone`.
- **Chunk every multi-row insert at 8 rows** (TR-38). D1 rejects a statement with more than 100 bound parameters. This binds the `pending` response rows written when a fixture opens.
- **Every write that can affect capacity goes through the Durable Object** (TR-12): a player self-responding, an owner override, adding a guest, waitlist promotion, and membership withdrawal. A write path that bypasses it is a bug, and BR-9 will eventually fail because of it.
- **Reads never touch the Durable Object** (TR-11). The fixture page, the squad list and every sweep query go straight to D1. Routing reads through the object would serialise them behind writes for no benefit.
- **Migrations are expand-only** (TR-24) and forward-only. Generate them with `npm run db:generate`; never hand-edit generated SQL.
- **Tests run in workerd against real bindings** (TR-27). Never mock D1 or the Durable Object.
- **No secrets in the repo.** It is public with push protection.
- **Commit after every task.** Conventional prefixes: `feat:`, `test:`, `chore:`, `fix:`, `docs:`, `ci:`.

## Spec amendments made by this plan

Five. The first four came from reading the installed APIs rather than their documentation; the fifth from working through what a player actually sees. All are folded back into the spec by Task 18.

1. **TR-10 is wrong about how Durable Objects serialise, and BR-9 depends on it.** The spec says Durable Objects "serialise requests, which gives BR-9 and BR-7 correctness with no locking logic". That is only true for Durable Object *storage* operations, which are covered by input gating. Our critical section awaits **D1**, which is an external async call from the object's perspective — the event loop yields, and a second request can interleave, read the same `in_count`, and double-book the last slot. The critical section must be wrapped in `ctx.blockConcurrencyWhile()`, which is documented for exactly this case: external async calls where you cannot tolerate state changes while the event loop yields. Task 5 does this and Task 5's test would fail without it.

2. **The Durable Object uses RPC, not `fetch()`.** `DurableObject` from `cloudflare:workers` supports typed methods called directly on the stub, so there is no request/response plumbing to write or parse. `namespace.getByName(fixtureId)` replaces `namespace.get(namespace.idFromName(fixtureId))`.

3. **`crypto.subtle.timingSafeEqual()` exists in workerd.** TR-14's constant-time comparison is a built-in, synchronous, returning `boolean`. Do not hand-roll one.

4. **Resend supports an `Idempotency-Key` request header**, expiring after 24 hours. Passing the `notification_log.dedupe_key` as that header gives a second layer of protection beneath the unique constraint, at no cost. TR-19 should mention it.

5. **Waitlist positions are stored sparse and displayed dense.** BR-6 fixes ordering by arrival time, and the stored `waitlist_position` never changes once assigned. When someone leaves the waitlist their number is simply not reused, so stored positions develop gaps — 1, 3, 4 after the second person drops out. That is harmless for promotion, which takes the lowest remaining position, but showing a player "position 4" when only two people are ahead of them is a lie. **The number shown to a player is always their rank among current waitlisted responses, computed at render time — never the stored column.** Renumbering on every departure was rejected: it is a write amplification on the hot path to fix a display problem, and it would make positions mutable, which BR-6 says they are not.

## File Structure

```
src/
  capacity/
    fixture-capacity.ts     The Durable Object. Stateless; serialises; writes D1.
    types.ts                Shared input/outcome types, importable without the DO class.
  domain/
    response-status.ts      Canonical RESPONSE_STATUSES, derived types. Mirrors lifecycle.ts.
    token.ts                HMAC response tokens. Pure; takes the secret as a parameter.
    open-fixture.ts         scheduled -> open, writing chunked pending rows (BR-1).
    reminder-time.ts        When a fixture's reminder is due, from wall-clock config.
  notify/
    notifier.ts             The Notifier interface and Message type.
    console-notifier.ts     Development. Logs.
    null-notifier.ts        Tests and non-production. Discards.
    resend-notifier.ts      Production. Batch endpoint, Idempotency-Key.
    quota.ts                The daily send ceiling (TR-31).
    factory.ts              Chooses an implementation from env.NOTIFIER.
    templates/
      reminder.ts           N-1. Typed payload -> {subject, html, text}.
  sweep/
    open-and-remind.ts      Hourly sweep steps 1 and 2.
    retire.ts               Hourly sweep step 4: past fixtures become played.
  db/
    queries.ts              Read models. Fixture-with-squad, eligible members.
  routes/
    respond.ts              GET and POST /r/:token.
  views/
    fixture.ts              The fixture page and its states.
test/
  ...                       Mirrors src/. Uses test/support/factories.ts.
```

---

# Part 1 — M2: the critical path

## Task 1: The `responses` table

**Files:**
- Create: `src/domain/response-status.ts`, `test/domain/response-status.test.ts`
- Modify: `src/db/schema.ts`
- Create: `test/db/responses.test.ts`
- Generated: `migrations/0001_*.sql`

**Interfaces:**
- Consumes: `src/db/schema.ts` tables, `test/support/factories.ts`.
- Produces:
  - `src/domain/response-status.ts` — `RESPONSE_STATUSES` (readonly tuple), `type ResponseStatus`, `RESPONSE_SOURCES`, `type ResponseSource`, `INITIAL_RESPONSE_STATUS = "pending"`, `occupiesSlot(status): boolean`.
  - `src/db/schema.ts` — a `responses` table.

- [ ] **Step 1: Write the failing status-module test**

`test/domain/response-status.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  INITIAL_RESPONSE_STATUS,
  occupiesSlot,
  RESPONSE_SOURCES,
  RESPONSE_STATUSES,
} from "../../src/domain/response-status.js";

describe("response statuses", () => {
  it("is the exact set the spec defines", () => {
    expect([...RESPONSE_STATUSES]).toEqual(["pending", "in", "out", "waitlisted", "withdrawn"]);
  });

  it("defaults to pending", () => {
    expect(INITIAL_RESPONSE_STATUS).toBe("pending");
  });

  it("lists the sources a response can come from", () => {
    expect([...RESPONSE_SOURCES]).toEqual(["token", "web", "owner", "system"]);
  });
});

describe("occupiesSlot", () => {
  it("is true only for in", () => {
    expect(occupiesSlot("in")).toBe(true);
    for (const status of ["pending", "out", "waitlisted", "withdrawn"] as const) {
      expect(occupiesSlot(status)).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- test/domain/response-status.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write the status module**

`src/domain/response-status.ts`. This mirrors `src/domain/lifecycle.ts` deliberately — one canonical definition, everything else derived, so adding a status is a single edit and a mismatch is a typecheck error:

```ts
/**
 * The states a Player's Response to a Fixture can be in (§1.8).
 *
 * Canonical definition. The Drizzle column and every union type derive from
 * this, so a value added here without updating a consumer is a typecheck error
 * rather than silent drift.
 */
export const RESPONSE_STATUSES = ["pending", "in", "out", "waitlisted", "withdrawn"] as const;

export type ResponseStatus = (typeof RESPONSE_STATUSES)[number];

export const INITIAL_RESPONSE_STATUS: ResponseStatus = "pending";

/** How a response came to be set (§2.8). */
export const RESPONSE_SOURCES = ["token", "web", "owner", "system"] as const;

export type ResponseSource = (typeof RESPONSE_SOURCES)[number];

/**
 * Whether a status consumes one of the fixture's slots.
 *
 * Only `in` does. `waitlisted` wants a slot but does not hold one, and
 * `withdrawn` explicitly frees the one it held (BR-3) without reading as a
 * decline the way `out` does.
 */
export function occupiesSlot(status: ResponseStatus): boolean {
  return status === "in";
}
```

- [ ] **Step 4: Add the table to the schema**

Append to `src/db/schema.ts`:

```ts
export const responses = sqliteTable(
  "responses",
  {
    id: text("id").primaryKey(),
    fixtureId: text("fixture_id").notNull().references(() => fixtures.id),
    playerId: text("player_id").notNull().references(() => players.id),
    status: text("status", { enum: RESPONSE_STATUSES }).notNull().default(INITIAL_RESPONSE_STATUS),
    // Null unless waitlisted. Ordering is strictly by when the player joined
    // the waitlist (BR-6) — no priority, no reordering.
    waitlistPosition: integer("waitlist_position"),
    // Null while pending: the player has not answered yet, and silence is not
    // consent (§1.4).
    respondedAt: integer("responded_at", { mode: "timestamp_ms" }),
    // Null when the player set it themselves; the owner's id for an override (BR-27).
    setByPlayerId: text("set_by_player_id").references(() => players.id),
    source: text("source", { enum: RESPONSE_SOURCES }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
  },
  (t) => [
    uniqueIndex("responses_fixture_player_unique").on(t.fixtureId, t.playerId),
    index("responses_fixture_status_idx").on(t.fixtureId, t.status),
    index("responses_player_idx").on(t.playerId),
  ],
);
```

Add the import at the top of `src/db/schema.ts`:

```ts
import {
  INITIAL_RESPONSE_STATUS,
  RESPONSE_SOURCES,
  RESPONSE_STATUSES,
} from "../domain/response-status.js";
```

- [ ] **Step 5: Generate the migration**

```bash
npm run db:generate
ls migrations/
```

Expected: a new `0001_*.sql` alongside the existing `0000_*.sql`. Read it. It must contain only `CREATE TABLE \`responses\`` and its indexes — **no `DROP`, no `ALTER` of an existing table**. If it contains anything destructive, stop: something is wrong with the schema edit, and TR-24 forbids shipping it.

- [ ] **Step 6: Write the constraint test**

`test/db/responses.test.ts`:

```ts
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../src/db/client.js";
import { fixtures, players, responses } from "../../src/db/schema.js";
import { insertGame, resetDatabase } from "../support/factories.js";

const db = getDb(env.DB);

async function seedFixtureAndPlayer(): Promise<{ fixtureId: string; playerId: string }> {
  const gameId = await insertGame(db);
  const fixtureId = crypto.randomUUID();
  await db.insert(fixtures).values({
    id: fixtureId,
    gameId,
    kicksOffAt: new Date("2026-08-13T18:00:00Z"),
    minPlayers: 10,
    maxPlayers: 14,
    prefersEvenNumbers: true,
    shortWarningOffsetHours: 12,
    durationMinutes: 60,
  });
  const playerId = crypto.randomUUID();
  await db.insert(players).values({ id: playerId, name: "Edward Cooper", email: "e@example.com" });
  return { fixtureId, playerId };
}

beforeEach(async () => {
  await resetDatabase();
});

describe("responses", () => {
  it("defaults to pending with no responded_at", async () => {
    const { fixtureId, playerId } = await seedFixtureAndPlayer();
    await db.insert(responses).values({ id: crypto.randomUUID(), fixtureId, playerId, source: "system" });

    const [saved] = await db.select().from(responses);
    expect(saved?.status).toBe("pending");
    expect(saved?.respondedAt).toBeNull();
    expect(saved?.waitlistPosition).toBeNull();
    expect(saved?.setByPlayerId).toBeNull();
  });

  it("allows only one response per player per fixture", async () => {
    const { fixtureId, playerId } = await seedFixtureAndPlayer();
    await db.insert(responses).values({ id: crypto.randomUUID(), fixtureId, playerId, source: "system" });

    await expect(
      db.insert(responses).values({ id: crypto.randomUUID(), fixtureId, playerId, source: "token" }),
    ).rejects.toThrow();
  });

  it("accepts a guest with no email as a respondent", async () => {
    const { fixtureId } = await seedFixtureAndPlayer();
    const guestId = crypto.randomUUID();
    await db.insert(players).values({ id: guestId, name: "Dave from work", isGuest: true });
    await db.insert(responses).values({
      id: crypto.randomUUID(), fixtureId, playerId: guestId, status: "in",
      source: "owner", respondedAt: new Date("2026-08-12T10:00:00Z"),
    });

    const [saved] = await db.select().from(responses);
    expect(saved?.status).toBe("in");
  });
});
```

- [ ] **Step 7: Extract the chunking helper so Task 3 can reuse it**

`src/domain/materialise.ts` currently has `INSERT_CHUNK_SIZE` and `chunk` as **private** module-level declarations. Task 3 needs both, and duplicating them would mean two constants that can silently diverge — with a D1 error as the failure mode.

Create `src/db/chunk.ts`:

```ts
/**
 * Rows per INSERT statement.
 *
 * D1 rejects a statement with more than 100 bound parameters (TR-38). The
 * effective row ceiling depends on the table's column count, and Drizzle may
 * bind more parameters per row than there are declared columns — so this is a
 * deliberately conservative constant rather than something computed. Measured:
 * `fixtures` failed at 10 rows per statement and succeeded at 9.
 *
 * Chunking means a mid-way failure can leave earlier chunks written. Every
 * caller must therefore be idempotent, so a retry completes the work rather
 * than duplicating it.
 */
export const INSERT_CHUNK_SIZE = 8;

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}
```

Then in `src/domain/materialise.ts`, delete both private declarations and import them instead:

```ts
import { chunk, INSERT_CHUNK_SIZE } from "../db/chunk.js";
```

Move the explanatory comment that was above the old constant into `chunk.ts` if it is not already covered, and leave a one-line pointer where it was. This is a pure refactor: `npm test` must still pass with the same count before you continue.

- [ ] **Step 8: Teach `resetDatabase` about the new table**

`test/support/factories.ts` currently clears `memberships`, `fixtures`, `games` and `players`. It does **not** clear `responses`, which does not exist yet — but from this task onward every test that uses it will leak response rows into the next test, producing failures that look like logic bugs and are not.

`responses` must be deleted **first**, before `fixtures` and `players`, to keep the existing child-first ordering:

```ts
export async function resetDatabase(): Promise<void> {
  await env.DB.exec("DELETE FROM responses");
  await env.DB.exec("DELETE FROM memberships");
  await env.DB.exec("DELETE FROM fixtures");
  await env.DB.exec("DELETE FROM games");
  await env.DB.exec("DELETE FROM players");
}
```

Add a test asserting the leak cannot happen: insert a response, call `resetDatabase()`, assert `SELECT COUNT(*) FROM responses` is 0.

- [ ] **Step 9: Run the full suite**

```bash
npm test
npm run typecheck
npm run lint
```

Expected: PASS. 152 tests before this task, so expect more, and nothing pre-existing broken.

- [ ] **Step 10: Apply locally and commit**

```bash
npm run db:migrate:local
git add -A
git commit -m "feat: responses table, response status module, shared chunking helper"
```

---

## Task 2: Response tokens

Implements TR-13, TR-14 and BR-24. This is the only thing standing between a stranger and someone else's response, so it gets attacked properly.

**Files:**
- Create: `src/domain/token.ts`, `test/domain/token.test.ts`
- Modify: `src/env.ts`, `wrangler.jsonc`, `.dev.vars.example`

**Interfaces:**
- Consumes: nothing. Pure; the secret is a parameter, never read from a binding here.
- Produces:
  - `interface ResponseTokenPayload { playerId: string; fixtureId: string; expiresAt: number }`
  - `type TokenVerification = { ok: true; payload: ResponseTokenPayload } | { ok: false; reason: "malformed" | "bad-signature" | "expired" }`
  - `signResponseToken(payload, secret): Promise<string>`
  - `verifyResponseToken(token, secret, now): Promise<TokenVerification>`
  - `responseTokenExpiry(kicksOffAt: Date): Date` — kickoff + 24h (BR-24)
  - `Bindings` gains `RESPONSE_TOKEN_SECRET: string`

- [ ] **Step 1: Write the failing token tests**

`test/domain/token.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  responseTokenExpiry,
  signResponseToken,
  verifyResponseToken,
} from "../../src/domain/token.js";

const SECRET = "test-secret-not-used-anywhere-real";
const OTHER_SECRET = "a-different-secret-entirely";
const NOW = new Date("2026-08-12T09:00:00Z");

function payload(overrides: Partial<Parameters<typeof signResponseToken>[0]> = {}) {
  return {
    playerId: "player-edward",
    fixtureId: "fixture-thursday",
    expiresAt: new Date("2026-08-14T18:00:00Z").getTime(),
    ...overrides,
  };
}

describe("round trip", () => {
  it("verifies a token it just signed", async () => {
    const token = await signResponseToken(payload(), SECRET);
    const result = await verifyResponseToken(token, SECRET, NOW);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.playerId).toBe("player-edward");
      expect(result.payload.fixtureId).toBe("fixture-thursday");
    }
  });

  it("produces a URL-safe token", async () => {
    const token = await signResponseToken(payload(), SECRET);
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(encodeURIComponent(token)).toBe(token);
  });

  it("is deterministic for the same payload and secret", async () => {
    expect(await signResponseToken(payload(), SECRET)).toBe(await signResponseToken(payload(), SECRET));
  });

  it("differs for a different player", async () => {
    const a = await signResponseToken(payload(), SECRET);
    const b = await signResponseToken(payload({ playerId: "player-sam" }), SECRET);
    expect(a).not.toBe(b);
  });
});

describe("rejection", () => {
  it("rejects an expired token (BR-24)", async () => {
    const token = await signResponseToken(payload({ expiresAt: NOW.getTime() - 1 }), SECRET);
    const result = await verifyResponseToken(token, SECRET, NOW);

    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  it("accepts a token expiring exactly now", async () => {
    const token = await signResponseToken(payload({ expiresAt: NOW.getTime() }), SECRET);
    expect((await verifyResponseToken(token, SECRET, NOW)).ok).toBe(true);
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await signResponseToken(payload(), OTHER_SECRET);
    expect(await verifyResponseToken(token, SECRET, NOW)).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("rejects a tampered payload", async () => {
    const token = await signResponseToken(payload(), SECRET);
    const [body, signature] = token.split(".");
    const forged = btoa(JSON.stringify(payload({ playerId: "player-impostor" })))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

    expect(await verifyResponseToken(`${forged}.${signature}`, SECRET, NOW))
      .toEqual({ ok: false, reason: "bad-signature" });
    expect(body).not.toBe(forged);
  });

  it("rejects a tampered signature", async () => {
    const token = await signResponseToken(payload(), SECRET);
    const [body, signature] = token.split(".");
    const flipped = (signature ?? "").slice(0, -1) + ((signature ?? "").endsWith("A") ? "B" : "A");

    expect(await verifyResponseToken(`${body}.${flipped}`, SECRET, NOW))
      .toEqual({ ok: false, reason: "bad-signature" });
  });

  it.each([
    ["", "empty"],
    ["not-a-token", "no separator"],
    [".", "empty halves"],
    ["abc.", "empty signature"],
    [".abc", "empty body"],
    ["a.b.c", "too many parts"],
    ["!!!.!!!", "invalid base64url"],
  ])("rejects %s (%s) as malformed", async (token) => {
    const result = await verifyResponseToken(token, SECRET, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("malformed");
  });

  it("rejects a validly-signed token whose payload is the wrong shape", async () => {
    // Signed with the real secret, so the signature passes — the shape check
    // is what must catch it.
    const body = btoa(JSON.stringify({ nonsense: true }))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const key = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
    );
    const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
    let binary = "";
    for (const b of sig) binary += String.fromCharCode(b);
    const encoded = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

    const result = await verifyResponseToken(`${body}.${encoded}`, SECRET, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("malformed");
  });
});

describe("cross-fixture safety", () => {
  it("a token for one fixture does not verify as another", async () => {
    const token = await signResponseToken(payload({ fixtureId: "fixture-a" }), SECRET);
    const result = await verifyResponseToken(token, SECRET, NOW);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.payload.fixtureId).not.toBe("fixture-b");
  });
});

describe("responseTokenExpiry", () => {
  it("is 24 hours after kickoff (BR-24)", () => {
    const expiry = responseTokenExpiry(new Date("2026-08-13T18:00:00Z"));
    expect(expiry.toISOString()).toBe("2026-08-14T18:00:00.000Z");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- test/domain/token.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write the token module**

`src/domain/token.ts`:

```ts
const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

/** 24 hours, per BR-24. */
const TOKEN_LIFETIME_AFTER_KICKOFF_MS = 86_400_000;

export interface ResponseTokenPayload {
  playerId: string;
  fixtureId: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

export type TokenVerification =
  | { ok: true; payload: ResponseTokenPayload }
  | { ok: false; reason: "malformed" | "bad-signature" | "expired" };

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): Uint8Array | null {
  if (value.length === 0 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    ENCODER.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

/**
 * A response token is `<base64url(payload)>.<base64url(hmac)>`, scoped to
 * exactly one player and one fixture (BR-24). It is opaque to the recipient
 * but not encrypted — it carries no secret, only two identifiers and an expiry,
 * and the signature is what makes it unforgeable.
 */
export async function signResponseToken(payload: ResponseTokenPayload, secret: string): Promise<string> {
  const body = base64UrlEncode(ENCODER.encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), ENCODER.encode(body));
  return `${body}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/**
 * Verify and decode a response token (TR-14).
 *
 * Order matters: the signature is checked before the payload is parsed, so no
 * attacker-controlled bytes are ever interpreted as structure. Comparison uses
 * `crypto.subtle.timingSafeEqual`, a workerd built-in, rather than `===` — a
 * short-circuiting comparison leaks how many leading bytes were correct, which
 * is enough to forge a signature one byte at a time.
 */
export async function verifyResponseToken(
  token: string,
  secret: string,
  now: Date,
): Promise<TokenVerification> {
  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, reason: "malformed" };

  const [body, signature] = parts;
  if (body === undefined || signature === undefined) return { ok: false, reason: "malformed" };

  const provided = base64UrlDecode(signature);
  const bodyBytes = base64UrlDecode(body);
  if (!provided || !bodyBytes) return { ok: false, reason: "malformed" };

  const expected = new Uint8Array(
    await crypto.subtle.sign("HMAC", await hmacKey(secret), ENCODER.encode(body)),
  );
  // Length is constant for HMAC-SHA256, so this comparison leaks nothing an
  // attacker does not already know, and timingSafeEqual requires equal lengths.
  if (provided.byteLength !== expected.byteLength) return { ok: false, reason: "bad-signature" };
  if (!crypto.subtle.timingSafeEqual(provided, expected)) return { ok: false, reason: "bad-signature" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(DECODER.decode(bodyBytes));
  } catch {
    return { ok: false, reason: "malformed" };
  }

  if (!isPayload(parsed)) return { ok: false, reason: "malformed" };
  if (now.getTime() > parsed.expiresAt) return { ok: false, reason: "expired" };

  return { ok: true, payload: parsed };
}

function isPayload(value: unknown): value is ResponseTokenPayload {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate["playerId"] === "string" &&
    typeof candidate["fixtureId"] === "string" &&
    typeof candidate["expiresAt"] === "number" &&
    Number.isFinite(candidate["expiresAt"])
  );
}

/** A token stops working 24 hours after its fixture kicks off (BR-24). */
export function responseTokenExpiry(kicksOffAt: Date): Date {
  return new Date(kicksOffAt.getTime() + TOKEN_LIFETIME_AFTER_KICKOFF_MS);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- test/domain/token.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Add the secret binding**

Extend `src/env.ts`:

```ts
export interface Bindings {
  DB: D1Database;
  NOTIFIER: string;
  MAX_EMAILS_PER_DAY: string;
  /** HMAC key for response tokens (TR-13). Set with `wrangler secret put`. */
  RESPONSE_TOKEN_SECRET: string;
}
```

Create `.dev.vars.example` — **committed**, and containing no real value:

```
# Copy to .dev.vars (gitignored) for local development.
# Any string works locally; production uses a Worker secret.
RESPONSE_TOKEN_SECRET=local-development-secret-do-not-use-in-production
```

Create your own local `.dev.vars` with the same content. It is already gitignored — confirm with `git check-ignore .dev.vars`.

Tests need the binding too. Add it to `vars` in `wrangler.jsonc` **only if** the test environment does not otherwise see it; prefer keeping the real secret out of the config entirely by relying on `.dev.vars`, which the workers pool reads. Verify which applies by running the suite after Step 6 — if `RESPONSE_TOKEN_SECRET` is `undefined` in a test, add a test-only value via the `miniflare.bindings` block in `vitest.config.ts` rather than to `wrangler.jsonc`.

- [ ] **Step 6: Set the production secret**

```bash
set -a; . ~/.config/makethe-team/deploy.env; set +a
head -c 32 /dev/urandom | base64 | npx wrangler secret put RESPONSE_TOKEN_SECRET
```

Do not print the value. Confirm it exists:

```bash
npx wrangler secret list
```

Expected: `RESPONSE_TOKEN_SECRET` listed. **Note in your report that rotating this secret invalidates every outstanding response link** — acceptable, since they expire 24 hours after kickoff anyway, but it must be a deliberate act.

- [ ] **Step 7: Run everything and commit**

```bash
npm test && npm run typecheck && npm run lint
git add -A
git commit -m "feat: HMAC-signed response tokens (TR-13, TR-14, BR-24)"
```

---

## Task 3: Opening a fixture

Implements BR-1, BR-11 and the eligible-set semantics. The M0–M1 review flagged that nothing in the codebase can currently produce an `open` fixture, so M2 must own this transition or none of the rest is reachable.

**Files:**
- Create: `src/domain/open-fixture.ts`, `test/domain/open-fixture.test.ts`

**Interfaces:**
- Consumes: `Db`, `fixtures`, `memberships`, `responses`, and `chunk` / `INSERT_CHUNK_SIZE` from `src/db/chunk.ts` (extracted in Task 1).
- Produces: `openFixture(db, fixtureId, now): Promise<OpenFixtureResult>` where `interface OpenFixtureResult { opened: boolean; pendingCreated: number; reason?: "already-open" | "terminal" | "not-found" }`.

- [ ] **Step 1: Write the failing tests**

`test/domain/open-fixture.test.ts`:

```ts
import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../src/db/client.js";
import { fixtures, memberships, players, responses } from "../../src/db/schema.js";
import { openFixture } from "../../src/domain/open-fixture.js";
import { insertGame, resetDatabase } from "../support/factories.js";

const db = getDb(env.DB);
const NOW = new Date("2026-08-12T09:00:00Z");
const KICKOFF = new Date("2026-08-13T18:00:00Z");

async function seed(squadSize: number, opts: { inactive?: number } = {}): Promise<{ gameId: string; fixtureId: string }> {
  const gameId = await insertGame(db);
  const fixtureId = crypto.randomUUID();
  await db.insert(fixtures).values({
    id: fixtureId, gameId, kicksOffAt: KICKOFF, minPlayers: 10, maxPlayers: 14,
    prefersEvenNumbers: true, shortWarningOffsetHours: 12, durationMinutes: 60,
  });

  const total = squadSize + (opts.inactive ?? 0);
  for (let i = 0; i < total; i++) {
    const playerId = `p-${i}`;
    await db.insert(players).values({ id: playerId, name: `Player ${i}`, email: `p${i}@example.com` });
    await db.insert(memberships).values({
      id: `m-${i}`, gameId, playerId,
      role: i === 0 ? "owner" : "player",
      active: i < squadSize,
    });
  }
  return { gameId, fixtureId };
}

beforeEach(async () => {
  await resetDatabase();
});

describe("openFixture", () => {
  it("writes a pending response for every active member (BR-1)", async () => {
    const { fixtureId } = await seed(12);

    const result = await openFixture(db, fixtureId, NOW);

    expect(result).toMatchObject({ opened: true, pendingCreated: 12 });
    const rows = await db.select().from(responses).where(eq(responses.fixtureId, fixtureId));
    expect(rows).toHaveLength(12);
    expect(rows.every((r) => r.status === "pending")).toBe(true);
    expect(rows.every((r) => r.source === "system")).toBe(true);
    expect(rows.every((r) => r.respondedAt === null)).toBe(true);
  });

  it("sets the lifecycle and opened_at", async () => {
    const { fixtureId } = await seed(3);

    await openFixture(db, fixtureId, NOW);

    const [fixture] = await db.select().from(fixtures).where(eq(fixtures.id, fixtureId));
    expect(fixture?.lifecycle).toBe("open");
    expect(fixture?.openedAt?.toISOString()).toBe(NOW.toISOString());
  });

  it("excludes inactive members (BR-1)", async () => {
    const { fixtureId } = await seed(8, { inactive: 4 });

    const result = await openFixture(db, fixtureId, NOW);

    expect(result.pendingCreated).toBe(8);
  });

  it("chunks past the D1 parameter ceiling (TR-38)", async () => {
    // 25 members is well beyond the ~9-row single-statement limit.
    const { fixtureId } = await seed(25);

    const result = await openFixture(db, fixtureId, NOW);

    expect(result.pendingCreated).toBe(25);
    const rows = await db.select().from(responses).where(eq(responses.fixtureId, fixtureId));
    expect(rows).toHaveLength(25);
  });

  it("is idempotent — opening twice creates nothing extra", async () => {
    const { fixtureId } = await seed(12);

    const first = await openFixture(db, fixtureId, NOW);
    const second = await openFixture(db, fixtureId, new Date(NOW.getTime() + 3_600_000));

    expect(first.opened).toBe(true);
    expect(second).toMatchObject({ opened: false, pendingCreated: 0, reason: "already-open" });
    const rows = await db.select().from(responses).where(eq(responses.fixtureId, fixtureId));
    expect(rows).toHaveLength(12);
  });

  it("does not reopen a cancelled fixture", async () => {
    const { fixtureId } = await seed(12);
    await db.update(fixtures).set({ lifecycle: "cancelled" }).where(eq(fixtures.id, fixtureId));

    const result = await openFixture(db, fixtureId, NOW);

    expect(result).toMatchObject({ opened: false, reason: "terminal" });
    expect(await db.select().from(responses)).toHaveLength(0);
  });

  it("reports a missing fixture rather than throwing", async () => {
    expect(await openFixture(db, "no-such-fixture", NOW)).toMatchObject({ opened: false, reason: "not-found" });
  });

  it("does not retroactively invite someone who joins after opening (BR-2)", async () => {
    const { gameId, fixtureId } = await seed(10);
    await openFixture(db, fixtureId, NOW);

    await db.insert(players).values({ id: "late", name: "Late Joiner", email: "late@example.com" });
    await db.insert(memberships).values({ id: "m-late", gameId, playerId: "late", active: true });

    const again = await openFixture(db, fixtureId, NOW);

    expect(again.pendingCreated).toBe(0);
    expect(await db.select().from(responses).where(eq(responses.fixtureId, fixtureId))).toHaveLength(10);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- test/domain/open-fixture.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement it**

`src/domain/open-fixture.ts`:

```ts
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { fixtures, memberships, responses } from "../db/schema.js";
import { chunk, INSERT_CHUNK_SIZE } from "../db/chunk.js";
import { isTerminalLifecycle } from "./lifecycle.js";

export interface OpenFixtureResult {
  opened: boolean;
  pendingCreated: number;
  reason?: "already-open" | "terminal" | "not-found";
}

/**
 * Move a fixture from `scheduled` to `open`, fixing its eligible set (BR-1).
 *
 * The set of players who can respond is decided here and nowhere else: a
 * `pending` row is written for every active member at this instant, so someone
 * who joins the squad afterwards is not retroactively invited (BR-2) and
 * someone who left is not asked.
 *
 * Idempotent by two mechanisms, because the hourly sweep may retry or overlap:
 * the lifecycle guard short-circuits a second call, and the
 * (fixture_id, player_id) unique index makes the insert safe even if two runs
 * pass the guard simultaneously. That second mechanism matters because the
 * insert is chunked (TR-38) and a partial write must be completable.
 */
export async function openFixture(db: Db, fixtureId: string, now: Date): Promise<OpenFixtureResult> {
  const [fixture] = await db.select().from(fixtures).where(eq(fixtures.id, fixtureId));
  if (!fixture) return { opened: false, pendingCreated: 0, reason: "not-found" };
  if (isTerminalLifecycle(fixture.lifecycle)) {
    return { opened: false, pendingCreated: 0, reason: "terminal" };
  }
  if (fixture.lifecycle === "open") {
    return { opened: false, pendingCreated: 0, reason: "already-open" };
  }

  const eligible = await db
    .select({ playerId: memberships.playerId })
    .from(memberships)
    .where(and(eq(memberships.gameId, fixture.gameId), eq(memberships.active, true)));

  let pendingCreated = 0;
  for (const batch of chunk(eligible, INSERT_CHUNK_SIZE)) {
    const inserted = await db
      .insert(responses)
      .values(
        batch.map(({ playerId }) => ({
          id: crypto.randomUUID(),
          fixtureId,
          playerId,
          status: "pending" as const,
          source: "system" as const,
        })),
      )
      .onConflictDoNothing()
      .returning({ id: responses.id });
    pendingCreated += inserted.length;
  }

  await db
    .update(fixtures)
    .set({ lifecycle: "open", openedAt: now })
    .where(eq(fixtures.id, fixtureId));

  return { opened: true, pendingCreated };
}
```

- [ ] **Step 4: Run and commit**

```bash
npm test && npm run typecheck && npm run lint
git add -A
git commit -m "feat: open a fixture and fix its eligible set (BR-1, BR-2, BR-11)"
```

---

## Task 4: Durable Object scaffolding

Stands the object up and proves the plumbing before any logic depends on it. Keeping this separate means a binding or migration mistake surfaces on its own rather than tangled with capacity logic.

**Files:**
- Create: `src/capacity/types.ts`, `src/capacity/fixture-capacity.ts`, `test/capacity/scaffolding.test.ts`
- Modify: `wrangler.jsonc`, `src/env.ts`, `src/index.ts`

**Interfaces:**
- Produces:
  - `src/capacity/types.ts` — `ResponseIntent = "in" | "out"`, `SetResponseInput`, `SetResponseOutcome`.
  - `src/capacity/fixture-capacity.ts` — `export class FixtureCapacity extends DurableObject<Bindings>` with `ping(): Promise<string>` for now.
  - `src/index.ts` re-exports `FixtureCapacity` (Cloudflare requires the class exported from the Worker entry).
  - `Bindings` gains `FIXTURE_CAPACITY: DurableObjectNamespace<FixtureCapacity>`.

- [ ] **Step 1: Configure the binding and migration**

Add to `wrangler.jsonc`:

```jsonc
  "durable_objects": {
    "bindings": [
      { "name": "FIXTURE_CAPACITY", "class_name": "FixtureCapacity" }
    ]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["FixtureCapacity"] }
  ],
```

`new_sqlite_classes`, not `new_classes` — SQLite-backed is the current default. The object stores nothing, but the storage backend is still declared at creation and cannot be changed later without a rename.

Note: the top-level `migrations` key is Durable Object class migrations. It is unrelated to `migrations_dir`, which is D1 schema migrations. They are different things with the same word.

- [ ] **Step 2: Write the failing scaffolding test**

`test/capacity/scaffolding.test.ts`:

```ts
import { env, listDurableObjectIds, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("FixtureCapacity plumbing", () => {
  it("is reachable by fixture id over RPC", async () => {
    const stub = env.FIXTURE_CAPACITY.getByName("fixture-thursday");
    expect(await stub.ping()).toBe("fixture-capacity");
  });

  it("gives the same instance for the same fixture id", async () => {
    const a = env.FIXTURE_CAPACITY.getByName("fixture-a");
    const b = env.FIXTURE_CAPACITY.getByName("fixture-a");
    expect(a.id.toString()).toBe(b.id.toString());
  });

  it("gives different instances for different fixtures", async () => {
    const a = env.FIXTURE_CAPACITY.getByName("fixture-a");
    const b = env.FIXTURE_CAPACITY.getByName("fixture-b");
    expect(a.id.toString()).not.toBe(b.id.toString());
  });

  it("exposes its state for direct inspection in tests", async () => {
    const stub = env.FIXTURE_CAPACITY.getByName("fixture-inspect");
    const idInside = await runInDurableObject(stub, (_instance, state) => state.id.toString());
    expect(idInside).toBe(stub.id.toString());
  });

  it("registers instances that were addressed", async () => {
    env.FIXTURE_CAPACITY.getByName("fixture-listed");
    await env.FIXTURE_CAPACITY.getByName("fixture-listed").ping();
    const ids = await listDurableObjectIds(env.FIXTURE_CAPACITY);
    expect(ids.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npm test -- test/capacity/scaffolding.test.ts`
Expected: FAIL — no such binding or no such class.

- [ ] **Step 4: Write the types and the class**

`src/capacity/types.ts`. Separate from the class so routes and views can import the shapes without pulling in the Durable Object:

```ts
import type { ResponseSource, ResponseStatus } from "../domain/response-status.js";

/** What a player can ask for. Waitlisting is an outcome, never an intent (BR-5). */
export type ResponseIntent = "in" | "out";

export interface SetResponseInput {
  fixtureId: string;
  playerId: string;
  intent: ResponseIntent;
  /** Null when the player set it themselves; the owner's id for an override. */
  actorPlayerId: string | null;
  source: ResponseSource;
  /** Passed in rather than read from the clock — domain code stays testable. */
  now: number;
}

export type SetResponseOutcome =
  | { kind: "recorded"; status: ResponseStatus; inCount: number; spotsLeft: number }
  /**
   * `waitlistPosition` is the **stored** position — permanent, never reused,
   * and therefore gappy once people leave the waitlist. Use it for logs and
   * assertions. Never show it to a player: the page renders `waitlistRank`
   * from `getFixtureWithSquad` instead. See spec amendment 5.
   */
  | { kind: "waitlisted"; waitlistPosition: number; inCount: number }
  | { kind: "rejected"; reason: "fixture-not-open" | "not-eligible" | "fixture-not-found" };
```

`src/capacity/fixture-capacity.ts`:

```ts
import { DurableObject } from "cloudflare:workers";
import type { Bindings } from "../env.js";

/**
 * Serialises every write that can affect a fixture's capacity (TR-10).
 *
 * One instance per fixture, addressed by fixture id. It holds **no state of its
 * own** — it reads and writes D1 inside its critical section, so D1 stays the
 * single source of truth and the two can never disagree.
 */
export class FixtureCapacity extends DurableObject<Bindings> {
  ping(): string {
    return "fixture-capacity";
  }
}
```

- [ ] **Step 5: Export the class and extend the bindings**

`src/index.ts` must re-export the class — Cloudflare resolves `class_name` against the Worker's entry module:

```ts
export { FixtureCapacity } from "./capacity/fixture-capacity.js";
```

Extend `src/env.ts`:

```ts
import type { FixtureCapacity } from "./capacity/fixture-capacity.js";

export interface Bindings {
  DB: D1Database;
  FIXTURE_CAPACITY: DurableObjectNamespace<FixtureCapacity>;
  NOTIFIER: string;
  MAX_EMAILS_PER_DAY: string;
  RESPONSE_TOKEN_SECRET: string;
}
```

If that import creates a cycle (`env` → `fixture-capacity` → `env`), use `import type` on both sides — type-only imports are erased and cannot cycle at runtime. Confirm `npm run typecheck` passes; if it still complains, move the `Bindings` interface into its own module rather than weakening the typing.

- [ ] **Step 6: Run to verify it passes, then commit**

```bash
npm test && npm run typecheck && npm run lint
npx wrangler deploy --dry-run
git add -A
git commit -m "feat: FixtureCapacity durable object scaffolding and binding"
```

The dry run must succeed. It will not print the Durable Object binding any more reliably than it prints crons, so treat a clean exit as the signal.

---

## Task 5: Capacity, waitlist placement, and BR-9

The correctness core of M2. Two people tapping "I'm in" at the same moment for one remaining slot must produce exactly one `in` and one `waitlisted`, always.

**Files:**
- Modify: `src/capacity/fixture-capacity.ts`
- Create: `test/capacity/set-response.test.ts`

**Interfaces:**
- Produces: `FixtureCapacity.setResponse(input: SetResponseInput): Promise<SetResponseOutcome>`.

- [ ] **Step 1: Write the failing capacity tests**

`test/capacity/set-response.test.ts`:

```ts
import { env } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../src/db/client.js";
import { fixtures, memberships, players, responses } from "../../src/db/schema.js";
import { openFixture } from "../../src/domain/open-fixture.js";
import { insertGame, resetDatabase } from "../support/factories.js";

const db = getDb(env.DB);
const NOW = new Date("2026-08-13T09:00:00Z");
const KICKOFF = new Date("2026-08-13T18:00:00Z");

async function seedOpenFixture(squadSize: number, maxPlayers = 14): Promise<string> {
  const gameId = await insertGame(db, { maxPlayers });
  const fixtureId = crypto.randomUUID();
  await db.insert(fixtures).values({
    id: fixtureId, gameId, kicksOffAt: KICKOFF, minPlayers: 10, maxPlayers,
    prefersEvenNumbers: true, shortWarningOffsetHours: 12, durationMinutes: 60,
  });
  for (let i = 0; i < squadSize; i++) {
    await db.insert(players).values({ id: `p-${i}`, name: `Player ${i}`, email: `p${i}@example.com` });
    await db.insert(memberships).values({ id: `m-${i}`, gameId, playerId: `p-${i}`, active: true });
  }
  await openFixture(db, fixtureId, NOW);
  return fixtureId;
}

function stubFor(fixtureId: string) {
  return env.FIXTURE_CAPACITY.getByName(fixtureId);
}

function accept(fixtureId: string, playerId: string) {
  return stubFor(fixtureId).setResponse({
    fixtureId, playerId, intent: "in", actorPlayerId: null, source: "token", now: NOW.getTime(),
  });
}

function decline(fixtureId: string, playerId: string) {
  return stubFor(fixtureId).setResponse({
    fixtureId, playerId, intent: "out", actorPlayerId: null, source: "token", now: NOW.getTime(),
  });
}

async function counts(fixtureId: string): Promise<{ inCount: number; cached: number }> {
  const rows = await db.select().from(responses)
    .where(and(eq(responses.fixtureId, fixtureId), eq(responses.status, "in")));
  const [fixture] = await db.select().from(fixtures).where(eq(fixtures.id, fixtureId));
  return { inCount: rows.length, cached: fixture?.inCount ?? -1 };
}

beforeEach(async () => {
  await resetDatabase();
});

describe("recording a response", () => {
  it("records in and updates the cached count", async () => {
    const fixtureId = await seedOpenFixture(5);

    const outcome = await accept(fixtureId, "p-0");

    expect(outcome).toMatchObject({ kind: "recorded", status: "in", inCount: 1, spotsLeft: 13 });
    expect(await counts(fixtureId)).toEqual({ inCount: 1, cached: 1 });
  });

  it("records out and stamps responded_at", async () => {
    const fixtureId = await seedOpenFixture(5);

    const outcome = await decline(fixtureId, "p-0");

    expect(outcome).toMatchObject({ kind: "recorded", status: "out", inCount: 0 });
    const [row] = await db.select().from(responses)
      .where(and(eq(responses.fixtureId, fixtureId), eq(responses.playerId, "p-0")));
    expect(row?.respondedAt?.toISOString()).toBe(NOW.toISOString());
  });

  it("lets a player change their mind, freeing the slot", async () => {
    const fixtureId = await seedOpenFixture(5);
    await accept(fixtureId, "p-0");

    await decline(fixtureId, "p-0");

    expect(await counts(fixtureId)).toEqual({ inCount: 0, cached: 0 });
  });

  it("is idempotent — accepting twice leaves one in", async () => {
    const fixtureId = await seedOpenFixture(5);

    await accept(fixtureId, "p-0");
    const second = await accept(fixtureId, "p-0");

    expect(second).toMatchObject({ kind: "recorded", status: "in", inCount: 1 });
    expect(await counts(fixtureId)).toEqual({ inCount: 1, cached: 1 });
  });
});

describe("capacity and the waitlist", () => {
  it("waitlists a player who accepts a full fixture (BR-5)", async () => {
    const fixtureId = await seedOpenFixture(5, 3);
    await accept(fixtureId, "p-0");
    await accept(fixtureId, "p-1");
    await accept(fixtureId, "p-2");

    const outcome = await accept(fixtureId, "p-3");

    expect(outcome).toMatchObject({ kind: "waitlisted", waitlistPosition: 1, inCount: 3 });
  });

  it("appends to the waitlist in arrival order (BR-6)", async () => {
    const fixtureId = await seedOpenFixture(6, 2);
    await accept(fixtureId, "p-0");
    await accept(fixtureId, "p-1");

    expect(await accept(fixtureId, "p-2")).toMatchObject({ waitlistPosition: 1 });
    expect(await accept(fixtureId, "p-3")).toMatchObject({ waitlistPosition: 2 });
    expect(await accept(fixtureId, "p-4")).toMatchObject({ waitlistPosition: 3 });
  });

  it("does not move a waitlisted player to the back when they tap again (BR-6)", async () => {
    const fixtureId = await seedOpenFixture(6, 2);
    await accept(fixtureId, "p-0");
    await accept(fixtureId, "p-1");
    await accept(fixtureId, "p-2"); // position 1
    await accept(fixtureId, "p-3"); // position 2

    expect(await accept(fixtureId, "p-2")).toMatchObject({ waitlistPosition: 1 });
  });

  it("promotes a waitlisted player who taps again once a slot has freed up", async () => {
    const fixtureId = await seedOpenFixture(6, 2);
    await accept(fixtureId, "p-0");
    await accept(fixtureId, "p-1");
    await accept(fixtureId, "p-2"); // waitlisted
    await decline(fixtureId, "p-0"); // a slot frees; automatic promotion is M4

    expect(await accept(fixtureId, "p-2")).toMatchObject({ kind: "recorded", status: "in" });
  });

  it("keeps the cached waitlist count accurate when positions are gappy", async () => {
    const fixtureId = await seedOpenFixture(8, 2);
    await accept(fixtureId, "p-0");
    await accept(fixtureId, "p-1");
    await accept(fixtureId, "p-2"); // position 1
    await accept(fixtureId, "p-3"); // position 2
    await accept(fixtureId, "p-4"); // position 3
    await decline(fixtureId, "p-2"); // leaves a gap at 1

    const [fixture] = await db.select().from(fixtures).where(eq(fixtures.id, fixtureId));
    // Two people remain waitlisted, at stored positions 2 and 3. The count must
    // be 2, not 3 — deriving it from the highest position would be wrong.
    expect(fixture?.waitlistCount).toBe(2);
  });

  it("keeps the cached waitlist count accurate", async () => {
    const fixtureId = await seedOpenFixture(5, 2);
    await accept(fixtureId, "p-0");
    await accept(fixtureId, "p-1");
    await accept(fixtureId, "p-2");

    const [fixture] = await db.select().from(fixtures).where(eq(fixtures.id, fixtureId));
    expect(fixture?.waitlistCount).toBe(1);
  });
});

describe("BR-9 — no double-booking, ever", () => {
  it("resolves two simultaneous acceptances for one slot deterministically", async () => {
    const fixtureId = await seedOpenFixture(6, 3);
    await accept(fixtureId, "p-0");
    await accept(fixtureId, "p-1");
    // One slot left. Two players tap at the same instant.

    const [a, b] = await Promise.all([accept(fixtureId, "p-2"), accept(fixtureId, "p-3")]);

    const kinds = [a.kind, b.kind].sort();
    expect(kinds).toEqual(["recorded", "waitlisted"]);
    expect(await counts(fixtureId)).toEqual({ inCount: 3, cached: 3 });
  });

  it("survives a burst of simultaneous acceptances", async () => {
    const fixtureId = await seedOpenFixture(20, 6);

    const outcomes = await Promise.all(
      Array.from({ length: 20 }, (_, i) => accept(fixtureId, `p-${i}`)),
    );

    const accepted = outcomes.filter((o) => o.kind === "recorded").length;
    const waitlisted = outcomes.filter((o) => o.kind === "waitlisted").length;

    expect(accepted).toBe(6);
    expect(waitlisted).toBe(14);
    expect(await counts(fixtureId)).toEqual({ inCount: 6, cached: 6 });

    // Waitlist positions must be a contiguous 1..14 with no gaps or duplicates.
    const rows = await db.select().from(responses)
      .where(and(eq(responses.fixtureId, fixtureId), eq(responses.status, "waitlisted")));
    const positions = rows.map((r) => r.waitlistPosition).sort((x, y) => (x ?? 0) - (y ?? 0));
    expect(positions).toEqual(Array.from({ length: 14 }, (_, i) => i + 1));
  });

  it("keeps the cached count equal to COUNT(*) after a randomised sequence", async () => {
    const fixtureId = await seedOpenFixture(10, 5);
    const script: Array<[string, "in" | "out"]> = [
      ["p-0", "in"], ["p-1", "in"], ["p-0", "out"], ["p-2", "in"], ["p-3", "in"],
      ["p-4", "in"], ["p-5", "in"], ["p-1", "out"], ["p-6", "in"], ["p-2", "out"],
      ["p-7", "in"], ["p-8", "in"], ["p-3", "out"], ["p-9", "in"],
    ];
    for (const [playerId, intent] of script) {
      await stubFor(fixtureId).setResponse({
        fixtureId, playerId, intent, actorPlayerId: null, source: "web", now: NOW.getTime(),
      });
    }

    const { inCount, cached } = await counts(fixtureId);
    expect(cached).toBe(inCount);
  });
});

describe("rejections", () => {
  it("refuses a fixture that is not open", async () => {
    const fixtureId = await seedOpenFixture(5);
    await db.update(fixtures).set({ lifecycle: "cancelled" }).where(eq(fixtures.id, fixtureId));

    expect(await accept(fixtureId, "p-0")).toMatchObject({ kind: "rejected", reason: "fixture-not-open" });
  });

  it("refuses a player with no response row — they were not eligible (BR-2)", async () => {
    const fixtureId = await seedOpenFixture(5);
    await db.insert(players).values({ id: "outsider", name: "Outsider", email: "o@example.com" });

    expect(await accept(fixtureId, "outsider")).toMatchObject({ kind: "rejected", reason: "not-eligible" });
  });

  it("refuses an unknown fixture", async () => {
    expect(
      await env.FIXTURE_CAPACITY.getByName("nope").setResponse({
        fixtureId: "nope", playerId: "p-0", intent: "in",
        actorPlayerId: null, source: "token", now: NOW.getTime(),
      }),
    ).toMatchObject({ kind: "rejected", reason: "fixture-not-found" });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- test/capacity/set-response.test.ts`
Expected: FAIL — `setResponse` is not a function.

- [ ] **Step 3: Implement `setResponse`**

Replace `src/capacity/fixture-capacity.ts`:

```ts
import { DurableObject } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { fixtures, responses } from "../db/schema.js";
import type { Bindings } from "../env.js";
import type { SetResponseInput, SetResponseOutcome } from "./types.js";

/**
 * Serialises every write that can affect a fixture's capacity (TR-10).
 *
 * One instance per fixture, addressed by fixture id. It holds **no state of its
 * own** — it reads and writes D1 inside its critical section, so D1 stays the
 * single source of truth and the two can never disagree.
 */
export class FixtureCapacity extends DurableObject<Bindings> {
  ping(): string {
    return "fixture-capacity";
  }

  /**
   * Record a player's response, deciding `in` versus `waitlisted` against the
   * fixture's capacity (BR-4, BR-5, BR-9).
   *
   * **`blockConcurrencyWhile` is load-bearing and must not be removed.** A
   * Durable Object does not automatically serialise across every `await`:
   * input gating covers Durable Object *storage* operations, and this critical
   * section awaits **D1**, which is an external call. Without the block, two
   * requests can both read `in_count = 13` before either writes, and both take
   * the last slot — exactly the double-booking BR-9 forbids. The BR-9 tests
   * fail without it.
   */
  async setResponse(input: SetResponseInput): Promise<SetResponseOutcome> {
    return this.ctx.blockConcurrencyWhile(async () => this.#setResponseLocked(input));
  }

  async #setResponseLocked(input: SetResponseInput): Promise<SetResponseOutcome> {
    const db = getDb(this.env.DB);
    const now = new Date(input.now);

    const [fixture] = await db.select().from(fixtures).where(eq(fixtures.id, input.fixtureId));
    if (!fixture) return { kind: "rejected", reason: "fixture-not-found" };
    if (fixture.lifecycle !== "open") return { kind: "rejected", reason: "fixture-not-open" };

    // Read every response for this fixture once. The squad is at most a few
    // dozen rows, and holding them in memory lets the whole decision — new
    // status, waitlist position, both cached counts — be computed without
    // further round trips inside the lock.
    const all = await db
      .select({
        id: responses.id,
        playerId: responses.playerId,
        status: responses.status,
        waitlistPosition: responses.waitlistPosition,
      })
      .from(responses)
      .where(eq(responses.fixtureId, input.fixtureId));

    // A row exists for every player eligible when the fixture opened. No row
    // means this player was not in the squad at that moment (BR-2).
    const existing = all.find((r) => r.playerId === input.playerId);
    if (!existing) return { kind: "rejected", reason: "not-eligible" };

    const others = all.filter((r) => r.id !== existing.id);
    const inCountWithoutThisPlayer = others.filter((r) => r.status === "in").length;
    const waitlistedWithoutThisPlayer = others.filter((r) => r.status === "waitlisted");

    // Decide the new state.
    let status: "in" | "out" | "waitlisted";
    let waitlistPosition: number | null = null;

    if (input.intent === "out") {
      status = "out";
    } else if (existing.status === "in") {
      // Already in. Report current state without a pointless write.
      const inCount = inCountWithoutThisPlayer + 1;
      return { kind: "recorded", status: "in", inCount, spotsLeft: Math.max(0, fixture.maxPlayers - inCount) };
    } else if (existing.status === "waitlisted") {
      // Already waitlisted and still full. Keep the original position — BR-6
      // fixes order by arrival, so re-tapping must not move them to the back.
      if (inCountWithoutThisPlayer >= fixture.maxPlayers) {
        return {
          kind: "waitlisted",
          waitlistPosition: existing.waitlistPosition ?? 1,
          inCount: inCountWithoutThisPlayer,
        };
      }
      status = "in";
    } else if (inCountWithoutThisPlayer >= fixture.maxPlayers) {
      // Full (BR-4). Appended to the end of the waitlist (BR-5, BR-6) and told
      // so explicitly — never silently.
      const highest = waitlistedWithoutThisPlayer.reduce(
        (max, r) => Math.max(max, r.waitlistPosition ?? 0),
        0,
      );
      status = "waitlisted";
      waitlistPosition = highest + 1;
    } else {
      status = "in";
    }

    // Recompute both cached counts from the resulting set. Deriving the
    // waitlist count from the assigned position would be wrong: positions are
    // never reused, so they develop gaps and drift above the real count.
    const inCount = inCountWithoutThisPlayer + (status === "in" ? 1 : 0);
    const waitlistCount = waitlistedWithoutThisPlayer.length + (status === "waitlisted" ? 1 : 0);

    await db.batch([
      db
        .update(responses)
        .set({
          status,
          waitlistPosition,
          respondedAt: now,
          setByPlayerId: input.actorPlayerId,
          source: input.source,
        })
        .where(eq(responses.id, existing.id)),
      db.update(fixtures).set({ inCount, waitlistCount }).where(eq(fixtures.id, input.fixtureId)),
    ]);

    if (status === "waitlisted") {
      return { kind: "waitlisted", waitlistPosition: waitlistPosition ?? 1, inCount };
    }
    return { kind: "recorded", status, inCount, spotsLeft: Math.max(0, fixture.maxPlayers - inCount) };
  }
}
```

Two typing notes. `db.batch()` is typed as a non-empty tuple `[U, ...U[]]`, so a plain array literal usually infers correctly but may need the elements kept inline rather than built up in a variable. And `input.now` is an epoch number rather than a `Date` because it crosses an RPC boundary — keep the conversion at the edge of the method.

- [ ] **Step 4: Run and confirm BR-9 passes**

Run: `npm test -- test/capacity/set-response.test.ts`
Expected: PASS, every case.

Then prove the concurrency control is real. Temporarily change `setResponse` to call `this.#setResponseLocked(input)` directly, without `blockConcurrencyWhile`, and re-run. **The BR-9 burst test must fail** — you should see more than 6 accepted. Restore the block and confirm green again. Record both outputs in your report: a test that passes with and without its safety mechanism is not testing anything.

- [ ] **Step 5: Commit**

```bash
npm test && npm run typecheck && npm run lint
git add -A
git commit -m "feat: serialised capacity writes and waitlist placement (BR-4, BR-5, BR-6, BR-9)"
```

---

## Task 6: The fixture read model and page

**Files:**
- Create: `src/db/queries.ts`, `src/views/fixture.ts`
- Create: `test/db/queries.test.ts`, `test/views/fixture.test.ts`
- Modify: `src/views/layout.ts` (export `escapeHtml`)

**Interfaces:**
- Produces:

```ts
// src/db/queries.ts
export interface SquadMember {
  playerId: string;
  name: string;
  status: ResponseStatus;
  /** Rank among current waitlisted members, 1-based. Null unless waitlisted.
   *  Computed here, never the stored column — see spec amendment 5. */
  waitlistRank: number | null;
}

export interface FixtureWithSquad {
  fixture: typeof fixtures.$inferSelect;
  game: typeof games.$inferSelect;
  squad: SquadMember[];
}

export function getFixtureWithSquad(db: Db, fixtureId: string): Promise<FixtureWithSquad | null>;
```

```ts
// src/views/fixture.ts
export interface FixturePageOptions {
  gameName: string;
  venueName: string;
  /** Already formatted for display in the game's timezone by the caller. */
  kicksOffAtLocal: string;
  view: FixtureView;
  squad: readonly SquadMember[];
  /** The player this page is being rendered for, identified by their token. */
  viewer: { playerId: string; status: ResponseStatus; waitlistRank?: number | null };
  /** Echoed into the form action so the POST carries the same token. */
  token: string;
  /** From `?intent=`. Emphasises one button with CSS. Never records anything. */
  intent: ResponseIntent | null;
  /** Set when the fixture is played or cancelled: render read-only, no buttons. */
  readOnlyReason?: "played" | "cancelled";
}

export function renderFixturePage(options: FixturePageOptions): string;
```

  - `src/views/layout.ts` — `escapeHtml` becomes an export.

- [ ] **Step 1: Write the read-model test**

`test/db/queries.test.ts` — assert that the squad comes back ordered `in` first (by response time), then `waitlisted` by position, then `pending`, then `out`, and that `withdrawn` players are excluded entirely. Seed a fixture with one player in each state and assert the exact ordering and the exclusion. Use `insertGame` and `openFixture` from the existing helpers rather than hand-writing rows.

- [ ] **Step 2: Write the view test**

`test/views/fixture.test.ts`. The assertions that matter:

```ts
import { describe, expect, it } from "vitest";
import { renderFixturePage } from "../../src/views/fixture.js";

const BASE = {
  gameName: "Thursday 7-a-side",
  venueName: "Oxford Sports Park",
  kicksOffAtLocal: "Thursday 13 August, 19:00",
  view: { status: "open" as const, flags: [], spotsLeft: 5, needsOwnerAttention: false },
  squad: [
    { playerId: "p1", name: "Edward Cooper", status: "in" as const, waitlistRank: null },
    { playerId: "p2", name: "Sam Okonjo", status: "pending" as const, waitlistRank: null },
  ],
  viewer: { playerId: "p2", status: "pending" as const },
  token: "tok",
  intent: null,
};

describe("fixture page", () => {
  it("contains no JavaScript at all (TR-4)", () => {
    expect(renderFixturePage(BASE)).not.toContain("<script");
  });

  it("offers two explicit POST buttons, not an auto-submit (TR-15)", () => {
    const html = renderFixturePage(BASE);
    expect(html).toContain('method="post"');
    expect(html).toContain('name="intent" value="in"');
    expect(html).toContain('name="intent" value="out"');
    expect(html).not.toContain("onload");
    expect(html).not.toContain("submit()");
  });

  it("escapes player names", () => {
    const html = renderFixturePage({
      ...BASE,
      squad: [{ playerId: "x", name: '<script>alert("x")</script>', status: "in", waitlistRank: null }],
    });
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  });

  it("says plainly when the viewer is on the waitlist (BR-5)", () => {
    const html = renderFixturePage({
      ...BASE,
      viewer: { playerId: "p2", status: "waitlisted", waitlistRank: 2 },
    });
    expect(html).toMatch(/waitlist/i);
    expect(html).toContain("2");
  });

  it("shows an uneven fixture as on, with a nudge", () => {
    const html = renderFixturePage({
      ...BASE,
      view: { status: "confirmed", flags: ["uneven"], spotsLeft: 3, needsOwnerAttention: true },
    });
    expect(html).toMatch(/confirmed|game is on/i);
    expect(html).toMatch(/odd number|one more|uneven/i);
  });

  it("never uses forbidden vocabulary in copy", () => {
    const html = renderFixturePage(BASE).toLowerCase();
    for (const word of ["rsvp", "event", "match"]) expect(html).not.toContain(word);
  });
});
```

- [ ] **Step 3: Implement the read model and the view**

Build `getFixtureWithSquad` as a single join across `responses`, `players`, `fixtures` and `games`, filtering out `withdrawn`. Build `renderFixturePage` on top of `layout`, using `fixtureView` for the status badge and `escapeHtml` for every interpolated value. Two `<form method="post">` elements, or one form with two submit buttons carrying different `value`s — both are fine, neither uses JavaScript. Style the primary action according to `intent` when present, purely with CSS classes.

Keep the copy plain: "You're in", "Can't make it", "You're on the waitlist, position 2". Say "response", never "RSVP".

- [ ] **Step 4: Run and commit**

```bash
npm test && npm run typecheck && npm run lint
git add -A
git commit -m "feat: fixture read model and server-rendered fixture page"
```

---

## Task 7: `GET /r/:token` — render only

Implements TR-15's read half and TR-14's friendly failure.

**Files:**
- Create: `src/routes/respond.ts`, `test/routes/respond-get.test.ts`
- Modify: `src/app.ts`

- [ ] **Step 1: Write the failing tests**

`test/routes/respond-get.test.ts`. The critical assertions:

- A valid token renders the fixture page with 200.
- **A `GET` records nothing.** Snapshot every response row before the request and assert they are byte-identical afterwards, including `respondedAt`. Do this for `?intent=in` too — the intent parameter must only affect styling.
- `?intent=in` visually emphasises the "I'm in" button but does not record.
- An expired token renders a friendly page (200 or 410, not 500) that explains and offers sign-in, and never leaks whether the fixture exists.
- A tampered token, a token for a different fixture, and a malformed token all render the same friendly page — the copy must not distinguish them, or it becomes an oracle.
- A token for a `played` or `cancelled` fixture renders read-only with an explanation (BR-24), with no buttons.

- [ ] **Step 2: Implement**

`src/routes/respond.ts` — verify the token with `verifyResponseToken(token, c.env.RESPONSE_TOKEN_SECRET, new Date())`, load via `getFixtureWithSquad`, render. On any `ok: false`, render one shared "this link isn't working" page. Do not branch the copy on `reason`; log the reason server-side instead.

Mount in `src/app.ts` with `app.route("/", respond)`.

- [ ] **Step 3: Run and commit**

```bash
npm test && npm run typecheck && npm run lint
git add -A
git commit -m "feat: GET /r/:token renders without mutating (TR-14, TR-15)"
```

---

## Task 8: `POST /r/:token` — record the response

**Files:**
- Modify: `src/routes/respond.ts`
- Create: `test/routes/respond-post.test.ts`

- [ ] **Step 1: Write the failing tests**

Assertions that matter:

- Posting `intent=in` records `in` and re-renders showing the player as in.
- Posting `intent=out` records `out`.
- Posting to a full fixture reports the waitlist placement explicitly in the rendered page. The number shown must come from `getFixtureWithSquad`'s `waitlistRank`, not from the outcome's stored `waitlistPosition` — add a test that creates a gap (waitlist three players, then send the first `out`) and asserts the remaining players are shown as 1 and 2, not 2 and 3.
- An invalid, expired or tampered token records nothing and renders the same friendly page as the `GET`.
- A missing or unrecognised `intent` value records nothing and returns 400.
- Posting for a `played` fixture records nothing (BR-15) and explains.
- The response goes through the Durable Object: assert by seeding a full fixture and checking the outcome is a waitlist placement rather than an over-capacity `in`.

- [ ] **Step 2: Implement**

Parse the form body with `await c.req.parseBody()`. Reject anything whose `intent` is not exactly `"in"` or `"out"`. Call `c.env.FIXTURE_CAPACITY.getByName(fixtureId).setResponse({...})` with `source: "token"` and `actorPlayerId: null`. Re-render the fixture page with the outcome, including a clear waitlist message when placed.

Render directly rather than redirecting: a redirect would need the token in the URL again and buys nothing without JavaScript.

- [ ] **Step 3: Run and commit**

```bash
npm test && npm run typecheck && npm run lint
git add -A
git commit -m "feat: POST /r/:token records a response through the durable object"
```

---

## Task 9: Deploy M2 and verify live

**Files:** none, unless verification finds a problem.

- [ ] **Step 1: Deploy**

Push to `main` and let CI deploy. Watch `gh run watch`.

Note this deploy applies migration `0001` and creates the Durable Object class for the first time. Both are one-way.

- [ ] **Step 2: Verify the live deployment**

```bash
set -a; . ~/.config/makethe-team/deploy.env; set +a
# Durable Object class registered?
curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/makethe-team/settings" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(json.dumps(d['result'].get('bindings'), indent=1))"

# Migration applied to production D1?
npx wrangler d1 execute makethe-team --remote --command \
  "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"

# Holding page and 404 floor unchanged
curl -s -o /dev/null -w "GET /        -> %{http_code}\n" https://makethe.team/
curl -s -o /dev/null -w "GET /r/bogus -> %{http_code}\n" https://makethe.team/r/bogus
```

Expected: a `FIXTURE_CAPACITY` durable object binding; `responses` among the tables; `/` still 200; `/r/bogus` renders the friendly page rather than erroring.

- [ ] **Step 3: Walk the critical path end to end, locally**

Seed a game, open a fixture, mint a token with the local secret, and drive the whole journey with `curl` against `wrangler dev` — including with a `GET` first, to prove the prefetch case leaves no trace. Record the transcript in your report. This is SC-1's only real test until email exists.

---

# Part 2 — M3: email

## Task 10: `notification_log` and `email_quota`

**Files:**
- Modify: `src/db/schema.ts`
- Create: `src/notify/dedupe-key.ts`, `test/notify/dedupe-key.test.ts`, `test/db/notification-log.test.ts`
- Generated: `migrations/0002_*.sql`

**Interfaces:**
- Produces:
  - `notificationLog` and `emailQuota` tables.
  - `src/notify/dedupe-key.ts` — `NOTIFICATION_TYPES` (`n1`…`n6`), `type NotificationType`, and one builder per type: `reminderKey(fixtureId, playerId)`, `promotionKey(fixtureId, playerId, promotedAt)`, `cancellationKey(fixtureId, playerId)`, `attentionKey(fixtureId, playerId)`, `welcomeKey(membershipId)`.

Follow §2.8's dedupe-key table exactly. Write a test asserting each builder produces the documented string, because these keys are the entire idempotency guarantee and a typo in one is a duplicate email to a real person.

`notification_log` needs `dedupe_key` UNIQUE, `notification_type`, nullable `fixture_id`, `player_id`, `channel`, `status` (`queued|sent|failed`), `provider_message_id`, `sent_at`, `error`. `email_quota` is `day` (text `YYYY-MM-DD`, primary key) and `sent_count`.

Commit as `feat: notification log and email quota tables`.

---

## Task 11: The `Notifier` interface, Console and Null

**Files:**
- Create: `src/notify/notifier.ts`, `src/notify/console-notifier.ts`, `src/notify/null-notifier.ts`, `src/notify/factory.ts`
- Create: `test/notify/notifier.test.ts`

**Interfaces:**
- Produces:

```ts
export type Channel = "email";

export interface Message {
  channel: Channel;
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Passed to the provider as an idempotency key where supported. */
  dedupeKey: string;
}

export type SendResult =
  | { ok: true; providerMessageId: string | null }
  | { ok: false; error: string };

export interface Notifier {
  send(messages: readonly Message[]): Promise<SendResult[]>;
}

export function createNotifier(env: Bindings): Notifier;
```

`send` takes an array so a provider that batches can. Implementations must return one `SendResult` per input, in the same order — assert that in the tests, because the caller maps results back onto log rows by index and a length mismatch would attribute a failure to the wrong player.

TR-21: the interface must not assume email. Keep `channel` on the message even though only `"email"` exists.

Commit as `feat: notifier interface with console and null implementations`.

---

## Task 12: `ResendNotifier`

**Files:**
- Create: `src/notify/resend-notifier.ts`, `test/notify/resend-notifier.test.ts`

Use the batch endpoint. Verified API shape:

- `POST https://api.resend.com/emails/batch`
- `Authorization: Bearer <key>`, `Content-Type: application/json`
- Body: a JSON array of `{ from, to, subject, html, text }`, max 100 per call
- Optional `Idempotency-Key` request header, max 256 chars, expiring after 24 hours
- Response: `{ "data": [{ "id": "…" }, …] }`, index-aligned with the request

Chunk at 100. Pass a per-batch `Idempotency-Key` derived from the batch's dedupe keys — a stable hash of them joined, truncated to 256 characters. This is a second layer beneath the `notification_log` unique constraint, and it costs nothing.

Test with `fetchMock` from `cloudflare:test` rather than hitting the network:

```ts
import { fetchMock } from "cloudflare:test";
import { beforeAll, afterEach } from "vitest";

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());
```

Cover: a successful batch mapping ids back in order; a non-2xx response producing `ok: false` for every message in that batch without throwing; a network error doing the same; the `Idempotency-Key` header being present; and a 250-message send producing exactly three upstream calls.

Add `RESEND_API_KEY` and `EMAIL_FROM` to `Bindings`. Do not set the real key yet.

Commit as `feat: Resend notifier with batching and idempotency keys`.

---

## Task 13: The daily send ceiling

**Files:**
- Create: `src/notify/quota.ts`, `test/notify/quota.test.ts`
- Modify: `src/notify/factory.ts`

Implements TR-31 and TR-32/BR-32. This is the real cost guard: Cloudflare has no account-level spend cap, and email is the one outbound cost that can run away.

Wrap whichever `Notifier` the factory chose in a quota decorator that, per UTC day:

1. Drops recipients whose email is null **before** counting them. A guest is skipped silently, is not a failure, and gets no log row (BR-32, TR-32).
2. Reads today's `sent_count`, sends only as many as remain under `MAX_EMAILS_PER_DAY`, and increments the counter by the number actually sent.
3. Returns `{ ok: false, error: "daily-ceiling-reached" }` for every message beyond the ceiling — a distinct, greppable reason, never a silent drop.

Tests: under the ceiling everything sends; at the ceiling nothing does; a partial batch straddling the ceiling sends exactly the remainder and fails the rest; the counter rolls over at UTC midnight; a null-email recipient is skipped without consuming quota.

Commit as `feat: hard daily email ceiling (TR-31, TR-32)`.

---

## Task 14: The reminder email template

**Files:**
- Create: `src/notify/templates/reminder.ts`, `test/notify/templates/reminder.test.ts`

N-1. A typed payload in, `{ subject, html, text }` out (TR-20). Both renditions are required — a text-only client must get a usable message.

The payload carries: game name, venue, local kickoff string, current in-count, spots left, and the player's response URL. The email body contains the two links, which point at `GET /r/<token>?intent=in` and `?intent=out` — remember these are links to a page, not submissions.

Tests: both renditions contain both links; the text rendition contains no HTML tags; player and venue names are escaped in the HTML rendition; the subject names the game and the day; an unsubscribe/leave link is present (BR-22); no forbidden vocabulary.

Commit as `feat: reminder email template (N-1)`.

---

## Task 15: Reminder timing and the sweep

**Files:**
- Create: `src/domain/reminder-time.ts`, `src/sweep/open-and-remind.ts`
- Create: `test/domain/reminder-time.test.ts`, `test/sweep/open-and-remind.test.ts`

**Interfaces:**
- Produces:
  - `reminderInstant(game, kicksOffAt): Date` — resolve `reminder_days_before` and `reminder_local_time` against the game's timezone, via `toUtc`. Pure.
  - `openAndRemind(db, notifier, now): Promise<SweepResult>`.

`reminder-time.ts` must go through `src/domain/time/zone.ts` — it may not touch `Intl` itself. Compute the kickoff's **local calendar date**, subtract `reminder_days_before` days with `addDays`, combine with `reminder_local_time`, convert back with `toUtc`. Do not subtract milliseconds from the kickoff instant: that drifts across a DST boundary, which is the entire point of BR-17.

Required tests for `reminderInstant`: a 19:00 BST kickoff reminds at 09:00 BST the day before (08:00Z); a 19:00 GMT kickoff reminds at 09:00 GMT (09:00Z); **a kickoff on Thursday 29 October 2026 reminds at 09:00 GMT on Wednesday the 28th (09:00Z) while the previous week's reminds at 09:00 BST (08:00Z)** — the DST-crossing pair; a non-default `reminder_days_before` of 2 works; a non-default `reminder_local_time` works.

`openAndRemind` implements the hourly sweep's steps 1 and 2, and the split between them is deliberate (see the M0–M1 plan's cron section): opening and reminding are separate so an Owner opening a fixture early still gets its reminder at the scheduled time.

1. For each `scheduled` fixture whose reminder instant has passed, call `openFixture`.
2. For each `open` fixture whose reminder instant has passed, find eligible players with no `n1:` log row, **insert the log rows first** with status `queued`, then send, then update each row to `sent` or `failed` with the provider id or error.

Insert-before-send is what makes BR-19 work: a crash between insert and send leaves a `queued` row that will not be retried, which is the safe direction. Losing one reminder is recoverable; sending two to a real person is not.

Required tests: a reminder is sent at the right hour and not before; **running the sweep twice sends exactly one email** (BR-19); a fixture opened early by an owner still gets its reminder at the scheduled time and not at opening; guests are skipped; a send failure marks the row `failed` and does not block other recipients; the DST-crossing fixture sends at 09:00 local.

Commit as `feat: reminder timing and the open-and-remind sweep (BR-17, BR-19, N-1)`.

---

## Task 16: Retiring played fixtures, and wiring the cron

**Files:**
- Create: `src/sweep/retire.ts`, `test/sweep/retire.test.ts`
- Modify: `src/cron/handler.ts`, `test/cron/handler.test.ts`

`retirePastFixtures(db, now)` transitions `open` fixtures past `kicks_off_at + duration_minutes` to `played` (BR-13). Cancelled fixtures are untouched. Responses become locked at that point (BR-15), which Task 8's route already respects.

Then wire the hourly branch of `handleScheduled` to run, in order: `openAndRemind`, then `retirePastFixtures`. Step 3 — the owner attention email — belongs to M4 and stays absent.

Keep the existing failure behaviour: log every failure, then throw if any occurred, so the invocation is visibly failed. Extend `test/index.test.ts` to cover the hourly path rejecting when the sweep fails.

Commit as `feat: retire played fixtures and wire the hourly sweep (BR-13, TR-8)`.

---

## Task 17: Deploy M3 and set up Resend

- [ ] **Step 1: Human step — create the Resend account and verify the domain**

This needs a person in a browser. Create a Resend account, add `makethe.team`, and add the DNS records it gives you to Cloudflare. Wait for verification. Then create an API key and store it as a Worker secret:

```bash
set -a; . ~/.config/makethe-team/deploy.env; set +a
npx wrangler secret put RESEND_API_KEY
```

Set `EMAIL_FROM` in `wrangler.jsonc` `vars` to `Make The Team <no-reply@makethe.team>`. That is not a secret.

- [ ] **Step 2: Deploy with `NOTIFIER=console` still set**

Deploy first with the console notifier, so the sweep runs in production and logs what it *would* send without sending anything. Let one real reminder window pass. Inspect the logs and the `notification_log` rows.

This step is the entire reason for the abstraction. Do not skip it.

- [ ] **Step 3: Switch to Resend with a low ceiling**

Set `MAX_EMAILS_PER_DAY` to something small — 20 while there is one game of fourteen — and `NOTIFIER=resend`. Deploy. Verify one real reminder arrives, and that a second sweep in the same hour sends nothing.

- [ ] **Step 4: Update the runbooks**

Record in `docs/runbooks/` how to rotate `RESEND_API_KEY`, what the ceiling is set to and why, and how to tell from `notification_log` whether a reminder was sent, queued or failed.

---

## Task 18: Fold this plan's spec amendments back into the spec

The spec must not drift from what was built. Five amendments were made; all are described in full at the top of this plan.

**Files:**
- Modify: `docs/superpowers/specs/2026-08-10-make-the-team-design.md`
- Modify: `docs/known-issues.md`

- [ ] **Step 1: Correct TR-10 — the concurrency claim is wrong and BR-9 depends on it**

§2.5's TR-10 currently says Durable Objects "serialise requests, which gives BR-9 and BR-7 correctness with no locking logic". Replace that clause. State that input gating covers Durable Object *storage* operations only; that this object's critical section awaits D1, which is an external call across which the event loop yields; and that the section is therefore wrapped in `ctx.blockConcurrencyWhile()`, without which two concurrent responses can read the same count and both take the last slot. Reference the test that proves it.

- [ ] **Step 2: Record that the Durable Object uses RPC**

Update §2.5 to describe typed methods on the stub rather than `fetch()`, and `getByName(fixtureId)` for addressing.

- [ ] **Step 3: Note `timingSafeEqual` in TR-14**

TR-14 says tokens are "verified in constant time". Add that `crypto.subtle.timingSafeEqual` is a workerd built-in and is what the implementation uses, so nobody hand-rolls one later.

- [ ] **Step 4: Note the Resend idempotency key in TR-19**

Record that Resend accepts an `Idempotency-Key` request header expiring after 24 hours, and that the `notification_log.dedupe_key` is passed as it, giving a second layer beneath the unique constraint.

- [ ] **Step 5: Add the stored-position versus displayed-rank rule**

Add a note under §2.8's `responses` schema, and a sentence to BR-6, stating that `waitlist_position` is permanent and never reused, so it develops gaps; that promotion takes the lowest remaining position; and that the number shown to a player is always their rank among current waitlisted responses, computed at render time.

- [ ] **Step 6: Record milestone status and refresh known issues**

Add M2 and M3 to the §2.14 status line. Move anything in `docs/known-issues.md` that this plan resolved out of the list, and add anything newly deferred.

- [ ] **Step 7: Verify no contradiction remains and commit**

Re-read both documents. Confirm nothing still describes the Durable Object as taking `fetch()` requests, nothing still claims automatic serialisation, and nothing implies a displayed waitlist number read straight from the column.

```bash
npm test && npm run typecheck && npm run lint
git add -A
git commit -m "docs: fold M2-M3 spec amendments back into the design spec"
```

---

## Done conditions

| Condition | Verified by |
|---|---|
| A `GET` on a response link records nothing | `npm test -- test/routes/respond-get.test.ts` |
| The whole journey works with JavaScript disabled | Rendered HTML contains no `<script>`; manual `curl` transcript |
| Two simultaneous acceptances for one slot give one `in`, one `waitlisted` | `npm test -- test/capacity/set-response.test.ts` |
| BR-9 genuinely depends on `blockConcurrencyWhile` | Removing it fails the burst test — recorded in Task 5's report |
| Cached counts match `COUNT(*)` after a randomised sequence | Same file |
| Expired, tampered and malformed tokens are all rejected identically | `npm test -- test/domain/token.test.ts`, `respond-get.test.ts` |
| A reminder arrives at 09:00 local across a DST boundary | `npm test -- test/domain/reminder-time.test.ts` |
| Running the sweep twice sends one email | `npm test -- test/sweep/open-and-remind.test.ts` |
| Guests are never emailed and never recorded as failures | `npm test -- test/notify/quota.test.ts` |
| Sends stop at the daily ceiling with a distinct reason | Same file |
| A real reminder arrives at `makethe.team` | Task 17 Step 3 |

## What M4 inherits

Waitlist **promotion** (BR-7), cancellation (BR-14, N-3) and the owner attention email (N-4, BR-31) are M4. They arrive into: a Durable Object that already owns every capacity write and is the natural home for promotion; a `Notifier` with a ceiling and a template pattern to copy; a `notification_log` whose dedupe keys for `n2`, `n3` and `n4` are already defined; and an hourly sweep with a documented slot for step 3.

One thing M4 must decide that this plan deliberately does not: promotion happens inside the Durable Object's critical section, but sending the N-2 email must not — a slow provider call would hold the lock. Expect to return the promoted player from `setResponse` and send outside the block.

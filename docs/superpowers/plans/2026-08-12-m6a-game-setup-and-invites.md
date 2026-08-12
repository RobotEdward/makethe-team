# M6a — Game setup and invites: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A signed-in person with no seed data can create a game, share an invite link and QR code, and have a stranger join the squad — with four weeks of fixtures already materialised.

**Architecture:** Server-rendered Hono routes under `/g/*` (session required) and `/j/:token` (public). Validation and membership logic live in pure domain modules with no database access, so they can be tested exhaustively without HTTP. Editing a game deletes and re-materialises its `scheduled` fixtures through the existing recurrence machinery rather than a second implementation. One small progressive-enhancement script; everything works without it.

**Tech Stack:** Cloudflare Workers, Hono, D1 + Drizzle, Vitest with `@cloudflare/vitest-pool-workers`. One new runtime dependency: `uqr` (QR encoding).

**Spec:** `docs/superpowers/specs/2026-08-12-m6a-game-setup-and-invites-design.md`. Read it before starting. Section references below (§3.2, §4.4 …) are to that document.

## Global Constraints

These apply to every task. They are not restated per-task.

- **No migration.** Every column already exists. If you believe you need one, you have misread the schema — re-read `src/db/schema.ts` and stop.
- **`new Date()` is banned by lint** except as `new Date(Date.now())` at a request edge. Domain functions take `now: Date` as a parameter. Follow `src/routes/dashboard.ts:32`.
- **All timezone conversion goes through `src/domain/time/zone.ts`.** Never construct an `Intl.DateTimeFormat` anywhere else.
- **All HTML interpolation goes through `escapeHtml`** from `src/views/layout.ts`.
- **Multi-row writes chunk at `INSERT_CHUNK_SIZE`** (8) from `src/db/chunk.ts` — TR-38, D1's 100-bound-parameter limit.
- **`db.batch()` is the only atomicity primitive.** There are no interactive transactions in D1.
- **Entitlement is re-checked in every handler** (TR-18). `requirePlayer` says *who*, never *whether*. A failed ownership check returns **404, not 403**.
- **Owner-facing pages must not regress the CSP.** Any new `<style>` block goes in `PAGE_STYLE_BLOCKS` (`src/views/styles.ts`); any new `<script>` goes in `PAGE_SCRIPT_BLOCKS` (`src/views/scripts.ts`). Both are hashed from source by `src/security/csp.ts`. A block not enumerated fails to compile at the `layout()` call site.
- **`Intl.supportedValuesOf('timeZone')` is available and typed.** Verified 12 August 2026 both at runtime in workerd (returns the full IANA list including `Europe/London`) and at compile time under this project's `lib: ["ES2022"]`. No `lib` change, no cast, no `@ts-expect-error` is needed; if you find yourself adding one, something else is wrong.
- **Every task ends green.** `npm run lint && npm run typecheck && npm test` before every commit.
- **Commit after every task**, using the message given in the task's final step.

---

## File structure

**Created:**

| File | Responsibility |
|---|---|
| `src/domain/redact-name.ts` | BR-26's "Edward C." — one implementation |
| `src/domain/game-form.ts` | Pure parse + validate of the game form body |
| `src/domain/create-game.ts` | Game + owner membership + first materialisation |
| `src/domain/update-game.ts` | Save + `scheduled`-fixture propagation, one `batch()` |
| `src/domain/join-squad.ts` | The four-outcome membership operation |
| `src/views/qr.ts` | QR matrix → inline SVG |
| `src/views/game-form.ts` | Create/edit form, including error redisplay |
| `src/views/game-overview.ts` | `/g/:id` |
| `src/views/join.ts` | Public invite page + the four outcome pages |
| `src/routes/games.ts` | `/g/*` handlers |
| `src/routes/join.ts` | `/j/:token` handlers |
| `src/notify/templates/welcome.ts` | N-6 email |
| `src/notify/send-welcome.ts` | N-6 send, mirroring `send-promotion.ts` |

**Modified:** `src/domain/audit.ts` (new entity types and actions), `src/notify/dedupe-key.ts` (N-6 key), `src/notify/delivery.ts` (nullable `fixtureId`), `src/domain/materialise.ts` (extract row-building), `src/views/styles.ts` (form/admin page styles), `src/views/scripts.ts` (copy-invite), `src/app.ts` (two mounts), `src/auth/paths.ts` (new path constants), `src/views/dashboard.ts` (links), `test/support/factories.ts` (player/membership builders).

---

## Task 1: Shared foundations — audit vocabulary, N-6 key, nullable notification scope

Three small changes to shared modules that later tasks depend on. They are one task because none is independently useful and all three are pure vocabulary/type widening.

**Files:**
- Modify: `src/domain/audit.ts`
- Modify: `src/notify/dedupe-key.ts:69-71`
- Modify: `src/notify/delivery.ts:59-63`
- Modify: `src/notify/send-promotion.ts:141` (call site, unchanged behaviour)
- Test: `test/notify/dedupe-key.test.ts`, `test/db/audit.test.ts`

**Interfaces:**
- Produces: `AUDIT_ENTITY_TYPES` gains `"game"` and `"membership"`; `AUDIT_ACTIONS` gains `"game.created"`, `"game.updated"`, `"game.invite_rotated"`, `"membership.joined"`, `"membership.rejoined"`. `welcomeKey(membershipId: string, joinedAt: string): string`. `insertQueuedLogRows(db, params: { fixtureId: string | null; notificationType }, pending)`.

- [ ] **Step 1: Write the failing tests**

Add to `test/notify/dedupe-key.test.ts`:

```typescript
describe("welcomeKey", () => {
  it("includes joinedAt so a rejoin is told again", () => {
    // §2.8 says "rejoining sends again", but UNIQUE (game_id, player_id)
    // forces a rejoin to reuse the membership row — so the membership id
    // alone cannot distinguish the two sends. See spec §4.4.
    const first = welcomeKey("m1", "2026-08-12T10:00:00.000Z");
    const second = welcomeKey("m1", "2026-09-01T10:00:00.000Z");

    expect(first).toBe("n6:m1:2026-08-12T10:00:00.000Z");
    expect(second).not.toBe(first);
  });
});
```

Add to `test/db/audit.test.ts`:

```typescript
it("records a game action against a game entity", async () => {
  const db = testDb();
  const gameId = await insertGame(db);

  await recordAudit(db, {
    actorPlayerId: null,
    entityType: "game",
    entityId: gameId,
    action: "game.created",
    after: { name: "Thursday 7-a-side" },
    now: new Date(1_760_000_000_000),
  });

  const [row] = await db.select().from(auditLog).where(eq(auditLog.entityId, gameId));
  expect(row?.action).toBe("game.created");
  expect(row?.entityType).toBe("game");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/notify/dedupe-key.test.ts test/db/audit.test.ts`
Expected: FAIL — `welcomeKey` takes one argument; `"game"` is not assignable to `AuditEntityType`.

- [ ] **Step 3: Widen the audit vocabulary**

In `src/domain/audit.ts`, replace the two exported arrays. Keep the existing module comment and extend it:

```typescript
/**
 * Extended by M6a, which is the first milestone to audit something that is not
 * a fixture. `entity_type` is a TypeScript-only narrowing — Drizzle's
 * `text({ enum })` emits no SQL CHECK on SQLite — so this needs no migration.
 */
export const AUDIT_ENTITY_TYPES = ["fixture", "game", "membership"] as const;

export const AUDIT_ACTIONS = [
  "fixture.cancelled",
  "fixture.reminder_email_deferred",
  "fixture.promotion_email_deferred",
  "fixture.cancellation_email_deferred",
  "fixture.attention_email_deferred",
  // M6a. `game.updated` carries before/after of the changed columns only,
  // not the whole row — an owner reading this wants to see what moved.
  "game.created",
  "game.updated",
  "game.invite_rotated",
  // A join through the public invite link. `actor_player_id` is the joining
  // player themselves: nobody else acted.
  "membership.joined",
  "membership.rejoined",
] as const;
```

- [ ] **Step 4: Give the N-6 key its `joinedAt` component**

In `src/notify/dedupe-key.ts`, replace `welcomeKey`:

```typescript
/**
 * N-6 welcome: once per membership, and again on each rejoin.
 *
 * §2.8's table gives this key as `n6:<membership_id>` and its prose says
 * "rejoining sends again". Those contradict each other, because
 * `UNIQUE (game_id, player_id)` on `memberships` forces a rejoin to reactivate
 * the existing row rather than insert a second one — so the membership id
 * alone is the same string both times and the unique index on `dedupe_key`
 * would silently drop the second welcome.
 *
 * `joinedAt` (reset on every reactivation, see `src/domain/join-squad.ts`)
 * is what distinguishes them. Passed as an ISO string by every caller.
 */
export function welcomeKey(membershipId: string, joinedAt: string): string {
  return `n6:${membershipId}:${joinedAt}`;
}
```

- [ ] **Step 5: Let a notification be un-scoped to a fixture**

In `src/notify/delivery.ts`, change `insertQueuedLogRows`'s parameter type and add the explanation:

```typescript
export async function insertQueuedLogRows(
  db: Db,
  /**
   * `fixtureId` is nullable because N-6 (welcome) is not fixture-scoped — the
   * column has always been nullable in §2.8 for exactly this notification, and
   * M6a is the first caller to use it. Every fixture-scoped caller still
   * passes a real id and is unaffected.
   */
  params: { fixtureId: string | null; notificationType: NotificationType },
  pending: PendingNotification[],
): Promise<PendingNotification[]> {
```

No body change is needed — the insert already passes the value straight through.

- [ ] **Step 6: Run the full suite**

Run: `npm run lint && npm run typecheck && npm test`
Expected: PASS. If `test/notify/send-promotion.test.ts` fails, you changed behaviour rather than a type — revert and re-read.

- [ ] **Step 7: Commit**

```bash
git add src/domain/audit.ts src/notify/dedupe-key.ts src/notify/delivery.ts test/
git commit -m "feat: widen audit vocabulary and un-scope N-6 from a fixture

M6a audits games and memberships, which are the first non-fixture
entities to reach audit_log, and sends the first notification that is
not about a fixture.

The N-6 dedupe key gains joinedAt. §2.8's key and its own prose
disagree once a rejoin reuses the membership row, which
UNIQUE (game_id, player_id) forces it to."
```

---

## Task 2: Name redaction (BR-26)

**Files:**
- Create: `src/domain/redact-name.ts`
- Test: `test/domain/redact-name.test.ts`

**Interfaces:**
- Produces: `redactName(fullName: string): string`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";
import { redactName } from "../../src/domain/redact-name.js";

describe("redactName (BR-26)", () => {
  it("renders a first name and a surname initial", () => {
    expect(redactName("Edward Charles")).toBe("Edward C.");
  });

  it("keeps only the last part's initial when there are three", () => {
    expect(redactName("Maria del Toro")).toBe("Maria T.");
  });

  it("returns a single-word name unchanged", () => {
    // Nothing to redact, and inventing an initial would be a lie.
    expect(redactName("Pelé")).toBe("Pelé");
  });

  it("collapses surrounding and repeated whitespace", () => {
    expect(redactName("  Edward   Charles  ")).toBe("Edward C.");
  });

  it("returns an empty string for an empty name", () => {
    expect(redactName("   ")).toBe("");
  });

  it("uppercases a lowercased surname initial", () => {
    expect(redactName("edward charles")).toBe("edward C.");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/domain/redact-name.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
/**
 * A squad member's name as a visitor holding an invite link may see it (BR-26):
 * first name plus surname initial, "Edward C.".
 *
 * One implementation, because BR-26 is a privacy rule rather than a formatting
 * preference — a second copy on some other page is how a full surname
 * eventually ships. The public invite page is its only caller today; any future
 * public surface must call this rather than interpolate `players.name`.
 *
 * A single-word name is returned unchanged. There is no surname to reduce, and
 * fabricating an initial would show something the person never entered.
 */
export function redactName(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter((part) => part !== "");
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0]!;

  const first = parts[0]!;
  const surname = parts[parts.length - 1]!;
  return `${first} ${surname[0]!.toUpperCase()}.`;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run test/domain/redact-name.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/domain/redact-name.ts test/domain/redact-name.test.ts
git commit -m "feat: redact a squad member's name to first name and initial (BR-26)"
```

---

## Task 3: Game form validation

The largest pure module in this plan, and the one that closes three known-issues rows. No database, no HTTP.

**Files:**
- Create: `src/domain/game-form.ts`
- Test: `test/domain/game-form.test.ts`

**Interfaces:**
- Consumes: `parseLocalTime`, `formatLocalDate` (`src/domain/time/local.ts`); `toLocalParts` (`src/domain/time/zone.ts`); `formatRecurrenceRule`, `WEEKDAYS`, `type Weekday` (`src/domain/recurrence/parse.ts`).
- Produces:

```typescript
export interface GameFormValues {
  name: string;
  venueName: string;
  venueAddress: string | null;
  venueUrl: string | null;
  timezone: string;
  recurrenceRule: string;
  kickoffTime: string;
  durationMinutes: number;
  minPlayers: number;
  maxPlayers: number;
  prefersEvenNumbers: boolean;
  reminderDaysBefore: number;
  reminderLocalTime: string;
  shortWarningOffsetHours: number;
}
export interface FieldError { field: string; message: string; }
export type GameFormResult =
  | { ok: true; values: GameFormValues; warnings: string[] }
  | { ok: false; errors: FieldError[] };
export function parseGameForm(body: Record<string, unknown>): GameFormResult;
export function supportedTimezones(): readonly string[];
export function localDateToday(now: Date, timezone: string): string;
```

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, expect, it } from "vitest";
import { localDateToday, parseGameForm, supportedTimezones } from "../../src/domain/game-form.js";

/** The minimum a valid submission carries. Individual tests override one key. */
function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "Thursday 7-a-side",
    venueName: "Oxford Sports Park",
    venueAddress: "Marston Ferry Road",
    weekday: "TH",
    interval: "1",
    kickoffTime: "19:00",
    durationMinutes: "60",
    minPlayers: "10",
    maxPlayers: "14",
    prefersEvenNumbers: "on",
    ...overrides,
  };
}

function errorsFor(overrides: Record<string, unknown>): string[] {
  const result = parseGameForm(body(overrides));
  if (result.ok) throw new Error("expected the form to be rejected");
  return result.errors.map((error) => error.field);
}

describe("parseGameForm", () => {
  it("accepts a complete submission and builds the recurrence rule", () => {
    const result = parseGameForm(body());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.values.recurrenceRule).toBe("FREQ=WEEKLY;INTERVAL=1;BYDAY=TH");
    expect(result.values.kickoffTime).toBe("19:00");
    expect(result.values.minPlayers).toBe(10);
    expect(result.values.prefersEvenNumbers).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it("defaults every field the create form does not ask for", () => {
    const result = parseGameForm(body());
    if (!result.ok) throw new Error("expected ok");

    expect(result.values.timezone).toBe("Europe/London");
    expect(result.values.reminderDaysBefore).toBe(1);
    expect(result.values.reminderLocalTime).toBe("09:00");
    expect(result.values.shortWarningOffsetHours).toBe(12);
    expect(result.values.venueUrl).toBeNull();
  });

  it("treats an absent checkbox as false", () => {
    // An unchecked HTML checkbox is absent from the body entirely, not "off".
    const result = parseGameForm(body({ prefersEvenNumbers: undefined }));
    if (!result.ok) throw new Error("expected ok");
    expect(result.values.prefersEvenNumbers).toBe(false);
  });

  it("trims the free-text fields", () => {
    const result = parseGameForm(body({ name: "  Thursday 7-a-side  " }));
    if (!result.ok) throw new Error("expected ok");
    expect(result.values.name).toBe("Thursday 7-a-side");
  });

  it("treats a blank optional field as null, not an empty string", () => {
    const result = parseGameForm(body({ venueAddress: "   " }));
    if (!result.ok) throw new Error("expected ok");
    expect(result.values.venueAddress).toBeNull();
  });

  it("rejects a missing name and a missing venue", () => {
    expect(errorsFor({ name: "" })).toContain("name");
    expect(errorsFor({ venueName: "" })).toContain("venueName");
  });

  it("rejects an over-long name rather than truncating it", () => {
    expect(errorsFor({ name: "x".repeat(201) })).toContain("name");
  });

  it("rejects min above max", () => {
    expect(errorsFor({ minPlayers: "15", maxPlayers: "14" })).toContain("minPlayers");
  });

  it("accepts min equal to max", () => {
    expect(parseGameForm(body({ minPlayers: "12", maxPlayers: "12" })).ok).toBe(true);
  });

  it("rejects a zero, negative or non-numeric player count", () => {
    expect(errorsFor({ minPlayers: "0" })).toContain("minPlayers");
    expect(errorsFor({ maxPlayers: "-1" })).toContain("maxPlayers");
    expect(errorsFor({ maxPlayers: "eleven" })).toContain("maxPlayers");
    expect(errorsFor({ maxPlayers: "11.5" })).toContain("maxPlayers");
  });

  it("rejects a duration of zero or more than a day", () => {
    expect(errorsFor({ durationMinutes: "0" })).toContain("durationMinutes");
    expect(errorsFor({ durationMinutes: "1441" })).toContain("durationMinutes");
  });

  it("rejects a kickoff time that is not HH:MM", () => {
    // Routed through parseLocalTime so an out-of-range LocalParts can never be
    // constructed from a form (docs/known-issues.md, spec §3.2).
    expect(errorsFor({ kickoffTime: "25:00" })).toContain("kickoffTime");
    expect(errorsFor({ kickoffTime: "7pm" })).toContain("kickoffTime");
    expect(errorsFor({ kickoffTime: "19:60" })).toContain("kickoffTime");
  });

  it("rejects an interval other than 1 or 2", () => {
    expect(errorsFor({ interval: "3" })).toContain("interval");
    expect(errorsFor({ interval: "0" })).toContain("interval");
  });

  it("rejects a weekday outside the seven BYDAY codes", () => {
    expect(errorsFor({ weekday: "XX" })).toContain("weekday");
  });

  it("rejects a timezone that is not a supported IANA zone", () => {
    expect(errorsFor({ timezone: "Mars/Olympus_Mons" })).toContain("timezone");
    expect(errorsFor({ timezone: "" })).toContain("timezone");
  });

  it("accepts every timezone it offers", () => {
    // The picker and the validator must agree, or the form can reject its own
    // options. Spot-check the ends and the default rather than all ~400.
    const zones = supportedTimezones();
    expect(zones).toContain("Europe/London");
    for (const timezone of [zones[0]!, zones[zones.length - 1]!, "Europe/London"]) {
      expect(parseGameForm(body({ timezone })).ok).toBe(true);
    }
  });

  it("rejects a venue URL that is not http or https", () => {
    expect(errorsFor({ venueUrl: "javascript:alert(1)" })).toContain("venueUrl");
    expect(errorsFor({ venueUrl: "not a url" })).toContain("venueUrl");
    expect(parseGameForm(body({ venueUrl: "https://example.com/pitch" })).ok).toBe(true);
  });

  it("rejects reminder and warning settings outside their ranges", () => {
    expect(errorsFor({ reminderDaysBefore: "8" })).toContain("reminderDaysBefore");
    expect(errorsFor({ reminderDaysBefore: "-1" })).toContain("reminderDaysBefore");
    expect(errorsFor({ reminderLocalTime: "24:00" })).toContain("reminderLocalTime");
    expect(errorsFor({ shortWarningOffsetHours: "0" })).toContain("shortWarningOffsetHours");
    expect(errorsFor({ shortWarningOffsetHours: "169" })).toContain("shortWarningOffsetHours");
  });

  it("reports every bad field at once, not just the first", () => {
    // The form redisplays all errors together; stopping at the first would
    // make a wrong submission take four round trips to fix.
    const fields = errorsFor({ name: "", minPlayers: "0", kickoffTime: "nope" });
    expect(fields).toEqual(expect.arrayContaining(["name", "minPlayers", "kickoffTime"]));
  });

  it("warns, but does not reject, an odd max with prefers-even (spec Part 3 item 6)", () => {
    const result = parseGameForm(body({ maxPlayers: "13", prefersEvenNumbers: "on" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("13");
  });

  it("does not warn about an odd max when parity is not preferred", () => {
    const result = parseGameForm(body({ maxPlayers: "13", prefersEvenNumbers: undefined }));
    if (!result.ok) throw new Error("expected ok");
    expect(result.warnings).toEqual([]);
  });

  it("ignores a non-string body value rather than coercing it", () => {
    // c.req.parseBody() can hand back a File for a multipart field.
    expect(errorsFor({ name: { not: "a string" } })).toContain("name");
  });
});

describe("localDateToday", () => {
  it("reads the local calendar date in the game's zone", () => {
    // 2026-08-12T23:30Z is already the 13th in Auckland.
    const instant = new Date(Date.UTC(2026, 7, 12, 23, 30));
    expect(localDateToday(instant, "Europe/London")).toBe("2026-08-13");
    expect(localDateToday(instant, "Pacific/Auckland")).toBe("2026-08-13");
    expect(localDateToday(instant, "America/Los_Angeles")).toBe("2026-08-12");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/domain/game-form.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
import { formatRecurrenceRule, WEEKDAYS, type Weekday } from "./recurrence/parse.js";
import { formatLocalDate, LocalTimeError, parseLocalTime } from "./time/local.js";
import { toLocalParts } from "./time/zone.js";

/**
 * Parse and validate the game form (spec §3.2). Pure: no database, no clock,
 * no HTTP. Shared by create and edit so the two cannot disagree about what a
 * valid game is.
 *
 * Returns *every* bad field rather than the first, because the form redisplays
 * them together — failing fast here would make a submission with three
 * mistakes take three round trips.
 *
 * Three of the rules below exist to close rows in `docs/known-issues.md`, and
 * each closes it by making the bad state unreachable from a form rather than
 * by changing the module that would have mishandled it:
 *
 * - Kickoff and reminder times go through `parseLocalTime`, so a `LocalParts`
 *   with `hour: 25` cannot be built from user input.
 * - Timezones are checked against `Intl.supportedValuesOf('timeZone')`, a
 *   membership test, so a rejected zone never reaches `Intl.DateTimeFormat`
 *   and cannot drive its uncached re-construction.
 * - An odd `max_players` with `prefers_even_numbers` is a **warning, not an
 *   error** (spec Part 3 item 6). BR-29 makes parity advisory; rejecting the
 *   configuration would be stricter than the rule it protects.
 */

const MAX_NAME_LENGTH = 200;
const MAX_ADDRESS_LENGTH = 500;
const MAX_URL_LENGTH = 500;
const MAX_DURATION_MINUTES = 1440;
const MAX_PLAYERS_CEILING = 200;
const MAX_WARNING_OFFSET_HOURS = 168;
const MAX_REMINDER_DAYS_BEFORE = 7;

export const DEFAULT_TIMEZONE = "Europe/London";
export const DEFAULT_REMINDER_DAYS_BEFORE = 1;
export const DEFAULT_REMINDER_LOCAL_TIME = "09:00";
export const DEFAULT_SHORT_WARNING_OFFSET_HOURS = 12;

export interface GameFormValues {
  name: string;
  venueName: string;
  venueAddress: string | null;
  venueUrl: string | null;
  timezone: string;
  recurrenceRule: string;
  kickoffTime: string;
  durationMinutes: number;
  minPlayers: number;
  maxPlayers: number;
  prefersEvenNumbers: boolean;
  reminderDaysBefore: number;
  reminderLocalTime: string;
  shortWarningOffsetHours: number;
}

export interface FieldError {
  field: string;
  message: string;
}

export type GameFormResult =
  | { ok: true; values: GameFormValues; warnings: string[] }
  | { ok: false; errors: FieldError[] };

/**
 * The zones the picker offers and the validator accepts — one list, so the
 * form can never reject an option it presented. Verified available in workerd
 * (spec §3.2).
 */
let cachedZones: readonly string[] | undefined;
export function supportedTimezones(): readonly string[] {
  cachedZones ??= Intl.supportedValuesOf("timeZone");
  return cachedZones;
}

/** The local calendar date in `timezone`, as the YYYY-MM-DD anchor column wants. */
export function localDateToday(now: Date, timezone: string): string {
  return formatLocalDate(toLocalParts(now, timezone));
}

/** A body value that is not a string is absent — `parseBody` can yield a File. */
function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function optionalText(value: unknown): string | null {
  const trimmed = text(value);
  return trimmed === "" ? null : trimmed;
}

const WHOLE_NUMBER = /^-?[0-9]+$/;

function integer(value: unknown): number | null {
  const raw = text(value);
  if (!WHOLE_NUMBER.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function isWeekday(value: string): value is Weekday {
  return (WEEKDAYS as readonly string[]).includes(value);
}

export function parseGameForm(body: Record<string, unknown>): GameFormResult {
  const errors: FieldError[] = [];
  const warnings: string[] = [];
  const fail = (field: string, message: string): void => void errors.push({ field, message });

  const name = text(body["name"]);
  if (name === "") fail("name", "Give the game a name.");
  else if (name.length > MAX_NAME_LENGTH) fail("name", `Keep the name under ${MAX_NAME_LENGTH} characters.`);

  const venueName = text(body["venueName"]);
  if (venueName === "") fail("venueName", "Say where you play.");
  else if (venueName.length > MAX_NAME_LENGTH) fail("venueName", `Keep the venue under ${MAX_NAME_LENGTH} characters.`);

  const venueAddress = optionalText(body["venueAddress"]);
  if (venueAddress !== null && venueAddress.length > MAX_ADDRESS_LENGTH) {
    fail("venueAddress", `Keep the address under ${MAX_ADDRESS_LENGTH} characters.`);
  }

  const venueUrl = optionalText(body["venueUrl"]);
  if (venueUrl !== null) {
    if (venueUrl.length > MAX_URL_LENGTH) {
      fail("venueUrl", `Keep the link under ${MAX_URL_LENGTH} characters.`);
    } else {
      // Scheme-checked, not merely parsed: `javascript:` parses perfectly well
      // and would render as a clickable link on the public invite page.
      let parsed: URL | null = null;
      try {
        parsed = new URL(venueUrl);
      } catch {
        parsed = null;
      }
      if (parsed === null || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
        fail("venueUrl", "The venue link must start with http:// or https://");
      }
    }
  }

  // `timezone` is absent on the create form, which is what the default is for.
  const timezone = text(body["timezone"]) === "" ? DEFAULT_TIMEZONE : text(body["timezone"]);
  if (!supportedTimezones().includes(timezone)) {
    fail("timezone", "Pick a time zone from the list.");
  }

  const weekday = text(body["weekday"]);
  if (!isWeekday(weekday)) fail("weekday", "Pick the day you play.");

  const interval = integer(body["interval"]);
  if (interval !== 1 && interval !== 2) {
    fail("interval", "Choose every week or every 2 weeks.");
  }

  const kickoffTime = text(body["kickoffTime"]);
  if (!isValidLocalTime(kickoffTime)) fail("kickoffTime", "Give a kickoff time as HH:MM, like 19:00.");

  const durationMinutes = integer(body["durationMinutes"]);
  if (durationMinutes === null || durationMinutes <= 0 || durationMinutes > MAX_DURATION_MINUTES) {
    fail("durationMinutes", "How long is the game, in minutes?");
  }

  const minPlayers = integer(body["minPlayers"]);
  if (minPlayers === null || minPlayers < 1 || minPlayers > MAX_PLAYERS_CEILING) {
    fail("minPlayers", "The minimum must be at least 1.");
  }

  const maxPlayers = integer(body["maxPlayers"]);
  if (maxPlayers === null || maxPlayers < 1 || maxPlayers > MAX_PLAYERS_CEILING) {
    fail("maxPlayers", "The maximum must be at least 1.");
  }

  if (minPlayers !== null && maxPlayers !== null && minPlayers > maxPlayers) {
    fail("minPlayers", "The minimum can't be higher than the maximum.");
  }

  const prefersEvenNumbers = typeof body["prefersEvenNumbers"] === "string";

  // Advisory, per BR-29 and spec Part 3 item 6: a full fixture at an odd max
  // can never satisfy parity, so it carries the `uneven` flag permanently.
  // Worth saying out loud; not worth refusing.
  if (prefersEvenNumbers && maxPlayers !== null && maxPlayers % 2 === 1) {
    warnings.push(
      `A squad of ${maxPlayers} can never split evenly, so every full fixture will show as uneven. That's only a nudge — nothing is blocked.`,
    );
  }

  const reminderDaysBefore = body["reminderDaysBefore"] === undefined
    ? DEFAULT_REMINDER_DAYS_BEFORE
    : integer(body["reminderDaysBefore"]);
  if (
    reminderDaysBefore === null ||
    reminderDaysBefore < 0 ||
    reminderDaysBefore > MAX_REMINDER_DAYS_BEFORE
  ) {
    fail("reminderDaysBefore", `Remind between 0 and ${MAX_REMINDER_DAYS_BEFORE} days before.`);
  }

  const reminderLocalTime = text(body["reminderLocalTime"]) === ""
    ? DEFAULT_REMINDER_LOCAL_TIME
    : text(body["reminderLocalTime"]);
  if (!isValidLocalTime(reminderLocalTime)) {
    fail("reminderLocalTime", "Give the reminder time as HH:MM, like 09:00.");
  }

  const shortWarningOffsetHours = body["shortWarningOffsetHours"] === undefined
    ? DEFAULT_SHORT_WARNING_OFFSET_HOURS
    : integer(body["shortWarningOffsetHours"]);
  if (
    shortWarningOffsetHours === null ||
    shortWarningOffsetHours < 1 ||
    shortWarningOffsetHours > MAX_WARNING_OFFSET_HOURS
  ) {
    fail("shortWarningOffsetHours", `Warn between 1 and ${MAX_WARNING_OFFSET_HOURS} hours before.`);
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    warnings,
    values: {
      name,
      venueName,
      venueAddress,
      venueUrl,
      timezone,
      recurrenceRule: formatRecurrenceRule({
        freq: "WEEKLY",
        interval: interval!,
        byday: weekday as Weekday,
      }),
      kickoffTime,
      durationMinutes: durationMinutes!,
      minPlayers: minPlayers!,
      maxPlayers: maxPlayers!,
      prefersEvenNumbers,
      reminderDaysBefore: reminderDaysBefore!,
      reminderLocalTime,
      shortWarningOffsetHours: shortWarningOffsetHours!,
    },
  };
}

/**
 * Delegates to `parseLocalTime` rather than testing a regex here, so the form
 * and the materialisation path agree on what a time is by construction.
 */
function isValidLocalTime(value: string): boolean {
  try {
    parseLocalTime(value);
    return true;
  } catch (error) {
    if (error instanceof LocalTimeError) return false;
    throw error;
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/domain/game-form.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Run the full gate and commit**

```bash
npm run lint && npm run typecheck && npm test
git add src/domain/game-form.ts test/domain/game-form.test.ts
git commit -m "feat: validate the game form as a pure module

Closes three known-issues rows by making the bad states unreachable
from a form rather than by changing the modules downstream: times go
through parseLocalTime, timezones are a membership test against the
list the picker offers, and an odd max with prefers-even is a warning
rather than a rejection (BR-29 is advisory)."
```

---

## Task 4: The QR code

**Files:**
- Create: `src/views/qr.ts`
- Test: `test/views/qr.test.ts`
- Modify: `package.json` (add `uqr`)

**Interfaces:**
- Produces: `qrSvg(text: string, options?: { size?: number }): string` — a complete `<svg>` element as a string.

- [ ] **Step 1: Add the dependency**

```bash
npm install uqr@^0.1.3
```

Verify it is a runtime dependency (`dependencies`, not `devDependencies`) and that it added no transitive packages: `npm ls uqr`.

- [ ] **Step 2: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";
import { qrSvg } from "../../src/views/qr.js";

describe("qrSvg", () => {
  const url = "https://makethe.team/j/2f1c8b3e-0000-4000-8000-000000000000";

  it("returns a complete inline svg element", () => {
    const svg = qrSvg(url);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg.trimEnd().endsWith("</svg>")).toBe(true);
  });

  it("never references an external resource", () => {
    // The whole reason this is inline SVG rather than an <img>: the CSP has
    // no img-src and default-src is 'none', so anything fetched is refused by
    // the browser (spec §4.2).
    const svg = qrSvg(url);
    expect(svg).not.toContain("<image");
    expect(svg).not.toContain("href");
    expect(svg).not.toContain("data:");
    expect(svg).not.toContain("http://");
  });

  it("carries an accessible name rather than being a bare graphic", () => {
    expect(qrSvg(url)).toContain("<title>");
    expect(qrSvg(url)).toContain('role="img"');
  });

  it("encodes different inputs differently", () => {
    expect(qrSvg(url)).not.toBe(qrSvg(`${url}x`));
  });

  it("uses a viewBox so the page controls the rendered size", () => {
    expect(qrSvg(url)).toContain("viewBox=");
  });

  it("escapes a title that contains markup characters", () => {
    // The URL is server-built today, but this renders a caller's string.
    expect(qrSvg('https://x/"><script>')).not.toContain("<script>");
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run test/views/qr.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

```typescript
import { encode } from "uqr";
import { escapeHtml } from "./layout.js";

/**
 * A QR code for `text`, as an inline `<svg>` element.
 *
 * **Inline SVG, never an `<img>`, and this is not a style preference.** The
 * Content-Security-Policy sets `default-src 'none'` and names no `img-src`, so
 * an image of any kind — including a `data:` URI — is refused by the browser
 * before it renders. That is exactly the mechanism that left both passkey
 * buttons broken in production while every server-side test passed (the
 * post-mortem in `docs/known-issues.md`). Inline SVG is markup rather than a
 * fetch, so it needs no directive and cannot fail that way. Adding `img-src`
 * to serve one QR code would widen the policy for the whole site.
 *
 * Encoding comes from `uqr` (MIT, no dependencies) rather than being
 * hand-rolled: QR is Reed–Solomon error correction plus mask selection, and
 * design principle 6 prefers the option with fewer moving parts — a call into
 * a small library is fewer than 400 lines of our own.
 *
 * Rendered as one `<path>` of module rectangles rather than thousands of
 * `<rect>` elements, which keeps the markup small enough to sit in a page.
 */
export function qrSvg(text: string, options: { size?: number } = {}): string {
  const { size = 240 } = options;
  const result = encode(text, { border: 2 });
  const modules = result.size;

  let path = "";
  for (let y = 0; y < modules; y++) {
    for (let x = 0; x < modules; x++) {
      if (result.data[y]![x]) path += `M${x} ${y}h1v1h-1z`;
    }
  }

  // `currentColor`, so the code inherits the page's foreground and stays legible
  // in both the light and dark palettes `STYLES` defines.
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${modules} ${modules}" width="${size}" height="${size}" role="img" shape-rendering="crispEdges"><title>QR code for ${escapeHtml(text)}</title><rect width="${modules}" height="${modules}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}
```

**Verified 12 August 2026** against `uqr@0.1.3`: `encode(data, options)` returns
`{ size: number; data: boolean[][]; … }`, which is the shape the code above
uses. `uqr` also ships a `renderSVG`, deliberately not used — it gives no
control over `role`, `<title>` or the `viewBox`, all of which the tests pin,
and wrapping it would be more code than the twelve lines above.

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run test/views/qr.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Run the gate and commit**

```bash
npm run lint && npm run typecheck && npm test
git add package.json package-lock.json src/views/qr.ts test/views/qr.test.ts
git commit -m "feat: render the invite QR code as inline SVG

Inline rather than an <img> because the CSP names no img-src and
default-src is 'none' — an image of any kind, data: URI included, is
refused by the browser. Same failure mode as the connect-src bug."
```

---

## Task 5: Extract per-game materialisation

A refactor with no behaviour change, needed by both Task 6 (create) and Task 8 (edit). Doing it separately keeps those two tasks about their own subject.

**Files:**
- Modify: `src/domain/materialise.ts`
- Test: `test/domain/materialise.test.ts` (existing tests must keep passing unchanged)

**Interfaces:**
- Produces:

```typescript
export type FixtureInsert = typeof fixtures.$inferInsert;
export function fixtureRowsFor(game: typeof games.$inferSelect, now: Date, horizon: Date): FixtureInsert[];
export async function materialiseGame(db: Db, game: typeof games.$inferSelect, now: Date, horizonDays?: number): Promise<number>;
```

- [ ] **Step 1: Write the failing test**

Add to `test/domain/materialise.test.ts`:

```typescript
describe("materialiseGame", () => {
  it("materialises one game and returns the count created", async () => {
    const db = testDb();
    const gameId = await insertGame(db);
    const [game] = await db.select().from(games).where(eq(games.id, gameId));
    const now = new Date(Date.UTC(2026, 7, 12, 9, 0));

    const created = await materialiseGame(db, game!, now);

    const rows = await db.select().from(fixtures).where(eq(fixtures.gameId, gameId));
    expect(created).toBe(rows.length);
    expect(created).toBeGreaterThan(0);
  });

  it("is idempotent — a second call creates nothing", async () => {
    const db = testDb();
    const gameId = await insertGame(db);
    const [game] = await db.select().from(games).where(eq(games.id, gameId));
    const now = new Date(Date.UTC(2026, 7, 12, 9, 0));

    await materialiseGame(db, game!, now);
    expect(await materialiseGame(db, game!, now)).toBe(0);
  });
});

describe("fixtureRowsFor", () => {
  it("builds rows without touching the database", async () => {
    const db = testDb();
    const gameId = await insertGame(db);
    const [game] = await db.select().from(games).where(eq(games.id, gameId));
    const now = new Date(Date.UTC(2026, 7, 12, 9, 0));

    const rows = fixtureRowsFor(game!, now, new Date(now.getTime() + 35 * 86_400_000));

    expect(rows.length).toBeGreaterThan(0);
    // The five columns §2.8 copies at materialisation.
    expect(rows[0]!.minPlayers).toBe(game!.minPlayers);
    expect(rows[0]!.maxPlayers).toBe(game!.maxPlayers);
    expect(rows[0]!.prefersEvenNumbers).toBe(game!.prefersEvenNumbers);
    expect(rows[0]!.shortWarningOffsetHours).toBe(game!.shortWarningOffsetHours);
    expect(rows[0]!.durationMinutes).toBe(game!.durationMinutes);
    // Nothing was written.
    expect(await db.select().from(fixtures)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/domain/materialise.test.ts`
Expected: FAIL — `materialiseGame` / `fixtureRowsFor` are not exported.

- [ ] **Step 3: Refactor `src/domain/materialise.ts`**

Extract the body of the existing loop. `materialiseFixtures` keeps its exact
behaviour — including one game's failure not stopping the others.

```typescript
export type FixtureInsert = typeof fixtures.$inferInsert;
export type Game = typeof games.$inferSelect;

/**
 * The fixture rows one game's recurrence produces between `now` and `horizon`.
 * Pure — builds rows, writes nothing.
 *
 * Split out from `materialiseFixtures` so an edit can re-derive a game's
 * `scheduled` fixtures inside its own `db.batch()` (see
 * `src/domain/update-game.ts`) without a second implementation of
 * recurrence-to-fixtures, and without this function deciding when to write.
 */
export function fixtureRowsFor(game: Game, now: Date, horizon: Date): FixtureInsert[] {
  const rule = parseRecurrenceRule(game.recurrenceRule);
  const instants = expandWeekly(
    rule,
    parseLocalDate(game.recurrenceStartDate),
    parseLocalTime(game.kickoffTime),
    game.timezone,
    now,
    horizon,
  );

  return instants.map((kicksOffAt) => ({
    id: crypto.randomUUID(),
    gameId: game.id,
    kicksOffAt,
    lifecycle: INITIAL_LIFECYCLE,
    minPlayers: game.minPlayers,
    maxPlayers: game.maxPlayers,
    prefersEvenNumbers: game.prefersEvenNumbers,
    shortWarningOffsetHours: game.shortWarningOffsetHours,
    durationMinutes: game.durationMinutes,
  }));
}

/**
 * Materialise one game's fixtures out to the horizon, returning how many rows
 * were actually created.
 *
 * Idempotent via the `(game_id, kicks_off_at)` unique index, which is what
 * makes the chunked write safe partway through — see the comment inside.
 */
export async function materialiseGame(
  db: Db,
  game: Game,
  now: Date,
  horizonDays: number = MATERIALISATION_HORIZON_DAYS,
): Promise<number> {
  const rows = fixtureRowsFor(game, now, new Date(now.getTime() + horizonDays * DAY_MS));
  if (rows.length === 0) return 0;

  let created = 0;
  // Chunked to stay under D1's 100-bound-parameter limit (TR-38). A failure
  // partway leaves earlier chunks committed and later ones missing, which is
  // safe only because onConflictDoNothing makes the whole operation
  // idempotent — the next run completes whatever is missing.
  for (const batch of chunk(rows, INSERT_CHUNK_SIZE)) {
    const inserted = await db.insert(fixtures).values(batch).onConflictDoNothing().returning({ id: fixtures.id });
    created += inserted.length;
  }
  return created;
}
```

Then rewrite `materialiseFixtures`'s loop body to call it:

```typescript
  for (const game of activeGames) {
    try {
      result.fixturesCreated += await materialiseGame(db, game, now, horizonDays);
    } catch (error) {
      result.failures.push({
        gameId: game.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
```

- [ ] **Step 4: Run the materialisation and sweep suites**

Run: `npx vitest run test/domain/materialise.test.ts test/sweep/ test/cron/`
Expected: PASS, including every pre-existing test unchanged. If a pre-existing
test now fails, you changed behaviour — the extraction must be behaviour-neutral.

- [ ] **Step 5: Run the gate and commit**

```bash
npm run lint && npm run typecheck && npm test
git add src/domain/materialise.ts test/domain/materialise.test.ts
git commit -m "refactor: extract per-game fixture materialisation

Creating a game and editing one both need to materialise a single
game — the second inside its own batch(). No behaviour change: the
daily sweep still loops over active games and still isolates one
game's failure from the rest."
```

---

## Task 6: Create a game

**Files:**
- Create: `src/domain/create-game.ts`, `src/views/game-form.ts`, `src/routes/games.ts`
- Modify: `src/auth/paths.ts`, `src/views/styles.ts`, `src/app.ts`
- Test: `test/domain/create-game.test.ts`, `test/routes/games.test.ts`

**Interfaces:**
- Consumes: `parseGameForm`, `localDateToday`, `GameFormValues` (Task 3); `materialiseGame` (Task 5); `buildAuditInsert` (`src/db/audit.ts`).
- Produces:

```typescript
// src/domain/create-game.ts
export interface CreateGameParams { db: Db; values: GameFormValues; ownerPlayerId: string; now: Date; }
export interface CreatedGame { gameId: string; inviteToken: string; fixturesCreated: number; }
export function createGame(params: CreateGameParams): Promise<CreatedGame>;

// src/auth/paths.ts
export const GAMES_PREFIX = "/g/*";
export const NEW_GAME_PATH = "/g/new";
export function gamePath(gameId: string): string;      // `/g/${gameId}`
export function gameEditPath(gameId: string): string;  // `/g/${gameId}/edit`
export function joinPath(token: string): string;       // `/j/${token}`

// src/views/game-form.ts
export interface GameFormPageParams {
  action: string;
  heading: string;
  submitLabel: string;
  values: Partial<Record<string, string>>;
  errors: readonly FieldError[];
  warnings: readonly string[];
  showAdvanced: boolean;
  affectedNotice?: string;
}
export function renderGameFormPage(params: GameFormPageParams): string;
```

- [ ] **Step 1: Write the failing domain test**

`test/domain/create-game.test.ts`:

```typescript
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createGame } from "../../src/domain/create-game.js";
import { parseGameForm } from "../../src/domain/game-form.js";
import { auditLog, fixtures, games, memberships } from "../../src/db/schema.js";
import { insertPlayer, resetDatabase, testDb } from "../support/factories.js";

function values() {
  const result = parseGameForm({
    name: "Thursday 7-a-side",
    venueName: "Oxford Sports Park",
    weekday: "TH",
    interval: "1",
    kickoffTime: "19:00",
    durationMinutes: "60",
    minPlayers: "10",
    maxPlayers: "14",
    prefersEvenNumbers: "on",
  });
  if (!result.ok) throw new Error("fixture form values must be valid");
  return result.values;
}

describe("createGame", () => {
  beforeEach(resetDatabase);

  const now = new Date(Date.UTC(2026, 7, 12, 9, 0));

  it("writes the game, the owner membership, and four weeks of fixtures", async () => {
    const db = testDb();
    const ownerPlayerId = await insertPlayer(db, { name: "Edward" });

    const created = await createGame({ db, values: values(), ownerPlayerId, now });

    const [game] = await db.select().from(games).where(eq(games.id, created.gameId));
    expect(game?.name).toBe("Thursday 7-a-side");
    expect(game?.recurrenceRule).toBe("FREQ=WEEKLY;INTERVAL=1;BYDAY=TH");

    const [membership] = await db.select().from(memberships).where(eq(memberships.gameId, created.gameId));
    expect(membership?.playerId).toBe(ownerPlayerId);
    expect(membership?.role).toBe("owner");
    expect(membership?.active).toBe(true);

    // J1's "no further action needed" is only true if they are already there.
    const rows = await db.select().from(fixtures).where(eq(fixtures.gameId, created.gameId));
    expect(rows.length).toBeGreaterThanOrEqual(4);
    expect(created.fixturesCreated).toBe(rows.length);
  });

  it("anchors the recurrence to today in the game's own timezone", async () => {
    const db = testDb();
    const ownerPlayerId = await insertPlayer(db);

    const created = await createGame({ db, values: values(), ownerPlayerId, now });

    const [game] = await db.select().from(games).where(eq(games.id, created.gameId));
    expect(game?.recurrenceStartDate).toBe("2026-08-12");
  });

  it("mints an unguessable invite token", async () => {
    const db = testDb();
    const ownerPlayerId = await insertPlayer(db);

    const first = await createGame({ db, values: values(), ownerPlayerId, now });
    const second = await createGame({ db, values: values(), ownerPlayerId, now });

    expect(first.inviteToken).not.toBe(second.inviteToken);
    expect(first.inviteToken).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("records the creation in audit_log (BR-27)", async () => {
    const db = testDb();
    const ownerPlayerId = await insertPlayer(db);

    const created = await createGame({ db, values: values(), ownerPlayerId, now });

    const [row] = await db.select().from(auditLog).where(eq(auditLog.entityId, created.gameId));
    expect(row?.action).toBe("game.created");
    expect(row?.actorPlayerId).toBe(ownerPlayerId);
  });
});
```

- [ ] **Step 2: Add the test factories this needs**

In `test/support/factories.ts`, add alongside the existing builders:

```typescript
import { memberships, players } from "../../src/db/schema.js";

export type PlayerInsert = typeof players.$inferInsert;

/** A plausible player row. Pass `email: null, isGuest: true` for a guest. */
export function playerRow(overrides: Partial<PlayerInsert> = {}): PlayerInsert {
  return {
    id: crypto.randomUUID(),
    name: "Edward Charles",
    email: `player-${crypto.randomUUID()}@example.com`,
    ...overrides,
  };
}

export async function insertPlayer(db: Db, overrides: Partial<PlayerInsert> = {}): Promise<string> {
  const row = playerRow(overrides);
  await db.insert(players).values(row);
  return row.id;
}

/** Put a player in a squad. Defaults to an active ordinary member. */
export async function insertMembership(
  db: Db,
  gameId: string,
  playerId: string,
  overrides: Partial<typeof memberships.$inferInsert> = {},
): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(memberships).values({ id, gameId, playerId, ...overrides });
  return id;
}
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run test/domain/create-game.test.ts`
Expected: FAIL — `src/domain/create-game.js` not found.

- [ ] **Step 4: Implement `src/domain/create-game.ts`**

```typescript
import { eq } from "drizzle-orm";
import { buildAuditInsert } from "../db/audit.js";
import type { Db } from "../db/client.js";
import { games, memberships } from "../db/schema.js";
import type { GameFormValues } from "./game-form.js";
import { localDateToday } from "./game-form.js";
import { materialiseGame } from "./materialise.js";

export interface CreateGameParams {
  db: Db;
  values: GameFormValues;
  /** The signed-in person creating it. They become the first Owner. */
  ownerPlayerId: string;
  now: Date;
}

export interface CreatedGame {
  gameId: string;
  inviteToken: string;
  fixturesCreated: number;
}

/**
 * Create a game, make its creator an Owner, and materialise its first four
 * weeks of fixtures (J1).
 *
 * **Materialising here rather than leaving it to the daily cron** is
 * deliberate: J1 promises "no further action needed — fixtures generate
 * themselves", and a game whose fixture list is empty for up to a day reads as
 * broken on the page the owner lands on immediately after creating it.
 *
 * `recurrence_start_date` is today's date *in the game's own timezone*, not
 * UTC and not the creator's. It anchors an INTERVAL=2 recurrence, which is
 * undefined without one (§2.8) — "every other Thursday" has no meaning until
 * you know which Thursday the fortnight counts from.
 *
 * The game row, the membership and the audit row go in one `db.batch()` —
 * D1's only atomicity primitive. Materialisation follows *outside* it, because
 * it needs the committed game row to expand and because it is idempotent by
 * way of the `(game_id, kicks_off_at)` unique index: if it fails, the game
 * exists with no fixtures and the next daily sweep fills them in, which is a
 * recoverable state. The reverse order would not be.
 */
export async function createGame(params: CreateGameParams): Promise<CreatedGame> {
  const { db, values, ownerPlayerId, now } = params;

  const gameId = crypto.randomUUID();
  const inviteToken = crypto.randomUUID();

  await db.batch([
    db.insert(games).values({
      id: gameId,
      ...values,
      recurrenceStartDate: localDateToday(now, values.timezone),
      inviteToken,
      active: true,
      createdAt: now,
    }),
    db.insert(memberships).values({
      id: crypto.randomUUID(),
      gameId,
      playerId: ownerPlayerId,
      role: "owner",
      active: true,
      joinedAt: now,
    }),
    buildAuditInsert(db, {
      actorPlayerId: ownerPlayerId,
      entityType: "game",
      entityId: gameId,
      action: "game.created",
      after: { name: values.name, venueName: values.venueName, recurrenceRule: values.recurrenceRule },
      now,
    }),
  ]);

  const [game] = await db.select().from(games).where(eq(games.id, gameId));
  const fixturesCreated = game ? await materialiseGame(db, game, now) : 0;

  return { gameId, inviteToken, fixturesCreated };
}
```

- [ ] **Step 5: Run the domain test**

Run: `npx vitest run test/domain/create-game.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Add the path constants**

In `src/auth/paths.ts` (the module with no imports, so views and routes can both name a path):

```typescript
/** Owner-facing game management. Mounted behind the session middleware. */
export const GAMES_PREFIX = "/g/*";
export const NEW_GAME_PATH = "/g/new";

export function gamePath(gameId: string): string {
  return `/g/${gameId}`;
}

export function gameEditPath(gameId: string): string {
  return `/g/${gameId}/edit`;
}

/**
 * The public invite link. Outside every authenticated prefix — a visitor
 * holding one has no session and must not need one (BR-26, §1.6 "Visitor").
 */
export function joinPath(token: string): string {
  return `/j/${token}`;
}
```

- [ ] **Step 7: Add the form page styles**

In `src/views/styles.ts`, add a block and enumerate it in `PAGE_STYLE_BLOCKS`
exactly as the existing blocks are. The shared `STYLES` centres content in a
30rem column, which suits sign-in but not a form:

```typescript
/**
 * Forms and owner pages: left-aligned, wider than the shared 30rem column,
 * with real labels above real inputs.
 *
 * The shared `STYLES` block centres `main` and sets `text-align: center`,
 * which is right for the single-purpose pages it was written for and wrong
 * for anything with more than three fields. This overrides both rather than
 * loosening the shared block, so no existing page moves.
 */
export const FORM_CSS = `
  main { max-width: 40rem; text-align: left; }
  h1 { text-align: left; }
  .field { margin: 1.1rem 0; }
  .field label { display: block; font-weight: 600; margin-bottom: 0.3rem; }
  .field input, .field select {
    width: 100%; padding: 0.6rem 0.7rem; font: inherit;
    color: var(--fg); background: var(--bg);
    border: 2px solid var(--line); border-radius: 0.5rem;
  }
  .field input:focus-visible, .field select:focus-visible {
    outline: 3px solid var(--accent); outline-offset: 1px;
  }
  .field .error { display: block; margin-top: 0.3rem; color: var(--warn); font-size: 0.9rem; }
  .field-invalid input, .field-invalid select { border-color: var(--warn); }
  .row { display: flex; gap: 1rem; }
  .row .field { flex: 1; }
  details { margin: 1.5rem 0; border-top: 1px solid var(--line); padding-top: 1rem; }
  summary { cursor: pointer; font-weight: 600; }
  .actions { display: flex; gap: 0.75rem; margin-top: 1.75rem; }
  .qr { margin: 1rem 0; max-width: 240px; }
  .invite-link { display: flex; gap: 0.5rem; align-items: center; }
  .invite-link input { flex: 1; font-family: ui-monospace, monospace; font-size: 0.85rem; }
  .squad { list-style: none; padding: 0; }
  .squad li { padding: 0.5rem 0; border-bottom: 1px solid var(--line); }
`;
```

- [ ] **Step 8: Implement `src/views/game-form.ts`**

```typescript
import type { FieldError } from "../domain/game-form.js";
import { supportedTimezones } from "../domain/game-form.js";
import { WEEKDAYS } from "../domain/recurrence/parse.js";
import { escapeHtml, layout } from "./layout.js";
import { FORM_CSS } from "./styles.js";

const WEEKDAY_LABELS: Record<string, string> = {
  MO: "Monday", TU: "Tuesday", WE: "Wednesday", TH: "Thursday",
  FR: "Friday", SA: "Saturday", SU: "Sunday",
};

export interface GameFormPageParams {
  /** Where the form posts. Always a same-origin relative path (`form-action 'self'`). */
  action: string;
  heading: string;
  submitLabel: string;
  /** Whatever was submitted, so a rejected form redisplays what was typed. */
  values: Partial<Record<string, string>>;
  errors: readonly FieldError[];
  warnings: readonly string[];
  /** The Advanced block appears on edit only — see spec §3.1. */
  showAdvanced: boolean;
  /** "This will update 4 scheduled fixtures…", on edit. */
  affectedNotice?: string;
}

/**
 * The create and edit form. One renderer for both, so the two cannot drift —
 * the same reason `parseGameForm` is shared on the other side.
 *
 * Every rejected submission comes back through here with `values` still
 * populated, so nothing a person typed is ever thrown away. That is why the
 * route answers 422 with this page rather than a bare 400.
 */
export function renderGameFormPage(params: GameFormPageParams): string {
  const { action, heading, submitLabel, values, errors, warnings, showAdvanced, affectedNotice } = params;

  const errorFor = (field: string): string | undefined =>
    errors.find((error) => error.field === field)?.message;

  const value = (field: string, fallback = ""): string => escapeHtml(values[field] ?? fallback);

  const field = (name: string, label: string, input: string): string => {
    const message = errorFor(name);
    return `
      <div class="field${message ? " field-invalid" : ""}">
        <label for="${name}">${escapeHtml(label)}</label>
        ${input}
        ${message ? `<span class="error" id="${name}-error">${escapeHtml(message)}</span>` : ""}
      </div>`;
  };

  const textInput = (name: string, type = "text", extra = ""): string =>
    `<input id="${name}" name="${name}" type="${type}" value="${value(name)}"${
      errorFor(name) ? ` aria-describedby="${name}-error"` : ""
    }${extra}>`;

  const weekdayOptions = WEEKDAYS.map((code) =>
    `<option value="${code}"${values["weekday"] === code ? " selected" : ""}>${WEEKDAY_LABELS[code]}</option>`,
  ).join("");

  const intervalOptions = [
    ["1", "Every week"],
    ["2", "Every 2 weeks"],
  ].map(([code, label]) =>
    `<option value="${code}"${values["interval"] === code ? " selected" : ""}>${label}</option>`,
  ).join("");

  const timezoneOptions = supportedTimezones().map((zone) =>
    `<option value="${escapeHtml(zone)}"${
      (values["timezone"] ?? "Europe/London") === zone ? " selected" : ""
    }>${escapeHtml(zone)}</option>`,
  ).join("");

  const advanced = showAdvanced
    ? `
      <details>
        <summary>Advanced</summary>
        ${field("timezone", "Time zone", `<select id="timezone" name="timezone">${timezoneOptions}</select>`)}
        ${field("venueUrl", "Venue link", textInput("venueUrl", "url"))}
        ${field("reminderDaysBefore", "Send the reminder this many days before", textInput("reminderDaysBefore", "number"))}
        ${field("reminderLocalTime", "Send the reminder at", textInput("reminderLocalTime", "time"))}
        ${field("shortWarningOffsetHours", "Warn owners this many hours before kickoff", textInput("shortWarningOffsetHours", "number"))}
      </details>`
    : "";

  const body = `
    <h1>${escapeHtml(heading)}</h1>
    ${errors.length > 0 ? `<p class="nudge">Some details need another look.</p>` : ""}
    ${warnings.map((warning) => `<p class="nudge">${escapeHtml(warning)}</p>`).join("")}
    ${affectedNotice ? `<p class="nudge">${escapeHtml(affectedNotice)}</p>` : ""}
    <form method="post" action="${escapeHtml(action)}">
      ${field("name", "Game name", textInput("name"))}
      ${field("venueName", "Where you play", textInput("venueName"))}
      ${field("venueAddress", "Address (optional)", textInput("venueAddress"))}
      <div class="row">
        ${field("weekday", "Day", `<select id="weekday" name="weekday">${weekdayOptions}</select>`)}
        ${field("interval", "How often", `<select id="interval" name="interval">${intervalOptions}</select>`)}
      </div>
      <div class="row">
        ${field("kickoffTime", "Kickoff", textInput("kickoffTime", "time"))}
        ${field("durationMinutes", "Minutes", textInput("durationMinutes", "number"))}
      </div>
      <div class="row">
        ${field("minPlayers", "Minimum players", textInput("minPlayers", "number"))}
        ${field("maxPlayers", "Maximum players", textInput("maxPlayers", "number"))}
      </div>
      <div class="field">
        <label for="prefersEvenNumbers">
          <input id="prefersEvenNumbers" name="prefersEvenNumbers" type="checkbox"${
            values["prefersEvenNumbers"] === undefined || values["prefersEvenNumbers"] === "on" ? " checked" : ""
          }>
          Prefer even numbers
        </label>
      </div>
      ${advanced}
      <div class="actions">
        <button class="button primary" type="submit">${escapeHtml(submitLabel)}</button>
      </div>
    </form>
  `;

  return layout({ title: `${heading} — Make The Team`, body, pageStyles: [FORM_CSS] });
}
```

- [ ] **Step 9: Implement `src/routes/games.ts` (create only for now)**

```typescript
import { Hono } from "hono";
import { NEW_GAME_PATH, gamePath } from "../auth/paths.js";
import { requirePlayer } from "../auth/session.js";
import { getDb } from "../db/client.js";
import { createGame } from "../domain/create-game.js";
import { parseGameForm } from "../domain/game-form.js";
import type { AppEnv, Bindings } from "../env.js";
import { renderGameFormPage } from "../views/game-form.js";

export const gamesRoutes = new Hono<AppEnv>();

/** This deployment's own origin, as the state-changing handlers compare it. */
function originOf(env: Bindings): string {
  return new URL(env.BETTER_AUTH_URL).origin;
}

/**
 * Rejects a cross-site form post. Mirrors `POST /dashboard` and `POST
 * /sign-out`: a browser always sends `Origin` on a cross-site form
 * submission, and a missing header is a non-browser client acting on its own
 * behalf, which is allowed.
 */
function wrongOrigin(c: { req: { header: (name: string) => string | undefined }; env: Bindings }): boolean {
  const origin = c.req.header("origin");
  return origin !== undefined && origin !== originOf(c.env);
}

/** Every string field of the submitted body, for redisplaying a rejected form. */
function submittedValues(form: Record<string, unknown>): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(form)) {
    if (typeof value === "string") values[key] = value;
  }
  return values;
}

gamesRoutes.get(NEW_GAME_PATH, requirePlayer, (c) =>
  c.html(
    renderGameFormPage({
      action: NEW_GAME_PATH,
      heading: "Set up a game",
      submitLabel: "Create the game",
      // Sensible starting values, not an empty form — the point is to get an
      // organiser to a shareable link in as few decisions as possible.
      values: { kickoffTime: "19:00", durationMinutes: "60", minPlayers: "10", maxPlayers: "14", weekday: "TH", interval: "1" },
      errors: [],
      warnings: [],
      showAdvanced: false,
    }),
  ),
);

gamesRoutes.post(NEW_GAME_PATH, requirePlayer, async (c) => {
  if (wrongOrigin(c)) return c.text("Forbidden", 403);

  const now = new Date(Date.now());
  const player = c.get("player")!;
  const form = await c.req.parseBody();
  const parsed = parseGameForm(form);

  if (!parsed.ok) {
    // 422, and the page comes back with everything still typed in it. A bare
    // 400 would throw away a form somebody just filled in on a phone.
    return c.html(
      renderGameFormPage({
        action: NEW_GAME_PATH,
        heading: "Set up a game",
        submitLabel: "Create the game",
        values: submittedValues(form),
        errors: parsed.errors,
        warnings: [],
        showAdvanced: false,
      }),
      422,
    );
  }

  const created = await createGame({ db: getDb(c.env.DB), values: parsed.values, ownerPlayerId: player.id, now });

  // 303 so a refresh does not re-post and create a second game.
  return c.redirect(gamePath(created.gameId), 303);
});
```

- [ ] **Step 10: Mount it**

In `src/app.ts`, add the import and both the prefix mount and the route:

```typescript
import { GAMES_PREFIX } from "./auth/paths.js";
import { gamesRoutes } from "./routes/games.js";
```

Add `/g/*` to the authenticated mounts, beside the existing
`AUTHENTICATED_PREFIX` ones — this is the "second mount" `sessionMiddleware`'s
comment anticipates:

```typescript
  // Owner game management. A third session mount, for the same reason
  // `/sign-in` is the second: `/g/*` needs a session and sits outside
  // `AUTHENTICATED_PREFIX`. The `no-store` header applies for the same reason
  // it does there — these pages show a squad's data.
  app.use(GAMES_PREFIX, sessionMiddleware);
  app.use(GAMES_PREFIX, async (c, next) => {
    await next();
    c.header("Cache-Control", "private, no-store");
  });
```

and register the routes: `app.route("/", gamesRoutes);`

- [ ] **Step 11: Write the route test**

`test/routes/games.test.ts`:

```typescript
import { SELF } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { games } from "../../src/db/schema.js";
import { resetDatabase, testDb } from "../support/factories.js";
import { ORIGIN, signIn } from "../support/sign-in.js";

async function post(path: string, cookie: string, fields: Record<string, string>) {
  return SELF.fetch(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, cookie },
    body: new URLSearchParams(fields),
    redirect: "manual",
  });
}

const VALID = {
  name: "Thursday 7-a-side",
  venueName: "Oxford Sports Park",
  weekday: "TH",
  interval: "1",
  kickoffTime: "19:00",
  durationMinutes: "60",
  minPlayers: "10",
  maxPlayers: "14",
  prefersEvenNumbers: "on",
};

describe("GET /g/new", () => {
  beforeEach(resetDatabase);

  it("redirects an anonymous visitor to sign in", async () => {
    const response = await SELF.fetch(`${ORIGIN}/g/new`, { redirect: "manual" });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/sign-in");
  });

  it("renders the form for a signed-in player", async () => {
    const { cookie } = await signIn();
    const response = await SELF.fetch(`${ORIGIN}/g/new`, { headers: { cookie } });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Set up a game");
  });
});

describe("POST /g/new", () => {
  beforeEach(resetDatabase);

  it("creates the game and redirects to it", async () => {
    const { cookie } = await signIn();
    const response = await post("/g/new", cookie, VALID);

    expect(response.status).toBe(303);
    const location = response.headers.get("location")!;
    expect(location).toMatch(/^\/g\/[0-9a-f-]{36}$/);

    const [game] = await testDb().select().from(games);
    expect(game?.name).toBe("Thursday 7-a-side");
    expect(location).toBe(`/g/${game!.id}`);
  });

  it("redisplays the form with the submitted values on a bad submission", async () => {
    const { cookie } = await signIn();
    const response = await post("/g/new", cookie, { ...VALID, minPlayers: "20", name: "Keep me" });

    expect(response.status).toBe(422);
    const html = await response.text();
    // Nothing typed is thrown away.
    expect(html).toContain('value="Keep me"');
    expect(html).toContain("The minimum can't be higher than the maximum.");
    expect(await testDb().select().from(games)).toHaveLength(0);
  });

  it("shows the odd-max warning without refusing the game", async () => {
    const { cookie } = await signIn();
    const response = await post("/g/new", cookie, { ...VALID, maxPlayers: "13" });
    expect(response.status).toBe(303);
  });

  it("refuses a cross-site form post", async () => {
    const { cookie } = await signIn();
    const response = await SELF.fetch(`${ORIGIN}/g/new`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example", cookie },
      body: new URLSearchParams(VALID),
      redirect: "manual",
    });
    expect(response.status).toBe(403);
    expect(await testDb().select().from(games)).toHaveLength(0);
  });

  it("refuses an anonymous post", async () => {
    const response = await SELF.fetch(`${ORIGIN}/g/new`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN },
      body: new URLSearchParams(VALID),
      redirect: "manual",
    });
    expect(response.status).toBe(302);
    expect(await testDb().select().from(games)).toHaveLength(0);
  });
});
```

- [ ] **Step 12: Run the route tests**

Run: `npx vitest run test/routes/games.test.ts`
Expected: PASS. The `/g/:id` redirect target does not exist yet and will 404 if
followed — these tests use `redirect: "manual"` and never follow it.

- [ ] **Step 13: Run the gate and commit**

```bash
npm run lint && npm run typecheck && npm test
git add src/ test/
git commit -m "feat: create a game (J1)

Materialises four weeks of fixtures immediately rather than waiting
for the daily cron: J1 promises fixtures generate themselves, and an
empty list on the page the owner lands on reads as broken.

A rejected form comes back 422 with every value still in it."
```

---

## Task 7: The game overview page, invite link and copy button

**Files:**
- Create: `src/views/game-overview.ts`
- Modify: `src/routes/games.ts`, `src/views/scripts.ts`, `src/db/queries.ts`
- Test: `test/routes/games.test.ts`, `test/views/scripts.test.ts`

**Interfaces:**
- Consumes: `qrSvg` (Task 4); `redactName` (Task 2); `gameEditPath`, `joinPath` (Task 6); `SITE_ORIGIN` (`src/notify/delivery.ts`).
- Produces:

```typescript
// src/db/queries.ts
export interface OwnedGame { game: typeof games.$inferSelect; }
export function findGameForOwner(db: Db, gameId: string, playerId: string): Promise<typeof games.$inferSelect | null>;
export function listSquad(db: Db, gameId: string): Promise<Array<{ playerId: string; name: string; role: "player" | "owner"; isGuest: boolean }>>;
export function listUpcomingFixtures(db: Db, gameId: string, now: Date): Promise<Array<{ id: string; kicksOffAt: Date; lifecycle: string; inCount: number }>>;

// src/views/scripts.ts
export const COPY_INVITE_JS: string;   // added to PAGE_SCRIPT_BLOCKS
```

- [ ] **Step 1: Write the failing entitlement tests**

Add to `test/routes/games.test.ts`:

```typescript
describe("GET /g/:id — entitlement (TR-18)", () => {
  beforeEach(resetDatabase);

  /** Creates a game owned by the signed-in player, returning its id and cookie. */
  async function ownedGame() {
    const { cookie } = await signIn();
    const response = await post("/g/new", cookie, VALID);
    const gameId = response.headers.get("location")!.replace("/g/", "");
    return { cookie, gameId };
  }

  it("shows the owner their game", async () => {
    const { cookie, gameId } = await ownedGame();
    const response = await SELF.fetch(`${ORIGIN}/g/${gameId}`, { headers: { cookie } });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Thursday 7-a-side");
  });

  it("404s for a signed-in player who is not a member", async () => {
    // The viewer signs in and owns their own game; this asks for somebody
    // else's, which they hold no membership row for at all. Testing it this
    // way round needs no second sign-in identity — `SELF.fetch` uses the
    // deployed bindings verbatim and cannot take a per-request allowlist.
    const { cookie } = await ownedGame();
    const db = testDb();
    const strangerId = await insertPlayer(db, { name: "Stranger" });
    const otherGameId = await insertGame(db);
    await insertMembership(db, otherGameId, strangerId, { role: "owner" });

    const response = await SELF.fetch(`${ORIGIN}/g/${otherGameId}`, { headers: { cookie }, redirect: "manual" });

    // 404, never 403 — a 403 would confirm the id names a real game.
    expect(response.status).toBe(404);
  });

  it("404s for a member who is not an owner", async () => {
    const { cookie, gameId } = await ownedGame();
    const db = testDb();
    // Demote the only owner: the same person, no longer entitled.
    await db.update(memberships).set({ role: "player" }).where(eq(memberships.gameId, gameId));

    const response = await SELF.fetch(`${ORIGIN}/g/${gameId}`, { headers: { cookie }, redirect: "manual" });
    expect(response.status).toBe(404);
  });

  it("404s for an owner whose membership has been deactivated", async () => {
    const { cookie, gameId } = await ownedGame();
    await testDb().update(memberships).set({ active: false }).where(eq(memberships.gameId, gameId));

    const response = await SELF.fetch(`${ORIGIN}/g/${gameId}`, { headers: { cookie }, redirect: "manual" });
    expect(response.status).toBe(404);
  });

  it("404s for a game id that does not exist", async () => {
    const { cookie } = await ownedGame();
    const response = await SELF.fetch(`${ORIGIN}/g/${crypto.randomUUID()}`, { headers: { cookie }, redirect: "manual" });
    expect(response.status).toBe(404);
  });
});
```

**No second sign-in identity is needed.** `test/support/sign-in.ts` signs in as
the single allowlisted address, and `SELF.fetch` uses the deployed bindings
verbatim so a per-request `SIGNIN_ALLOWLIST` override is not available to it.
Every case above is instead expressed as *the same viewer, differently
entitled* — a game they hold no membership for, a membership demoted to
`player`, a membership deactivated. That covers all four `findGameForOwner`
null branches without a second identity, and keeps these tests on `SELF.fetch`
like every other route test in the repo (TR-29).

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/routes/games.test.ts`
Expected: FAIL — `GET /g/:id` is not registered, so every case 404s including
the owner's, which is the one that must pass.

- [ ] **Step 3: Add the queries**

In `src/db/queries.ts`:

```typescript
/**
 * The game, if and only if this player is an active Owner of it (TR-18).
 *
 * Returns `null` for "no such game", "not a member", "a member but not an
 * owner" and "an owner whose membership was deactivated" alike — the caller
 * answers 404 for all four, so a game id cannot be probed for existence and a
 * demoted owner learns nothing from the difference.
 *
 * This is the entitlement check for every `/g/:id` route. Middleware cannot do
 * it: which row to check depends on which row the handler is about.
 */
export async function findGameForOwner(
  db: Db,
  gameId: string,
  playerId: string,
): Promise<typeof games.$inferSelect | null> {
  const [row] = await db
    .select({ game: games })
    .from(games)
    .innerJoin(memberships, eq(memberships.gameId, games.id))
    .where(
      and(
        eq(games.id, gameId),
        eq(games.active, true),
        eq(memberships.playerId, playerId),
        eq(memberships.role, "owner"),
        eq(memberships.active, true),
      ),
    )
    .limit(1);
  return row?.game ?? null;
}

/** Active squad members, owners first then alphabetical. */
export async function listSquad(
  db: Db,
  gameId: string,
): Promise<Array<{ playerId: string; name: string; role: "player" | "owner"; isGuest: boolean }>> {
  return db
    .select({
      playerId: players.id,
      name: players.name,
      role: memberships.role,
      isGuest: players.isGuest,
    })
    .from(memberships)
    .innerJoin(players, eq(players.id, memberships.playerId))
    .where(and(eq(memberships.gameId, gameId), eq(memberships.active, true)))
    .orderBy(desc(memberships.role), players.name);
}

/** Non-terminal fixtures from `now` onward, soonest first. */
export async function listUpcomingFixtures(
  db: Db,
  gameId: string,
  now: Date,
): Promise<Array<{ id: string; kicksOffAt: Date; lifecycle: string; inCount: number }>> {
  return db
    .select({
      id: fixtures.id,
      kicksOffAt: fixtures.kicksOffAt,
      lifecycle: fixtures.lifecycle,
      inCount: fixtures.inCount,
    })
    .from(fixtures)
    .where(and(eq(fixtures.gameId, gameId), gte(fixtures.kicksOffAt, now)))
    .orderBy(fixtures.kicksOffAt);
}
```

Add whatever imports (`and`, `desc`, `gte`, `players`, `memberships`,
`fixtures`, `games`) the file does not already have.

- [ ] **Step 4: Add the copy-invite script**

In `src/views/scripts.ts`, after `PASSKEY_REGISTER_JS`:

```typescript
/**
 * Copy the invite link to the clipboard, from `/g/:id`.
 *
 * The first script in this project that is pure convenience rather than a
 * browser-only capability, and it earns its place on the terms the module
 * comment sets: the page is complete without it. The link renders in a
 * `readonly` input that can be selected and copied by hand, and this only
 * adds a button beside it. Scripting off, or an old browser without
 * `navigator.clipboard`, is the same page minus one button.
 *
 * No `fetch`, so it adds nothing to `connect-src`. If a future version of this
 * block ever does talk to the network, re-read the "a hash lets a script run"
 * section above first.
 */
export const COPY_INVITE_JS = `
(function () {
  var input = document.getElementById("invite-url");
  var button = document.getElementById("invite-copy");
  if (!input || !button) return;
  if (!navigator.clipboard || typeof navigator.clipboard.writeText !== "function") return;

  button.hidden = false;

  button.addEventListener("click", function () {
    navigator.clipboard.writeText(input.value).then(function () {
      var original = button.textContent;
      button.textContent = "Copied";
      setTimeout(function () { button.textContent = original; }, 2000);
    }).catch(function () {
      // The input is still there and still selectable — say so rather than
      // failing silently, which is the diagnosability lesson from the passkey
      // scripts' bare .catch() (docs/known-issues.md).
      button.textContent = "Press and hold to copy";
    });
  });
})();
`;
```

Add it to `PAGE_SCRIPT_BLOCKS`:

```typescript
export const PAGE_SCRIPT_BLOCKS = [PASSKEY_SIGN_IN_JS, PASSKEY_REGISTER_JS, COPY_INVITE_JS] as const;
```

- [ ] **Step 5: Implement `src/views/game-overview.ts`**

```typescript
import { gameEditPath, joinPath } from "../auth/paths.js";
import { redactName } from "../domain/redact-name.js";
import { formatLocalDateTime } from "../domain/time/zone.js";
import { SITE_ORIGIN } from "../notify/delivery.js";
import { escapeHtml, layout } from "./layout.js";
import { qrSvg } from "./qr.js";
import { COPY_INVITE_JS } from "./scripts.js";
import { FORM_CSS } from "./styles.js";

export interface GameOverviewParams {
  gameId: string;
  gameName: string;
  venueName: string;
  timezone: string;
  inviteToken: string;
  squad: ReadonlyArray<{ name: string; role: "player" | "owner"; isGuest: boolean }>;
  upcoming: ReadonlyArray<{ id: string; kicksOffAt: Date; lifecycle: string; inCount: number }>;
}

/**
 * The owner's home for one game: how to share it, who is in the squad, and
 * what is coming up.
 *
 * The squad list shows full names — this page is behind an owner entitlement
 * check, and an owner already knows who is in their own squad. BR-26's
 * redaction applies to the *public* invite page (`src/views/join.ts`), which
 * strangers can reach.
 */
export function renderGameOverviewPage(params: GameOverviewParams): string {
  const { gameId, gameName, venueName, timezone, inviteToken, squad, upcoming } = params;
  const inviteUrl = `${SITE_ORIGIN}${joinPath(inviteToken)}`;

  const squadItems = squad
    .map((member) =>
      `<li>${escapeHtml(member.name)}${member.role === "owner" ? " — organiser" : ""}${
        member.isGuest ? " (guest)" : ""
      }</li>`,
    )
    .join("");

  const fixtureItems = upcoming
    .map((fixture) =>
      `<li>${escapeHtml(formatLocalDateTime(fixture.kicksOffAt, timezone))} — ${escapeHtml(fixture.lifecycle)}, ${fixture.inCount} in</li>`,
    )
    .join("");

  const body = `
    <h1>${escapeHtml(gameName)}</h1>
    <p>${escapeHtml(venueName)}</p>
    <p><a href="${escapeHtml(gameEditPath(gameId))}">Edit this game</a></p>

    <h2>Invite people</h2>
    <p>Share this link in your group chat, or let people scan the code.</p>
    <div class="invite-link">
      <input id="invite-url" type="text" readonly value="${escapeHtml(inviteUrl)}">
      <button class="button" type="button" id="invite-copy" hidden>Copy</button>
    </div>
    <div class="qr">${qrSvg(inviteUrl)}</div>
    <form method="post" action="${escapeHtml(`/g/${gameId}/invite/rotate`)}">
      <button class="button" type="submit">Replace this link</button>
    </form>

    <h2>Squad (${squad.length})</h2>
    <ul class="squad">${squadItems || "<li>Nobody has joined yet.</li>"}</ul>

    <h2>Coming up</h2>
    <ul class="squad">${fixtureItems || "<li>No fixtures scheduled.</li>"}</ul>
  `;

  return layout({
    title: `${gameName} — Make The Team`,
    body,
    pageStyles: [FORM_CSS],
    pageScripts: [COPY_INVITE_JS],
  });
}
```

- [ ] **Step 6: Add the route**

In `src/routes/games.ts`:

```typescript
gamesRoutes.get("/g/:id", requirePlayer, async (c) => {
  const now = new Date(Date.now());
  const db = getDb(c.env.DB);
  const player = c.get("player")!;

  // The entitlement re-check (TR-18). `requirePlayer` established who; this
  // establishes whether. 404 rather than 403 for every failure mode, so a
  // game id cannot be probed.
  const game = await findGameForOwner(db, c.req.param("id"), player.id);
  if (game === null) return c.text("Not found", 404);

  const [squad, upcoming] = await Promise.all([
    listSquad(db, game.id),
    listUpcomingFixtures(db, game.id, now),
  ]);

  return c.html(
    renderGameOverviewPage({
      gameId: game.id,
      gameName: game.name,
      venueName: game.venueName,
      timezone: game.timezone,
      inviteToken: game.inviteToken,
      squad,
      upcoming,
    }),
  );
});
```

Register `/g/new` **before** `/g/:id` in the file, or Hono will match `new` as
an id. Verify by reading the file top to bottom after the edit.

- [ ] **Step 7: Add the invite-rotation route**

```typescript
gamesRoutes.post("/g/:id/invite/rotate", requirePlayer, async (c) => {
  if (wrongOrigin(c)) return c.text("Forbidden", 403);

  const now = new Date(Date.now());
  const db = getDb(c.env.DB);
  const player = c.get("player")!;

  const game = await findGameForOwner(db, c.req.param("id"), player.id);
  if (game === null) return c.text("Not found", 404);

  const inviteToken = crypto.randomUUID();
  await db.batch([
    db.update(games).set({ inviteToken }).where(eq(games.id, game.id)),
    buildAuditInsert(db, {
      actorPlayerId: player.id,
      entityType: "game",
      entityId: game.id,
      action: "game.invite_rotated",
      // Never the old token itself: audit_log is read by people and a live
      // credential should not sit in it. The fact of the change is the point.
      before: { rotated: true },
      now,
    }),
  ]);

  return c.redirect(gamePath(game.id), 303);
});
```

- [ ] **Step 8: Test the invite link, QR, and rotation**

Add to `test/routes/games.test.ts`:

```typescript
describe("the invite link on /g/:id", () => {
  beforeEach(resetDatabase);

  it("shows the absolute invite URL and an inline QR code", async () => {
    const { cookie, gameId } = await ownedGame();
    const [game] = await testDb().select().from(games).where(eq(games.id, gameId));

    const html = await (await SELF.fetch(`${ORIGIN}/g/${gameId}`, { headers: { cookie } })).text();

    expect(html).toContain(`https://makethe.team/j/${game!.inviteToken}`);
    expect(html).toContain("<svg");
    // Inline, never fetched — the CSP has no img-src (spec §4.2).
    expect(html).not.toContain("<img");
  });

  it("replaces the token on rotation and dead-links the old one", async () => {
    const { cookie, gameId } = await ownedGame();
    const db = testDb();
    const before = (await db.select().from(games).where(eq(games.id, gameId)))[0]!.inviteToken;

    const response = await post(`/g/${gameId}/invite/rotate`, cookie, {});
    expect(response.status).toBe(303);

    const after = (await db.select().from(games).where(eq(games.id, gameId)))[0]!.inviteToken;
    expect(after).not.toBe(before);

    const [audit] = await db.select().from(auditLog).where(eq(auditLog.action, "game.invite_rotated"));
    expect(audit?.actorPlayerId).not.toBeNull();
    // The old token must not be recoverable from the audit trail.
    expect(JSON.stringify(audit)).not.toContain(before);
  });

  it("404s a rotation attempt by a non-owner", async () => {
    const { gameId } = await ownedGame();
    await testDb().update(memberships).set({ role: "player" }).where(eq(memberships.gameId, gameId));
    const { cookie } = await signIn();

    const response = await post(`/g/${gameId}/invite/rotate`, cookie, {});
    expect(response.status).toBe(404);
  });
});
```

- [ ] **Step 9: Run the gate and commit**

```bash
npm run lint && npm run typecheck && npm test
git add src/ test/
git commit -m "feat: the owner game page, invite link, QR and rotation

Entitlement is re-checked in the handler and every failure mode
answers 404, so a game id cannot be probed for existence.

The copy button is the first script here that is convenience rather
than capability. The readonly input renders regardless; no JS means
one fewer button, not a broken page."
```

---

## Task 8: Editing a game, and propagation to scheduled fixtures

**Files:**
- Create: `src/domain/update-game.ts`
- Modify: `src/routes/games.ts`, `src/db/queries.ts`
- Test: `test/domain/update-game.test.ts`, `test/routes/games.test.ts`

**Interfaces:**
- Consumes: `fixtureRowsFor` (Task 5); `parseGameForm`, `GameFormValues` (Task 3); `findGameForOwner` (Task 7).
- Produces:

```typescript
export interface UpdateGameParams { db: Db; game: typeof games.$inferSelect; values: GameFormValues; actorPlayerId: string; now: Date; }
export interface UpdateGameResult { scheduledRewritten: number; untouched: number; }
export function updateGame(params: UpdateGameParams): Promise<UpdateGameResult>;
export function countFixturesByPropagation(db: Db, gameId: string, now: Date): Promise<{ scheduled: number; untouched: number }>;
```

- [ ] **Step 1: Write the failing test**

`test/domain/update-game.test.ts`:

```typescript
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { fixtures, games } from "../../src/db/schema.js";
import { parseGameForm } from "../../src/domain/game-form.js";
import { materialiseGame } from "../../src/domain/materialise.js";
import { updateGame } from "../../src/domain/update-game.js";
import { insertGame, insertPlayer, resetDatabase, testDb } from "../support/factories.js";

const NOW = new Date(Date.UTC(2026, 7, 12, 9, 0));

function values(overrides: Record<string, string> = {}) {
  const result = parseGameForm({
    name: "Thursday 7-a-side",
    venueName: "Oxford Sports Park",
    weekday: "TH",
    interval: "1",
    kickoffTime: "19:00",
    durationMinutes: "60",
    minPlayers: "10",
    maxPlayers: "14",
    prefersEvenNumbers: "on",
    ...overrides,
  });
  if (!result.ok) throw new Error(`invalid fixture values: ${JSON.stringify(result.errors)}`);
  return result.values;
}

async function seed() {
  const db = testDb();
  const gameId = await insertGame(db, { recurrenceStartDate: "2026-08-13" });
  const [game] = await db.select().from(games).where(eq(games.id, gameId));
  await materialiseGame(db, game!, NOW);
  const actorPlayerId = await insertPlayer(db);
  return { db, game: game!, actorPlayerId };
}

describe("updateGame", () => {
  beforeEach(resetDatabase);

  it("rewrites scheduled fixtures with the new kickoff time", async () => {
    const { db, game, actorPlayerId } = await seed();

    await updateGame({ db, game, values: values({ kickoffTime: "20:30" }), actorPlayerId, now: NOW });

    const rows = await db.select().from(fixtures).where(eq(fixtures.gameId, game.id));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      // 20:30 Europe/London in August is 19:30 UTC.
      expect(row.kicksOffAt.getUTCHours()).toBe(19);
      expect(row.kicksOffAt.getUTCMinutes()).toBe(30);
    }
  });

  it("copies the new min, max, parity and duration onto scheduled fixtures", async () => {
    const { db, game, actorPlayerId } = await seed();

    await updateGame({
      db,
      game,
      values: values({ minPlayers: "8", maxPlayers: "12", durationMinutes: "90", prefersEvenNumbers: "" }),
      actorPlayerId,
      now: NOW,
    });

    const rows = await db.select().from(fixtures).where(eq(fixtures.gameId, game.id));
    for (const row of rows) {
      expect(row.minPlayers).toBe(8);
      expect(row.maxPlayers).toBe(12);
      expect(row.durationMinutes).toBe(90);
      expect(row.prefersEvenNumbers).toBe(false);
    }
  });

  it("never touches an open, played or cancelled fixture", async () => {
    const { db, game, actorPlayerId } = await seed();
    const existing = await db.select().from(fixtures).where(eq(fixtures.gameId, game.id));
    const [first, second, third] = existing;

    await db.update(fixtures).set({ lifecycle: "open" }).where(eq(fixtures.id, first!.id));
    await db.update(fixtures).set({ lifecycle: "played" }).where(eq(fixtures.id, second!.id));
    await db.update(fixtures).set({ lifecycle: "cancelled" }).where(eq(fixtures.id, third!.id));

    const result = await updateGame({
      db, game, values: values({ kickoffTime: "20:30", maxPlayers: "20" }), actorPlayerId, now: NOW,
    });

    // The three non-scheduled rows survive untouched — people have already
    // been emailed about them (spec §3.3).
    for (const id of [first!.id, second!.id, third!.id]) {
      const [row] = await db.select().from(fixtures).where(eq(fixtures.id, id));
      expect(row?.maxPlayers).toBe(14);
      expect(row?.kicksOffAt.getTime()).toBe(existing.find((f) => f.id === id)!.kicksOffAt.getTime());
    }
    expect(result.untouched).toBe(3);
  });

  it("does not violate the (game_id, kicks_off_at) unique index when times shift onto each other", async () => {
    // Shifting every fixture by exactly one week moves each onto the slot the
    // next one occupied. An in-place update would collide; delete-then-insert
    // does not (spec §3.3).
    const { db, game, actorPlayerId } = await seed();

    await expect(
      updateGame({ db, game, values: values({ weekday: "FR" }), actorPlayerId, now: NOW }),
    ).resolves.toBeDefined();

    const rows = await db.select().from(fixtures).where(eq(fixtures.gameId, game.id));
    const times = rows.map((row) => row.kicksOffAt.getTime());
    expect(new Set(times).size).toBe(times.length);
  });

  it("re-derives kickoffs correctly across a DST boundary", async () => {
    const db = testDb();
    const gameId = await insertGame(db, { recurrenceStartDate: "2026-10-20", kickoffTime: "19:00" });
    const [game] = await db.select().from(games).where(eq(games.id, gameId));
    const now = new Date(Date.UTC(2026, 9, 20, 9, 0));
    await materialiseGame(db, game!, now);
    const actorPlayerId = await insertPlayer(db);

    await updateGame({ db, game: game!, values: values({ kickoffTime: "19:00" }), actorPlayerId, now });

    const rows = await db.select().from(fixtures).where(eq(fixtures.gameId, gameId));
    // BST before the last Sunday in October, GMT after — 19:00 local either
    // way, which is 18:00Z then 19:00Z.
    const hours = new Set(rows.map((row) => row.kicksOffAt.getUTCHours()));
    expect(hours.size).toBeGreaterThan(1);
  });

  it("records the change in audit_log", async () => {
    const { db, game, actorPlayerId } = await seed();
    await updateGame({ db, game, values: values({ name: "Friday 7-a-side" }), actorPlayerId, now: NOW });

    const [row] = await db.select().from(auditLog).where(eq(auditLog.action, "game.updated"));
    expect(row?.actorPlayerId).toBe(actorPlayerId);
    expect(row?.beforeJson).toContain("Thursday 7-a-side");
    expect(row?.afterJson).toContain("Friday 7-a-side");
  });

  it("re-anchors the recurrence when the day or interval changes", async () => {
    const { db, game, actorPlayerId } = await seed();
    await updateGame({ db, game, values: values({ weekday: "MO", interval: "2" }), actorPlayerId, now: NOW });

    const [updated] = await db.select().from(games).where(eq(games.id, game.id));
    // A fortnightly pattern counted from a stale anchor lands on the wrong week.
    expect(updated?.recurrenceStartDate).toBe("2026-08-12");
  });

  it("keeps the anchor when the pattern is unchanged", async () => {
    const { db, game, actorPlayerId } = await seed();
    await updateGame({ db, game, values: values({ kickoffTime: "20:00" }), actorPlayerId, now: NOW });

    const [updated] = await db.select().from(games).where(eq(games.id, game.id));
    expect(updated?.recurrenceStartDate).toBe("2026-08-13");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/domain/update-game.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/domain/update-game.ts`**

```typescript
import { and, count, eq, gte, ne } from "drizzle-orm";
import { buildAuditInsert } from "../db/audit.js";
import { chunk, INSERT_CHUNK_SIZE } from "../db/chunk.js";
import type { Db } from "../db/client.js";
import { fixtures, games } from "../db/schema.js";
import type { GameFormValues } from "./game-form.js";
import { localDateToday } from "./game-form.js";
import { fixtureRowsFor, MATERIALISATION_HORIZON_DAYS } from "./materialise.js";

const DAY_MS = 86_400_000;

export interface UpdateGameParams {
  db: Db;
  game: typeof games.$inferSelect;
  values: GameFormValues;
  actorPlayerId: string;
  now: Date;
}

export interface UpdateGameResult {
  /** Scheduled fixtures deleted and rebuilt. */
  scheduledRewritten: number;
  /** Open, played and cancelled fixtures left exactly as they were. */
  untouched: number;
}

/**
 * Save a game's settings and propagate them to its future fixtures (spec §3.3).
 *
 * **What propagates, and why the line is where it is.** §2.8 copies five
 * columns onto each fixture at materialisation "so changing the Game later
 * doesn't rewrite history". Read literally that would freeze a `scheduled`
 * fixture four weeks out, which is not what an owner means when they correct a
 * kickoff time. The line this function draws instead is *has anyone been told
 * about this fixture yet*: `open` means the reminder has been sent (BR-11), so
 * its terms are in somebody's inbox and are genuinely history. `scheduled`
 * means nobody has heard anything, so there is nothing to preserve.
 *
 * **Delete and re-materialise, not update in place.** Re-deriving kickoff
 * instants moves rows onto new `kicks_off_at` values, and a game shifted by a
 * week moves every fixture onto the slot its neighbour held — which the
 * `(game_id, kicks_off_at)` unique index refuses. Deleting the whole
 * `scheduled` set first sidesteps that entirely.
 *
 * This is safe *only* for `scheduled` fixtures, and that is a second
 * independent reason the others are excluded: a `scheduled` fixture has no
 * `responses` and no `notification_log` rows — both are written when it opens
 * — so nothing holds a foreign key to the ids being deleted. Deleting an
 * `open` fixture this way would orphan real data.
 *
 * Everything is one `db.batch()`: D1 has no interactive transactions, so this
 * is the only way the delete and the re-insert cannot half-happen.
 */
export async function updateGame(params: UpdateGameParams): Promise<UpdateGameResult> {
  const { db, game, values, actorPlayerId, now } = params;

  // Re-anchor only when the *pattern* moves. A fortnightly game keeps counting
  // from its original anchor when only the kickoff time changes; if the day or
  // the interval changes, the old anchor names a week that no longer means
  // anything and "every other Monday" would start on the wrong one.
  const patternChanged = values.recurrenceRule !== game.recurrenceRule;
  const recurrenceStartDate = patternChanged
    ? localDateToday(now, values.timezone)
    : game.recurrenceStartDate;

  const updated = { ...game, ...values, recurrenceStartDate };

  const horizon = new Date(now.getTime() + MATERIALISATION_HORIZON_DAYS * DAY_MS);
  const rows = fixtureRowsFor(updated, now, horizon);

  const scheduledBefore = await db
    .select({ value: count() })
    .from(fixtures)
    .where(and(eq(fixtures.gameId, game.id), eq(fixtures.lifecycle, "scheduled")));

  const untouched = await db
    .select({ value: count() })
    .from(fixtures)
    .where(and(eq(fixtures.gameId, game.id), ne(fixtures.lifecycle, "scheduled")));

  const statements = [
    db.update(games).set({ ...values, recurrenceStartDate }).where(eq(games.id, game.id)),
    // Scoped to this game *and* to `scheduled`. Both halves are load-bearing.
    db.delete(fixtures).where(and(eq(fixtures.gameId, game.id), eq(fixtures.lifecycle, "scheduled"))),
    ...chunk(rows, INSERT_CHUNK_SIZE).map((batch) =>
      // `onConflictDoNothing` because a re-derived instant can collide with a
      // surviving `open` fixture at the same moment — the open one wins, since
      // it is the one people were emailed about.
      db.insert(fixtures).values(batch).onConflictDoNothing(),
    ),
    buildAuditInsert(db, {
      actorPlayerId,
      entityType: "game",
      entityId: game.id,
      action: "game.updated",
      before: auditShape(game),
      after: auditShape(updated),
      now,
    }),
  ];

  await db.batch(statements as [typeof statements[number], ...typeof statements]);

  return {
    scheduledRewritten: scheduledBefore[0]?.value ?? 0,
    untouched: untouched[0]?.value ?? 0,
  };
}

/** The fields worth showing an owner in an audit trail — not the whole row. */
function auditShape(game: {
  name: string; venueName: string; kickoffTime: string; recurrenceRule: string;
  minPlayers: number; maxPlayers: number; prefersEvenNumbers: boolean; timezone: string;
}) {
  return {
    name: game.name,
    venueName: game.venueName,
    kickoffTime: game.kickoffTime,
    recurrenceRule: game.recurrenceRule,
    minPlayers: game.minPlayers,
    maxPlayers: game.maxPlayers,
    prefersEvenNumbers: game.prefersEvenNumbers,
    timezone: game.timezone,
  };
}

/**
 * How many fixtures an edit would rewrite, and how many it would leave alone.
 * Shown on the edit form before the save, so the effect is never a surprise.
 */
export async function countFixturesByPropagation(
  db: Db,
  gameId: string,
  now: Date,
): Promise<{ scheduled: number; untouched: number }> {
  const [scheduled] = await db
    .select({ value: count() })
    .from(fixtures)
    .where(and(eq(fixtures.gameId, gameId), eq(fixtures.lifecycle, "scheduled"), gte(fixtures.kicksOffAt, now)));
  const [untouched] = await db
    .select({ value: count() })
    .from(fixtures)
    .where(and(eq(fixtures.gameId, gameId), ne(fixtures.lifecycle, "scheduled"), gte(fixtures.kicksOffAt, now)));

  return { scheduled: scheduled?.value ?? 0, untouched: untouched?.value ?? 0 };
}
```

- [ ] **Step 4: Run the domain tests**

Run: `npx vitest run test/domain/update-game.test.ts`
Expected: PASS (8 tests). If `db.batch()` rejects the statement array's type,
the tuple assertion above is the fix — Drizzle types `batch` as a non-empty
tuple and the array is always non-empty here.

- [ ] **Step 5: Add the edit routes**

In `src/routes/games.ts`:

```typescript
gamesRoutes.get("/g/:id/edit", requirePlayer, async (c) => {
  const now = new Date(Date.now());
  const db = getDb(c.env.DB);
  const game = await findGameForOwner(db, c.req.param("id"), c.get("player")!.id);
  if (game === null) return c.text("Not found", 404);

  const counts = await countFixturesByPropagation(db, game.id, now);
  const rule = parseRecurrenceRule(game.recurrenceRule);

  return c.html(
    renderGameFormPage({
      action: gameEditPath(game.id),
      heading: `Edit ${game.name}`,
      submitLabel: "Save changes",
      values: {
        name: game.name,
        venueName: game.venueName,
        venueAddress: game.venueAddress ?? "",
        venueUrl: game.venueUrl ?? "",
        timezone: game.timezone,
        weekday: rule.byday,
        interval: String(rule.interval),
        kickoffTime: game.kickoffTime,
        durationMinutes: String(game.durationMinutes),
        minPlayers: String(game.minPlayers),
        maxPlayers: String(game.maxPlayers),
        prefersEvenNumbers: game.prefersEvenNumbers ? "on" : "",
        reminderDaysBefore: String(game.reminderDaysBefore),
        reminderLocalTime: game.reminderLocalTime,
        shortWarningOffsetHours: String(game.shortWarningOffsetHours),
      },
      errors: [],
      warnings: [],
      showAdvanced: true,
      affectedNotice: propagationNotice(counts),
    }),
  );
});

/** "This will update 4 scheduled fixtures. 1 open fixture is unchanged." */
function propagationNotice(counts: { scheduled: number; untouched: number }): string | undefined {
  if (counts.scheduled === 0 && counts.untouched === 0) return undefined;
  const scheduled = `This will update ${counts.scheduled} scheduled ${counts.scheduled === 1 ? "fixture" : "fixtures"}.`;
  if (counts.untouched === 0) return scheduled;
  return `${scheduled} ${counts.untouched} ${counts.untouched === 1 ? "fixture people have already been emailed about stays" : "fixtures people have already been emailed about stay"} unchanged.`;
}

gamesRoutes.post("/g/:id/edit", requirePlayer, async (c) => {
  if (wrongOrigin(c)) return c.text("Forbidden", 403);

  const now = new Date(Date.now());
  const db = getDb(c.env.DB);
  const game = await findGameForOwner(db, c.req.param("id"), c.get("player")!.id);
  if (game === null) return c.text("Not found", 404);

  const form = await c.req.parseBody();
  const parsed = parseGameForm(form);

  if (!parsed.ok) {
    return c.html(
      renderGameFormPage({
        action: gameEditPath(game.id),
        heading: `Edit ${game.name}`,
        submitLabel: "Save changes",
        values: submittedValues(form),
        errors: parsed.errors,
        warnings: [],
        showAdvanced: true,
      }),
      422,
    );
  }

  await updateGame({ db, game, values: parsed.values, actorPlayerId: c.get("player")!.id, now });

  return c.redirect(gamePath(game.id), 303);
});
```

- [ ] **Step 6: Test the edit routes**

Add to `test/routes/games.test.ts`:

```typescript
describe("editing a game", () => {
  beforeEach(resetDatabase);

  it("prefills the form from the stored game", async () => {
    const { cookie, gameId } = await ownedGame();
    const html = await (await SELF.fetch(`${ORIGIN}/g/${gameId}/edit`, { headers: { cookie } })).text();

    expect(html).toContain('value="Thursday 7-a-side"');
    expect(html).toContain('value="19:00"');
    // The Advanced block is on edit only (spec §3.1).
    expect(html).toContain("<summary>Advanced</summary>");
  });

  it("states how many fixtures the change will affect", async () => {
    const { cookie, gameId } = await ownedGame();
    const html = await (await SELF.fetch(`${ORIGIN}/g/${gameId}/edit`, { headers: { cookie } })).text();
    expect(html).toMatch(/This will update \d+ scheduled fixtures?\./);
  });

  it("saves and redirects", async () => {
    const { cookie, gameId } = await ownedGame();
    const response = await post(`/g/${gameId}/edit`, cookie, { ...VALID, name: "Friday 7-a-side", kickoffTime: "20:00" });

    expect(response.status).toBe(303);
    const [game] = await testDb().select().from(games).where(eq(games.id, gameId));
    expect(game?.name).toBe("Friday 7-a-side");
  });

  it("404s for a non-owner", async () => {
    const { cookie, gameId } = await ownedGame();
    await testDb().update(memberships).set({ role: "player" }).where(eq(memberships.gameId, gameId));

    expect((await SELF.fetch(`${ORIGIN}/g/${gameId}/edit`, { headers: { cookie }, redirect: "manual" })).status).toBe(404);
    expect((await post(`/g/${gameId}/edit`, cookie, VALID)).status).toBe(404);
  });
});
```

- [ ] **Step 7: Run the gate and commit**

```bash
npm run lint && npm run typecheck && npm test
git add src/ test/
git commit -m "feat: edit a game and propagate to its scheduled fixtures

An edit rewrites every scheduled fixture and never touches an open,
played or cancelled one — the line is whether anyone has been emailed
about it, which is the sense in which §2.8 means history.

Delete-and-re-materialise rather than update-in-place: shifting a game
by a week moves every fixture onto its neighbour's slot, which the
(game_id, kicks_off_at) unique index refuses. Safe only because a
scheduled fixture has no responses and no notification_log rows."
```

---

## Task 9: Joining a squad

**Files:**
- Create: `src/domain/join-squad.ts`
- Test: `test/domain/join-squad.test.ts`

**Interfaces:**
- Produces:

```typescript
export type JoinOutcome =
  | { kind: "joined"; playerId: string; membershipId: string; joinedAt: Date; playerName: string }
  | { kind: "rejoined"; playerId: string; membershipId: string; joinedAt: Date; playerName: string }
  | { kind: "already-member"; playerId: string; playerName: string };
export interface JoinSquadParams { db: Db; gameId: string; name: string; email: string; now: Date; }
export function joinSquad(params: JoinSquadParams): Promise<JoinOutcome>;
export function normaliseEmail(raw: string): string;
export function isPlausibleEmail(value: string): boolean;
```

- [ ] **Step 1: Write the failing test**

`test/domain/join-squad.test.ts`:

```typescript
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { auditLog, memberships, players } from "../../src/db/schema.js";
import { isPlausibleEmail, joinSquad, normaliseEmail } from "../../src/domain/join-squad.js";
import { insertGame, insertMembership, insertPlayer, resetDatabase, testDb } from "../support/factories.js";

const NOW = new Date(Date.UTC(2026, 7, 12, 9, 0));

describe("joinSquad", () => {
  beforeEach(resetDatabase);

  it("creates a player and an active membership for a new address", async () => {
    const db = testDb();
    const gameId = await insertGame(db);

    const outcome = await joinSquad({ db, gameId, name: "Alex Smith", email: "alex@example.com", now: NOW });

    expect(outcome.kind).toBe("joined");
    const [player] = await db.select().from(players).where(eq(players.email, "alex@example.com"));
    expect(player?.name).toBe("Alex Smith");
    const [membership] = await db.select().from(memberships).where(eq(memberships.gameId, gameId));
    expect(membership?.active).toBe(true);
    expect(membership?.role).toBe("player");
  });

  it("reuses an existing player and keeps their stored name", async () => {
    // One address is one person, and joining a second squad must not rename
    // them in the first (spec §4.4).
    const db = testDb();
    const gameId = await insertGame(db);
    const existingId = await insertPlayer(db, { name: "Alexandra Smith", email: "alex@example.com" });

    const outcome = await joinSquad({ db, gameId, name: "Al", email: "alex@example.com", now: NOW });

    expect(outcome.kind).toBe("joined");
    expect(outcome.playerId).toBe(existingId);
    const [player] = await db.select().from(players).where(eq(players.id, existingId));
    expect(player?.name).toBe("Alexandra Smith");
  });

  it("is idempotent for someone already in the squad", async () => {
    const db = testDb();
    const gameId = await insertGame(db);
    const playerId = await insertPlayer(db, { email: "alex@example.com" });
    await insertMembership(db, gameId, playerId);

    const outcome = await joinSquad({ db, gameId, name: "Alex", email: "alex@example.com", now: NOW });

    expect(outcome.kind).toBe("already-member");
    expect(await db.select().from(memberships).where(eq(memberships.gameId, gameId))).toHaveLength(1);
    // No write at all, so nothing to audit and nothing to email.
    expect(await db.select().from(auditLog)).toHaveLength(0);
  });

  it("reactivates a membership someone previously left, with a fresh joinedAt", async () => {
    const db = testDb();
    const gameId = await insertGame(db);
    const playerId = await insertPlayer(db, { email: "alex@example.com" });
    const membershipId = await insertMembership(db, gameId, playerId, {
      active: false,
      leftAt: new Date(Date.UTC(2026, 5, 1)),
      joinedAt: new Date(Date.UTC(2026, 0, 1)),
    });

    const outcome = await joinSquad({ db, gameId, name: "Alex", email: "alex@example.com", now: NOW });

    expect(outcome.kind).toBe("rejoined");
    expect(outcome.membershipId).toBe(membershipId);
    const [membership] = await db.select().from(memberships).where(eq(memberships.id, membershipId));
    expect(membership?.active).toBe(true);
    expect(membership?.leftAt).toBeNull();
    // The fresh joinedAt is what makes the N-6 dedupe key differ (§4.4).
    expect(membership?.joinedAt.getTime()).toBe(NOW.getTime());
  });

  it("does not disturb a membership in another game", async () => {
    const db = testDb();
    const first = await insertGame(db);
    const second = await insertGame(db);
    const playerId = await insertPlayer(db, { email: "alex@example.com" });
    await insertMembership(db, first, playerId);

    await joinSquad({ db, gameId: second, name: "Alex", email: "alex@example.com", now: NOW });

    expect(await db.select().from(memberships).where(eq(memberships.playerId, playerId))).toHaveLength(2);
  });

  it("records the join in audit_log", async () => {
    const db = testDb();
    const gameId = await insertGame(db);

    const outcome = await joinSquad({ db, gameId, name: "Alex", email: "alex@example.com", now: NOW });
    if (outcome.kind === "already-member") throw new Error("expected a join");

    const [row] = await db.select().from(auditLog).where(eq(auditLog.entityId, outcome.membershipId));
    expect(row?.action).toBe("membership.joined");
    // The joiner acted on their own behalf; nobody else did anything.
    expect(row?.actorPlayerId).toBe(outcome.playerId);
  });

  it("matches an address case-insensitively", async () => {
    const db = testDb();
    const gameId = await insertGame(db);
    const existingId = await insertPlayer(db, { email: "alex@example.com" });

    const outcome = await joinSquad({ db, gameId, name: "Alex", email: "ALEX@Example.com", now: NOW });

    expect(outcome.playerId).toBe(existingId);
  });
});

describe("normaliseEmail", () => {
  it("trims and lowercases", () => {
    expect(normaliseEmail("  Alex@Example.COM ")).toBe("alex@example.com");
  });
});

describe("isPlausibleEmail", () => {
  it("accepts an ordinary address", () => {
    expect(isPlausibleEmail("alex@example.com")).toBe(true);
    expect(isPlausibleEmail("alex+squad@example.co.uk")).toBe(true);
  });

  it("rejects what is obviously not one", () => {
    expect(isPlausibleEmail("")).toBe(false);
    expect(isPlausibleEmail("alex")).toBe(false);
    expect(isPlausibleEmail("alex@")).toBe(false);
    expect(isPlausibleEmail("@example.com")).toBe(false);
    expect(isPlausibleEmail("alex @example.com")).toBe(false);
    expect(isPlausibleEmail("alex@example")).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/domain/join-squad.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
import { and, eq } from "drizzle-orm";
import { buildAuditInsert } from "../db/audit.js";
import type { Db } from "../db/client.js";
import { memberships, players } from "../db/schema.js";

/**
 * Put someone in a squad from the public invite link (J1, spec §4.4).
 *
 * Shared rather than inlined in the route, because J6's "add a squad member
 * directly" is the same operation with a different caller — and because the
 * four outcomes below are the interesting part, not the HTTP around them.
 *
 * **One address is one person.** An email that already exists reuses the
 * `players` row and the *stored* name wins; the name typed on the form is
 * discarded. Joining a second squad therefore cannot rename you in the first,
 * and there is no unaudited path by which one squad's form input changes how
 * you appear to another. The cost is that a typo'd name cannot be corrected
 * here — that belongs to a profile-edit surface (§1.6, M7).
 *
 * **BR-2 is deliberate, not a bug.** A player who joins after a fixture has
 * opened is not in that fixture: `pending` rows are written for the eligible
 * set at the moment a fixture opens (BR-1) and nothing back-fills them. The
 * page that renders this outcome says which fixture is their first.
 */

export type JoinOutcome =
  | { kind: "joined"; playerId: string; membershipId: string; joinedAt: Date; playerName: string }
  | { kind: "rejoined"; playerId: string; membershipId: string; joinedAt: Date; playerName: string }
  | { kind: "already-member"; playerId: string; playerName: string };

export interface JoinSquadParams {
  db: Db;
  gameId: string;
  name: string;
  /** Raw from the form. Normalised here, not by the caller. */
  email: string;
  now: Date;
}

/**
 * Trimmed and lowercased, so `Ed@x.com` and `ed@x.com` cannot become two
 * Players under the `UNIQUE (email) WHERE email IS NOT NULL` index.
 */
export function normaliseEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * A shape check, not a deliverability check — nothing here can know whether an
 * address exists, and the N-6 welcome is what actually tests that (spec §4.4:
 * the email doubles as proof of address).
 */
export function isPlausibleEmail(value: string): boolean {
  if (value.length === 0 || value.length > 254) return false;
  if (/\s/.test(value)) return false;
  const at = value.indexOf("@");
  if (at <= 0 || at !== value.lastIndexOf("@")) return false;
  const domain = value.slice(at + 1);
  return domain.length > 0 && domain.includes(".") && !domain.startsWith(".") && !domain.endsWith(".");
}

export async function joinSquad(params: JoinSquadParams): Promise<JoinOutcome> {
  const { db, gameId, name, now } = params;
  const email = normaliseEmail(params.email);

  const [existing] = await db.select().from(players).where(eq(players.email, email)).limit(1);

  // A guest can never collide here: guests have `email IS NULL` by definition
  // (§2.8) and this lookup is by email.
  const playerId = existing?.id ?? crypto.randomUUID();
  const playerName = existing?.name ?? name.trim();

  if (!existing) {
    await db.insert(players).values({ id: playerId, name: playerName, email, createdAt: now });
  }

  const [membership] = await db
    .select()
    .from(memberships)
    .where(and(eq(memberships.gameId, gameId), eq(memberships.playerId, playerId)))
    .limit(1);

  if (membership?.active === true) {
    return { kind: "already-member", playerId, playerName };
  }

  if (membership) {
    // Reactivate rather than insert: UNIQUE (game_id, player_id) forbids a
    // second row. `joinedAt` is reset because it is what makes the N-6 dedupe
    // key differ, which is what lets a rejoin be welcomed again (§4.4).
    await db.batch([
      db
        .update(memberships)
        .set({ active: true, leftAt: null, joinedAt: now })
        .where(eq(memberships.id, membership.id)),
      buildAuditInsert(db, {
        actorPlayerId: playerId,
        entityType: "membership",
        entityId: membership.id,
        action: "membership.rejoined",
        after: { gameId, playerId },
        now,
      }),
    ]);
    return { kind: "rejoined", playerId, membershipId: membership.id, joinedAt: now, playerName };
  }

  const membershipId = crypto.randomUUID();
  await db.batch([
    db.insert(memberships).values({
      id: membershipId,
      gameId,
      playerId,
      role: "player",
      active: true,
      joinedAt: now,
    }),
    buildAuditInsert(db, {
      actorPlayerId: playerId,
      entityType: "membership",
      entityId: membershipId,
      action: "membership.joined",
      after: { gameId, playerId },
      now,
    }),
  ]);

  return { kind: "joined", playerId, membershipId, joinedAt: now, playerName };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/domain/join-squad.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Run the gate and commit**

```bash
npm run lint && npm run typecheck && npm test
git add src/domain/join-squad.ts test/domain/join-squad.test.ts
git commit -m "feat: join a squad from an invite link

One address is one person: an existing email reuses the player row and
the stored name wins, so joining a second squad cannot rename you in
the first. A rejoin reactivates the membership with a fresh joinedAt,
which is what lets the N-6 welcome be sent again."
```

---

## Task 10: The N-6 welcome email

**Files:**
- Create: `src/notify/templates/welcome.ts`, `src/notify/send-welcome.ts`
- Test: `test/notify/templates/welcome.test.ts`, `test/notify/send-welcome.test.ts`

**Interfaces:**
- Consumes: `welcomeKey` (Task 1); `insertQueuedLogRows`, `applySendResult`, `SITE_ORIGIN` (`src/notify/delivery.ts`); `JoinOutcome` (Task 9).
- Produces:

```typescript
export function renderWelcomeEmail(params: {
  playerName: string; gameName: string; venueName: string;
  whenLocal: string | null; dashboardUrl: string;
}): { subject: string; html: string; text: string };

export type WelcomeSendOutcome =
  | { kind: "sent" } | { kind: "deferred" } | { kind: "failed"; reason: string }
  | { kind: "already-logged" } | { kind: "skipped-no-recipient" };

export function sendWelcomeEmail(params: {
  db: Db; notifier: Notifier; gameId: string; playerId: string;
  membershipId: string; joinedAt: Date; now: Date;
}): Promise<WelcomeSendOutcome>;
```

- [ ] **Step 1: Write the template test**

`test/notify/templates/welcome.test.ts` — mirror the structure of
`test/notify/templates/promotion.test.ts`, which is the closest existing
single-recipient template. Assert:

```typescript
import { describe, expect, it } from "vitest";
import { renderWelcomeEmail } from "../../../src/notify/templates/welcome.js";

const params = {
  playerName: "Alex",
  gameName: "Thursday 7-a-side",
  venueName: "Oxford Sports Park",
  whenLocal: "Thursday 20 August at 19:00",
  dashboardUrl: "https://makethe.team/app/dashboard",
};

describe("renderWelcomeEmail", () => {
  it("names the game in the subject", () => {
    expect(renderWelcomeEmail(params).subject).toContain("Thursday 7-a-side");
  });

  it("says which fixture is their first, because it is not the current one (BR-2)", () => {
    const { text } = renderWelcomeEmail(params);
    expect(text).toContain("Thursday 20 August at 19:00");
  });

  it("stays honest when there is no scheduled fixture yet", () => {
    const { text, html } = renderWelcomeEmail({ ...params, whenLocal: null });
    expect(text).not.toContain("null");
    expect(html).not.toContain("null");
  });

  it("escapes a name containing markup", () => {
    const { html } = renderWelcomeEmail({ ...params, playerName: '<script>alert(1)</script>' });
    expect(html).not.toContain("<script>");
  });

  it("offers a text alternative for every link in the HTML", () => {
    const { text } = renderWelcomeEmail(params);
    expect(text).toContain("https://makethe.team/app/dashboard");
  });
});
```

- [ ] **Step 2: Run to verify failure, then implement the template**

Run: `npx vitest run test/notify/templates/welcome.test.ts` → FAIL.

Write `src/notify/templates/welcome.ts` following `src/notify/templates/promotion.ts`
exactly: the same table-based HTML structure, the same `escapeHtml`/`href`
helpers, the same text alternative. Do not invent a new email design — five
templates already share one, and a sixth that differs is the beginning of six
that all differ. Content:

- Subject: `You're in the squad for <game name>`
- Body: who added them (the invite link), where and when the game is, that
  they'll get an email the day before each fixture with two buttons, and — per
  BR-2 — the date of their **first** fixture, which is the next `scheduled`
  one, not any fixture already `open`.
- A link to the dashboard so they can sign in and see everything.

Run the template test to green.

- [ ] **Step 3: Write the sender test**

`test/notify/send-welcome.test.ts`, mirroring `test/notify/send-promotion.test.ts`:

```typescript
it("sends once and records the log row", async () => { /* … */ });
it("returns already-logged for a repeated send with the same joinedAt", async () => { /* … */ });
it("sends again after a rejoin, because joinedAt differs (§4.4)", async () => { /* … */ });
it("writes a notification_log row with a null fixture_id", async () => { /* … */ });
it("skips a player with no usable address without writing a row (BR-32)", async () => { /* … */ });
it("defers rather than failing when the daily ceiling refuses it", async () => { /* … */ });
```

The third test is the one that justifies Task 1's dedupe-key change; the fourth
is the one that justifies its nullable `fixtureId`.

- [ ] **Step 4: Implement `src/notify/send-welcome.ts`**

Follow `src/notify/send-promotion.ts` closely — same ordering
(`insertQueuedLogRows` → `notifier.send` → `applySendResult`), same treatment
of a notifier that throws, same BR-32 guard on a blank or missing address, same
`skipped-no-recipient` returning before any row is written. Two differences,
both to be stated in the doc comment:

- `insertQueuedLogRows(db, { fixtureId: null, notificationType: "n6" }, …)` —
  N-6 is not about a fixture.
- The dedupe key is `welcomeKey(membershipId, joinedAt.toISOString())`.

- [ ] **Step 5: Run the gate and commit**

```bash
npm run lint && npm run typecheck && npm test
git add src/notify/ test/notify/
git commit -m "feat: the N-6 welcome email

The first notification in the catalogue that is not about a fixture,
which is why notification_log.fixture_id has always been nullable, and
the first whose dedupe key must survive a rejoin."
```

---

## Task 11: The public invite page and the join flow

**Files:**
- Create: `src/views/join.ts`, `src/routes/join.ts`
- Modify: `src/app.ts`, `src/db/queries.ts`
- Test: `test/routes/join.test.ts`

**Interfaces:**
- Consumes: `joinSquad`, `normaliseEmail`, `isPlausibleEmail` (Task 9); `sendWelcomeEmail` (Task 10); `redactName` (Task 2); `createNotifier` (`src/notify/factory.ts` — check its exact export name and signature before use).
- Produces:

```typescript
// src/db/queries.ts
export function findGameByInviteToken(db: Db, token: string): Promise<typeof games.$inferSelect | null>;
export function findFirstScheduledFixture(db: Db, gameId: string, now: Date): Promise<{ kicksOffAt: Date } | null>;

// src/views/join.ts
export function renderInvitePage(params: InvitePageParams): string;
export function renderJoinOutcomePage(params: JoinOutcomePageParams): string;
```

- [ ] **Step 1: Write the failing route tests**

`test/routes/join.test.ts`:

```typescript
import { SELF } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { games, memberships, notificationLog, players } from "../../src/db/schema.js";
import { insertGame, insertMembership, insertPlayer, resetDatabase, testDb } from "../support/factories.js";
import { ORIGIN } from "../support/sign-in.js";

async function seedGame(overrides = {}) {
  const db = testDb();
  const gameId = await insertGame(db, overrides);
  const [game] = await db.select().from(games).where(eq(games.id, gameId));
  return { db, game: game! };
}

function joinPost(token: string, fields: Record<string, string>, origin: string | null = ORIGIN) {
  return SELF.fetch(`${ORIGIN}/j/${token}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(origin === null ? {} : { origin }),
    },
    body: new URLSearchParams(fields),
    redirect: "manual",
  });
}

describe("GET /j/:token", () => {
  beforeEach(resetDatabase);

  it("shows the game to an anonymous visitor with no session", async () => {
    const { game } = await seedGame();
    const response = await SELF.fetch(`${ORIGIN}/j/${game.inviteToken}`);

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Thursday 7-a-side");
    expect(html).toContain("Oxford Sports Park");
  });

  it("redacts squad members to a first name and initial (BR-26)", async () => {
    const { db, game } = await seedGame();
    const playerId = await insertPlayer(db, { name: "Edward Charles", email: "edward@example.com" });
    await insertMembership(db, game.id, playerId);

    const html = await (await SELF.fetch(`${ORIGIN}/j/${game.inviteToken}`)).text();

    expect(html).toContain("Edward C.");
    expect(html).not.toContain("Charles");
    // Never an address, on a page anyone holding the link can open.
    expect(html).not.toContain("edward@example.com");
  });

  it("404s an unknown token", async () => {
    await seedGame();
    expect((await SELF.fetch(`${ORIGIN}/j/${crypto.randomUUID()}`)).status).toBe(404);
  });

  it("404s a rotated token without hinting that it was ever real", async () => {
    const { db, game } = await seedGame();
    const old = game.inviteToken;
    await db.update(games).set({ inviteToken: crypto.randomUUID() }).where(eq(games.id, game.id));

    const response = await SELF.fetch(`${ORIGIN}/j/${old}`);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("Thursday 7-a-side");
  });

  it("404s an inactive game", async () => {
    const { db, game } = await seedGame();
    await db.update(games).set({ active: false }).where(eq(games.id, game.id));
    expect((await SELF.fetch(`${ORIGIN}/j/${game.inviteToken}`)).status).toBe(404);
  });

  it("posts to the path the handler reads, with the field names it parses", async () => {
    // The assertion the connect-src post-mortem asks for: a form with the
    // wrong action, method or field names fails *identically* to a correct one
    // under server-side testing, because the handler is simply never called.
    const { game } = await seedGame();
    const html = await (await SELF.fetch(`${ORIGIN}/j/${game.inviteToken}`)).text();

    expect(html).toContain(`action="/j/${game.inviteToken}"`);
    expect(html).toContain('method="post"');
    expect(html).toContain('name="name"');
    expect(html).toContain('name="email"');
  });
});

describe("POST /j/:token", () => {
  beforeEach(resetDatabase);

  it("creates the player and the membership and welcomes them", async () => {
    const { db, game } = await seedGame();

    const response = await joinPost(game.inviteToken, { name: "Alex Smith", email: "alex@example.com" });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("You're in");

    const [player] = await db.select().from(players).where(eq(players.email, "alex@example.com"));
    expect(player?.name).toBe("Alex Smith");
    const [membership] = await db.select().from(memberships).where(eq(memberships.gameId, game.id));
    expect(membership?.active).toBe(true);

    const [log] = await db.select().from(notificationLog).where(eq(notificationLog.notificationType, "n6"));
    expect(log?.playerId).toBe(player!.id);
    expect(log?.fixtureId).toBeNull();
  });

  it("is idempotent for someone already in the squad", async () => {
    const { db, game } = await seedGame();
    const playerId = await insertPlayer(db, { email: "alex@example.com" });
    await insertMembership(db, game.id, playerId);

    const response = await joinPost(game.inviteToken, { name: "Alex", email: "alex@example.com" });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("already in");
    expect(await db.select().from(memberships).where(eq(memberships.gameId, game.id))).toHaveLength(1);
    expect(await db.select().from(notificationLog)).toHaveLength(0);
  });

  it("redisplays the form when the email is not plausible", async () => {
    const { db, game } = await seedGame();

    const response = await joinPost(game.inviteToken, { name: "Alex", email: "not-an-address" });

    expect(response.status).toBe(422);
    const html = await response.text();
    expect(html).toContain('value="Alex"');
    expect(await db.select().from(players)).toHaveLength(0);
  });

  it("requires a name", async () => {
    const { db, game } = await seedGame();
    const response = await joinPost(game.inviteToken, { name: "  ", email: "alex@example.com" });

    expect(response.status).toBe(422);
    expect(await db.select().from(players)).toHaveLength(0);
  });

  it("refuses a cross-site post", async () => {
    const { db, game } = await seedGame();
    const response = await joinPost(game.inviteToken, { name: "Alex", email: "alex@example.com" }, "https://evil.example");

    expect(response.status).toBe(403);
    expect(await db.select().from(players)).toHaveLength(0);
  });

  it("allows a post with no Origin header at all", async () => {
    // A non-browser client acting on its own behalf, same rule as the
    // dashboard and sign-out forms.
    const { game } = await seedGame();
    const response = await joinPost(game.inviteToken, { name: "Alex", email: "alex@example.com" }, null);
    expect(response.status).toBe(200);
  });

  it("404s an unknown token before doing any work", async () => {
    const db = testDb();
    const response = await joinPost(crypto.randomUUID(), { name: "Alex", email: "alex@example.com" });

    expect(response.status).toBe(404);
    expect(await db.select().from(players)).toHaveLength(0);
  });

  it("welcomes someone back after they had left", async () => {
    const { db, game } = await seedGame();
    const playerId = await insertPlayer(db, { email: "alex@example.com" });
    await insertMembership(db, game.id, playerId, { active: false, leftAt: new Date(Date.UTC(2026, 5, 1)) });

    const response = await joinPost(game.inviteToken, { name: "Alex", email: "alex@example.com" });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Welcome back");
    const [membership] = await db.select().from(memberships).where(eq(memberships.playerId, playerId));
    expect(membership?.active).toBe(true);
    expect(membership?.leftAt).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/routes/join.test.ts`
Expected: FAIL — every case 404s, because `/j/:token` is not registered.

- [ ] **Step 3: Add the queries**

```typescript
/** An active game by its invite token, or null. Never leaks why it was null. */
export async function findGameByInviteToken(
  db: Db,
  token: string,
): Promise<typeof games.$inferSelect | null> {
  const [game] = await db
    .select()
    .from(games)
    .where(and(eq(games.inviteToken, token), eq(games.active, true)))
    .limit(1);
  return game ?? null;
}

/**
 * The next `scheduled` fixture — the first one a joiner will actually be
 * invited to (BR-2). Deliberately excludes `open` fixtures: a player added
 * after a fixture opens is not in it, because `pending` rows were written for
 * the eligible set at that moment and nothing back-fills them.
 */
export async function findFirstScheduledFixture(
  db: Db,
  gameId: string,
  now: Date,
): Promise<{ kicksOffAt: Date } | null> {
  const [fixture] = await db
    .select({ kicksOffAt: fixtures.kicksOffAt })
    .from(fixtures)
    .where(and(eq(fixtures.gameId, gameId), eq(fixtures.lifecycle, "scheduled"), gte(fixtures.kicksOffAt, now)))
    .orderBy(fixtures.kicksOffAt)
    .limit(1);
  return fixture ?? null;
}
```

- [ ] **Step 4: Implement `src/views/join.ts`**

Two renderers. The invite page carries the form; the outcome page renders one
of three messages. Both use `layout` with `FORM_CSS`, both escape everything,
and neither takes any script. Key requirements the tests pin:

- `<form method="post" action="/j/<token>">` with inputs named exactly `name`
  and `email`, `type="email"`, both `required`.
- Squad members rendered through `redactName`.
- Never an email address anywhere in the output.
- Outcome copy: `You're in` / `Welcome back` / `You're already in this squad`.
- The "You're in" page names the first `scheduled` fixture, and says plainly
  that a fixture already underway is not one they are in (BR-2).

- [ ] **Step 5: Implement `src/routes/join.ts`**

```typescript
import { Hono } from "hono";
import { getDb } from "../db/client.js";
import { findFirstScheduledFixture, findGameByInviteToken, listSquad } from "../db/queries.js";
import { isPlausibleEmail, joinSquad, normaliseEmail } from "../domain/join-squad.js";
import { formatLocalDateTime } from "../domain/time/zone.js";
import type { AppEnv, Bindings } from "../env.js";
import { createNotifier } from "../notify/factory.js";
import { sendWelcomeEmail } from "../notify/send-welcome.js";
import { renderInvitePage, renderJoinOutcomePage } from "../views/join.js";

export const join = new Hono<AppEnv>();

/**
 * The public invite flow (J1, spec §4).
 *
 * **Unauthenticated, and it both writes rows and sends email** — the same
 * class as `POST /r/:token`. What bounds the cost of abuse is the quota
 * wrapper around the notifier (`MAX_EMAILS_PER_DAY`, TR-31), not the origin
 * check or the token's unguessability; both of those are real but narrower.
 * A WAF rate-limit rule on `/j/*` is documented in
 * `docs/runbooks/cloudflare.md` and is a supplement (TR-37), not a control:
 * everything here must hold with it switched off.
 *
 * Mounted outside every session prefix. A visitor holding an invite link has
 * no session and must not need one (§1.6).
 */
```

`GET /j/:token`: look up the game, 404 if null, render the invite page with the
squad (redacted) and the game's details.

`POST /j/:token`: origin check → 403; look up the game → 404; validate name and
email → 422 re-rendering the invite page with the values and a message;
`joinSquad`; on `joined` or `rejoined`, send N-6 through
`c.executionCtx.waitUntil(...)` exactly as `POST /r/:token` does for promotion
— the person's page must not wait on a provider; render the outcome page.

**Read `src/notify/factory.ts` for the notifier's real construction signature
before writing this.** It is the quota-wrapped notifier and must never be
bypassed.

- [ ] **Step 6: Mount it in `src/app.ts`**

`app.route("/", join);` — outside `AUTHENTICATED_PREFIX` and outside
`SIGN_IN_PREFIX`, alongside `respond` and `cancel`.

- [ ] **Step 7: Run the tests, the gate, and commit**

Run: `npx vitest run test/routes/join.test.ts` → PASS (13 tests).

```bash
npm run lint && npm run typecheck && npm test
git add src/ test/
git commit -m "feat: the public invite page and join flow (J1)

BR-26 redaction on the only page a stranger can reach, an origin check
matching the dashboard's, and the N-6 send through the quota wrapper
so a leaked link cannot cost more than the daily ceiling.

The form-wiring assertion is the one the connect-src post-mortem asks
for: a form with the wrong action or field names fails identically to
a correct one when only the server is tested."
```

---

## Task 12: Close the loop — CSP coverage, navigation, and the documentation

**Files:**
- Modify: `test/security/csp.test.ts`, `test/routes/signin.test.ts` (page enumeration), `src/views/dashboard.ts`, `docs/known-issues.md`, `docs/runbooks/cloudflare.md`, `docs/superpowers/specs/2026-08-10-make-the-team-design.md`

- [ ] **Step 1: Add the four new pages to the CSP sweep**

In `test/security/csp.test.ts`, extend the page list with `/g/new`, `/g/:id`,
`/g/:id/edit` and `/j/:token`. The QR page is the one that would have failed
under an `<img>`-based implementation — confirm it passes `expectFixedDirectives`
and that `expectFetchTargetsAllowed` still covers every block including
`COPY_INVITE_JS` (which makes no `fetch`, so it contributes nothing, and the
assertion should pass trivially rather than be skipped).

Run: `npx vitest run test/security/csp.test.ts` → PASS.

- [ ] **Step 2: Verify the script enumeration test still holds**

`test/routes/signin.test.ts` checks every script on every reachable page
against `SCRIPT_BLOCKS`. `/g/:id` now emits one. Add it to that enumeration if
the test lists pages explicitly.

Run: `npx vitest run test/routes/signin.test.ts test/views/scripts.test.ts` → PASS.

- [ ] **Step 3: Link the new pages from the dashboard**

In `src/views/dashboard.ts`, add a "Set up a game" link to `/g/new`, and list
any games the viewer owns with links to `/g/:id`. This needs a query for
"games where this player is an active owner" — add `listOwnedGames(db, playerId)`
to `src/db/queries.ts` alongside `findGameForOwner`. Without this, the whole
feature is unreachable except by typing a URL.

Add a dashboard test asserting the link is present and that a player who owns
no game does not see an empty list header.

- [ ] **Step 4: Update `docs/known-issues.md`**

Three rows move to done, with the date and the reason:

- The `LocalParts` rollover row — closed, noting it was closed by making the
  state unreachable from the form (`parseLocalTime` on every submitted time)
  rather than by changing `src/domain/time/zone.ts`.
- The timezone negative-caching row — closed on the same basis: the picker and
  the validator share one list, so a rejected zone is not submittable.
- The odd-`max_players` row — closed as a soft warning, per spec Part 3 item 6.

Add one new row: the leaked-invite-link abuse case from spec §4.5, whose full
remedy needs J6's member-removal control, with that as the trigger.

Leave the two passkey rows (`.catch()` diagnosability, `verify-registration`
500) **open and tagged M6** — they belong to neither sub-project and are a
separate small change.

- [ ] **Step 5: Update `docs/runbooks/cloudflare.md`**

Add a `join-throttle` rate-limiting rule for `/j/*` beside the existing
`respond-throttle`, written in the same form, and mark it **not yet applied**
with a note that it must be created by hand in the dashboard — the deploy
token deliberately lacks Firewall Services → Edit.

- [ ] **Step 6: Write the N-6 dedupe-key amendment back into the spec**

In `docs/superpowers/specs/2026-08-10-make-the-team-design.md` §2.8, change the
N-6 row of the dedupe-key table to `n6:<membership_id>:<joined_at>` and note
why in one sentence: a rejoin reuses the membership row, so the id alone cannot
distinguish two welcomes. Add M6a to §2.14's status line.

- [ ] **Step 7: Full gate, then commit**

```bash
npm run lint && npm run typecheck && npm test
git add src/ test/ docs/
git commit -m "docs: close three known issues and record M6a's one new one

Two of the three are closed by making the bad state unreachable from
the form rather than by changing the module downstream, which is worth
saying out loud so nobody 'fixes' zone.ts later believing it unguarded.

Amends §2.8's N-6 dedupe key, which contradicted its own prose."
```

- [ ] **Step 8: Verify the whole feature by hand before declaring it done**

The post-mortem's standing instruction is that a passing suite is consistent
with a completely broken browser feature. So, against `npm run dev`:

1. Sign in, create a game, confirm you land on `/g/:id` with fixtures listed.
2. Confirm the QR code renders — with devtools open, and **zero CSP violations
   in the console**. This is the check no test can make.
3. Copy the invite link with the button; then disable JavaScript, reload, and
   confirm the link is still readable and selectable and the page is intact.
4. Open the invite link in a private window (no session), join with a new
   address, confirm the welcome page and the `notification_log` row.
5. Edit the game's kickoff time and confirm the fixture list moves.

Record anything surprising in `docs/known-issues.md` rather than fixing it
silently.

---

## Self-review notes

**Spec coverage.** §2 routes → Tasks 6, 7, 8, 11. §2.1 owner check → Task 7
(queries) and every route task. §2.2 JS policy → Task 7. §3.1 form → Tasks 3, 6.
§3.2 validation and the three known issues → Task 3, closed in Task 12. §3.3
propagation → Task 8. §3.4 audit → Tasks 1, 6, 8, 9. §3.5 create → Task 6.
§4.1 link and rotation → Task 7. §4.2 QR → Task 4. §4.3 public page → Task 11.
§4.4 four outcomes and the dedupe amendment → Tasks 1, 9, 10. §4.5 controls →
Tasks 10 (quota), 11 (origin, normalisation), 12 (WAF runbook). §4.6 shared
`joinSquad` and BR-2 → Tasks 9, 11. §5 no migration → global constraint.
§6 modules → the file-structure table. §7 testing → every task, plus Task 12.
§8 known issues → Task 12.

**Deliberately deferred within this plan:** the two passkey known-issues rows
(§8 of the spec says they belong to M6 but to neither sub-project).

**One thing to watch during Task 7.** Hono matches `/g/new` against `/g/:id` if
the parameterised route is registered first. The plan says to order them, and
the "404s a game id that does not exist" test will not catch a mis-ordering —
it would surface as `GET /g/new` 404ing, which the Task 6 test does catch.

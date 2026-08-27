# M39 Confirm-to-join Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A join from an address the product has never verified sends one confirmation email and writes nothing; clicking through performs the join and marks the address verified.

**Architecture:** A fourth signed-token kind (`join`) carries `(gameId, inviteToken, email, name)` statelessly. `POST /j/:token` branches on whether the address matches a player with `email_verified_at`; the unverified branch sends N-14 through the quota-wrapped notifier with a once-per-day guard in a new two-day ring table `join_confirmations`, and `GET|POST /join/:jtoken` completes the join. `joinSquad` gains an optional `emailVerifiedAt`. The owner's squad page badges legacy unconfirmed members.

**Tech Stack:** Cloudflare Workers, Hono, D1 + Drizzle, Vitest (`@cloudflare/vitest-pool-workers`), Playwright.

**Spec:** `docs/superpowers/specs/2026-08-26-confirm-to-join-design.md` — read its "Implementation notes" section; the rulings there (path `/join/:jtoken`, no `notification_log` row for N-14, `join_confirmations` table, `n14` in the catalogue) bind every task below.

## Global Constraints

- Work in a sibling worktree `../maketheteam-m39` on branch `m39-confirm-to-join`; `npm install` there; **never** add `allowScripts` to `package.json`. Stage explicit paths only — never `git add -A` / `git add .`.
- Every interpolation goes through `escapeHtml`, including `href` and class attributes. No `style=""` attributes; any new `<style>` block goes in `PAGE_STYLE_BLOCKS` (`src/security/csp.ts` hashes exactly those). No `'unsafe-inline'` / `'unsafe-hashes'`.
- A refusal is a **404**, never a 403 (TR-18). Wrong-origin POSTs are the one existing 403 (`wrongOrigin`), kept as is.
- No bare `new Date()` below the route edge; `now` is a parameter everywhere.
- Comments name the failure a rule prevents; they do not restate the code.
- Copy rules: the confirmation email carries no fixture date, no `/r/`, `/j/`, `/leave/` link and no squad list (BR-51). The word for a legacy member with null `email_verified_at` is **"Unconfirmed"** (BR-52).
- Token lifetime for `join` is exactly **7 days** (BR-48). Dedupe day is the **UTC** calendar day `YYYY-MM-DD` (same convention as `email_quota.day`).
- Full suite (`npm test`, >120 s) runs in the foreground at the end of every task that touches `src/`; never background it and end the turn.
- Every new public route is added to the TR-16 sweep in `test/routes/signin.test.ts` (Task 5) — that test fails the build otherwise.

---

### Task 1: The `join` token kind

**Files:**
- Modify: `src/domain/token.ts`
- Test: `test/domain/token.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface JoinTokenPayload { gameId: string; inviteToken: string; email: string; name: string; expiresAt: number }
  export function joinTokenExpiry(now: Date): Date            // now + 7 days
  export function signJoinToken(payload: JoinTokenPayload, secret: string): Promise<string>
  export function verifyJoinToken(token: string, secret: string, now: Date): Promise<TokenVerification<JoinTokenPayload>>
  ```
  Signed with `RESPONSE_TOKEN_SECRET` (same as `leave`).

- [ ] **Step 1: Write the failing tests.** Find `describe("leave tokens"` in `test/domain/token.test.ts` and add after it, using that block's `CLOCK_NOW` and local `SECRET` style:

```ts
describe("join tokens (M39)", () => {
  const SECRET = "join-token-tests-only";
  const payload = () => ({
    gameId: "g-1",
    inviteToken: "inv-1",
    email: "jack@example.com",
    name: "Jack Hart",
    expiresAt: joinTokenExpiry(CLOCK_NOW).getTime(),
  });

  it("round-trips the whole payload, name included", async () => {
    const token = await signJoinToken(payload(), SECRET);
    expect(await verifyJoinToken(token, SECRET, CLOCK_NOW)).toEqual({ ok: true, payload: payload() });
  });

  it("expires seven days after minting (BR-48)", () => {
    expect(joinTokenExpiry(CLOCK_NOW).getTime()).toBe(CLOCK_NOW.getTime() + 7 * 24 * 60 * 60 * 1000);
  });

  it("rejects a token presented after its expiry", async () => {
    const token = await signJoinToken({ ...payload(), expiresAt: CLOCK_NOW.getTime() - 1 }, SECRET);
    expect(await verifyJoinToken(token, SECRET, CLOCK_NOW)).toEqual({ ok: false, reason: "expired" });
  });

  it("refuses a leave token presented as a join token", async () => {
    const token = await signLeaveToken({ gameId: "g-1", playerId: "p-1", expiresAt: CLOCK_NOW.getTime() + 1000 }, SECRET);
    expect(await verifyJoinToken(token, SECRET, CLOCK_NOW)).toEqual({ ok: false, reason: "malformed" });
  });

  it("refuses a join token presented as a leave or response token", async () => {
    const token = await signJoinToken(payload(), SECRET);
    expect(await verifyLeaveToken(token, SECRET, CLOCK_NOW)).toEqual({ ok: false, reason: "malformed" });
    expect(await verifyResponseToken(token, SECRET, CLOCK_NOW)).toEqual({ ok: false, reason: "malformed" });
  });

  it("refuses a join token signed with a different secret", async () => {
    const token = await signJoinToken(payload(), "other-secret");
    expect(await verifyJoinToken(token, SECRET, CLOCK_NOW)).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("refuses a payload missing the invite token, so rotation can always be checked (BR-49)", async () => {
    // Signed as the real kind with a shape the guard must reject — mirrors the
    // "same-secret body satisfying both shapes" cases above.
    const { inviteToken: _dropped, ...withoutInvite } = payload();
    const token = await signJoinToken(withoutInvite as never, SECRET);
    expect(await verifyJoinToken(token, SECRET, CLOCK_NOW)).toEqual({ ok: false, reason: "malformed" });
  });
});
```
Add `joinTokenExpiry, signJoinToken, verifyJoinToken` to the file's import from `../../src/domain/token.js`.

- [ ] **Step 2: Run to verify it fails.** `npx vitest run test/domain/token.test.ts` — expected: fails to compile/import (`signJoinToken` is not exported).

- [ ] **Step 3: Implement.** In `src/domain/token.ts`:
  - Extend `type TokenKind = "response" | "cancel" | "leave" | "join";` and add `join: "RESPONSE_TOKEN_SECRET"` to `SECRET_BINDING_NAME`.
  - After the leave-token section add:

```ts
/**
 * A join-confirmation token (M39, BR-48). Scoped to one game *and* the
 * invite token it was minted from: `/join/:jtoken` refuses it when the game's
 * `invite_token` has since been rotated (BR-49), which is what keeps rotation
 * a complete remedy for a leaked link — without `inviteToken` in the signed
 * bytes, every confirmation email already in flight would outlive it.
 *
 * `email` and `name` travel here, not in a table, so the product stores
 * nothing about a person who never confirms. Both are attacker-typed and are
 * escaped at every render like any other interpolation.
 */
export interface JoinTokenPayload {
  gameId: string;
  inviteToken: string;
  email: string;
  name: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

/** Seven days (BR-48): long enough to read the email late, bounded anyway by BR-49. */
const JOIN_TOKEN_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

export function joinTokenExpiry(now: Date): Date {
  return new Date(now.getTime() + JOIN_TOKEN_LIFETIME_MS);
}

function isJoinPayload(value: unknown): value is JoinTokenPayload {
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate["gameId"] === "string" &&
    typeof candidate["inviteToken"] === "string" &&
    typeof candidate["email"] === "string" &&
    typeof candidate["name"] === "string" &&
    typeof candidate["expiresAt"] === "number" &&
    Number.isFinite(candidate["expiresAt"])
  );
}

export async function signJoinToken(payload: JoinTokenPayload, secret: string): Promise<string> {
  return signToken("join", payload, secret);
}

/** Verify and decode a join token. See {@link verifyToken}. */
export async function verifyJoinToken(
  token: string,
  secret: string,
  now: Date,
): Promise<TokenVerification<JoinTokenPayload>> {
  return verifyToken("join", token, secret, now, isJoinPayload);
}
```

- [ ] **Step 4: Run to verify it passes.** `npx vitest run test/domain/token.test.ts` — all green, including the pre-existing kind-separation cases.

- [ ] **Step 5: Commit.**
```bash
git add src/domain/token.ts test/domain/token.test.ts
git commit -m "M39: a join-confirmation token kind, scoped to game and invite token"
```

---

### Task 2: Catalogue entry `n14` and the `join_confirmations` table

**Files:**
- Modify: `src/notify/dedupe-key.ts`, `src/notify/notification-controls.ts`, `src/views/admin-notifications.ts`, `src/db/schema.ts`, `test/support/factories.ts`
- Create: `migrations/0025_<generated>.sql` (+ `migrations/meta/`) via `npm run db:generate`
- Test: `test/notify/notification-controls.test.ts`, `test/routes/admin-notifications.test.ts`

**Interfaces:**
- Produces: `joinConfirmations` Drizzle table `{ gameId, email, day, createdAt }`, PK `(game_id, email, day)`, `game_id` FK → `games.id` on delete cascade. `NotificationType` now includes `"n14"`; `NOTIFICATION_CONTROLS.n14 = { scope: "admin", channels: ["email"] }`.
- Note for the implementer: `test/notify/notification-invariants.test.ts` will fail after this task with `no driver registered for n14` — **expected**; Task 3 adds the driver. Run that file only to confirm it fails for exactly that reason.

- [ ] **Step 1: Failing tests.** In `test/notify/notification-controls.test.ts`, change the `splits the catalogue as the spec does` expectation for admin to `["n6", "n7", "n10", "n14"]`, and add:

```ts
  it("keeps n14 email-only: a confirmation goes to an address with no player behind it (M39)", () => {
    expect(NOTIFICATION_CONTROLS.n14).toEqual({ scope: "admin", channels: ["email"] });
  });
```
In `test/routes/admin-notifications.test.ts` find the test that renders the admin grid for an admin and add an assertion that the page contains `Join confirmation` (the new `NAMES.n14`). Read that file to find the right helper for signing in as admin.

- [ ] **Step 2: Run** `npx vitest run test/notify/notification-controls.test.ts test/routes/admin-notifications.test.ts` — expected red on the two new assertions.

- [ ] **Step 3: Implement.**
  - `src/notify/dedupe-key.ts`: append `"n14"` to `NOTIFICATION_TYPES`. Add, near `pickerHandoverKey`:
    ```ts
    /**
     * N-14 join confirmation (M39): **no `notification_log` row and no key
     * builder.** `notification_log.player_id` is NOT NULL and there is no
     * player yet — that is the whole point of the message. Once-per-day is
     * kept by `join_confirmations` (`src/notify/send-join-confirmation.ts`),
     * and the provider key is a fresh UUID exactly as N-5's is.
     */
    ```
  - `src/notify/notification-controls.ts`: add `n14: { scope: "admin", channels: ["email"] },` and amend the doc comment's "adding `n14`" sentence to "adding `n15`".
  - `src/views/admin-notifications.ts`: add `n14: "Join confirmation"` to `NAMES`.
  - `src/db/schema.ts`, after `gameNotificationSettings`:
    ```ts
    /**
     * One row per (game, address, UTC day) that an N-14 join confirmation was
     * attempted for (M39, BR-53). Inserted *before* the send, so a primary-key
     * conflict is the once-per-day guard — the only thing stopping a leaked
     * invite link from making the form mail one victim eighty times a day.
     *
     * `email` is stranger-typed. Every insert also deletes rows older than
     * yesterday (`send-join-confirmation.ts`), so the table never holds more
     * than two days of addresses nobody has confirmed — the `signin_refusals`
     * ring-buffer argument, bounded by time instead of by count.
     */
    export const joinConfirmations = sqliteTable(
      "join_confirmations",
      {
        gameId: text("game_id")
          .notNull()
          .references(() => games.id, { onDelete: "cascade" }),
        email: text("email").notNull(),
        /** UTC date, YYYY-MM-DD, as `email_quota.day`. */
        day: text("day").notNull(),
        createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
      },
      (table) => [primaryKey({ columns: [table.gameId, table.email, table.day] })],
    );
    ```
  - Run `npm run db:generate`; confirm exactly one new `migrations/0025_*.sql` containing `CREATE TABLE \`join_confirmations\`` and the journal entry. Do not hand-edit the generated SQL.
  - `test/support/factories.ts`: add `"join_confirmations"` to `RESET_TABLES` **before** `"games"` (it has an FK to games; put it beside `game_notification_settings`).

- [ ] **Step 4: Run** the two test files again — green. Run `npx tsc --noEmit` — expect exactly one error class: the invariants suite's `DRIVERS` is `Partial`, so it compiles; if anything else fails, fix it here. Run `npx vitest run test/notify/notification-invariants.test.ts` and confirm the only failures are `no driver registered for n14`.

- [ ] **Step 5: Commit.**
```bash
git add src/notify/dedupe-key.ts src/notify/notification-controls.ts src/views/admin-notifications.ts src/db/schema.ts migrations test/support/factories.ts test/notify/notification-controls.test.ts test/routes/admin-notifications.test.ts
git commit -m "M39: n14 in the catalogue and the join_confirmations once-per-day table"
```

---

### Task 3: The N-14 sender and template

**Files:**
- Create: `src/notify/templates/join-confirmation.ts`, `src/notify/send-join-confirmation.ts`
- Test: `test/notify/send-join-confirmation.test.ts`, `test/notify/notification-invariants.test.ts` (driver)

**Interfaces:**
- Consumes: `signJoinToken`, `joinTokenExpiry` (Task 1); `joinConfirmations` (Task 2); `loadAdminNotificationSwitches` (`src/domain/app-settings.ts`, returns `{ isOn(type, channel) }`); `SITE_ORIGIN` from `src/notify/delivery.ts`; `Notifier`/`EmailMessage` from `src/notify/notifier.ts`; `DAILY_CEILING_REASON` from `src/notify/quota.ts`.
- Produces:
  ```ts
  export interface JoinConfirmationEmailPayload { name: string; gameName: string; confirmUrl: string }
  export function renderJoinConfirmationEmail(p: JoinConfirmationEmailPayload): { subject: string; html: string; text: string }

  export type JoinConfirmationOutcome =
    | { kind: "sent" } | { kind: "already-sent-today" } | { kind: "switched-off" }
    | { kind: "deferred" } | { kind: "failed"; reason: string };
  export interface SendJoinConfirmationParams {
    db: Db; notifier: Notifier; gameId: string; gameName: string; inviteToken: string;
    email: string;   // already normalised by the caller
    name: string;    // already trimmed
    now: Date; responseTokenSecret: string;
  }
  export function sendJoinConfirmation(p: SendJoinConfirmationParams): Promise<JoinConfirmationOutcome>
  export function utcDay(now: Date): string   // "YYYY-MM-DD"
  ```

- [ ] **Step 1: Failing tests.** Create `test/notify/send-join-confirmation.test.ts`, modelled on `test/notify/send-welcome.test.ts`'s `RecordingNotifier` (copy that class in; it is small):

```ts
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../src/db/client.js";
import { joinConfirmations } from "../../src/db/schema.js";
import { verifyJoinToken } from "../../src/domain/token.js";
import { renderJoinConfirmationEmail } from "../../src/notify/templates/join-confirmation.js";
import { sendJoinConfirmation, utcDay } from "../../src/notify/send-join-confirmation.js";
import { insertGame, requireEmailMessage, resetDatabase, setAdminSwitch } from "../support/factories.js";
// ...RecordingNotifier as in send-welcome.test.ts...

const db = getDb(env.DB);
const SECRET = env.RESPONSE_TOKEN_SECRET;
const NOW = new Date("2026-08-27T09:00:00Z");

async function seed() {
  const gameId = await insertGame(db, { name: "Thursday 7-a-side", inviteToken: "inv-abc" });
  return gameId;
}
function params(gameId: string, notifier: RecordingNotifier, overrides = {}) {
  return { db, notifier, gameId, gameName: "Thursday 7-a-side", inviteToken: "inv-abc",
    email: "jack@example.com", name: "Jack Hart", now: NOW, responseTokenSecret: SECRET, ...overrides };
}

describe("sendJoinConfirmation (N-14)", () => {
  beforeEach(resetDatabase);

  it("emails a working confirmation link and records the day", async () => {
    const gameId = await seed();
    const notifier = new RecordingNotifier();
    expect(await sendJoinConfirmation(params(gameId, notifier))).toEqual({ kind: "sent" });

    const message = requireEmailMessage(notifier.all[0]!);
    expect(message.to).toBe("jack@example.com");
    const url = new URL(message.text.match(/https?:\/\/\S+\/join\/\S+/)![0]);
    const jtoken = url.pathname.split("/").pop()!;
    const verified = await verifyJoinToken(jtoken, SECRET, NOW);
    expect(verified).toMatchObject({ ok: true, payload: { gameId, inviteToken: "inv-abc", email: "jack@example.com", name: "Jack Hart" } });

    const rows = await db.select().from(joinConfirmations);
    expect(rows).toEqual([expect.objectContaining({ gameId, email: "jack@example.com", day: "2026-08-27" })]);
  });

  it("sends at most one per address per game per UTC day (BR-53)", async () => {
    const gameId = await seed();
    const notifier = new RecordingNotifier();
    await sendJoinConfirmation(params(gameId, notifier));
    expect(await sendJoinConfirmation(params(gameId, notifier, { name: "Different Name" }))).toEqual({ kind: "already-sent-today" });
    expect(notifier.all).toHaveLength(1);
    // The next day is a new message.
    const tomorrow = new Date("2026-08-28T00:00:01Z");
    expect(await sendJoinConfirmation(params(gameId, notifier, { now: tomorrow }))).toEqual({ kind: "sent" });
  });

  it("prunes rows older than yesterday on every insert", async () => {
    const gameId = await seed();
    await db.insert(joinConfirmations).values([
      { gameId, email: "old@example.com", day: "2026-08-20", createdAt: NOW },
      { gameId, email: "yesterday@example.com", day: "2026-08-26", createdAt: NOW },
    ]);
    await sendJoinConfirmation(params(gameId, new RecordingNotifier()));
    const days = (await db.select().from(joinConfirmations)).map((r) => r.day).sort();
    expect(days).toEqual(["2026-08-26", "2026-08-27"]);
  });

  it("is masked by the administrator's n14 email switch, writing nothing", async () => {
    const gameId = await seed();
    await setAdminSwitch(db, "n14", "email", false);
    const notifier = new RecordingNotifier();
    expect(await sendJoinConfirmation(params(gameId, notifier))).toEqual({ kind: "switched-off" });
    expect(notifier.all).toHaveLength(0);
    expect(await db.select().from(joinConfirmations)).toHaveLength(0);
  });

  it("reports a daily-ceiling refusal as deferred and releases the day, so a retry can send", async () => {
    const gameId = await seed();
    const notifier = new RecordingNotifier();
    notifier.ceilingFor.add("jack@example.com");
    expect(await sendJoinConfirmation(params(gameId, notifier))).toEqual({ kind: "deferred" });
    expect(await db.select().from(joinConfirmations)).toHaveLength(0);
  });

  it("reports a provider failure and keeps the day (it may have been delivered)", async () => {
    const gameId = await seed();
    const notifier = new RecordingNotifier();
    notifier.failFor.add("jack@example.com");
    expect(await sendJoinConfirmation(params(gameId, notifier))).toEqual({ kind: "failed", reason: "simulated-provider-failure" });
    expect(await db.select().from(joinConfirmations)).toHaveLength(1);
  });
});

describe("renderJoinConfirmationEmail (BR-51)", () => {
  const rendered = renderJoinConfirmationEmail({
    name: "Jack <b>Hart</b>", gameName: "Thursday & Friday", confirmUrl: "https://makethe.team/join/tok",
  });

  it("names the game and the typed name, escaped", () => {
    expect(rendered.subject).toBe("Confirm you want to join Thursday & Friday");
    expect(rendered.html).toContain("Jack &lt;b&gt;Hart&lt;/b&gt;");
    expect(rendered.html).toContain("Thursday &amp; Friday");
    expect(rendered.html).not.toContain("<b>Hart</b>");
  });

  it("carries the confirmation link and nothing else a stranger could use", () => {
    for (const body of [rendered.html, rendered.text]) {
      expect(body).toContain("https://makethe.team/join/tok");
      expect(body).not.toMatch(/\/r\/|\/j\/|\/leave\/|\/cancel\//);
      expect(body).not.toMatch(/\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*day\b.*\d{1,2}:\d{2}/);
    }
    expect(rendered.text).toContain("If you didn't ask for this, ignore it");
  });
});

describe("utcDay", () => {
  it("is the UTC calendar date", () => {
    expect(utcDay(new Date("2026-08-27T23:59:59Z"))).toBe("2026-08-27");
    expect(utcDay(new Date("2026-08-28T00:00:00Z"))).toBe("2026-08-28");
  });
});
```

Then in `test/notify/notification-invariants.test.ts` add a driver (after `n13Driver`) and register `n14: n14Driver` in `DRIVERS`:

```ts
// --- n14: sendJoinConfirmation (test/notify/send-join-confirmation.test.ts) ---
// No recipient player to seed: N-14 is the one type addressed to someone who
// is not in `players` yet.
const n14Driver: Driver = {
  async seed(db) {
    return insertGame(db, { name: "Thursday 7-a-side", inviteToken: "n14-invite" });
  },
  async send(db, gameId, notifier) {
    await sendJoinConfirmation({
      db, notifier, gameId, gameName: "Thursday 7-a-side", inviteToken: "n14-invite",
      email: "n14-joiner@example.com", name: "Nia", now: new Date("2026-08-27T09:00:00Z"),
      responseTokenSecret: SECRET,
    });
  },
};
```

- [ ] **Step 2: Run** `npx vitest run test/notify/send-join-confirmation.test.ts test/notify/notification-invariants.test.ts` — red (module missing).

- [ ] **Step 3: Implement the template** `src/notify/templates/join-confirmation.ts`. Copy the HTML shell of `renderWelcomeEmail` (same palette, same table layout) with this content only:

```ts
import { escapeHtml } from "../../views/layout.js";

/**
 * N-14 (M39, BR-51). The only email the product sends to an address it does
 * not trust yet, so it carries the game's name, the name typed and one link —
 * and deliberately no fixture date, no response, invite or leave link and no
 * squad. Delivered to the wrong inbox, it tells its reader nothing.
 */
export interface JoinConfirmationEmailPayload {
  name: string;
  gameName: string;
  /** Absolute `/join/:jtoken` URL, server-built from `SITE_ORIGIN`. */
  confirmUrl: string;
}

export function renderJoinConfirmationEmail(payload: JoinConfirmationEmailPayload): { subject: string; html: string; text: string } {
  const { name, gameName, confirmUrl } = payload;
  const subject = `Confirm you want to join ${gameName}`;
  const lead = `Someone — probably you — asked to join the squad for ${gameName} as ${name}.`;
  const action = "Tap the button to confirm it's you and take your place in the squad.";
  const ignore = "If you didn't ask for this, ignore it — nothing happens unless you confirm.";
  const expiry = "The link works for seven days.";
  const html = /* welcome.ts shell with: <p>Hi ${escapeHtml(name)},</p><h1>${escapeHtml(gameName)}</h1>
     <p>${escapeHtml(lead)}</p><p>${escapeHtml(action)}</p>
     button "Yes, join the squad" → href="${escapeHtml(confirmUrl)}"
     fallback "If the button doesn't work, copy this address…" + ${escapeHtml(confirmUrl)}
     <p>${escapeHtml(expiry)}</p><hr><p>${escapeHtml(ignore)}</p> — NO leave link, NO dashboard link */ ;
  const text = [`Hi ${name},`, "", gameName, "", lead, action, "", "Yes, join the squad:", confirmUrl, "", expiry, "", "---", ignore, ""].join("\n");
  return { subject, html, text };
}
```
(Write the real HTML, not the comment; the comment lists what it must and must not contain.)

- [ ] **Step 4: Implement the sender** `src/notify/send-join-confirmation.ts`:

```ts
import { and, eq, lt } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { joinConfirmations } from "../db/schema.js";
import { loadAdminNotificationSwitches } from "../domain/app-settings.js";
import { joinTokenExpiry, signJoinToken } from "../domain/token.js";
import { joinConfirmPath } from "../auth/paths.js";
import { SITE_ORIGIN } from "./delivery.js";
import type { Notifier } from "./notifier.js";
import { DAILY_CEILING_REASON } from "./quota.js";
import { renderJoinConfirmationEmail } from "./templates/join-confirmation.js";

export type JoinConfirmationOutcome =
  | { kind: "sent" }
  | { kind: "already-sent-today" }
  | { kind: "switched-off" }
  | { kind: "deferred" }
  | { kind: "failed"; reason: string };

export interface SendJoinConfirmationParams {
  db: Db;
  /** Always the quota-wrapped notifier from `createNotifier` (TR-31). */
  notifier: Notifier;
  gameId: string;
  gameName: string;
  inviteToken: string;
  /** Already normalised (`normaliseEmail`). */
  email: string;
  /** Already trimmed and non-empty. */
  name: string;
  now: Date;
  responseTokenSecret: string;
}

/** The UTC calendar day, the same convention `email_quota.day` uses. */
export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function dayBefore(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return utcDay(d);
}

/**
 * Send N-14 (M39). **No `notification_log` row**: `player_id` there is NOT
 * NULL and there is no player yet. The once-per-day guard is the primary key
 * of `join_confirmations`, claimed *before* the send so two concurrent
 * submissions cannot both mail the same address — one of them hits the
 * conflict and reports `already-sent-today`.
 *
 * The day is released on a ceiling refusal (the message never left) and kept
 * on a provider failure (it may have), matching how `notification_log` rows
 * are treated by every other sender.
 */
export async function sendJoinConfirmation(params: SendJoinConfirmationParams): Promise<JoinConfirmationOutcome> {
  const { db, notifier, gameId, gameName, inviteToken, email, name, now, responseTokenSecret } = params;

  const admin = await loadAdminNotificationSwitches(db);
  if (!admin.isOn("n14", "email")) return { kind: "switched-off" };

  const day = utcDay(now);
  // Two days, not one: a row from yesterday must survive so that a request at
  // 23:59 and its retry at 00:01 are still two different days, not a prune of
  // the row that was just written.
  await db.delete(joinConfirmations).where(lt(joinConfirmations.day, dayBefore(day)));
  const claimed = await db
    .insert(joinConfirmations)
    .values({ gameId, email, day, createdAt: now })
    .onConflictDoNothing()
    .returning({ day: joinConfirmations.day });
  if (claimed.length === 0) return { kind: "already-sent-today" };

  const jtoken = await signJoinToken(
    { gameId, inviteToken, email, name, expiresAt: joinTokenExpiry(now).getTime() },
    responseTokenSecret,
  );
  const rendered = renderJoinConfirmationEmail({ name, gameName, confirmUrl: `${SITE_ORIGIN}${joinConfirmPath(jtoken)}` });

  const [result] = await notifier.send([
    // A fresh UUID, as N-5 uses: each issuance is a distinct message, and
    // keying on the token would write a live credential into provider logs.
    { channel: "email", to: email, subject: rendered.subject, html: rendered.html, text: rendered.text, dedupeKey: `n14:${crypto.randomUUID()}` },
  ]);
  if (result === undefined) return { kind: "failed", reason: "notifier-contract-violation" };
  if (result.ok) return { kind: "sent" };
  if (result.error === DAILY_CEILING_REASON) {
    await db.delete(joinConfirmations).where(and(eq(joinConfirmations.gameId, gameId), eq(joinConfirmations.email, email), eq(joinConfirmations.day, day)));
    return { kind: "deferred" };
  }
  return { kind: "failed", reason: result.error };
}
```
Add to `src/auth/paths.ts` (Task 5 mounts the route; the constant is needed now):
```ts
/** M39: the confirmation link in an N-14 email. Public, token-bearing, rate-limited like `/j/*`. */
export const JOIN_CONFIRM_PREFIX = "/join/*";
export function joinConfirmPath(jtoken: string): string {
  return `/join/${encodeURIComponent(jtoken)}`;
}
```

- [ ] **Step 5: Run** both test files — green, including the invariants baseline and invariant 2 for `n14.email`. Then `npm run lint && npx tsc --noEmit`.

- [ ] **Step 6: Commit.**
```bash
git add src/notify/templates/join-confirmation.ts src/notify/send-join-confirmation.ts src/auth/paths.ts test/notify/send-join-confirmation.test.ts test/notify/notification-invariants.test.ts
git commit -m "M39: N-14 join confirmation sender, once per address per game per day"
```

---

### Task 4: `POST /j/:token` sends instead of seating an unverified address

**Files:**
- Modify: `src/domain/join-squad.ts`, `src/routes/join.ts`, `src/views/join.ts`
- Test: `test/routes/join.test.ts`, `test/domain/join-squad.test.ts` (if present; else the route tests cover it)

**Interfaces:**
- Consumes: `sendJoinConfirmation` (Task 3).
- Produces: `JoinSquadParams.emailVerifiedAt?: Date` — when given, set on a created row and `coalesce`d onto a reused one. `renderCheckInboxPage({ gameName, email })` in `src/views/join.ts`. In `src/routes/join.ts` an exported `isVerifiedAddress(db, email): Promise<boolean>`.
- Ruling recorded here: the spec's "viewer signed in → join as today" branch needs **no code**. `link-player.ts` stamps `email_verified_at` on every sign-in, so a signed-in player typing their own address is a verified address. A signed-in player typing a *different* address gets the confirmation flow, which is right.

- [ ] **Step 1: Failing tests.** In `test/routes/join.test.ts`, the `POST /j/:token` block's existing joins all use fresh addresses and will now take the confirmation path. Rework as follows:
  - Add a helper `insertVerifiedPlayer(db, email)` at the top: `insertPlayer(db, { email, emailVerifiedAt: NOW })`.
  - In every existing test that expects a join to happen (`creates the player and the membership and welcomes them`, `answers both halves of a double-tapped join`, `welcomes someone back after they had left`, `puts a late joiner into the open fixture`, `shows the onboarding CTA`), seed the address as a verified player first so the test keeps proving what it proved.
  - Add:

```ts
  it("seats nobody for an address it has never verified — one email, no rows (BR-47)", async () => {
    const { db, game } = await seedGame();
    const before = {
      players: (await db.select().from(players)).length,
      memberships: (await db.select().from(memberships)).length,
      responses: (await db.select().from(responsesTable)).length,
      audit: (await db.select().from(auditLog)).length,
    };
    const response = await joinPost(game.inviteToken, { name: "Jack Hart", email: "Jack@Example.com" });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Check your inbox");
    expect(html).toContain("jack@example.com");

    expect((await db.select().from(players)).length).toBe(before.players);
    expect((await db.select().from(memberships)).length).toBe(before.memberships);
    expect((await db.select().from(responsesTable)).length).toBe(before.responses);
    expect((await db.select().from(auditLog)).length).toBe(before.audit);
    expect(await notificationRowsAfterSettling()).toHaveLength(0);
    expect(await db.select().from(joinConfirmations)).toEqual([
      expect.objectContaining({ gameId: game.id, email: "jack@example.com" }),
    ]);
  });

  it("treats a known but unverified address the same way, then confirmation verifies it", async () => {
    const { db, game } = await seedGame();
    const playerId = await insertPlayer(db, { email: "legacy@example.com", emailVerifiedAt: null });
    const response = await joinPost(game.inviteToken, { name: "Legacy", email: "legacy@example.com" });
    expect(await response.text()).toContain("Check your inbox");
    expect(await db.select().from(memberships).where(eq(memberships.playerId, playerId))).toHaveLength(0);
  });

  it("still joins a verified address in one click", async () => {
    const { db, game } = await seedGame();
    await insertVerifiedPlayer(db, "ada@example.com");
    const response = await joinPost(game.inviteToken, { name: "Ada", email: "ada@example.com" });
    expect(await response.text()).toContain("You're in");
    await waitForNotificationRows(1);
  });

  it("shows the inbox page again on a same-day resubmit rather than revealing the guard", async () => {
    const { game } = await seedGame();
    await joinPost(game.inviteToken, { name: "Jack", email: "jack@example.com" });
    const again = await joinPost(game.inviteToken, { name: "Jack", email: "jack@example.com" });
    expect(again.status).toBe(200);
    expect(await again.text()).toContain("Check your inbox");
  });
```
Import `auditLog`, `joinConfirmations` from the schema. Update the TR-16 capture in `test/routes/signin.test.ts` only if it breaks (its POST uses an already-member signed-in player — verified by sign-in — so it should not).

- [ ] **Step 2: Run** `npx vitest run test/routes/join.test.ts` — red.

- [ ] **Step 3: Implement.**
  - `src/domain/join-squad.ts`: add `emailVerifiedAt?: Date` to `JoinSquadParams`. In `attemptJoin`, on insert pass `emailVerifiedAt: params.emailVerifiedAt ?? null`; when `existing` is found and `params.emailVerifiedAt` is set, run
    ```ts
    // An earlier verification is never moved forward (link-player.ts's rule):
    // the column records when we *first* knew the address reached them.
    await db.update(players)
      .set({ emailVerifiedAt: sql`coalesce(${players.emailVerifiedAt}, ${params.emailVerifiedAt.getTime()})` })
      .where(eq(players.id, existing.id));
    ```
  - `src/views/join.ts`: add
    ```ts
    export interface CheckInboxPageParams { gameName: string; email: string }
    /** M39. Shows the submitter their own address back (as the 422 branch already does) and nothing about the squad. */
    export function renderCheckInboxPage({ gameName, email }: CheckInboxPageParams): string {
      const body = `
        <h1>Check your inbox</h1>
        <p>We've sent an email to <strong>${escapeHtml(email)}</strong> to confirm you want to join ${escapeHtml(gameName)}.</p>
        <p>Tap the button in it and you're in. If it hasn't arrived in a few minutes, check your spam folder — and check the address above is right. If it isn't, go back and try again.</p>
      `;
      return layout({ title: `Join ${gameName} — Make The Team`, body, pageStyles: [FORM_CSS] });
    }
    ```
  - `src/routes/join.ts`: after the 422 checks and before `joinSquad`:
    ```ts
    if (!(await isVerifiedAddress(db, email))) {
      // BR-47: nothing is written for an address nobody has proved reaches
      // anyone. The send is awaited, not handed to waitUntil — the page says
      // "we've sent", and a ceiling refusal must not make that a lie; it is
      // reported on the same page instead.
      const outcome = await sendJoinConfirmation({
        db, notifier: createNotifier(c.env, db, now), gameId: game.id, gameName: game.name,
        inviteToken: game.inviteToken, email, name, now, responseTokenSecret: c.env.RESPONSE_TOKEN_SECRET,
      });
      if (outcome.kind === "failed" || outcome.kind === "deferred") {
        console.error(`join confirmation (N-14) not sent for game ${game.id}: ${outcome.kind}${outcome.kind === "failed" ? ` ${outcome.reason}` : ""}`);
        return c.html(await invitePageFor({ db, game, now, values: { name, email }, error: "We couldn't send the confirmation email just now. Please try again in a little while." }), 503);
      }
      // `sent`, `already-sent-today` and `switched-off` all show the same page:
      // the first two so a resubmit does not reveal the guard, the third so an
      // administrator switching N-14 off closes joining rather than reopening
      // the unconfirmed path.
      return c.html(renderCheckInboxPage({ gameName: game.name, email }));
    }
    ```
    and
    ```ts
    /** BR-47: only a row with `email_verified_at` counts. Guests and erased rows have null email and never match. */
    export async function isVerifiedAddress(db: Db, email: string): Promise<boolean> {
      const [row] = await db.select({ verified: players.emailVerifiedAt }).from(players).where(eq(players.email, email)).limit(1);
      return row?.verified != null;
    }
    ```
    Add the imports (`players`, `eq`, `sendJoinConfirmation`, `renderCheckInboxPage`).

- [ ] **Step 4: Run** `npx vitest run test/routes/join.test.ts test/routes/signin.test.ts` — green. Then `npm run lint && npx tsc --noEmit`, then the full `npm test` in the foreground.

- [ ] **Step 5: Commit.**
```bash
git add src/domain/join-squad.ts src/routes/join.ts src/views/join.ts test/routes/join.test.ts
git commit -m "M39: an unverified address gets a confirmation email, not a seat (BR-47)"
```

---

### Task 5: `GET|POST /join/:jtoken`

**Files:**
- Modify: `src/routes/join.ts`, `src/views/join.ts`, `src/app.ts`, `test/routes/signin.test.ts`
- Test: `test/routes/join-confirm.test.ts`

**Interfaces:**
- Consumes: `verifyJoinToken` (Task 1), `joinSquad({ emailVerifiedAt })` (Task 4), `notifyJoiner` + `backfillOpenFixtureResponses` (existing, `src/routes/join.ts`), `findGameByInviteToken` (`src/db/queries.ts`), `JOIN_CONFIRM_PREFIX` (Task 3).
- Produces: `renderJoinConfirmPage({ gameName, venueName, name, action })` in `src/views/join.ts`.

- [ ] **Step 1: Failing tests.** Create `test/routes/join-confirm.test.ts`:

```ts
import { SELF, env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { auditLog, games, memberships, players } from "../../src/db/schema.js";
import { joinTokenExpiry, signJoinToken, signLeaveToken, leaveTokenExpiry } from "../../src/domain/token.js";
import { insertGame, insertPlayer, resetDatabase, testDb } from "../support/factories.js";
import { ORIGIN } from "../support/sign-in.js";

const SECRET = env.RESPONSE_TOKEN_SECRET;
const NOW = new Date();

async function seed() {
  const db = testDb();
  const gameId = await insertGame(db, { inviteToken: "inv-1" });
  const jtoken = await signJoinToken(
    { gameId, inviteToken: "inv-1", email: "jack@example.com", name: "Jack Hart", expiresAt: joinTokenExpiry(NOW).getTime() },
    SECRET,
  );
  return { db, gameId, jtoken };
}
const get = (t: string) => SELF.fetch(`${ORIGIN}/join/${t}`);
const post = (t: string, origin: string | null = ORIGIN) =>
  SELF.fetch(`${ORIGIN}/join/${t}`, { method: "POST", headers: origin ? { origin } : {}, redirect: "manual" });

describe("GET /join/:jtoken", () => {
  beforeEach(resetDatabase);

  it("asks 'Join X as Name?' and writes nothing (BR-50)", async () => {
    const { db, jtoken } = await seed();
    const response = await get(jtoken);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Jack Hart");
    expect(html).toContain("Thursday 7-a-side");
    expect(html).toContain(`action="/join/${jtoken}"`);
    expect(await db.select().from(players)).toHaveLength(0);
    expect(await db.select().from(memberships)).toHaveLength(0);
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("escapes the typed name", async () => {
    const { gameId } = await seed();
    const jtoken = await signJoinToken({ gameId, inviteToken: "inv-1", email: "x@example.com", name: "<img src=x>", expiresAt: joinTokenExpiry(NOW).getTime() }, SECRET);
    const html = await (await get(jtoken)).text();
    expect(html).not.toContain("<img src=x>");
    expect(html).toContain("&lt;img src=x&gt;");
  });

  it("404s a rotated invite link without explaining (BR-49)", async () => {
    const { db, gameId, jtoken } = await seed();
    await db.update(games).set({ inviteToken: "inv-2" }).where(eq(games.id, gameId));
    expect((await get(jtoken)).status).toBe(404);
    expect((await post(jtoken)).status).toBe(404);
  });

  it("404s garbage, an expired token and a leave token", async () => {
    const { gameId } = await seed();
    expect((await get("not-a-token")).status).toBe(404);
    const expired = await signJoinToken({ gameId, inviteToken: "inv-1", email: "a@b.co", name: "A", expiresAt: NOW.getTime() - 1 }, SECRET);
    expect((await get(expired)).status).toBe(404);
    const leave = await signLeaveToken({ gameId, playerId: "p", expiresAt: leaveTokenExpiry(NOW).getTime() }, SECRET);
    expect((await get(leave)).status).toBe(404);
  });
});

describe("POST /join/:jtoken", () => {
  beforeEach(resetDatabase);

  it("creates the player verified, seats them, and welcomes them (BR-48)", async () => {
    const { db, gameId, jtoken } = await seed();
    const response = await post(jtoken);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("You're in");
    const [player] = await db.select().from(players).where(eq(players.email, "jack@example.com"));
    expect(player?.name).toBe("Jack Hart");
    expect(player?.emailVerifiedAt).not.toBeNull();
    expect(await db.select().from(memberships).where(eq(memberships.gameId, gameId))).toHaveLength(1);
    // reuse join.test.ts's waitForNotificationRows pattern to see the N-6 land
  });

  it("verifies a legacy unverified row instead of creating a second person", async () => {
    const { db, jtoken } = await seed();
    const legacyId = await insertPlayer(db, { email: "jack@example.com", emailVerifiedAt: null, name: "Jack H" });
    await post(jtoken);
    const rows = await db.select().from(players).where(eq(players.email, "jack@example.com"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(legacyId);
    expect(rows[0]!.emailVerifiedAt).not.toBeNull();
  });

  it("never moves an earlier verification forward", async () => {
    const { db, jtoken } = await seed();
    const earlier = new Date("2026-01-01T00:00:00Z");
    await insertPlayer(db, { email: "jack@example.com", emailVerifiedAt: earlier });
    await post(jtoken);
    const [row] = await db.select().from(players).where(eq(players.email, "jack@example.com"));
    expect(row!.emailVerifiedAt).toEqual(earlier);
  });

  it("is idempotent: a second click says already in", async () => {
    const { jtoken } = await seed();
    await post(jtoken);
    expect(await (await post(jtoken)).text()).toContain("already in this squad");
  });

  it("refuses a cross-site post", async () => {
    const { jtoken } = await seed();
    expect((await post(jtoken, "https://evil.example")).status).toBe(403);
  });

  it("records the join as arriving by invite link, actor null", async () => {
    const { db, jtoken } = await seed();
    await post(jtoken);
    const [row] = await db.select().from(auditLog).where(eq(auditLog.action, "membership.joined"));
    expect(row!.actorPlayerId).toBeNull();
    expect(JSON.parse(row!.afterJson!)).toMatchObject({ via: "invite_link" });
  });
});
```
Also in `test/routes/signin.test.ts`: add `capture("join confirm", /Join the squad as/, new Request(\`${ORIGIN}/join/${jtoken}\`))` next to the existing `invite` capture (mint the token there with `signJoinToken` for the seeded game), and add `"GET /join/:jtoken": "join confirm"` plus a `POST /join/:jtoken` exclusion entry with the same reasoning the file gives `POST /leave/:token` (renders the same outcome page as `POST /j/:token`, covered in `test/routes/join-confirm.test.ts`).

- [ ] **Step 2: Run** `npx vitest run test/routes/join-confirm.test.ts test/routes/signin.test.ts` — red.

- [ ] **Step 3: Implement.**
  - `src/views/join.ts`:
    ```ts
    export interface JoinConfirmPageParams { gameName: string; venueName: string; name: string; action: string }
    /**
     * M39, BR-50. The `GET` behind a confirmation link: one sentence and one
     * button. A `GET` that joined would let every mail scanner that follows
     * links join squads on people's behalf.
     */
    export function renderJoinConfirmPage({ gameName, venueName, name, action }: JoinConfirmPageParams): string {
      const body = `
        <h1>Join the squad as ${escapeHtml(name)}?</h1>
        <p>${escapeHtml(gameName)} at ${escapeHtml(venueName)}.</p>
        <form method="post" action="${escapeHtml(action)}">
          <div class="actions"><button class="button primary" type="submit">Yes, join the squad</button></div>
        </form>
        <p>Not you? Just close this page — nothing happens unless you press the button.</p>
      `;
      return layout({ title: `Join ${gameName} — Make The Team`, body, pageStyles: [FORM_CSS] });
    }
    ```
  - `src/routes/join.ts`: a shared resolver and two handlers:
    ```ts
    /**
     * The game a join token points at, or null. `findGameByInviteToken` with the
     * token's *own* invite token, then an id check: a rotated link (BR-49), an
     * inactive game and a forged pairing all fall out as one flat 404.
     */
    async function resolveJoinToken(c: Context<AppEnv>, db: Db, now: Date) {
      const verified = await verifyJoinToken(c.req.param("jtoken"), c.env.RESPONSE_TOKEN_SECRET, now);
      if (!verified.ok) return null;
      const game = await findGameByInviteToken(db, verified.payload.inviteToken);
      if (game === null || game.id !== verified.payload.gameId) return null;
      return { game, payload: verified.payload };
    }

    join.get("/join/:jtoken", async (c) => {
      const now = new Date(Date.now());
      const db = getDb(c.env.DB);
      const resolved = await resolveJoinToken(c, db, now);
      if (resolved === null) return c.html(renderNotFoundPage(), 404);
      return c.html(renderJoinConfirmPage({
        gameName: resolved.game.name, venueName: resolved.game.venueName,
        name: resolved.payload.name, action: joinConfirmPath(c.req.param("jtoken")),
      }));
    });

    join.post("/join/:jtoken", async (c) => {
      if (wrongOrigin(c)) return c.text("Forbidden", 403);
      const now = new Date(Date.now());
      const db = getDb(c.env.DB);
      const resolved = await resolveJoinToken(c, db, now);
      if (resolved === null) return c.text("Not found", 404);
      const { game, payload } = resolved;
      // BR-48: the same join `POST /j/:token` performs for a verified address,
      // plus the verification stamp — the click on this link is the proof.
      const outcome = await joinSquad({ db, gameId: game.id, name: payload.name, email: payload.email, now, emailVerifiedAt: now });
      if (outcome.kind === "joined" || outcome.kind === "rejoined") {
        const backfilled = await backfillOpenFixtureResponses(db, game.id, outcome.playerId);
        c.executionCtx.waitUntil(notifyJoiner(c.env, game.id, outcome, now, backfilled));
      }
      const firstFixture = await findFirstUpcomingFixture(db, game.id, now);
      return c.html(renderJoinOutcomePage({ kind: outcome.kind, gameName: game.name, venueName: game.venueName,
        firstFixture: firstFixture ? { local: formatLocalDateTime(firstFixture.kicksOffAt, game.timezone), lifecycle: firstFixture.lifecycle } : null }));
    });
    ```
    Extract the outcome-page rendering shared with `POST /j/:token` into one local function rather than duplicating it.
  - `src/app.ts`: add `JOIN_CONFIRM_PREFIX` to the `tokenRateLimit()` prefix list and give `/join/*` the same `private, no-store` middleware as `/j/*` (one loop over both prefixes; the comment there already gives the reason).
  - Update the module doc comment of `src/routes/join.ts` and `src/security/rate-limit.ts`'s family list to name `/join/:jtoken`.

- [ ] **Step 4: Run** the two test files, then `npm run lint && npx tsc --noEmit`, then full `npm test` in the foreground.

- [ ] **Step 5: Commit.**
```bash
git add src/routes/join.ts src/views/join.ts src/app.ts src/security/rate-limit.ts test/routes/join-confirm.test.ts test/routes/signin.test.ts
git commit -m "M39: /join/:jtoken confirms a join — GET asks, POST seats (BR-48–50)"
```

---

### Task 6: "Unconfirmed" on the owner's squad page (BR-52)

**Files:**
- Modify: `src/db/queries.ts` (`listSquad`), `src/routes/games.ts` (the squad mapping near `muted: isMuted(member, now)`), `src/views/game-overview.ts`, `src/views/styles.ts`
- Test: `test/views/game-overview.test.ts` (find the existing squad-row tests; add there) and `test/views/style-cascade.test.ts` only if a collision appears

- [ ] **Step 1: Failing test.** In the game-overview view tests add a case rendering a squad with one member `unconfirmed: true` and one `unconfirmed: false`, asserting the first row contains `<span class="member-unconfirmed">Unconfirmed</span>` and the second does not; and that a guest (`isGuest: true`) is never marked even with `unconfirmed: true` (a guest has no address to confirm).

- [ ] **Step 2: Run** it — red (type error on `unconfirmed`).

- [ ] **Step 3: Implement.**
  - `listSquad`: add `emailVerifiedAt: players.emailVerifiedAt` to the select and the return type.
  - `src/routes/games.ts`: in the squad mapping add `unconfirmed: !member.isGuest && member.emailVerifiedAt === null,`.
  - `src/views/game-overview.ts`: add `unconfirmed: boolean` to the squad member type with the doc comment
    ```ts
    /**
     * Null `email_verified_at` (M39, BR-52): a member seated before confirm-to-join
     * existed, whose address has never answered. Shown so the organiser can
     * tidy legacy rows by hand; nothing removes them automatically.
     */
    ```
    and render `const unconfirmed = member.unconfirmed ? ' <span class="member-unconfirmed">Unconfirmed</span>' : "";` beside `muted`, placed after `${muted}`.
  - `src/views/styles.ts`: find `.member-muted` and add `.member-unconfirmed` with the same rule set (or extend the selector to `.member-muted, .member-unconfirmed`). It is inside an existing registered block, so nothing new to add to `PAGE_STYLE_BLOCKS` — state that in the commit message.

- [ ] **Step 4: Look at it (CLAUDE.md rule 3).** `npx playwright test --grep "@capture game-overview"` (find the exact catalogue id in `test/browser/catalogue.ts`) after adding an unverified member to the browser world if the world has none; read the PNG in `test/browser/screenshots/`. Then `npx vitest run test/views` and full `npm test`.

- [ ] **Step 5: Commit.**
```bash
git add src/db/queries.ts src/routes/games.ts src/views/game-overview.ts src/views/styles.ts test/views/game-overview.test.ts
git commit -m "M39: mark legacy unconfirmed members on the squad page (BR-52)"
```

---

### Task 7: Docs, catalogue captures, known-issues, and the whole-branch check

**Files:**
- Modify: `docs/guide/02-inviting-your-squad.md`, `docs/guide/05-running-your-squad.md`, `docs/guide/manifest.json`, `docs/known-issues.md`, `test/browser/catalogue.ts`, `test/browser/world.ts` (if the world needs a join token), the spec's status line.

- [ ] **Step 1: Guide.** In `02-inviting-your-squad.md` under "What a player sees", add a paragraph: after typing a name and address the player is told to check their inbox; the email has one button; pressing it puts them in the squad and shows the "You're in" page. Anyone who has joined a game before, or signed in, skips the email. In `05-running-your-squad.md` in the squad section, one sentence on the **Unconfirmed** tag and that Remove is the way to tidy such a row.
- [ ] **Step 2: Browser catalogue.** Add two `CataloguePage` entries after `join`: `join-inbox` (POST result — check how the catalogue drives a POST; if it cannot, mark it `note`-only and capture via a route test's HTML instead) and `join-confirm` (`GET /join/:jtoken`, persona anonymous, the world minting a token with `signJoinToken` from its seeded game). Run `npx playwright test --grep "@capture join"` and read both PNGs. Do **not** run `npm run guide:capture` (broken by TR-37; see memory) — add the two ids to `docs/guide/manifest.json` with a note that images are pending the guide-capture fix.
- [ ] **Step 3: known-issues row 25.** Append: `**Closed by M39, <date>.** …the join itself is now prevented for any address the product has not verified (BR-47); a leaked link buys one confirmation email per address per game per day (BR-53) and no row.` Strike the row title as the file's convention does for closed rows and set the trigger column to `Closed`.
- [ ] **Step 4: Spec status.** Change the spec's status line to `implemented in M39`.
- [ ] **Step 5: Verify.** `npm run lint && npx tsc --noEmit`, full `npm test` in the foreground, then `npx playwright test` in the foreground.
- [ ] **Step 6: Commit.**
```bash
git add docs/guide/02-inviting-your-squad.md docs/guide/05-running-your-squad.md docs/guide/manifest.json docs/known-issues.md docs/superpowers/specs/2026-08-26-confirm-to-join-design.md test/browser/catalogue.ts test/browser/world.ts
git commit -m "M39: guide, catalogue captures and known-issues closure for confirm-to-join"
```

---

## Self-review notes

- Spec coverage: BR-47 (T4), BR-48 (T1, T5), BR-49 (T1 shape check, T5 rotation test), BR-50 (T5 GET test), BR-51 (T3 template tests), BR-52 (T6), BR-53 (T2 table, T3 dedupe/admin-switch tests). Invariants 1–7 from the spec: 1 → T4; 2 → T1; 3 → T5; 4 → T3; 5 → T5; 6 → T2/T3; 7 → T5.
- Deliberately not done: a `TOKEN_LIMITER` test for `/join/*` (the limiter is untestable under vitest — no `CF-Connecting-IP`, bindings optional) — the mount is asserted by reading `src/app.ts` in review.
- Type consistency: `sendJoinConfirmation` params in T3 match the call in T4; `joinConfirmPath` is defined in T3 and used in T3 and T5; `emailVerifiedAt` on `JoinSquadParams` is defined in T4 and used in T5.

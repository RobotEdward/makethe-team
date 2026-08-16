# Player Account Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a player an account page showing their name, email and last 20 fixtures across every game; give an organiser a read-only view of one of their own squad members; and put a sign-in link on the home page.

**Architecture:** Two separate pages rather than one URL branching on the viewer. `/app/account` names no player id, so its subject is always the session's own player. `/g/:id/squad/:playerId` is game-scoped and entitled by the existing `loadSquadTarget` helper, which already answers 404 for a game you don't organise and for a player who isn't in it. The fixture history reuses the dashboard's existing joined query, with the lifecycle filter lifted out of the shared security predicate so history can include `played` and `cancelled` without touching the parts that keep one player out of another's rows.

**Tech Stack:** TypeScript, Hono, Drizzle ORM over Cloudflare D1, Better Auth, Vitest with `@cloudflare/vitest-pool-workers` (`SELF.fetch` against the real Worker), Playwright for the browser catalogue.

**Spec:** `docs/superpowers/specs/2026-08-16-player-account-design.md`

## Global Constraints

- **Worktree:** all work happens in `/home/edward/src/maketheteam-m11-player-account` on branch `m11-player-account`. The spec is already committed there.
- **No migration.** This milestone adds no column and no table. If you find yourself editing `src/db/schema.ts`, stop — something has gone wrong.
- **TR-18 — guards establish *who*, never *what*.** `requirePlayer` says a signed-in player is asking. Every entitlement question is re-asked against the database inside the handler. A failed entitlement check answers `c.text("Not found", 404)`, never 403, so an id cannot be probed for existence.
- **TR-5 — every timezone conversion goes through `formatLocalDateTime` from `src/domain/time/zone.ts`.** Never format a date any other way.
- **No bare `new Date()` below the route edge.** A lint rule enforces it. Read the clock once per handler as `const now = new Date(Date.now())` and pass it down.
- **TR-16 — no `type="password"` and no password field anywhere.**
- **Escape everything.** Every interpolation into HTML goes through `escapeHtml` from `src/views/layout.ts`, including `href` values built from ids.
- **Vocabulary:** the domain word is **Player**, never "user". `user` is Better Auth's own model name and is confined to `src/db/schema.ts` and `src/auth/`.
- **Origin check on every state-changing POST:** `if (origin !== undefined && origin !== originOf(c.env)) return c.text("Forbidden", 403);`
- **Verification commands**, run from the worktree root: `npm run lint`, `npm run typecheck`, `npm test`. All three must pass before any commit.
- **Commit trailers** on every commit:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01WzHAQF3vBYdjm3A3hw2Jkt
  ```

## File Structure

**Created:**
- `src/domain/player-name.ts` — validates a submitted name. Pure, no database, no markup.
- `src/views/account.ts` — renders `/app/account`.
- `src/views/squad-member.ts` — renders `/g/:id/squad/:playerId`.
- `test/domain/player-name.test.ts`
- `test/routes/account.test.ts`

**Modified:**
- `src/auth/paths.ts` — `ACCOUNT_PATH`, `memberDetailPath()`.
- `src/domain/audit.ts` — the `player.renamed` action.
- `src/db/dashboard-queries.ts` — `listPlayerFixtureHistory`, and `entitledTo` parameterised.
- `src/routes/account.ts` — `GET` and `POST /app/account`.
- `src/routes/games.ts` — `GET /g/:id/squad/:playerId`.
- `src/routes/home.ts` — the sign-in link.
- `src/views/game-overview.ts` — the "View details" link in the per-member disclosure.
- `test/routes/squad.test.ts` — the organiser view's tests.
- `test/routes/dashboard.test.ts` — nothing new, but the `entitledTo` refactor must leave it green.
- `test/browser/catalogue.ts`, `test/browser/catalogue.spec.ts`, `test/routes/signin.test.ts` — the three registration guards.

**No new CSS.** The account page composes `FIXTURE_STYLES_CSS`, `DASHBOARD_STYLES_CSS` and `FORM_CSS`, all already exported from `src/views/styles.ts`; the squad-member page uses `FORM_CSS`. Adding a style block for two pages that need no new visual idiom would be the M10 design treatment undone.

---

### Task 1: The sign-in link on the home page

The smallest independent deliverable, and it unblocks nothing else — do it first so the branch has something shippable on it immediately.

**Files:**
- Modify: `src/routes/home.ts:8-18`
- Test: `test/routes/signin.test.ts` (an existing suite — add one case)

**Interfaces:**
- Consumes: `SIGN_IN_PATH` from `src/auth/paths.js` (already exported).
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Write the failing test**

Add to `test/routes/signin.test.ts`, inside the existing top-level `describe` block that covers the sign-in page (put it next to the other `GET /` assertions if there are any, otherwise at the end of the file before the final closing brace):

```ts
describe("the home page's way in", () => {
  it("links to the sign-in page", async () => {
    const body = await (await SELF.fetch(`${ORIGIN}/`)).text();
    expect(body).toContain(`href="${SIGN_IN_PATH}"`);
  });
});
```

`SELF`, `ORIGIN` and `SIGN_IN_PATH` are already imported by that file — check the import block at the top and only add what is genuinely missing.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/routes/signin.test.ts`
Expected: FAIL — the home page body contains no `href="/sign-in"`.

- [ ] **Step 3: Write minimal implementation**

Replace the body in `src/routes/home.ts`:

```ts
import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import { PRIVACY_PATH, SIGN_IN_PATH } from "../auth/paths.js";
import { layout } from "../views/layout.js";

export const home = new Hono<AppEnv>();

/**
 * The holding page, and the only link into the signed-in half of the site.
 *
 * The sign-in link is **unconditional** — it does not become "Your dashboard"
 * for somebody already signed in. `/` sits outside every mount of
 * `sessionMiddleware` on purpose (see that middleware's own doc comment on
 * blast radius), so personalising this one word would mean either a fourth
 * mount or a `resolveSessionPlayer` call, putting a cookie parse and an HMAC
 * verification on every hit to the page strangers, prefetchers and crawlers
 * reach. `/sign-in` already bounces an existing session to the dashboard, so
 * the unconditional link is not even wrong for a signed-in visitor.
 */
home.get("/", (c) =>
  c.html(
    layout({
      title: "Make The Team",
      body: `<h1>Make The Team</h1>
             <p>Getting a regular game on, without the group chat.</p>
             <p><a href="${SIGN_IN_PATH}">Sign in</a></p>
             <p><a href="${PRIVACY_PATH}">Privacy</a></p>`,
      centred: true,
    }),
  ),
);
```

- [ ] **Step 4: Run the full verification**

Run: `npm run lint && npm run typecheck && npm test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/routes/home.ts test/routes/signin.test.ts
git commit -m "feat: a way in from the home page

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WzHAQF3vBYdjm3A3hw2Jkt"
```

---

### Task 2: The name validator

Pure domain logic, no database, no HTTP. Written first so Task 4's route has a rule to call rather than an `if` to invent.

**Files:**
- Create: `src/domain/player-name.ts`
- Test: `test/domain/player-name.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export type PlayerNameResult =
    | { ok: true; name: string }
    | { ok: false; problem: string };
  export function parsePlayerName(raw: unknown): PlayerNameResult;
  ```
  Task 4 calls exactly this.

- [ ] **Step 1: Write the failing test**

Create `test/domain/player-name.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parsePlayerName } from "../../src/domain/player-name.js";

describe("parsePlayerName", () => {
  it("accepts an ordinary name", () => {
    expect(parsePlayerName("Sam Okafor")).toEqual({ ok: true, name: "Sam Okafor" });
  });

  it("trims surrounding whitespace", () => {
    expect(parsePlayerName("  Sam Okafor \n")).toEqual({ ok: true, name: "Sam Okafor" });
  });

  it("refuses an empty name", () => {
    const result = parsePlayerName("");
    expect(result.ok).toBe(false);
  });

  it("refuses a name that is only whitespace", () => {
    const result = parsePlayerName("   ");
    expect(result.ok).toBe(false);
  });

  it("refuses a name longer than 200 characters", () => {
    const result = parsePlayerName("a".repeat(201));
    expect(result.ok).toBe(false);
  });

  it("accepts a name of exactly 200 characters", () => {
    expect(parsePlayerName("a".repeat(200))).toEqual({ ok: true, name: "a".repeat(200) });
  });

  it("refuses a value that is not a string at all", () => {
    // `parseBody` hands back a File for a multipart field, and undefined for a
    // field the form never sent. Neither is a name.
    expect(parsePlayerName(undefined).ok).toBe(false);
    expect(parsePlayerName(42).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/domain/player-name.test.ts`
Expected: FAIL — `Cannot find module '../../src/domain/player-name.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/domain/player-name.ts`:

```ts
/**
 * The one rule about what a Player may call themselves (M11).
 *
 * Its own module, and not an `if` inside `POST /app/account`, for the reason
 * `src/domain/game-form.ts` is its own module: the route's job is to write a
 * row and answer, and a validation rule inlined at the one call site that
 * needs it today is a rule the next call site will restate slightly
 * differently. `MAX_LENGTH` matches `MAX_NAME_LENGTH` in `game-form.ts` — the
 * same question about the same kind of free text, deliberately given the same
 * answer.
 */

const MAX_LENGTH = 200;

export type PlayerNameResult =
  | { ok: true; name: string }
  | { ok: false; problem: string };

/**
 * Validate a submitted name.
 *
 * Takes `unknown` rather than `string` because its caller's input is
 * `c.req.parseBody()`, which hands back `string | File` for a present field
 * and `undefined` for an absent one. Narrowing here rather than at the call
 * site means the route cannot forget to.
 *
 * An empty name is refused rather than quietly ignored. A blank in a squad
 * list is worse than a refusal: it appears in every fixture page, every
 * reminder email and every organiser's roster, and nobody reading one can tell
 * whether it is a bug or a person.
 */
export function parsePlayerName(raw: unknown): PlayerNameResult {
  if (typeof raw !== "string") {
    return { ok: false, problem: "Tell us what to call you." };
  }
  const name = raw.trim();
  if (name.length === 0) {
    return { ok: false, problem: "Tell us what to call you." };
  }
  if (name.length > MAX_LENGTH) {
    return { ok: false, problem: `Keep your name under ${MAX_LENGTH} characters.` };
  }
  return { ok: true, name };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/domain/player-name.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/domain/player-name.ts test/domain/player-name.test.ts
git commit -m "feat: the rule for what a player may call themselves

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WzHAQF3vBYdjm3A3hw2Jkt"
```

---

### Task 3: The fixture history query

**Files:**
- Modify: `src/db/dashboard-queries.ts:90-98` (the `entitledTo` function) and the end of the file
- Test: `test/routes/dashboard.test.ts` must stay green; the new query is proved by Task 5's route tests

**Interfaces:**
- Consumes: `DashboardFixture` and `selectEntitledFixtures`, both already in this module.
- Produces:
  ```ts
  export async function listPlayerFixtureHistory(
    db: Db,
    playerId: string,
    limit: number,
  ): Promise<DashboardFixture[]>;
  ```
  Task 5 calls it as `listPlayerFixtureHistory(db, player.id, 20)`.

Note the ordering difference from `listDashboardFixtures`: that one is `asc` (soonest first, because it is a to-do list); this one is `desc` (most recent first, because it is a history).

- [ ] **Step 1: Parameterise the lifecycle filter**

The security predicate and the scope filter are currently one function. Split them, keeping the security half shared. Replace `entitledTo` in `src/db/dashboard-queries.ts` with:

```ts
/**
 * The entitlement predicate, in one place, used by every read and write path.
 *
 * **This is a security control, not a display filter (TR-18).** The session
 * middleware established *who* is asking and stopped there; every membership
 * question has to be re-asked against the database by the handler. Three
 * conditions carry that weight:
 *
 * - `memberships.active` — a player who left a Game keeps their history but
 *   loses their standing in it. Dropping this condition would let anyone who
 *   was *ever* in a squad keep seeing that squad's fixtures. The visible
 *   consequence, stated so nobody "fixes" it later: leaving a game removes its
 *   fixtures from the account page's history too.
 * - `responses.player_id = :viewer` — the join starts from the viewer's own
 *   response rows, so no row for another player can be reached at all, whether
 *   to display or to write.
 * - `withdrawn` is excluded for the reason `getFixtureWithSquad` excludes it:
 *   a withdrawn player is not a squad member any more (spec amendment 5).
 *
 * **The lifecycle filter is deliberately *not* here (M11).** It used to be,
 * and it was the one condition in this function that is a question of scope
 * rather than of entitlement: the dashboard is a to-do list so it excludes
 * `played` and `cancelled`, and the account page is a history so it includes
 * them. Passing it in keeps the three security conditions in exactly one place
 * while letting a caller widen what it *shows* without touching what it may
 * *reach*. A caller that widened this function's `notInArray` instead would
 * have silently widened the dashboard's write path with it.
 */
function entitledTo(playerId: string, extra?: SQL): SQL | undefined {
  return and(
    eq(responses.playerId, playerId),
    eq(memberships.active, true),
    ne(responses.status, "withdrawn"),
    ...(extra ? [extra] : []),
  );
}
```

`selectEntitledFixtures` is unchanged — it still takes `extra` and passes it through. The lifecycle condition now moves to each caller.

- [ ] **Step 2: Move the lifecycle filter into the two existing callers**

Replace `listDashboardFixtures` and `findActionableFixture` at the bottom of the file:

```ts
/**
 * The lifecycle scope the *dashboard* uses: a fixture nobody can act on any
 * more is not a thing to do this week.
 *
 * "Upcoming" is defined by lifecycle rather than by comparing `kicks_off_at`
 * against a clock: the retire sweep is what moves a finished fixture to
 * `played`, and a fixture still `open` an hour after its nominal kickoff is
 * genuinely still open to respond to. A clock comparison here would hide it
 * and would make the page's contents depend on an instant D1 and the Durable
 * Object can disagree about.
 */
const NOT_FINISHED = notInArray(fixtures.lifecycle, [...TERMINAL_LIFECYCLES]);

/**
 * Every fixture the viewer may still act on, soonest first (J7, BR-25).
 *
 * One statement, no matter how many games the viewer belongs to.
 */
export async function listDashboardFixtures(db: Db, playerId: string): Promise<DashboardFixture[]> {
  const rows = await selectEntitledFixtures(db, playerId, NOT_FINISHED).orderBy(
    asc(fixtures.kicksOffAt),
  );
  return rows.map(toDashboardFixture);
}

/**
 * The one fixture a posted form names, **if** the viewer is entitled to act on
 * it — the write path's re-check of exactly the predicate the read path used.
 *
 * `null` means "no", without distinguishing "no such fixture" from "not
 * yours": the caller answers 404 either way, so a fixture id cannot be probed
 * for existence (TR-18). Keeping `NOT_FINISHED` here is what locks a `played`
 * fixture (BR-15) against a replayed form.
 */
export async function findActionableFixture(
  db: Db,
  playerId: string,
  fixtureId: string,
): Promise<DashboardFixture | null> {
  const [row] = await selectEntitledFixtures(
    db,
    playerId,
    and(NOT_FINISHED, eq(fixtures.id, fixtureId)),
  ).limit(1);
  return row ? toDashboardFixture(row) : null;
}
```

- [ ] **Step 3: Run the dashboard suite to prove the refactor changed no behaviour**

Run: `npm test -- test/routes/dashboard.test.ts`
Expected: PASS, exactly as before the refactor. If anything fails here, the split is wrong — fix it before going on. This step exists because a security predicate refactor with no behavioural test of its own is the shape of change that quietly widens access.

- [ ] **Step 4: Add the history query**

Append to `src/db/dashboard-queries.ts`:

```ts
/**
 * The viewer's own fixtures, most recent first, across every game they are
 * still an active member of (M11, the account page).
 *
 * Two deliberate differences from `listDashboardFixtures`, and nothing else:
 *
 * 1. **No lifecycle filter at all.** `played` and `cancelled` fixtures are the
 *    history — excluding them, as the dashboard does, would leave this list
 *    showing exactly what the dashboard already shows.
 * 2. **`desc` and a `limit`.** Most recent first, so an upcoming fixture sorts
 *    above a played one and the list is a timeline rather than a to-do list.
 *
 * Everything that keeps one player out of another's rows is untouched: this
 * goes through `selectEntitledFixtures`, whose join is rooted at
 * `responses.player_id = :viewer`, so there is no other player's row for it to
 * reach even if a future caller passed a hostile `limit`.
 */
export async function listPlayerFixtureHistory(
  db: Db,
  playerId: string,
  limit: number,
): Promise<DashboardFixture[]> {
  const rows = await selectEntitledFixtures(db, playerId)
    .orderBy(desc(fixtures.kicksOffAt))
    .limit(limit);
  return rows.map(toDashboardFixture);
}
```

Update the import at the top of the file — `desc` is new:

```ts
import { and, asc, desc, eq, ne, notInArray, type SQL } from "drizzle-orm";
```

- [ ] **Step 5: Run the full verification**

Run: `npm run lint && npm run typecheck && npm test`
Expected: all pass. `listPlayerFixtureHistory` has no caller yet, which is fine — it is exercised by Task 5.

- [ ] **Step 6: Commit**

```bash
git add src/db/dashboard-queries.ts
git commit -m "feat: a player's own fixture history, most recent first

Splits the lifecycle scope out of entitledTo, which was mixing a display
choice in with the three conditions that keep one player out of another's
rows. The dashboard keeps its filter; the history query has none.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WzHAQF3vBYdjm3A3hw2Jkt"
```

---

### Task 4: The path constant and the audit action

Two one-line additions, together because neither is testable alone and both are consumed by Task 5.

**Files:**
- Modify: `src/auth/paths.ts` (after `DELETE_ACCOUNT_CANCEL_PATH`, and near `memberRemovePath`)
- Modify: `src/domain/audit.ts` (the `AUDIT_ACTIONS` array)

**Interfaces:**
- Produces: `ACCOUNT_PATH: string` (= `"/app/account"`), `memberDetailPath(gameId: string, playerId: string): string` (= `/g/${gameId}/squad/${playerId}`), and the `"player.renamed"` member of `AuditAction`. Tasks 5, 6 and 7 all consume these.

- [ ] **Step 1: Add `ACCOUNT_PATH`**

In `src/auth/paths.ts`, immediately after the `DELETE_ACCOUNT_PATH` / `DELETE_ACCOUNT_CANCEL_PATH` pair:

```ts
/**
 * Where a player sees and edits their own record (M11).
 *
 * Under `DASHBOARD_PATH` so it sits behind the session mount and the
 * `private, no-store` header `AUTHENTICATED_PREFIX` carries — this page
 * renders an email address and a fixture history, and neither belongs in a
 * shared cache.
 *
 * **No player id in the path, and that is the entitlement design.** The
 * subject is always `c.get("player")`, so unlike `memberDetailPath` below
 * there is no id here for a handler to forget to check or for a stranger to
 * probe.
 */
export const ACCOUNT_PATH = `${DASHBOARD_PATH}/account`;
```

- [ ] **Step 2: Add `memberDetailPath`**

In the same file, directly above `memberRolePath` — extend that pair's existing doc comment block by adding this function beneath it:

```ts
/**
 * One squad member as their organiser sees them (M11).
 *
 * Takes the *player* id like its two siblings above, and is entitled the same
 * way: `loadSquadTarget` in `src/routes/games.ts` scopes the lookup by game id
 * as well, so a player id here can neither be probed nor used against another
 * squad (TR-18).
 */
export function memberDetailPath(gameId: string, playerId: string): string {
  return `/g/${gameId}/squad/${playerId}`;
}
```

- [ ] **Step 3: Add the audit action**

In `src/domain/audit.ts`, inside the `AUDIT_ACTIONS` array, after the four `player.erasure_*` / `player.erased` entries:

```ts
  // M11. A player renaming themselves on `/app/account`. Subject and actor are
  // always the same player, like the erasure actions above and for the same
  // reason — the route acts on the session's own player id and takes no
  // parameter naming a player. `before`/`after` carry `{ name }`, because what
  // the row is *for* is what the name used to be.
  "player.renamed",
```

- [ ] **Step 4: Verify nothing broke**

Run: `npm run lint && npm run typecheck && npm test`
Expected: all pass. `AUDIT_ACTIONS` feeds a `text({ enum })` column, so a typo here is a typecheck failure rather than a runtime surprise.

- [ ] **Step 5: Commit**

```bash
git add src/auth/paths.ts src/domain/audit.ts
git commit -m "feat: the account path, the member-detail path, and player.renamed

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WzHAQF3vBYdjm3A3hw2Jkt"
```

---

### Task 5: `/app/account` — the player's own page

The largest task. View and routes together, because a view with no route serving it cannot be tested through `SELF.fetch`, which is how every page in this repo is tested.

**Files:**
- Create: `src/views/account.ts`
- Modify: `src/routes/account.ts` (add the two handlers; the erasure handlers stay untouched)
- Test: `test/routes/account.test.ts` (new)

**Interfaces:**
- Consumes: `ACCOUNT_PATH`, `PASSKEYS_PATH`, `DELETE_ACCOUNT_PATH`, `PRIVACY_PATH`, `gamePath` from `src/auth/paths.js`; `parsePlayerName` from Task 2; `listPlayerFixtureHistory` from Task 3; `"player.renamed"` from Task 4; `fixtureView` from `src/domain/fixture-view.js`; `formatLocalDateTime` from `src/domain/time/zone.js`; `recordAudit` from `src/db/audit.js`.
- Produces:
  ```ts
  export interface AccountFixtureRow {
    gameId: string;
    gameName: string;
    venueName: string;
    kicksOffAtLocal: string;
    statusLabel: string;
    myStatusLabel: string;
  }
  export interface AccountPageOptions {
    playerName: string;
    email: string | null;
    fixtures: readonly AccountFixtureRow[];
    problem?: string;
    erasesAtLocal?: string;
  }
  export function renderAccountPage(options: AccountPageOptions): string;
  ```

- [ ] **Step 1: Write the failing tests**

Create `test/routes/account.test.ts`:

```ts
import { SELF, env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { ACCOUNT_PATH, DELETE_ACCOUNT_PATH, PASSKEYS_PATH, SIGN_IN_PATH } from "../../src/auth/paths.js";
import { getDb } from "../../src/db/client.js";
import { auditLog, players } from "../../src/db/schema.js";
import {
  insertFixture,
  insertGame,
  insertMembership,
  insertPlayer,
  insertResponse,
  resetDatabase,
} from "../support/factories.js";
import { ALLOWED, ORIGIN, signIn } from "../support/sign-in.js";

const db = getDb(env.DB);

/** Far-future and fixed, so nothing here depends on how the suite ages. */
const NEXT_WEEK = new Date("2030-06-20T18:00:00Z");
const LAST_WEEK = new Date("2030-06-06T18:00:00Z");

/** The Player the sign-in journey created for `ALLOWED`. */
async function viewerId(): Promise<string> {
  const [player] = await db.select().from(players).where(eq(players.email, ALLOWED));
  expect(player, "signing in must have created a Player").toBeDefined();
  return player!.id;
}

function get(cookie?: string) {
  return SELF.fetch(`${ORIGIN}${ACCOUNT_PATH}`, {
    headers: cookie ? { cookie } : {},
    redirect: "manual",
  });
}

function post(cookie: string, fields: Record<string, string>, origin: string | null = ORIGIN) {
  return SELF.fetch(`${ORIGIN}${ACCOUNT_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie,
      ...(origin ? { origin } : {}),
    },
    body: new URLSearchParams(fields),
    redirect: "manual",
  });
}

beforeEach(resetDatabase);

describe("GET /app/account", () => {
  it("redirects an anonymous visitor to sign in", async () => {
    const response = await get();
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(SIGN_IN_PATH);
  });

  it("shows the viewer's name, their email, and the two account links", async () => {
    const { cookie } = await signIn();
    const body = await (await get(cookie)).text();

    expect(body).toContain(ALLOWED);
    expect(body).toContain(`href="${PASSKEYS_PATH}"`);
    expect(body).toContain(`href="${DELETE_ACCOUNT_PATH}"`);
  });

  it("lists a played fixture, which the dashboard deliberately hides", async () => {
    const { cookie } = await signIn();
    const me = await viewerId();
    const gameId = await insertGame(db, { name: "Thursday 7-a-side" });
    await insertMembership(db, gameId, me);
    const fixtureId = await insertFixture(db, gameId, {
      lifecycle: "played",
      kicksOffAt: LAST_WEEK,
    });
    await insertResponse(db, fixtureId, me, { status: "in" });

    const body = await (await get(cookie)).text();
    expect(body).toContain("Thursday 7-a-side");
  });

  it("shows at most 20 fixtures, most recent first", async () => {
    const { cookie } = await signIn();
    const me = await viewerId();
    const gameId = await insertGame(db, { name: "Thursday 7-a-side" });
    await insertMembership(db, gameId, me);

    // 22 fixtures, one per week going backwards. The two oldest must not show.
    for (let week = 0; week < 22; week++) {
      const kicksOffAt = new Date(LAST_WEEK.getTime() - week * 7 * 24 * 3600_000);
      const fixtureId = await insertFixture(db, gameId, { lifecycle: "played", kicksOffAt });
      await insertResponse(db, fixtureId, me, { status: "in" });
    }

    const body = await (await get(cookie)).text();
    const rows = body.match(/class="fixture-card"/g) ?? [];
    expect(rows).toHaveLength(20);
  });

  it("does not list fixtures from a game the viewer has left", async () => {
    const { cookie } = await signIn();
    const me = await viewerId();
    const gameId = await insertGame(db, { name: "Sunday league" });
    await insertMembership(db, gameId, me, { active: false, leftAt: LAST_WEEK });
    const fixtureId = await insertFixture(db, gameId, {
      lifecycle: "played",
      kicksOffAt: LAST_WEEK,
    });
    await insertResponse(db, fixtureId, me, { status: "in" });

    const body = await (await get(cookie)).text();
    expect(body).not.toContain("Sunday league");
  });

  it("never lists another player's fixture", async () => {
    const { cookie } = await signIn();
    const me = await viewerId();
    const gameId = await insertGame(db, { name: "Thursday 7-a-side" });
    await insertMembership(db, gameId, me);
    const stranger = await insertPlayer(db, { name: "Sam Okafor", email: "sam@example.com" });
    const theirGameId = await insertGame(db, { name: "Somebody else's game" });
    await insertMembership(db, theirGameId, stranger);
    const theirFixture = await insertFixture(db, theirGameId, { kicksOffAt: NEXT_WEEK });
    await insertResponse(db, theirFixture, stranger, { status: "in" });

    const body = await (await get(cookie)).text();
    expect(body).not.toContain("Somebody else's game");
    expect(body).not.toContain("Sam Okafor");
  });
});

describe("POST /app/account", () => {
  it("renames the player, audits it, and redirects", async () => {
    const { cookie } = await signIn();
    const me = await viewerId();

    const response = await post(cookie, { name: "  Alex Mercer  " });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(ACCOUNT_PATH);

    const [row] = await db.select().from(players).where(eq(players.id, me));
    expect(row!.name).toBe("Alex Mercer");

    const audits = (await db.select().from(auditLog)).filter((a) => a.action === "player.renamed");
    expect(audits).toHaveLength(1);
    expect(audits[0]!.actorPlayerId).toBe(me);
    expect(audits[0]!.entityId).toBe(me);
    expect(JSON.parse(audits[0]!.afterJson!)).toEqual({ name: "Alex Mercer" });
  });

  it("refuses an empty name on the page itself, changing nothing", async () => {
    const { cookie } = await signIn();
    const me = await viewerId();
    const [before] = await db.select().from(players).where(eq(players.id, me));

    const response = await post(cookie, { name: "   " });
    expect(response.status).toBe(422);
    expect(await response.text()).toContain("Tell us what to call you.");

    const [after] = await db.select().from(players).where(eq(players.id, me));
    expect(after!.name).toBe(before!.name);
  });

  it("refuses a cross-origin post", async () => {
    const { cookie } = await signIn();
    const response = await post(cookie, { name: "Alex Mercer" }, "https://evil.example");
    expect(response.status).toBe(403);
  });

  it("does not write Better Auth's own user row", async () => {
    const { cookie } = await signIn();
    await post(cookie, { name: "Alex Mercer" });

    const rows = await env.DB.prepare("SELECT name FROM user").all<{ name: string }>();
    expect(rows.results.every((row) => row.name !== "Alex Mercer")).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- test/routes/account.test.ts`
Expected: FAIL — `ACCOUNT_PATH` resolves but nothing serves it, so `GET` 404s and the assertions miss.

- [ ] **Step 3: Write the view**

Create `src/views/account.ts`:

```ts
import { ACCOUNT_PATH, DELETE_ACCOUNT_PATH, PASSKEYS_PATH, PRIVACY_PATH, gamePath } from "../auth/paths.js";
import { escapeHtml, layout } from "./layout.js";
import { signOutForm } from "./sign-out-form.js";
import { DASHBOARD_STYLES_CSS, FIXTURE_STYLES_CSS, FORM_CSS } from "./styles.js";

/**
 * One fixture as the account page shows it — already formatted, already
 * labelled, by the route.
 *
 * **No other player appears here, by name or otherwise**, for the reason
 * `DashboardRow` gives: this page is a cross-game view of the viewer's *own*
 * record, and the squad belongs to the fixture page. The type has nowhere to
 * put a roster, which is what stops one creeping in.
 */
export interface AccountFixtureRow {
  gameId: string;
  gameName: string;
  venueName: string;
  /** Already formatted in the game's timezone by the caller (TR-5). */
  kicksOffAtLocal: string;
  /** The fixture's own state, in words: "Played", "Called off", "Confirmed"… */
  statusLabel: string;
  /** What the viewer answered: "You were in", "You couldn't make it"… */
  myStatusLabel: string;
}

export interface AccountPageOptions {
  playerName: string;
  /** Null for a guest, who has no contact details (§2.8, BR-32). */
  email: string | null;
  fixtures: readonly AccountFixtureRow[];
  /** A refusal to explain on this page — an empty or over-long name. */
  problem?: string;
  /** Set when this player has an erasure pending — already formatted (M7b). */
  erasesAtLocal?: string;
}

/**
 * One history row. Deliberately *not* `renderRow` from `src/views/dashboard.ts`:
 * that card carries the two response buttons, and this page must offer no way
 * to answer a fixture. The card class is shared so the two pages look alike.
 */
function renderFixture(row: AccountFixtureRow): string {
  return `
    <li class="fixture-card">
      <h3><a href="${escapeHtml(gamePath(row.gameId))}">${escapeHtml(row.gameName)}</a></h3>
      <p class="kickoff">${escapeHtml(row.kicksOffAtLocal)}</p>
      <p class="venue">${escapeHtml(row.venueName)}</p>
      <p class="status-line">${escapeHtml(row.statusLabel)}</p>
      <p class="viewer-headline">${escapeHtml(row.myStatusLabel)}</p>
    </li>`;
}

/**
 * A player's own account: who we have them down as, how they sign in, and what
 * they have played.
 *
 * The email is rendered as text and not as an input, and the page says why.
 * `players.email` is Better Auth's sign-in identity as well as a column here,
 * so an editable field would mean either a typo that ends the account — sign-in
 * stops working *and* the magic link that would fix it goes to a stranger's
 * inbox — or a verified-change flow, which is its own milestone. Saying the
 * address is fixed is honest; a field that silently half-works is not.
 *
 * Server-rendered, no `<script>`, no `type="password"` (TR-4, TR-15, TR-16).
 */
export function renderAccountPage({
  playerName,
  email,
  fixtures,
  problem,
  erasesAtLocal,
}: AccountPageOptions): string {
  const problemNotice = problem === undefined ? "" : `<p class="problem">${escapeHtml(problem)}</p>`;

  // Shown here as well as on the dashboard, for the reason `renderErasureBanner`
  // gives: a pending erasure is invisible to whoever did not request it unless
  // every page they visit routinely says so.
  const erasureNotice =
    erasesAtLocal === undefined
      ? ""
      : `<div class="nudge">
           <p>Your data is due to be erased on <strong>${escapeHtml(erasesAtLocal)}</strong>.</p>
           <p><a href="${DELETE_ACCOUNT_PATH}">More about this</a></p>
         </div>`;

  const emailLine =
    email === null
      ? `<p class="read-only">We don't have an email address for you.</p>`
      : `<p class="read-only">${escapeHtml(email)}</p>`;

  const body = `
    <h1>Your account</h1>
    ${problemNotice}
    ${erasureNotice}

    <h2>Your name</h2>
    <p>This is what your squads see, on every fixture and in every email.</p>
    <form method="post" action="${ACCOUNT_PATH}">
      <label for="name">Name</label>
      <input id="name" name="name" type="text" value="${escapeHtml(playerName)}" maxlength="200" required>
      <button class="button primary" type="submit">Save</button>
    </form>

    <h2>Your email address</h2>
    ${emailLine}
    <p>This is how you sign in and where your reminders go, so it can't be changed here yet.</p>

    <h2>How you sign in</h2>
    <p><a href="${PASSKEYS_PATH}">Manage your passkeys</a></p>

    <h2>Your fixtures</h2>
    ${
      fixtures.length === 0
        ? `<p class="read-only">Nothing yet. Once you've answered a fixture, it'll show up here.</p>`
        : `<ul class="fixture-list">${fixtures.map(renderFixture).join("")}</ul>`
    }

    <p><a href="${DELETE_ACCOUNT_PATH}">Delete my account and data</a> · <a href="${PRIVACY_PATH}">Privacy</a></p>
    ${signOutForm("Sign out")}
  `;

  return layout({
    title: "Your account — Make The Team",
    body,
    pageStyles: [FIXTURE_STYLES_CSS, DASHBOARD_STYLES_CSS, FORM_CSS],
  });
}
```

- [ ] **Step 4: Write the two handlers**

Add to `src/routes/account.ts`. Extend the existing import block rather than adding a second one — `eq`, `Hono`, `Context`, `getDb`, `players`, `recordAudit`, `formatLocalDateTime` and `AppEnv`/`Bindings` are already imported there. The new imports are `ACCOUNT_PATH` and `PRIVACY_PATH`-adjacent path constants, `listPlayerFixtureHistory`, `fixtureView`, `parsePlayerName` and `renderAccountPage`.

```ts
/** How many fixtures the account page shows. Twenty weeks of a weekly game. */
const HISTORY_LIMIT = 20;

/**
 * Render `/app/account` from scratch, in whichever state the database is in.
 *
 * Its own function for the reason `renderDeleteAccount` above and
 * `renderDashboard` are: the `POST`'s refusal must answer with the same page a
 * plain `GET` would, with the reason on it, and a refusal assembled separately
 * from the page it refuses on is exactly how the two drift apart. `problem` is
 * the only difference between the two callers, and it drives the status code.
 */
async function renderAccount(c: Context<AppEnv>, problem?: string) {
  const now = new Date(Date.now());
  const player = c.get("player")!;
  const db = getDb(c.env.DB);

  const history = await listPlayerFixtureHistory(db, player.id, HISTORY_LIMIT);

  return c.html(
    renderAccountPage({
      playerName: player.name,
      email: player.email,
      fixtures: history.map((fixture) => ({
        gameId: fixture.gameId,
        gameName: fixture.gameName,
        venueName: fixture.venueName,
        // Every timezone conversion in this codebase goes through this one
        // module, in the fixture's own game's zone (TR-5).
        kicksOffAtLocal: formatLocalDateTime(fixture.kicksOffAt, fixture.timezone),
        statusLabel: fixtureStatusLabel(fixtureView(fixture, now).status),
        myStatusLabel: historyStatusLabel(fixture.myStatus),
      })),
      problem,
      // `player` already carries `erasesAt` — `sessionMiddleware` selects the
      // whole row, so this is a field read, not a second query. Not scoped to
      // a game, so `Europe/London`, matching the N-8 email and the dashboard.
      erasesAtLocal:
        player.erasesAt === null
          ? undefined
          : formatLocalDateTime(player.erasesAt, "Europe/London"),
    }),
    problem === undefined ? 200 : 422,
  );
}

/**
 * The fixture's own state in words, past tense where the fixture is past.
 *
 * Its own function rather than `renderStatusLine` from `src/views/fixture.ts`:
 * that one words a fixture somebody can still act on ("2 more needed"), and
 * every row here may be history.
 */
function fixtureStatusLabel(status: FixtureStatus): string {
  switch (status) {
    case "played":
      return "Played";
    case "cancelled":
      return "Called off";
    case "scheduled":
      return "Not open yet";
    case "confirmed":
      return "Going ahead";
    case "short":
      return "Short of players";
    case "open":
      return "Open for answers";
  }
}

/** What the viewer answered, worded for a list that is mostly history. */
function historyStatusLabel(status: ResponseStatus): string {
  switch (status) {
    case "in":
      return "You were in";
    case "out":
      return "You couldn't make it";
    case "waitlisted":
      return "You were on the waitlist";
    case "pending":
      return "You didn't answer";
    case "withdrawn":
      // Unreachable: `entitledTo` excludes withdrawn rows. Here so the switch
      // is exhaustive and a new status becomes a typecheck failure.
      return "You withdrew";
  }
}

/**
 * The page itself. **Writes nothing** — the rename is the `POST` below.
 *
 * `requirePlayer`, matching the dashboard: an anonymous visitor is redirected
 * to sign-in and a session with no linked Player gets the 403 page with its
 * exits. The guard establishes *who* and stops there (TR-18); there is no
 * player id in this route's URL to check, because the subject is always
 * `c.get("player")`, which is also why this page has no denial state to
 * design.
 */
account.get(ACCOUNT_PATH, requirePlayer, async (c) => renderAccount(c));

/**
 * Rename yourself (M11).
 *
 * **`players.name` only — never Better Auth's `user.name`.** Nothing in this
 * product renders that column; the domain row is the name every page, every
 * email and every squad list reads. Writing both would create two names that
 * can disagree with no rule about which wins.
 *
 * The origin check mirrors `POST /app`'s, for the same reason: this is a
 * same-origin form post on our own page, a browser always sends `Origin` on a
 * cross-site one, and a missing header is a non-browser client acting on its
 * own behalf.
 */
account.post(ACCOUNT_PATH, requirePlayer, async (c) => {
  const origin = c.req.header("origin");
  if (origin !== undefined && origin !== originOf(c.env)) {
    return c.text("Forbidden", 403);
  }

  const now = new Date(Date.now());
  const player = c.get("player")!;
  const db = getDb(c.env.DB);

  const form = await c.req.parseBody();
  const parsed = parsePlayerName(form["name"]);
  // Re-rendered as the page itself at 422 with the reason on it, the way
  // `renderDeleteAccount` and `renderDashboard` answer their own refusals,
  // rather than a dead end.
  if (!parsed.ok) return renderAccount(c, parsed.problem);

  await db.update(players).set({ name: parsed.name }).where(eq(players.id, player.id));
  await recordAudit(db, {
    actorPlayerId: player.id,
    entityType: "player",
    entityId: player.id,
    action: "player.renamed",
    before: { name: player.name },
    after: { name: parsed.name },
    now,
  });

  // 303 to the page itself, so a refresh does not re-post and the new name is
  // rendered by the one `GET` above rather than by a second copy of the page
  // assembled after the write.
  return c.redirect(ACCOUNT_PATH, 303);
});
```

Add the imports this needs to the top of `src/routes/account.ts`:

```ts
import { ACCOUNT_PATH } from "../auth/paths.js";
import { listPlayerFixtureHistory } from "../db/dashboard-queries.js";
import { fixtureView, type FixtureStatus } from "../domain/fixture-view.js";
import { parsePlayerName } from "../domain/player-name.js";
import type { ResponseStatus } from "../domain/response-status.js";
import { renderAccountPage } from "../views/account.js";
```

`ACCOUNT_PATH` joins the existing `../auth/paths.js` import rather than adding a second line for the same module — check what that import block already looks like and merge.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- test/routes/account.test.ts`
Expected: PASS, 10 tests. If the "at most 20" test finds a different count, check the `desc`/`limit` in Task 3 rather than the view.

- [ ] **Step 6: Run the full verification**

Run: `npm run lint && npm run typecheck && npm test`
Expected: all pass. `test/routes/signin.test.ts` will now fail its route-completeness guard — that is expected and is fixed in Task 8. If it is the *only* failure, go on; if anything else fails, stop and fix it.

- [ ] **Step 7: Commit**

```bash
git add src/views/account.ts src/routes/account.ts test/routes/account.test.ts
git commit -m "feat: /app/account — a player's own name, email and fixtures

Name is editable and audited. Email is read-only and the page says why:
it is Better Auth's sign-in identity as well as a players column, and a
verified change is its own milestone.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WzHAQF3vBYdjm3A3hw2Jkt"
```

---

### Task 6: `/g/:id/squad/:playerId` — the organiser's view

**Files:**
- Create: `src/views/squad-member.ts`
- Modify: `src/routes/games.ts` (a new `GET`, beside the five routes that already call `loadSquadTarget`)
- Test: `test/routes/squad.test.ts`

**Interfaces:**
- Consumes: `loadSquadTarget` (already in `games.ts`, returns `{ db, game, member } | null`, where `member` is `MembershipInGame` from `src/db/queries.ts` carrying `playerId`, `name`, `email`, `isGuest`, `role`, `active`, `joinedAt`, `leftAt`); `displayName` from `src/domain/display-name.js`. The route registration must match `memberDetailPath` from Task 4 exactly — `/g/:id/squad/:playerId`.
- Produces:
  ```ts
  export interface SquadMemberPageOptions {
    gameId: string;
    gameName: string;
    memberName: string;
    email: string | null;
    isGuest: boolean;
    role: "player" | "owner";
    joinedAtLocal: string;
  }
  export function renderSquadMemberPage(options: SquadMemberPageOptions): string;
  ```

**Note on the test fixtures:** only one email address is allowlisted for sign-in (`ALLOWED` in `test/support/sign-in.ts`), so there is exactly one identity a test can sign in as. Build the "not entitled" cases by making the *signed-in viewer* the outsider — a game they merely belong to, or one they have nothing to do with — never by trying to sign in as a second person.

- [ ] **Step 1: Write the failing tests**

Add to `test/routes/squad.test.ts`. The file already has `ownedGame()`, `ORIGIN`, `SELF`, `signIn`, `testDb` and the factories imported; add `memberDetailPath` to the `paths.js` import if the file has one, otherwise build the URL as a template literal like the existing tests do.

```ts
describe("GET /g/:id/squad/:playerId", () => {
  beforeEach(resetDatabase);

  it("shows the member's name, email, role and joined date", async () => {
    const { cookie, gameId, memberId } = await ownedGame();

    const response = await SELF.fetch(`${ORIGIN}/g/${gameId}/squad/${memberId}`, {
      headers: { cookie },
    });

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("Sam Okafor");
    expect(body).toContain("sam@example.com");
  });

  it("shows no fixture history, not even from this game", async () => {
    const { cookie, gameId, memberId, db } = await ownedGame();
    const fixtureId = await insertFixture(db, gameId, { lifecycle: "played" });
    await insertResponse(db, fixtureId, memberId, { status: "in" });

    const body = await (
      await SELF.fetch(`${ORIGIN}/g/${gameId}/squad/${memberId}`, { headers: { cookie } })
    ).text();

    // The class the account page's history uses. Its absence is the property
    // most likely to be broken by a later refactor that "shares" the two views.
    expect(body).not.toContain("fixture-card");
  });

  it("404s for a signed-in player who merely belongs to the game", async () => {
    const { cookie } = await signIn();
    const db = testDb();
    const [viewer] = await db.select().from(players).where(eq(players.email, ALLOWED));
    const gameId = await insertGame(db, { name: "Thursday 7-a-side" });
    // The viewer is an ordinary member, not an organiser.
    await insertMembership(db, gameId, viewer!.id, { role: "player" });
    const owner = await insertPlayer(db, { name: "Sam Okafor", email: "sam@example.com" });
    await insertMembership(db, gameId, owner, { role: "owner" });

    const response = await SELF.fetch(`${ORIGIN}/g/${gameId}/squad/${owner}`, {
      headers: { cookie },
    });
    expect(response.status).toBe(404);
  });

  it("404s for an organiser of a different game", async () => {
    const { cookie } = await ownedGame();
    const db = testDb();
    const otherGameId = await insertGame(db, { name: "Somebody else's game" });
    const stranger = await insertPlayer(db, { name: "Priya Raman", email: "priya@example.com" });
    await insertMembership(db, otherGameId, stranger);

    const response = await SELF.fetch(`${ORIGIN}/g/${otherGameId}/squad/${stranger}`, {
      headers: { cookie },
    });
    expect(response.status).toBe(404);
  });

  it("404s for a player who is not in this squad", async () => {
    const { cookie, gameId } = await ownedGame();
    const db = testDb();
    const stranger = await insertPlayer(db, { name: "Priya Raman", email: "priya@example.com" });

    const response = await SELF.fetch(`${ORIGIN}/g/${gameId}/squad/${stranger}`, {
      headers: { cookie },
    });
    expect(response.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- test/routes/squad.test.ts`
Expected: the three 404 cases pass already (nothing serves the route, so Hono's own 404 answers), and the two content cases FAIL. That is fine and worth noticing: the 404 tests only become meaningful once the route exists, which is why they are written now rather than after.

- [ ] **Step 3: Write the view**

Create `src/views/squad-member.ts`:

```ts
import { gamePath } from "../auth/paths.js";
import { escapeHtml, layout } from "./layout.js";
import { FORM_CSS } from "./styles.js";

export interface SquadMemberPageOptions {
  gameId: string;
  gameName: string;
  /** Already through `displayName` by the caller — never a raw column. */
  memberName: string;
  /** Null for a guest, who has no contact details (§2.8, BR-32). */
  email: string | null;
  isGuest: boolean;
  role: "player" | "owner";
  /** Already formatted in the game's timezone by the caller (TR-5). */
  joinedAtLocal: string;
}

/**
 * One squad member as their organiser sees them (M11).
 *
 * **Read-only, and there is no form on this page at all** — which is why the
 * route needs no origin check. The two things an organiser may actually do to
 * a member, role and removal, stay in the per-member disclosure on the game
 * overview; the closing link goes back there rather than duplicating them,
 * because two copies of a destructive control is one more than can be kept in
 * step.
 *
 * **No fixture history, and nothing from any other game.** An organiser is
 * entitled to their own squad, not to a person: what this player does
 * elsewhere is not this organiser's business, and there is no way to render
 * "only fixtures from this game" that does not immediately raise the question
 * of why not the rest. `src/views/account.ts` is the page that answers that
 * question, and only the player themselves can reach it.
 */
export function renderSquadMemberPage({
  gameId,
  gameName,
  memberName,
  email,
  isGuest,
  role,
  joinedAtLocal,
}: SquadMemberPageOptions): string {
  const emailLine =
    email === null
      ? `<p class="read-only">No email address — ${isGuest ? "a guest, added for one fixture" : "we've never had one for them"}.</p>`
      : `<p class="read-only">${escapeHtml(email)}</p>`;

  const body = `
    <h1>${escapeHtml(memberName)}</h1>
    <p>In <a href="${escapeHtml(gamePath(gameId))}">${escapeHtml(gameName)}</a>.</p>

    <h2>Email</h2>
    ${emailLine}

    <h2>In this squad</h2>
    <p class="read-only">${role === "owner" ? "Organiser" : "Player"}, since ${escapeHtml(joinedAtLocal)}.</p>

    <p><a href="${escapeHtml(gamePath(gameId))}">Back to ${escapeHtml(gameName)}</a>, where you can change their role or take them out of the squad.</p>
  `;

  return layout({
    title: `${memberName} — ${gameName} — Make The Team`,
    body,
    pageStyles: [FORM_CSS],
  });
}
```

**There is no form on this page**, which is what lets the route below carry no origin check. Do not add the role or removal controls here: they exist on the game overview, and two copies of a destructive control is one more than can be kept in step. The closing link is how somebody who came here to act gets back to them.

- [ ] **Step 4: Write the route**

Add to `src/routes/games.ts`, immediately above the existing `gamesRoutes.get("/g/:id/squad/:playerId/remove", …)`:

```ts
/**
 * One squad member, as their organiser sees them (M11).
 *
 * Entitled entirely by `loadSquadTarget`: owner of *this* game, and
 * `:playerId` genuinely in *this* squad. `null` is 404 and never 403, because
 * this path carries two ids either of which could otherwise be probed for
 * existence (TR-18) — which is also the answer a signed-in stranger gets, by
 * construction rather than by a separate branch.
 *
 * Read-only. There is no `POST` counterpart to this route: renaming a member
 * is the member's own business (`/app/account`), and the role and removal
 * controls belong to the two routes below.
 */
gamesRoutes.get("/g/:id/squad/:playerId", requirePlayer, async (c) => {
  const target = await loadSquadTarget(c, c.req.param("id"), c.req.param("playerId"));
  if (target === null) return c.text("Not found", 404);

  return c.html(
    renderSquadMemberPage({
      gameId: target.game.id,
      gameName: target.game.name,
      // Never the raw column. An organiser who has since erased themselves, or
      // a member erased between two page loads, must not render as a
      // placeholder name — every renderer of a player's name goes through this.
      memberName: displayName(target.member.name, null),
      email: target.member.email,
      isGuest: target.member.isGuest,
      role: target.member.role,
      joinedAtLocal: formatLocalDateTime(target.member.joinedAt, target.game.timezone),
    }),
  );
});
```

Check `src/routes/games.ts`'s existing imports before adding: `formatLocalDateTime` and `requirePlayer` are almost certainly already there. Add `renderSquadMemberPage` from `../views/squad-member.js`, and `displayName` from `../domain/display-name.js` if absent.

If `displayName`'s signature does not accept `(name, null)` — read `src/domain/display-name.ts` first — pass whatever it actually wants for "not erased". An erased player cannot reach this page anyway (erasure deactivates every membership and `loadSquadTarget` refuses an inactive one), so this call is belt-and-braces; do not invent a second erasure check here.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- test/routes/squad.test.ts`
Expected: PASS, including the five new cases.

- [ ] **Step 6: Run the full verification**

Run: `npm run lint && npm run typecheck && npm test`
Expected: all pass except `test/routes/signin.test.ts`'s route-completeness guard, fixed in Task 8.

- [ ] **Step 7: Commit**

```bash
git add src/views/squad-member.ts src/routes/games.ts test/routes/squad.test.ts
git commit -m "feat: an organiser's read-only view of one squad member

Name, email, role and joined date. No fixture history, from this game or
any other: an organiser is entitled to their own squad, not to a person.
404 for anyone else, per loadSquadTarget's existing rule.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WzHAQF3vBYdjm3A3hw2Jkt"
```

---

### Task 7: Make both pages reachable

A page nobody can navigate to is a page that does not exist. This repo has been bitten by exactly that before — see `renderOwnedGamesSection`'s doc comment in `src/views/dashboard.ts`.

**Files:**
- Modify: `src/views/game-overview.ts:62-83` (the `squadItems` map)
- Modify: `src/views/dashboard.ts` (the footer links)
- Test: `test/routes/squad.test.ts` and `test/routes/dashboard.test.ts`

**Interfaces:**
- Consumes: `memberDetailPath` and `ACCOUNT_PATH` from Task 4.
- Produces: nothing.

- [ ] **Step 1: Write the failing tests**

Add to `test/routes/squad.test.ts`, inside the `GET /g/:id/squad/:playerId` describe:

```ts
  it("is linked from the game overview's per-member disclosure", async () => {
    const { cookie, gameId, memberId } = await ownedGame();

    const body = await (await SELF.fetch(`${ORIGIN}/g/${gameId}`, { headers: { cookie } })).text();
    expect(body).toContain(`href="/g/${gameId}/squad/${memberId}"`);
  });
```

Add to `test/routes/dashboard.test.ts`, alongside the existing assertions about the dashboard's footer links:

```ts
  it("links to the account page", async () => {
    const { cookie } = await signIn();
    const body = await (
      await SELF.fetch(`${ORIGIN}${DASHBOARD_PATH}`, { headers: { cookie } })
    ).text();
    expect(body).toContain(`href="${ACCOUNT_PATH}"`);
  });
```

Add `ACCOUNT_PATH` to that file's `paths.js` import.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- test/routes/squad.test.ts test/routes/dashboard.test.ts`
Expected: FAIL on the two new cases.

- [ ] **Step 3: Add the link to the game overview**

In `src/views/game-overview.ts`, inside the `<details class="member-actions">` block, make "View details" the **first** child, above the role form:

```ts
      return `<li>
        <span class="member">${name}${organiser}${guest}${you}</span>
        <details class="member-actions">
          <summary>Manage</summary>
          <p><a href="${escapeHtml(memberDetailPath(gameId, member.playerId))}">View details</a></p>
          <form method="post" action="${escapeHtml(memberRolePath(gameId, member.playerId))}">
            <input type="hidden" name="role" value="${nextRole}">
            <button class="button" type="submit">${roleLabel}</button>
          </form>
          <a href="${escapeHtml(memberRemovePath(gameId, member.playerId))}">Remove</a>
        </details>
      </li>`;
```

Add `memberDetailPath` to the `../auth/paths.js` import at the top of that file.

Inside the disclosure rather than on the summary row, because M10 §3.8 put the controls behind a disclosure precisely so that a fourteen-person squad reads as a squad and not as a control panel. First within it, because reading is what an organiser opening a member's row most often wants.

- [ ] **Step 4: Add the link to the dashboard**

In `src/views/dashboard.ts`, change the footer line so the account page sits beside the passkey link:

```ts
    <p><a href="${ACCOUNT_PATH}">Your account</a> · <a href="${PASSKEYS_PATH}">Sign in faster next time with a passkey</a></p>
```

Add `ACCOUNT_PATH` to that file's `../auth/paths.js` import.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- test/routes/squad.test.ts test/routes/dashboard.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the full verification**

Run: `npm run lint && npm run typecheck && npm test`
Expected: all pass except the `signin.test.ts` route guard.

- [ ] **Step 7: Commit**

```bash
git add src/views/game-overview.ts src/views/dashboard.ts test/routes/squad.test.ts test/routes/dashboard.test.ts
git commit -m "feat: link both new pages from where people actually are

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WzHAQF3vBYdjm3A3hw2Jkt"
```

---

### Task 8: The three registration guards

This repo enforces that every route is catalogued, CSP-checked and captured. All three caught the M7c privacy page late; do them deliberately here rather than discovering them from a red suite.

**Files:**
- Modify: `test/browser/catalogue.ts`
- Modify: `test/browser/catalogue.spec.ts`
- Modify: `test/routes/signin.test.ts`

**Interfaces:**
- Consumes: `ACCOUNT_PATH` from Task 4, and `World.gameId` / `World.memberPlayerId` from `test/browser/world.ts`.

- [ ] **Step 1: See exactly what is failing**

Run: `npm test -- test/routes/signin.test.ts`
Expected: FAIL, naming `GET /app/account`, `POST /app/account` and `GET /g/:id/squad/:playerId` as registered routes the enumeration does not know about. Read the failure before editing — it tells you the exact keys to add.

- [ ] **Step 2: Add the two catalogue entries**

In `test/browser/catalogue.ts`, add `ACCOUNT_PATH` to the `../../src/auth/paths.js` import, then add these entries — the account page after `delete-account`, and the squad member page beside `remove-member`:

```ts
  {
    id: "account",
    title: "Your account",
    path: () => ACCOUNT_PATH,
    // The `owner` persona: the seeded owner has fixtures, so the history list
    // renders with rows rather than as its empty state, which is the version
    // worth putting in front of a browser and a CSP.
    persona: "owner",
    note: "A player's own record: their name (editable), their email (not), how they sign in, and their last 20 fixtures across every game.",
  },
```

```ts
  {
    id: "squad-member",
    title: "Squad member",
    path: (w) => `/g/${w.gameId}/squad/${w.memberPlayerId}`,
    persona: "owner",
    note: "One squad member as their organiser sees them — name, email, role, joined date, and deliberately no history.",
  },
```

- [ ] **Step 3: Register the routes in the catalogue spec**

In `test/browser/catalogue.spec.ts`, add `ACCOUNT_PATH` to the `paths.js` import, to the `CONSTANTS` record, and add both routes to `ROUTE_TO_ID`:

```ts
  [ACCOUNT_PATH, "account"],
  ["/g/:id/squad/:playerId", "squad-member"],
```

- [ ] **Step 4: Register the routes in the completeness guard**

In `test/routes/signin.test.ts`, add to `ROUTE_TO_PAGE`:

```ts
    "GET /app/account": "account",
    "GET /g/:id/squad/:playerId": "squad member",
```

The page names on the right must match names that suite actually captures — read how `"delete my data"` and `"squad remove confirm"` are produced there and add the two captures the same way, so the `capturedPageNames` assertion passes.

`POST /app/account` goes wherever its sibling POSTs go: read whether `POST /app` and `POST /app/delete` are in `ROUTE_TO_PAGE` or in `EXCLUDED_ROUTES`, and follow that, with a reason if it is the latter — an unexplained exclusion is exactly what that map's comment forbids.

- [ ] **Step 5: Run the full verification**

Run: `npm run lint && npm run typecheck && npm test`
Expected: **all pass, with nothing outstanding.** This is the first task since Task 4 where the whole suite should be green; if it is not, do not go on to Task 9.

- [ ] **Step 6: Commit**

```bash
git add test/browser/catalogue.ts test/browser/catalogue.spec.ts test/routes/signin.test.ts
git commit -m "test: register the account and squad-member pages

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WzHAQF3vBYdjm3A3hw2Jkt"
```

---

### Task 9: Browser pass and screenshots

**Files:**
- Modify: `test/browser/screenshots/` (regenerated artefacts)

- [ ] **Step 1: Run the browser suite**

Run: `npm run test:browser`
Expected: PASS. Both new pages go through the console/CSP gate for the first time here. A CSP failure means something in a new view emitted an attribute or inline handler the policy forbids — fix the view, never the policy.

- [ ] **Step 2: Capture the screenshots**

Run: `npm run guide:capture`
Expected: new phone screenshots for `account` and `squad-member` under `test/browser/screenshots/`.

- [ ] **Step 3: Look at both screenshots**

Open them and check the M10 design treatment holds: one muted grey, the same type scale as the dashboard, no orphaned control, nothing overflowing at phone width. The account page's fixture list should read as a sibling of the dashboard's cards, not as a different product.

- [ ] **Step 4: Commit**

```bash
git add test/browser/screenshots
git commit -m "test: phone screenshots for the account and squad-member pages

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WzHAQF3vBYdjm3A3hw2Jkt"
```

---

### Task 10: Guide chapter and merge

**Files:**
- Modify: `docs/guide/07-your-own-fixtures.md` (or a new chapter — read the existing set first)
- Modify: `docs/guide/manifest.json`
- Modify: `spec.md` (§2.14 build order — add the M11 row)

- [ ] **Step 1: Read the guide's shape**

Read `docs/guide/README.md`, `docs/guide/manifest.json` and `docs/guide/07-your-own-fixtures.md`. The account page belongs with a player's own fixtures; the squad-member page belongs with `05-running-your-squad.md`. Decide from what is there whether these are additions to those two chapters or a new one — do not add a chapter if a section will do.

- [ ] **Step 2: Write the prose**

Two sections. Match the surrounding chapters' voice — second person, present tense, no feature-list tone — and match how they reference their images (read one first; the manifest and the `images/` naming are load-bearing).

Into the player-facing chapter, under a `## Your account` heading:

> There's a page for you as well as for your games. **Your account** — linked from your games list — has your name on it, and changing it there changes it everywhere: on every fixture your squad can see, and in every email that goes out about you.
>
> Your email address is on that page too, but you can't change it there. It's how you sign in, so changing it isn't a matter of typing a new one — get it wrong and the link that would put it right goes to somebody else's inbox. For now, if you need a different address, sign up again with it and ask your organiser to swap you over.
>
> Underneath is everything you've played, most recent first, twenty fixtures deep, across all your games rather than just one. If you've left a game, its fixtures aren't in the list: the page shows you the squads you're in.

Into the organiser-facing chapter, under a `## Looking somebody up` heading:

> Open **Manage** next to anybody in your squad and the first thing there is **View details**. It's a small page: their name, their email address, whether they're an organiser, and how long they've been in the squad.
>
> You can't edit any of it, and you can't see what they've played. Their name is theirs to change, and their fixtures in *other* games aren't yours to look at — this page is about your squad, not about a person. Changing their role or taking them out of the squad is still done back on the game page, where it's always been.

- [ ] **Step 3: Add the M11 row to the build order**

In `spec.md` §2.14, add a row for M11 matching how M8 and M10 were added.

- [ ] **Step 4: Full verification, one last time**

Run: `npm run lint && npm run typecheck && npm test && npm run test:browser`
Expected: all pass.

- [ ] **Step 5: Commit and merge**

```bash
git add docs/guide spec.md
git commit -m "docs: the account page and the squad-member view, in the guide

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WzHAQF3vBYdjm3A3hw2Jkt"
```

Then use the `superpowers:finishing-a-development-branch` skill to decide how this integrates, rather than merging by reflex.

---

## Notes for the executor

**Things that will look like bugs and are not:**

- `listPlayerFixtureHistory` has no caller after Task 3. Task 5 is its caller.
- The three 404 tests in Task 6 pass before the route exists, because Hono's own 404 answers. They become meaningful once the route is registered — which is the point of writing them before it.
- `test/routes/signin.test.ts` is red from Task 5 to Task 8. That is the route-completeness guard doing its job. It must be green at the end of Task 8.

**Things that would be bugs:**

- Any 403 from the squad-member route. It is 404, always. See the Global Constraints.
- Any fixture data on the squad-member page.
- Any write to Better Auth's `user` table from `POST /app/account`.
- Any new `notInArray(fixtures.lifecycle, …)` inside `entitledTo`. The split in Task 3 is the point of Task 3.

# Recording the result (M25, BR-37) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After a fixture is played, any player who was in it — plus any active organiser — files a claim about what happened; others agree or file an alternative; the most-backed claim locks 48 hours after kickoff.

**Architecture:** One row per (fixture, player) in `fixture_result_claims`, so one-player-one-vote is a unique constraint rather than a rule the write path remembers, and a candidate is a `GROUP BY` rather than a row that can be orphaned. The tally is two-level — outcome first, then margin among the claims consistent with it. The lock is a pure predicate (`claims exist && now >= kickoff + 48h`), and `fixture_results` is a recomputable cache of the derivation at the instant it froze, not a stored state. A new player-facing fixture page carries the result panel, the squad and the published teams.

**Tech Stack:** TypeScript, Hono, Drizzle ORM on Cloudflare D1, Workers cron, Vitest (`@cloudflare/vitest-pool-workers`), Playwright.

**Spec:** `docs/superpowers/specs/2026-08-21-fixture-results-design.md` — read it alongside this plan; every task argues from it.

## Global Constraints

These apply to every task. They are not reminders; each has shipped as a production defect in this repository at least once.

- **Every interpolation goes through `escapeHtml`**, including `href` and class attributes.
- **A `<style>` block not listed in `PAGE_STYLE_BLOCKS` (`src/views/styles.ts`) is silently dropped by the browser.** `src/security/csp.ts` hashes exactly `STYLE_BLOCKS` for `style-src`. Every test still passes.
- **`pageStyles` array order is cascade order.** `layout()` joins them in order; at equal specificity the later block wins.
- **A `style="…"` attribute is stripped.** `style-src` is hash-only with no `style-src-attr`. Use a declared class. Never add `'unsafe-inline'` or `'unsafe-hashes'`.
- **A script block not in `PAGE_SCRIPT_BLOCKS` (`src/views/scripts.ts`) is dropped the same way.**
- **A stored value indexing a lookup table can be `undefined`.** These columns are `text NOT NULL` with no CHECK constraint. `escapeHtml(undefined)` throws and 500s the page. Read the label first, branch on whether there is one.
- **A backtick inside a CSS comment in `styles.ts` terminates the template literal**, and `tsc` reports only a bare `TS1005` at a confusing location.
- **A comment inside a style block ships to the browser as page content**, so quoting UI copy there can turn "this string is absent" tests red.
- **`toContain` on a generated numeric class family prefix-matches.** Put the delimiter in the needle (`.w-5 {`).
- **An order-pinning test passes vacuously when a block is absent** (`indexOf` returns `-1`). Pair it with a presence assertion.
- **Stub an injected builtin with an ordinary function that checks its receiver, never an arrow function.** A field holding the global `fetch` called as `this.fetchImpl(...)` throws `Illegal invocation` in Workers; an arrow stub reads a method call and a free call identically. See `test/notify/push-notifier.test.ts`.
- **Guards establish *who*; entitlement is re-asked per handler, and a refusal is a 404, not a 403** (TR-18).
- **All timezone conversion goes through `formatLocalDateTime`** (TR-5).
- **Comments name the failure a rule prevents.** They do not restate the code. A comment that overclaims is worse than none.

**Commands:**

```bash
npx vitest run <path>          # scoped, ~9s
npm test                       # full suite, >120s — wait for it, never background it
npm run lint && npx tsc --noEmit
npm run db:generate            # drizzle-kit generate, after a schema edit
npx playwright test            # browser suite, ~5min
```

**Constants fixed here so no two tasks disagree:**

| name | value |
|---|---|
| `RESULT_OUTCOMES` | `["a", "b", "draw"]` |
| `MAX_SCORE` | `99` |
| `RESULT_LOCK_WINDOW_MS` | `48 * 60 * 60 * 1000` |
| `RESULT_NUDGE_WINDOW_MS` | `12 * 60 * 60 * 1000` |
| notification type | `"n12"` |
| dedupe key | `n12:<fixtureId>:<playerId>` |
| audit actions | `fixture.result_filed`, `fixture.result_changed`, `fixture.result_cleared`, `fixture.result_locked`, `fixture.result_nudge_email_deferred` |

---

## File Structure

**Created:**

| file | responsibility |
|---|---|
| `src/domain/result.ts` | Outcomes, form parsing, the two-level tally, the derived winner. Pure — no database, no clock. |
| `src/domain/result-lock.ts` | The deadline and the lock/writable predicates. Pure; `now` is a parameter. |
| `src/db/result-queries.ts` | Reading claims, the electorate, and the four writes. Kept out of `queries.ts`, which is already 574 lines. |
| `src/views/result.ts` | The result panel, shared by the player fixture page and the owner fixture page. |
| `src/views/player-fixture.ts` | The player's view of one fixture. |
| `src/routes/results.ts` | `POST …/result` and `POST …/result/clear`, its own Hono router mounted like `broadcast`. |
| `src/sweep/result-cache.ts` | Materialising `fixture_results`. |
| `src/notify/send-result-nudge.ts` | N-12. |
| `src/notify/templates/result-nudge.ts` | N-12's email body. |
| `test/domain/result.test.ts`, `test/domain/result-lock.test.ts`, `test/db/result-queries.test.ts`, `test/routes/player-fixture.test.ts`, `test/routes/results.test.ts`, `test/views/result-panel.test.ts`, `test/sweep/result-cache.test.ts`, `test/notify/result-nudge.test.ts`, `test/played-fixture-freeze.test.ts`, `test/browser/result.spec.ts` | |

**Modified:** `src/db/schema.ts`, `src/domain/audit.ts`, `src/notify/dedupe-key.ts`, `src/notify/push-copy.ts`, `src/views/styles.ts`, `src/views/fixture.ts`, `src/views/owner-fixture.ts`, `src/views/dashboard.ts`, `src/views/account.ts`, `src/views/player-game.ts`, `src/views/game-overview.ts`, `src/routes/games.ts`, `src/routes/dashboard.ts`, `src/routes/account.ts`, `src/auth/paths.ts`, `src/cron/handler.ts`, `src/app.ts`, `src/db/dashboard-queries.ts`, `test/support/factories.ts`, `test/stored-lookups.test.ts`, `test/views/style-cascade.test.ts`, `screens.md`, `docs/known-issues.md`, `docs/guide/`.

---

### Task 1: The played-fixture freeze invariant

This is task zero, and it comes before any feature work. Spec §12 decides that teams accuracy needs no stored column *because* every input to it is frozen once a fixture is `played`. That is currently an inference from reading three routes, not something the suite asserts. If this test fails, stop and tell the maintainer — §12 collapses and the stored-flag option comes back.

**Files:**
- Test: `test/played-fixture-freeze.test.ts` (create)

**Interfaces:**
- Consumes: `insertGame`, `insertFixture`, `insertPlayer`, `insertMembership`, `insertResponse`, `resetDatabase`, `testDb` from `test/support/factories.ts`; `signIn`, `ORIGIN` from `test/support/sign-in.ts`.
- Produces: nothing importable. It is a tripwire.

- [ ] **Step 1: Write the failing test**

Create `test/played-fixture-freeze.test.ts`:

```ts
import { SELF } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { fixtures, responses } from "../src/db/schema.js";
import {
  insertFixture,
  insertGame,
  insertMembership,
  insertPlayer,
  insertResponse,
  resetDatabase,
  testDb,
} from "./support/factories.js";
import { ORIGIN, signIn } from "./support/sign-in.js";
```

`signIn` takes an address that the sign-in gate admits. Find in `test/support/sign-in.ts` which address that is and how `signIn` returns its cookie, and use the same seeded address here rather than inventing one — several suites pass a constant exported from that module. Then the body:

```ts
/**
 * The freeze M25 §12 rests on: once a fixture is `played`, nothing may change
 * who was in it or which side they were on.
 *
 * `announcementOutstanding` is a pure predicate over exactly these four
 * columns, which is why the results milestone stores no `teams_were_accurate`
 * flag — the answer is computable forever. That is only true while this test
 * passes. If it fails, a result's teams-accuracy figure is a lie about a
 * fixture whose rosters moved after the fact, and the design needs the column
 * back.
 */
const KICKOFF = new Date("2026-08-13T18:00:00Z");

describe("a played fixture is frozen", () => {
  let gameId: string;
  let fixtureId: string;
  let ownerId: string;
  let playerId: string;
  let cookie: string;

  beforeEach(async () => {
    await resetDatabase();
    const db = testDb();
    ownerId = await insertPlayer(db, { email: "owner@example.com" });
    playerId = await insertPlayer(db, { email: "player@example.com" });
    gameId = await insertGame(db);
    await insertMembership(db, gameId, ownerId, { role: "owner" });
    await insertMembership(db, gameId, playerId);
    fixtureId = await insertFixture(db, gameId, {
      kicksOffAt: KICKOFF,
      lifecycle: "played",
      teamsSavedAt: KICKOFF,
      teamsPublishedAt: KICKOFF,
    });
    await insertResponse(db, fixtureId, playerId, { status: "in", team: "a" });
    cookie = await signIn("owner@example.com");
  });

  it("refuses an owner override of a response", async () => {
    const response = await SELF.fetch(
      `${ORIGIN}/g/${gameId}/f/${fixtureId}/response/${playerId}`,
      {
        method: "POST",
        headers: { cookie, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ intent: "out" }),
      },
    );
    expect(response.status).not.toBe(303);

    const [row] = await testDb().select().from(responses).where(eq(responses.fixtureId, fixtureId));
    expect(row?.status).toBe("in");
    expect(row?.team).toBe("a");
  });

  it("refuses a team save", async () => {
    const before = await testDb().select().from(fixtures).where(eq(fixtures.id, fixtureId));
    const response = await SELF.fetch(`${ORIGIN}/g/${gameId}/f/${fixtureId}/teams`, {
      method: "POST",
      headers: { cookie, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ [`team:${playerId}`]: "b" }),
    });
    expect(response.status).not.toBe(303);

    const [after] = await testDb().select().from(fixtures).where(eq(fixtures.id, fixtureId));
    expect(after?.teamsSavedAt?.getTime()).toBe(before[0]?.teamsSavedAt?.getTime());
    const [row] = await testDb().select().from(responses).where(eq(responses.fixtureId, fixtureId));
    expect(row?.team).toBe("a");
  });

  it("refuses a publish", async () => {
    const before = await testDb().select().from(fixtures).where(eq(fixtures.id, fixtureId));
    const response = await SELF.fetch(`${ORIGIN}/g/${gameId}/f/${fixtureId}/teams/publish`, {
      method: "POST",
      headers: { cookie, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({}),
    });
    expect(response.status).not.toBe(303);

    const [after] = await testDb().select().from(fixtures).where(eq(fixtures.id, fixtureId));
    expect(after?.teamsPublishedAt?.getTime()).toBe(before[0]?.teamsPublishedAt?.getTime());
  });

  it("refuses a response through the token route", async () => {
    // Find how `test/routes/respond-post.test.ts` mints a token for a fixture
    // and reuse that helper here; assert the stored row is untouched
    // afterwards, exactly as the three tests above do.
  });
});
```

Fill in the fourth test by reading `test/routes/respond-post.test.ts` for how it signs a response token — do not guess the helper's name or signature.

- [ ] **Step 2: Run it**

Run: `npx vitest run test/played-fixture-freeze.test.ts`

Expected: **PASS**, if the freeze is real. This is the one test in the plan that is expected to pass on first run — it asserts existing behaviour. If any case fails, **stop and report it**: it is a live production defect and it invalidates spec §12.

- [ ] **Step 3: Add the stored-lookups note**

In `test/stored-lookups.test.ts`, in the module doc comment, add one line pointing at the new file, so the two invariant suites are findable from each other:

```
 * The sibling invariant is `test/played-fixture-freeze.test.ts`: this file
 * proves a renderer survives a value it has never heard of, that one proves a
 * played fixture's rows never change under one.
```

- [ ] **Step 4: Commit**

```bash
git add test/played-fixture-freeze.test.ts test/stored-lookups.test.ts
git commit -m "test: pin the played-fixture freeze M25 derives teams accuracy from"
```

---

### Task 2: Schema, migration, and test factories

**Files:**
- Modify: `src/db/schema.ts` (append two tables after `responses`)
- Create: `migrations/00NN_*.sql` (generated, do not hand-write)
- Modify: `test/support/factories.ts` (`RESET_TABLES`, a new factory)
- Test: `test/db/result-queries.test.ts` (create, one shape assertion for now)

**Interfaces:**
- Produces: `fixtureResultClaims` and `fixtureResults` Drizzle tables; `insertResultClaim(db, fixtureId, playerId, overrides)` returning the row id.

- [ ] **Step 1: Write the failing test**

Create `test/db/result-queries.test.ts`. Copy the import block style from `test/db/` siblings.

```ts
describe("fixture_result_claims", () => {
  beforeEach(resetDatabase);

  it("allows one claim per player per fixture and refuses a second", async () => {
    const db = testDb();
    const playerId = await insertPlayer(db, { email: "a@example.com" });
    const gameId = await insertGame(db);
    const fixtureId = await insertFixture(db, gameId, { lifecycle: "played" });

    await insertResultClaim(db, fixtureId, playerId, { outcome: "a", scoreA: 3, scoreB: 2 });

    await expect(
      insertResultClaim(db, fixtureId, playerId, { outcome: "draw" }),
    ).rejects.toThrow();
  });

  it("allows the same player a claim on a different fixture", async () => {
    const db = testDb();
    const playerId = await insertPlayer(db, { email: "a@example.com" });
    const gameId = await insertGame(db);
    const one = await insertFixture(db, gameId, { lifecycle: "played" });
    const two = await insertFixture(db, gameId, {
      lifecycle: "played",
      kicksOffAt: new Date("2026-08-20T18:00:00Z"),
    });

    await insertResultClaim(db, one, playerId, { outcome: "a" });
    await insertResultClaim(db, two, playerId, { outcome: "b" });

    const rows = await db.select().from(fixtureResultClaims);
    expect(rows).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/db/result-queries.test.ts`
Expected: FAIL — `fixtureResultClaims` is not exported, `insertResultClaim` does not exist.

- [ ] **Step 3: Add the tables**

In `src/db/schema.ts`, after the `responses` table, add:

```ts
/**
 * One player's claim about what happened in a played fixture (BR-37, M25).
 *
 * **One row per (fixture, player), and that is the whole voting model.** There
 * is no separate table of candidate results and no table of votes: a candidate
 * *is* a `GROUP BY` over these rows, so a candidate with nobody behind it
 * cannot exist and there is no id for a vote to dangle from. Agreeing with
 * somebody copies their values into your own row; changing your mind updates
 * it in place.
 *
 * The unique index is what makes "one player, one endorsement" a property of
 * the database rather than a rule every write path has to remember — the same
 * move `responses_fixture_player_unique` makes one table up.
 *
 * **The flip history lives in `audit_log`**, which already carries
 * `before_json`/`after_json`. A `superseded_at` column here would put a filter
 * on every read that somebody eventually forgets.
 */
export const fixtureResultClaims = sqliteTable(
  "fixture_result_claims",
  {
    id: text("id").primaryKey(),
    fixtureId: text("fixture_id").notNull().references(() => fixtures.id),
    playerId: text("player_id").notNull().references(() => players.id),
    /**
     * Present on every claim, including a scored one, so the outcome tally is
     * a single `GROUP BY` rather than a `CASE` over two nullable integers.
     *
     * A stored value indexing a lookup, in a bare `text NOT NULL` with no
     * CHECK constraint — the same shape as `fixtures.lifecycle` and
     * `responses.team`, both of which have 500'd a page by arriving as a value
     * the TypeScript type said was impossible. Enumerated in
     * `test/stored-lookups.test.ts`.
     *
     * **Derived from the score whenever one is given** (`parseClaim` in
     * `src/domain/result.ts`), never taken from the form. A row saying
     * "3-2, draw" would count toward an outcome its own score contradicts,
     * and nothing in SQLite would catch it.
     */
    outcome: text("outcome", { enum: RESULT_OUTCOMES }).notNull(),
    /** Both null (outcome-only) or both set. Enforced by `parseClaim`. */
    scoreA: integer("score_a"),
    scoreB: integer("score_b"),
    /**
     * When this player took *this* position — moved forward when they change
     * it, not left at row birth.
     *
     * It exists to answer one question, the last tie-break in
     * `deriveResult`: how long has this candidate been standing? A player who
     * switched from 3-2 to 4-2 this morning has not been backing 4-2 since
     * Thursday, and `created_at` would say they had.
     */
    filedAt: integer("filed_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
  },
  (t) => [uniqueIndex("fixture_result_claims_fixture_player_unique").on(t.fixtureId, t.playerId)],
);

/**
 * The derived result of a fixture, materialised once at the instant it froze
 * (BR-37, M25).
 *
 * **This is a cache, and the design depends on that staying true.** Every page
 * and every refusal reads `deriveResult` over the claims; nothing reads this
 * table to decide anything. A sweep run that fails, or a deploy that never
 * runs one, costs a row the next run writes — not a fixture stuck in a wrong
 * state with nothing to notice it.
 *
 * It exists for exactly one reason: a purely derived result is a function
 * evaluated at read time, so changing the tie-break rule — or fixing a bug in
 * it — would silently rewrite last season's results underneath anything fitted
 * on them, with no row edited and no test failing.
 * `test/sweep/result-cache.test.ts` asserts a stored row still equals the
 * derivation, which is what makes "only a cache" true rather than aspirational.
 */
export const fixtureResults = sqliteTable("fixture_results", {
  fixtureId: text("fixture_id").primaryKey().references(() => fixtures.id),
  outcome: text("outcome", { enum: RESULT_OUTCOMES }).notNull(),
  /** Null means "outcome agreed, score not" — a legitimate, recordable state. */
  scoreA: integer("score_a"),
  scoreB: integer("score_b"),
  outcomeBackers: integer("outcome_backers").notNull(),
  marginBackers: integer("margin_backers").notNull(),
  voterCount: integer("voter_count").notNull(),
  /** The turnout denominator: the electorate's size at lock. */
  eligibleCount: integer("eligible_count").notNull(),
  distinctOutcomes: integer("distinct_outcomes").notNull(),
  distinctScores: integer("distinct_scores").notNull(),
  /** Whether the fixture had published teams for a roster join to reach. */
  rostered: integer("rostered", { mode: "boolean" }).notNull(),
  /**
   * `announcementOutstanding` inverted, evaluated at lock. Spec §12: this is
   * derivable forever from frozen rows, and is cached here only so that a
   * future change to that predicate cannot rewrite history.
   */
  teamsAccurate: integer("teams_accurate", { mode: "boolean" }).notNull(),
  lockedAt: integer("locked_at", { mode: "timestamp_ms" }).notNull(),
  materialisedAt: integer("materialised_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
});
```

Add the import at the top of `schema.ts`:

```ts
import { RESULT_OUTCOMES } from "../domain/result.js";
```

`src/domain/result.ts` does not exist yet, so create it now containing **only** the constant and its type — the rest arrives in Task 3. `src/domain/lifecycle.ts` is the precedent for a domain module the schema imports: it deliberately imports nothing itself, to keep the schema layer from cycling back through the domain layer. Do the same here.

```ts
/**
 * The one definition of `fixture_result_claims.outcome` and
 * `fixture_results.outcome` (BR-37).
 *
 * This module imports nothing on purpose: the schema layer depends on it, so
 * anything it depended on would risk a cycle back through the domain layer —
 * exactly the constraint `src/domain/lifecycle.ts` documents.
 */
export const RESULT_OUTCOMES = ["a", "b", "draw"] as const;

export type ResultOutcome = (typeof RESULT_OUTCOMES)[number];
```

- [ ] **Step 4: Generate the migration**

Run: `npm run db:generate`

Then **read the generated SQL**. It must contain exactly two `CREATE TABLE`s and one `CREATE UNIQUE INDEX`, and must not alter or drop anything existing. Drizzle names the file itself; do not rename it.

- [ ] **Step 5: Register the tables for reset, and add the factory**

In `test/support/factories.ts`, add to `RESET_TABLES` — **before** `"responses"`, since both new tables hold a foreign key to `fixtures` and the list deletes children before parents:

```ts
  "fixture_results",
  "fixture_result_claims",
```

Add the factory beside `insertResponse`:

```ts
export async function insertResultClaim(
  db: Db,
  fixtureId: string,
  playerId: string,
  overrides: Partial<typeof fixtureResultClaims.$inferInsert> = {},
): Promise<string> {
  const id = crypto.randomUUID();
  // `filedAt` is pinned rather than left to the caller's wall clock: the last
  // tie-break in `deriveResult` compares these instants, and a suite whose
  // claims all land in the same millisecond cannot test it.
  await db.insert(fixtureResultClaims).values({
    id,
    fixtureId,
    playerId,
    outcome: "a",
    filedAt: NOW,
    ...overrides,
  });
  return id;
}
```

Import `fixtureResultClaims` from `../src/db/schema.js` at the top of that file.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run test/db/result-queries.test.ts && npx tsc --noEmit && npm run lint`
Expected: PASS, clean, clean.

- [ ] **Step 7: Commit**

```bash
git add src/db/schema.ts src/domain/result.ts migrations/ test/support/factories.ts test/db/result-queries.test.ts
git commit -m "feat: fixture_result_claims and fixture_results tables (M25)"
```

---

### Task 3: The domain — parsing a claim and the two-level tally

**Files:**
- Modify: `src/domain/result.ts` (created empty-ish in Task 2)
- Test: `test/domain/result.test.ts` (create)

**Interfaces:**
- Consumes: `RESULT_OUTCOMES`, `ResultOutcome` (Task 2).
- Produces:
  - `MAX_SCORE: 99`
  - `outcomeFromScore(scoreA: number, scoreB: number): ResultOutcome`
  - `interface ResultClaim { playerId: string; outcome: ResultOutcome; scoreA: number | null; scoreB: number | null; filedAt: Date }`
  - `type ParsedClaim = { ok: true; outcome: ResultOutcome; scoreA: number | null; scoreB: number | null } | { ok: false; problem: string }`
  - `parseClaim(form: { outcome: string | undefined; scoreA: string | undefined; scoreB: string | undefined }): ParsedClaim`
  - `interface ScoreCandidate { scoreA: number; scoreB: number; backers: readonly string[]; firstFiledAt: Date }`
  - `interface OutcomeCandidate { outcome: ResultOutcome; backers: readonly string[]; firstFiledAt: Date; scores: readonly ScoreCandidate[]; unscoredBackers: number }`
  - `tally(claims: readonly ResultClaim[]): readonly OutcomeCandidate[]`
  - `interface DerivedResult { outcome: ResultOutcome; outcomeBackers: number; scoreA: number | null; scoreB: number | null; marginBackers: number; voterCount: number; distinctOutcomes: number; distinctScores: number }`
  - `deriveResult(claims: readonly ResultClaim[], organiserIds: ReadonlySet<string>): DerivedResult | null`

- [ ] **Step 1: Write the failing test**

Create `test/domain/result.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  deriveResult,
  outcomeFromScore,
  parseClaim,
  tally,
  type ResultClaim,
} from "../../src/domain/result.js";

const T = (minutes: number) => new Date(Date.UTC(2026, 7, 13, 20, minutes));

function claim(overrides: Partial<ResultClaim> & { playerId: string }): ResultClaim {
  return { outcome: "a", scoreA: null, scoreB: null, filedAt: T(0), ...overrides };
}

const NOBODY = new Set<string>();

describe("outcomeFromScore", () => {
  it("names the higher side and calls equal scores a draw", () => {
    expect(outcomeFromScore(3, 2)).toBe("a");
    expect(outcomeFromScore(2, 3)).toBe("b");
    expect(outcomeFromScore(0, 0)).toBe("draw");
  });
});

describe("parseClaim", () => {
  it("derives the outcome from the score and ignores the submitted one", () => {
    // The whole point: a row saying "3-2, draw" must be unconstructible,
    // because it would count toward an outcome its own score contradicts and
    // nothing in SQLite would catch it.
    const parsed = parseClaim({ outcome: "draw", scoreA: "3", scoreB: "2" });
    expect(parsed).toEqual({ ok: true, outcome: "a", scoreA: 3, scoreB: 2 });
  });

  it("accepts an outcome with no score", () => {
    expect(parseClaim({ outcome: "b", scoreA: "", scoreB: "" })).toEqual({
      ok: true,
      outcome: "b",
      scoreA: null,
      scoreB: null,
    });
  });

  it("refuses half a score", () => {
    const parsed = parseClaim({ outcome: "a", scoreA: "3", scoreB: "" });
    expect(parsed.ok).toBe(false);
  });

  it("refuses a negative, a fraction, a non-number and anything over the cap", () => {
    for (const bad of ["-1", "1.5", "three", "100"]) {
      expect(parseClaim({ outcome: "a", scoreA: bad, scoreB: "0" }).ok).toBe(false);
    }
  });

  it("refuses an outcome outside the union", () => {
    expect(parseClaim({ outcome: "abandoned", scoreA: "", scoreB: "" }).ok).toBe(false);
    expect(parseClaim({ outcome: undefined, scoreA: "", scoreB: "" }).ok).toBe(false);
  });
});

describe("tally", () => {
  it("counts a scored claim toward its outcome alongside an outcome-only one", () => {
    const claims = [
      claim({ playerId: "p1", outcome: "a", scoreA: 3, scoreB: 2 }),
      claim({ playerId: "p2", outcome: "a", scoreA: 3, scoreB: 2 }),
      claim({ playerId: "p3", outcome: "a" }),
    ];
    const [top] = tally(claims);
    expect(top?.outcome).toBe("a");
    expect(top?.backers).toHaveLength(3);
    expect(top?.unscoredBackers).toBe(1);
    expect(top?.scores).toHaveLength(1);
    expect(top?.scores[0]?.backers).toHaveLength(2);
  });

  it("keeps distinct scores within one outcome apart", () => {
    const claims = [
      claim({ playerId: "p1", outcome: "a", scoreA: 3, scoreB: 2 }),
      claim({ playerId: "p2", outcome: "a", scoreA: 4, scoreB: 2 }),
    ];
    expect(tally(claims)[0]?.scores).toHaveLength(2);
  });

  it("orders outcomes by backers, most first", () => {
    const claims = [
      claim({ playerId: "p1", outcome: "b" }),
      claim({ playerId: "p2", outcome: "a" }),
      claim({ playerId: "p3", outcome: "a" }),
    ];
    expect(tally(claims).map((c) => c.outcome)).toEqual(["a", "b"]);
  });
});

describe("deriveResult", () => {
  it("returns null when nobody has filed", () => {
    expect(deriveResult([], NOBODY)).toBeNull();
  });

  it("records the unanimous outcome and the majority margin separately", () => {
    // Five voters: three say Bibs 3-2, two say Bibs won with no score. The
    // squad is unanimous on the outcome; the margin is attested by three.
    // A flat tally would report "3-2, three backers" and throw the unanimity
    // away, which is backwards for anything fitted on this data.
    const claims = [
      claim({ playerId: "p1", outcome: "a", scoreA: 3, scoreB: 2 }),
      claim({ playerId: "p2", outcome: "a", scoreA: 3, scoreB: 2 }),
      claim({ playerId: "p3", outcome: "a", scoreA: 3, scoreB: 2 }),
      claim({ playerId: "p4", outcome: "a" }),
      claim({ playerId: "p5", outcome: "a" }),
    ];
    expect(deriveResult(claims, NOBODY)).toEqual({
      outcome: "a",
      outcomeBackers: 5,
      scoreA: 3,
      scoreB: 2,
      marginBackers: 3,
      voterCount: 5,
      distinctOutcomes: 1,
      distinctScores: 1,
    });
  });

  it("locks an outcome with no score when nobody gave one", () => {
    const derived = deriveResult([claim({ playerId: "p1", outcome: "draw" })], NOBODY);
    expect(derived?.scoreA).toBeNull();
    expect(derived?.marginBackers).toBe(0);
  });

  it("breaks an outcome tie on an organiser's backing", () => {
    const claims = [
      claim({ playerId: "p1", outcome: "a", filedAt: T(0) }),
      claim({ playerId: "owner", outcome: "b", filedAt: T(5) }),
    ];
    expect(deriveResult(claims, new Set(["owner"]))?.outcome).toBe("b");
  });

  it("breaks an outcome tie on filing order when no organiser voted", () => {
    const claims = [
      claim({ playerId: "p1", outcome: "a", filedAt: T(0) }),
      claim({ playerId: "p2", outcome: "b", filedAt: T(5) }),
    ];
    expect(deriveResult(claims, NOBODY)?.outcome).toBe("a");
  });

  it("prefers backers over an organiser's backing", () => {
    // The organiser breaks ties; it does not outvote the squad.
    const claims = [
      claim({ playerId: "p1", outcome: "a" }),
      claim({ playerId: "p2", outcome: "a" }),
      claim({ playerId: "owner", outcome: "b" }),
    ];
    expect(deriveResult(claims, new Set(["owner"]))?.outcome).toBe("a");
  });

  it("applies the same three steps to the margin", () => {
    const claims = [
      claim({ playerId: "p1", outcome: "a", scoreA: 3, scoreB: 2, filedAt: T(0) }),
      claim({ playerId: "owner", outcome: "a", scoreA: 4, scoreB: 2, filedAt: T(5) }),
    ];
    const derived = deriveResult(claims, new Set(["owner"]));
    expect([derived?.scoreA, derived?.scoreB]).toEqual([4, 2]);
  });

  it("ignores scores from a losing outcome when choosing the margin", () => {
    // Two people said Skins won 5-0. They lost the outcome vote, so their
    // score must not be able to become "Bibs won 5-0".
    const claims = [
      claim({ playerId: "p1", outcome: "a", scoreA: 1, scoreB: 0 }),
      claim({ playerId: "p2", outcome: "a", scoreA: 1, scoreB: 0 }),
      claim({ playerId: "p3", outcome: "a", scoreA: 1, scoreB: 0 }),
      claim({ playerId: "p4", outcome: "b", scoreA: 0, scoreB: 5 }),
      claim({ playerId: "p5", outcome: "b", scoreA: 0, scoreB: 5 }),
    ];
    const derived = deriveResult(claims, NOBODY);
    expect([derived?.scoreA, derived?.scoreB]).toEqual([1, 0]);
    expect(derived?.distinctScores).toBe(2);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/domain/result.test.ts`
Expected: FAIL — `parseClaim`, `tally`, `deriveResult` are not exported.

- [ ] **Step 3: Implement**

Append to `src/domain/result.ts` (keep `RESULT_OUTCOMES` at the top, and keep the module import-free):

```ts
/**
 * The largest score either side may be given.
 *
 * Arbitrary, and that is fine: it exists so that a pasted number cannot
 * produce a row nothing can render sensibly, not because 100-0 is
 * footballing nonsense.
 */
export const MAX_SCORE = 99;

/** One player's position on what happened, as the tally sees it. */
export interface ResultClaim {
  playerId: string;
  outcome: ResultOutcome;
  scoreA: number | null;
  scoreB: number | null;
  filedAt: Date;
}

export function outcomeFromScore(scoreA: number, scoreB: number): ResultOutcome {
  if (scoreA > scoreB) return "a";
  if (scoreB > scoreA) return "b";
  return "draw";
}

export type ParsedClaim =
  | { ok: true; outcome: ResultOutcome; scoreA: number | null; scoreB: number | null }
  | { ok: false; problem: string };

function parseScore(raw: string | undefined): number | null | "bad" {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") return null;
  // `Number()` rather than `parseInt`: `parseInt("3abc")` is 3, which would
  // accept a field the person plainly did not mean.
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < 0 || value > MAX_SCORE) return "bad";
  return value;
}

/**
 * Turn one submitted form into a claim, or into the reason it is not one.
 *
 * **The submitted outcome is ignored whenever a score is given.** This is the
 * only thing standing between the two-level tally and a claim that counts
 * toward an outcome its own score contradicts — `fixture_result_claims.outcome`
 * has no CHECK constraint behind it, so nothing else would catch such a row.
 */
export function parseClaim(form: {
  outcome: string | undefined;
  scoreA: string | undefined;
  scoreB: string | undefined;
}): ParsedClaim {
  const a = parseScore(form.scoreA);
  const b = parseScore(form.scoreB);
  if (a === "bad" || b === "bad") {
    return { ok: false, problem: `Scores must be whole numbers between 0 and ${MAX_SCORE}.` };
  }
  if ((a === null) !== (b === null)) {
    return { ok: false, problem: "Give both scores, or leave both blank and just say who won." };
  }
  if (a !== null && b !== null) {
    return { ok: true, outcome: outcomeFromScore(a, b), scoreA: a, scoreB: b };
  }
  const outcome = RESULT_OUTCOMES.find((value) => value === form.outcome);
  if (outcome === undefined) {
    return { ok: false, problem: "Say who won, or give the score." };
  }
  return { ok: true, outcome, scoreA: null, scoreB: null };
}

export interface ScoreCandidate {
  scoreA: number;
  scoreB: number;
  backers: readonly string[];
  firstFiledAt: Date;
}

export interface OutcomeCandidate {
  outcome: ResultOutcome;
  backers: readonly string[];
  firstFiledAt: Date;
  scores: readonly ScoreCandidate[];
  /** Backers of this outcome who gave no score — the "score not given" row. */
  unscoredBackers: number;
}

/**
 * Compare two candidates by the three steps every level of the tally uses, in
 * this order: most backers, then an organiser's backing, then the earliest
 * claim.
 *
 * Step 2 exists because step 3 alone rewards being quick over being right: a
 * wrong early claim that picks up one friend would beat a correct later one.
 * Step 3 is a total order on distinct instants, so the comparison never falls
 * through to whatever order the rows arrived in.
 */
function compareCandidates(
  left: { backers: readonly string[]; firstFiledAt: Date },
  right: { backers: readonly string[]; firstFiledAt: Date },
  organiserIds: ReadonlySet<string>,
): number {
  if (left.backers.length !== right.backers.length) return right.backers.length - left.backers.length;
  const leftOrganiser = left.backers.some((id) => organiserIds.has(id));
  const rightOrganiser = right.backers.some((id) => organiserIds.has(id));
  if (leftOrganiser !== rightOrganiser) return leftOrganiser ? -1 : 1;
  return left.firstFiledAt.getTime() - right.firstFiledAt.getTime();
}

function earliest(claims: readonly ResultClaim[]): Date {
  return claims.reduce(
    (soonest, claim) => (claim.filedAt < soonest ? claim.filedAt : soonest),
    claims[0]!.filedAt,
  );
}

/**
 * Group the claims into candidates, most-backed first.
 *
 * Ordered by backer count alone — not by `compareCandidates`, which needs the
 * organiser set the renderer has no business knowing. The page shows a list;
 * `deriveResult` decides a winner.
 */
export function tally(claims: readonly ResultClaim[]): readonly OutcomeCandidate[] {
  const byOutcome = new Map<ResultOutcome, ResultClaim[]>();
  for (const claim of claims) {
    const bucket = byOutcome.get(claim.outcome) ?? [];
    bucket.push(claim);
    byOutcome.set(claim.outcome, bucket);
  }

  const candidates: OutcomeCandidate[] = [];
  for (const [outcome, group] of byOutcome) {
    const byScore = new Map<string, ResultClaim[]>();
    for (const claim of group) {
      if (claim.scoreA === null || claim.scoreB === null) continue;
      const key = `${claim.scoreA}-${claim.scoreB}`;
      const bucket = byScore.get(key) ?? [];
      bucket.push(claim);
      byScore.set(key, bucket);
    }
    const scores: ScoreCandidate[] = [...byScore.values()]
      .map((group) => ({
        scoreA: group[0]!.scoreA!,
        scoreB: group[0]!.scoreB!,
        backers: group.map((claim) => claim.playerId),
        firstFiledAt: earliest(group),
      }))
      .sort((left, right) => right.backers.length - left.backers.length);

    candidates.push({
      outcome,
      backers: group.map((claim) => claim.playerId),
      firstFiledAt: earliest(group),
      scores,
      unscoredBackers: group.filter((claim) => claim.scoreA === null).length,
    });
  }

  return candidates.sort((left, right) => right.backers.length - left.backers.length);
}

export interface DerivedResult {
  outcome: ResultOutcome;
  outcomeBackers: number;
  /** Null is "outcome agreed, score not" — legitimate, and recordable. */
  scoreA: number | null;
  scoreB: number | null;
  marginBackers: number;
  voterCount: number;
  distinctOutcomes: number;
  distinctScores: number;
}

/**
 * The result these claims say, or null when nobody has filed.
 *
 * Two levels, because outcome-agreement and margin-agreement are different
 * facts and one number cannot carry both. The outcome is decided across
 * *every* claim — a 3-2 claim counts toward "Bibs won" exactly as an
 * outcome-only one does — and the margin only among the scored claims
 * consistent with the winning outcome, so a losing side's score can never
 * become the winner's.
 *
 * Pure: no clock and no database. The 48-hour window is
 * `src/domain/result-lock.ts`'s business, and this function is the same
 * answer before and after it.
 */
export function deriveResult(
  claims: readonly ResultClaim[],
  organiserIds: ReadonlySet<string>,
): DerivedResult | null {
  if (claims.length === 0) return null;
  const candidates = [...tally(claims)].sort((left, right) =>
    compareCandidates(left, right, organiserIds),
  );
  const winner = candidates[0]!;
  const margin = [...winner.scores].sort((left, right) =>
    compareCandidates(left, right, organiserIds),
  )[0];

  return {
    outcome: winner.outcome,
    outcomeBackers: winner.backers.length,
    scoreA: margin?.scoreA ?? null,
    scoreB: margin?.scoreB ?? null,
    marginBackers: margin?.backers.length ?? 0,
    voterCount: claims.length,
    distinctOutcomes: candidates.length,
    distinctScores: candidates.reduce((total, candidate) => total + candidate.scores.length, 0),
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/domain/result.test.ts && npx tsc --noEmit && npm run lint`
Expected: PASS, clean, clean.

- [ ] **Step 5: Commit**

```bash
git add src/domain/result.ts test/domain/result.test.ts
git commit -m "feat: two-level result tally and claim parsing (M25)"
```

---

### Task 4: The lock window

**Files:**
- Create: `src/domain/result-lock.ts`
- Test: `test/domain/result-lock.test.ts` (create)

**Interfaces:**
- Consumes: `ResultClaim` from `src/domain/result.js`; `Lifecycle` from `src/domain/lifecycle.js`.
- Produces:
  - `RESULT_LOCK_WINDOW_MS`
  - `resultDeadline(kicksOffAt: Date): Date`
  - `isResultLocked(kicksOffAt: Date, claimCount: number, now: Date): boolean`
  - `resultWritable(lifecycle: Lifecycle, kicksOffAt: Date, claimCount: number, now: Date): boolean`
  - `resultLockedAt(kicksOffAt: Date, claims: readonly ResultClaim[]): Date | null`

- [ ] **Step 1: Write the failing test**

Create `test/domain/result-lock.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  RESULT_LOCK_WINDOW_MS,
  isResultLocked,
  resultDeadline,
  resultLockedAt,
  resultWritable,
} from "../../src/domain/result-lock.js";
import type { ResultClaim } from "../../src/domain/result.js";

const KICKOFF = new Date("2026-08-13T18:00:00Z");
const DEADLINE = new Date(KICKOFF.getTime() + RESULT_LOCK_WINDOW_MS);

function claim(filedAt: Date): ResultClaim {
  return { playerId: "p1", outcome: "a", scoreA: null, scoreB: null, filedAt };
}

describe("resultDeadline", () => {
  it("is 48 hours after kickoff, not after full time", () => {
    expect(resultDeadline(KICKOFF).toISOString()).toBe("2026-08-15T18:00:00.000Z");
  });
});

describe("isResultLocked", () => {
  it("is open right up to the deadline", () => {
    expect(isResultLocked(KICKOFF, 2, new Date(DEADLINE.getTime() - 1))).toBe(false);
  });

  it("locks at the deadline exactly", () => {
    expect(isResultLocked(KICKOFF, 2, DEADLINE)).toBe(true);
  });

  it("does not lock after the deadline when nobody filed", () => {
    // Nothing to lock, so nothing locks: the form stays open and the first
    // late claim locks on filing. This one line is the whole empty case.
    expect(isResultLocked(KICKOFF, 0, new Date(DEADLINE.getTime() + 1))).toBe(false);
  });

  it("is locked the instant a late claim exists", () => {
    expect(isResultLocked(KICKOFF, 1, new Date(DEADLINE.getTime() + 1))).toBe(true);
  });
});

describe("resultWritable", () => {
  it("is writable on a played fixture before the deadline", () => {
    expect(resultWritable("played", KICKOFF, 1, KICKOFF)).toBe(true);
  });

  it("is writable after the deadline when nothing was filed", () => {
    expect(resultWritable("played", KICKOFF, 0, new Date(DEADLINE.getTime() + 1))).toBe(true);
  });

  it("is not writable once locked", () => {
    expect(resultWritable("played", KICKOFF, 1, DEADLINE)).toBe(false);
  });

  it("is never writable on any other lifecycle", () => {
    for (const lifecycle of ["scheduled", "open", "cancelled"] as const) {
      expect(resultWritable(lifecycle, KICKOFF, 0, DEADLINE)).toBe(false);
    }
  });
});

describe("resultLockedAt", () => {
  it("is the deadline when the claims predate it", () => {
    expect(resultLockedAt(KICKOFF, [claim(KICKOFF)])?.getTime()).toBe(DEADLINE.getTime());
  });

  it("is the first claim's own instant when it was filed late", () => {
    const late = new Date(DEADLINE.getTime() + 60_000);
    expect(resultLockedAt(KICKOFF, [claim(late)])?.getTime()).toBe(late.getTime());
  });

  it("is null with no claims", () => {
    expect(resultLockedAt(KICKOFF, [])).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/domain/result-lock.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/domain/result-lock.ts`:

```ts
import type { Lifecycle } from "./lifecycle.js";
import type { ResultClaim } from "./result.js";

/**
 * How long a result stays open to argument (BR-37).
 *
 * Measured from **kickoff**, not from full time: it is the rule as stated, it
 * needs no duration arithmetic, and kickoff is the instant everybody involved
 * already knows.
 */
export const RESULT_LOCK_WINDOW_MS = 48 * 60 * 60 * 1000;

export function resultDeadline(kicksOffAt: Date): Date {
  return new Date(kicksOffAt.getTime() + RESULT_LOCK_WINDOW_MS);
}

/**
 * Whether the claims on this fixture are final.
 *
 * **Both halves of the agreed behaviour fall out of this one expression, with
 * no second state and no special case.** Before the deadline claims exist and
 * can be argued with. At the deadline an existing claim set freezes. After the
 * deadline with *nothing* filed, `claimCount > 0` is false — so the fixture
 * stays writable, reads "no result recorded", and the first late claim makes
 * this true on the very same evaluation, standing alone with no voting round.
 *
 * A squad that forgot for two days does not lose the fixture from its history;
 * a squad that recorded something does not get it rewritten a week later.
 */
export function isResultLocked(kicksOffAt: Date, claimCount: number, now: Date): boolean {
  return claimCount > 0 && now.getTime() >= resultDeadline(kicksOffAt).getTime();
}

/**
 * Whether this fixture will accept a claim right now.
 *
 * `cancelled` is excluded for BR-16's reason — it is terminal and is never
 * resurrected into another lifecycle — and `open`/`scheduled` because there is
 * nothing yet to have a result about.
 */
export function resultWritable(
  lifecycle: Lifecycle,
  kicksOffAt: Date,
  claimCount: number,
  now: Date,
): boolean {
  if (lifecycle !== "played") return false;
  return !isResultLocked(kicksOffAt, claimCount, now);
}

/**
 * The instant this fixture's result became final, or null if it has not.
 *
 * The later of the deadline and the earliest claim: a fixture nobody filed on
 * until Tuesday locked on Tuesday, not retrospectively on Saturday evening.
 * Cached on `fixture_results.locked_at`; never used to decide anything, only
 * to record what happened.
 */
export function resultLockedAt(kicksOffAt: Date, claims: readonly ResultClaim[]): Date | null {
  if (claims.length === 0) return null;
  const first = claims.reduce(
    (soonest, claim) => (claim.filedAt < soonest ? claim.filedAt : soonest),
    claims[0]!.filedAt,
  );
  const deadline = resultDeadline(kicksOffAt);
  return first > deadline ? first : deadline;
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/domain/result-lock.test.ts && npx tsc --noEmit && npm run lint`
Expected: PASS, clean, clean.

- [ ] **Step 5: Commit**

```bash
git add src/domain/result-lock.ts test/domain/result-lock.test.ts
git commit -m "feat: the 48-hour result lock window (M25)"
```

---

### Task 5: Queries — claims, the electorate, and the four writes

**Files:**
- Create: `src/db/result-queries.ts`
- Modify: `test/db/result-queries.test.ts` (append)

**Interfaces:**
- Consumes: `Db` from `src/db/client.js`; `ResultClaim` from `src/domain/result.js`; `fixtureResultClaims`, `memberships`, `players`, `responses` from `src/db/schema.js`.
- Produces:
  - `interface StoredClaim extends ResultClaim { id: string; name: string; erasedAt: Date | null }`
  - `listResultClaims(db, fixtureId): Promise<StoredClaim[]>`
  - `resultElectorate(db, gameId, fixtureId): Promise<{ eligibleIds: Set<string>; organiserIds: Set<string> }>`
  - `findResultClaim(db, fixtureId, playerId): Promise<StoredClaim | null>`
  - `putResultClaim(db, params: { fixtureId; playerId; outcome; scoreA; scoreB; now }): Promise<void>`
  - `deleteResultClaim(db, fixtureId, playerId): Promise<boolean>`

- [ ] **Step 1: Write the failing test**

Append to `test/db/result-queries.test.ts`:

```ts
describe("resultElectorate", () => {
  it("is everyone who was in, plus every active owner, and no guest", async () => {
    const db = testDb();
    const gameId = await insertGame(db);
    const inPlayer = await insertPlayer(db, { email: "in@example.com" });
    const outPlayer = await insertPlayer(db, { email: "out@example.com" });
    const owner = await insertPlayer(db, { email: "owner@example.com" });
    const formerOwner = await insertPlayer(db, { email: "former@example.com" });
    const guest = await insertPlayer(db, { name: "Guest", isGuest: true });
    for (const id of [inPlayer, outPlayer, guest]) await insertMembership(db, gameId, id);
    await insertMembership(db, gameId, owner, { role: "owner" });
    await insertMembership(db, gameId, formerOwner, { role: "owner", active: false });

    const fixtureId = await insertFixture(db, gameId, { lifecycle: "played" });
    await insertResponse(db, fixtureId, inPlayer, { status: "in" });
    await insertResponse(db, fixtureId, outPlayer, { status: "out" });
    await insertResponse(db, fixtureId, guest, { status: "in" });

    const { eligibleIds, organiserIds } = await resultElectorate(db, gameId, fixtureId);

    expect(eligibleIds.has(inPlayer)).toBe(true);
    expect(eligibleIds.has(owner)).toBe(true);
    // A guest has an `in` row and no account. They are on the roster and can
    // never file; `requirePlayer` is what actually stops them, and this set
    // must agree with it or the turnout denominator lies.
    expect(eligibleIds.has(guest)).toBe(false);
    expect(eligibleIds.has(outPlayer)).toBe(false);
    expect(eligibleIds.has(formerOwner)).toBe(false);
    expect(organiserIds).toEqual(new Set([owner]));
  });
});

describe("putResultClaim", () => {
  it("files once and then updates in place, moving filedAt", async () => {
    const db = testDb();
    const playerId = await insertPlayer(db, { email: "a@example.com" });
    const gameId = await insertGame(db);
    const fixtureId = await insertFixture(db, gameId, { lifecycle: "played" });
    const first = new Date("2026-08-14T09:00:00Z");
    const second = new Date("2026-08-14T10:00:00Z");

    await putResultClaim(db, { fixtureId, playerId, outcome: "a", scoreA: 3, scoreB: 2, now: first });
    await putResultClaim(db, { fixtureId, playerId, outcome: "b", scoreA: 2, scoreB: 3, now: second });

    const claims = await listResultClaims(db, fixtureId);
    expect(claims).toHaveLength(1);
    expect(claims[0]?.outcome).toBe("b");
    // `filed_at` answers "how long has this position been held?", which is the
    // last tie-break. A player who switched an hour ago has not been backing
    // the new position since this morning.
    expect(claims[0]?.filedAt.getTime()).toBe(second.getTime());
  });

  it("clears a score when the player moves to an outcome-only claim", async () => {
    const db = testDb();
    const playerId = await insertPlayer(db, { email: "a@example.com" });
    const gameId = await insertGame(db);
    const fixtureId = await insertFixture(db, gameId, { lifecycle: "played" });
    const now = new Date("2026-08-14T09:00:00Z");

    await putResultClaim(db, { fixtureId, playerId, outcome: "a", scoreA: 3, scoreB: 2, now });
    await putResultClaim(db, { fixtureId, playerId, outcome: "a", scoreA: null, scoreB: null, now });

    const [claim] = await listResultClaims(db, fixtureId);
    expect(claim?.scoreA).toBeNull();
    expect(claim?.scoreB).toBeNull();
  });
});

describe("deleteResultClaim", () => {
  it("removes only the caller's own row and reports whether there was one", async () => {
    const db = testDb();
    const mine = await insertPlayer(db, { email: "a@example.com" });
    const theirs = await insertPlayer(db, { email: "b@example.com" });
    const gameId = await insertGame(db);
    const fixtureId = await insertFixture(db, gameId, { lifecycle: "played" });
    await insertResultClaim(db, fixtureId, mine, { outcome: "a" });
    await insertResultClaim(db, fixtureId, theirs, { outcome: "b" });

    expect(await deleteResultClaim(db, fixtureId, mine)).toBe(true);
    expect(await deleteResultClaim(db, fixtureId, mine)).toBe(false);
    expect(await listResultClaims(db, fixtureId)).toHaveLength(1);
  });
});

describe("listResultClaims", () => {
  it("carries the erasure marker so a renderer never prints the placeholder", async () => {
    const db = testDb();
    const erasedAt = new Date("2026-08-01T00:00:00Z");
    const playerId = await insertPlayer(db, { name: "[erased player]", erasedAt });
    const gameId = await insertGame(db);
    const fixtureId = await insertFixture(db, gameId, { lifecycle: "played" });
    await insertResultClaim(db, fixtureId, playerId, { outcome: "a" });

    expect((await listResultClaims(db, fixtureId))[0]?.erasedAt?.getTime()).toBe(erasedAt.getTime());
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/db/result-queries.test.ts`
Expected: FAIL — `src/db/result-queries.js` not found.

- [ ] **Step 3: Implement**

Create `src/db/result-queries.ts`:

```ts
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "./client.js";
import { fixtureResultClaims, memberships, players, responses } from "./schema.js";
import type { ResultClaim, ResultOutcome } from "../domain/result.js";

/**
 * A claim as stored, with just enough about its author to render it.
 *
 * `erasedAt` travels with the row for the reason `SquadMember.erasedAt` does:
 * a played fixture keeps its erased participants, so `name` may be the
 * `[erased player]` placeholder, which must never reach a screen. Every read
 * of it goes through `displayName`.
 */
export interface StoredClaim extends ResultClaim {
  id: string;
  name: string;
  erasedAt: Date | null;
}

export async function listResultClaims(db: Db, fixtureId: string): Promise<StoredClaim[]> {
  return db
    .select({
      id: fixtureResultClaims.id,
      playerId: fixtureResultClaims.playerId,
      outcome: fixtureResultClaims.outcome,
      scoreA: fixtureResultClaims.scoreA,
      scoreB: fixtureResultClaims.scoreB,
      filedAt: fixtureResultClaims.filedAt,
      name: players.name,
      erasedAt: players.erasedAt,
    })
    .from(fixtureResultClaims)
    .innerJoin(players, eq(fixtureResultClaims.playerId, players.id))
    .where(eq(fixtureResultClaims.fixtureId, fixtureId));
}

/**
 * Who may file on this fixture, and which of them are organisers (BR-37 §6).
 *
 * Everyone who was `in`, plus every active owner whether or not they played —
 * the organiser is who chases a missing result, and their membership of
 * `organiserIds` is what `deriveResult`'s second tie-break reads.
 *
 * **Guests are excluded here even though `requirePlayer` already stops them.**
 * They hold `in` rows (`addGuest` writes one) and have no account, so leaving
 * them in would inflate `eligible_count` — the turnout denominator on every
 * cached result — with people who could never have voted.
 *
 * Two queries rather than a union: they are different joins over different
 * tables, and D1 has no interactive transactions to make one round trip
 * safer than two reads of frozen rows.
 */
export async function resultElectorate(
  db: Db,
  gameId: string,
  fixtureId: string,
): Promise<{ eligibleIds: Set<string>; organiserIds: Set<string> }> {
  const [playedRows, ownerRows] = await Promise.all([
    db
      .select({ playerId: responses.playerId })
      .from(responses)
      .innerJoin(players, eq(responses.playerId, players.id))
      .where(
        and(
          eq(responses.fixtureId, fixtureId),
          eq(responses.status, "in"),
          eq(players.isGuest, false),
        ),
      ),
    db
      .select({ playerId: memberships.playerId })
      .from(memberships)
      .where(
        and(
          eq(memberships.gameId, gameId),
          eq(memberships.role, "owner"),
          eq(memberships.active, true),
        ),
      ),
  ]);

  const organiserIds = new Set(ownerRows.map((row) => row.playerId));
  const eligibleIds = new Set(playedRows.map((row) => row.playerId));
  organiserIds.forEach((id) => eligibleIds.add(id));
  return { eligibleIds, organiserIds };
}

export async function findResultClaim(
  db: Db,
  fixtureId: string,
  playerId: string,
): Promise<StoredClaim | null> {
  const rows = await listResultClaims(db, fixtureId);
  return rows.find((row) => row.playerId === playerId) ?? null;
}

/**
 * File or move one player's claim.
 *
 * An upsert on the unique index, so a replayed form cannot produce a second
 * row for the same person — the constraint, not this function, is the
 * guarantee. `filedAt` is written on both paths: see the column's comment for
 * why a change moves it.
 *
 * `scoreA`/`scoreB` are written unconditionally, including as nulls, so that
 * a player moving from "3-2" to a bare "Bibs won" does not keep a score they
 * have withdrawn.
 */
export async function putResultClaim(
  db: Db,
  params: {
    fixtureId: string;
    playerId: string;
    outcome: ResultOutcome;
    scoreA: number | null;
    scoreB: number | null;
    now: Date;
  },
): Promise<void> {
  await db
    .insert(fixtureResultClaims)
    .values({
      id: crypto.randomUUID(),
      fixtureId: params.fixtureId,
      playerId: params.playerId,
      outcome: params.outcome,
      scoreA: params.scoreA,
      scoreB: params.scoreB,
      filedAt: params.now,
    })
    .onConflictDoUpdate({
      target: [fixtureResultClaims.fixtureId, fixtureResultClaims.playerId],
      set: {
        outcome: params.outcome,
        scoreA: params.scoreA,
        scoreB: params.scoreB,
        filedAt: params.now,
      },
    });
}

/** Withdraw your own claim. Returns whether there was one to withdraw. */
export async function deleteResultClaim(
  db: Db,
  fixtureId: string,
  playerId: string,
): Promise<boolean> {
  const deleted = await db
    .delete(fixtureResultClaims)
    .where(
      and(
        eq(fixtureResultClaims.fixtureId, fixtureId),
        eq(fixtureResultClaims.playerId, playerId),
      ),
    )
    .returning({ id: fixtureResultClaims.id });
  return deleted.length > 0;
}
```

`inArray` is imported for Task 11's use of this module; if ESLint flags it as unused now, remove it and add it back in Task 11.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/db/result-queries.test.ts && npx tsc --noEmit && npm run lint`
Expected: PASS, clean, clean.

- [ ] **Step 5: Commit**

```bash
git add src/db/result-queries.ts test/db/result-queries.test.ts
git commit -m "feat: result claim queries and the electorate (M25)"
```

---

### Task 6: The result panel view

**Files:**
- Create: `src/views/result.ts`
- Modify: `src/views/styles.ts` (add `RESULT_CSS`, register it in `PAGE_STYLE_BLOCKS`)
- Modify: `test/stored-lookups.test.ts`
- Modify: `test/views/style-cascade.test.ts` (only if it needs a new entry — read it first)
- Test: `test/views/result-panel.test.ts` (create)

**Interfaces:**
- Consumes: `OutcomeCandidate`, `DerivedResult`, `ResultOutcome`, `MAX_SCORE` from `src/domain/result.js`; `escapeHtml` from `src/views/layout.js`; `TeamId` from `src/domain/teams.js`.
- Produces:
  - `outcomeNames(game: { teamAName: string; teamBName: string }): Record<ResultOutcome, string>`
  - `outcomeLabel(names: Record<ResultOutcome, string>, outcome: ResultOutcome): string | null`
  - `interface ResultPanelParams { names; candidates; derived; locked; writable; eligible; rostered; yourPlayerId; deadlineLocal; actionPath; clearPath }`
  - `renderResultPanel(params: ResultPanelParams): string`

- [ ] **Step 1: Write the failing test**

Create `test/views/result-panel.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { renderResultPanel, outcomeNames, type ResultPanelParams } from "../../src/views/result.js";
import { deriveResult, tally, type ResultClaim } from "../../src/domain/result.js";

const NAMES = outcomeNames({ teamAName: "Bibs", teamBName: "Skins" });

function claim(playerId: string, overrides: Partial<ResultClaim> = {}): ResultClaim {
  return {
    playerId,
    outcome: "a",
    scoreA: null,
    scoreB: null,
    filedAt: new Date("2026-08-13T20:00:00Z"),
    ...overrides,
  };
}

function params(overrides: Partial<ResultPanelParams> = {}): ResultPanelParams {
  return {
    names: NAMES,
    candidates: [],
    derived: null,
    locked: false,
    writable: true,
    eligible: true,
    rostered: true,
    yourPlayerId: "p1",
    deadlineLocal: "Sat 15 Aug, 7:00pm",
    actionPath: "/g/g1/f/f1/result",
    clearPath: "/g/g1/f/f1/result/clear",
    ...overrides,
  };
}

describe("renderResultPanel", () => {
  it("offers the game's own side names, not Team A and Team B", () => {
    const html = renderResultPanel(params());
    expect(html).toContain("Bibs");
    expect(html).toContain("Skins");
    expect(html).not.toContain("Team A");
  });

  it("shows the deadline while the window is open", () => {
    expect(renderResultPanel(params())).toContain("Sat 15 Aug, 7:00pm");
  });

  it("lists each candidate with its backer count and marks the viewer's own", () => {
    const claims = [claim("p1"), claim("p2"), claim("p3", { outcome: "b" })];
    const html = renderResultPanel(params({ candidates: tally(claims) }));
    expect(html).toContain("2");
    expect(html).toContain("your pick");
  });

  it("renders an agree form per candidate that posts values, never an id", () => {
    const html = renderResultPanel(params({ candidates: tally([claim("p2", { scoreA: 3, scoreB: 2 })]) }));
    expect(html).toContain('name="outcome"');
    expect(html).toContain('value="3"');
    // Nothing may name a candidate by id: with no id in the form there is
    // nothing a tampered submission can point at but its own single vote.
    expect(html).not.toContain("candidateId");
  });

  it("shows both confidence figures when locked", () => {
    const derived = deriveResult(
      [claim("p1", { scoreA: 3, scoreB: 2 }), claim("p2", { scoreA: 3, scoreB: 2 }), claim("p3")],
      new Set(),
    );
    const html = renderResultPanel(params({ derived, locked: true, writable: false }));
    expect(html).toContain("Bibs won 3–2");
    expect(html).toContain("3 of 3");
    expect(html).toContain("2 of 3");
  });

  it("says the score was not agreed when the winning outcome had no scores", () => {
    const derived = deriveResult([claim("p1"), claim("p2")], new Set());
    const html = renderResultPanel(params({ derived, locked: true, writable: false }));
    expect(html).toContain("Bibs won");
    expect(html).toContain("Score not agreed");
  });

  it("says so when the fixture was never rostered", () => {
    const derived = deriveResult([claim("p1")], new Set());
    const html = renderResultPanel(params({ derived, locked: true, writable: false, rostered: false }));
    expect(html).toContain("Teams weren't picked");
  });

  it("still offers the form after the deadline when nothing was filed", () => {
    const html = renderResultPanel(params({ locked: false, writable: true, candidates: [], derived: null }));
    expect(html).toContain("No result recorded");
    expect(html).toContain("<form");
  });

  it("offers no form to someone who was not in the fixture", () => {
    const html = renderResultPanel(params({ eligible: false }));
    expect(html).not.toContain("<form");
  });

  it("escapes a side name containing markup", () => {
    const html = renderResultPanel(
      params({ names: outcomeNames({ teamAName: '<script>x</script>', teamBName: "Skins" }) }),
    );
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("says nothing rather than throwing on an outcome this build cannot name", () => {
    // The stored-lookup rule: `outcome` is a bare text column with no CHECK,
    // so a row can carry a value the union says is impossible, and
    // `escapeHtml(undefined)` throws and 500s the page.
    const derived = deriveResult([claim("p1", { outcome: "abandoned" as never })], new Set());
    expect(() => renderResultPanel(params({ derived, locked: true, writable: false }))).not.toThrow();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/views/result-panel.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Add the CSS block**

In `src/views/styles.ts`, immediately **before** `FRESHNESS_CSS`, add:

```ts
/**
 * The result panel (M25): the candidate list while a result is open to
 * argument, and the locked result with its two confidence figures.
 *
 * All-new selectors, so nothing already on a page changes appearance by
 * adding this block. Deliberately not reusing `.squad` — a candidate row is a
 * count and a control, not a person and two controls, and sharing the
 * selector would put this block into the ul.squad cascade collision that
 * SQUAD_STYLES_CSS and FORM_CSS already have.
 */
export const RESULT_CSS = `
  .result-candidates { list-style: none; margin: 0.8rem 0 0; padding: 0; display: grid; gap: 0.6rem; }
  .result-candidate {
    display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.6rem 0.9rem;
    padding: 0.7rem 0.9rem; border: 1px solid var(--line); border-radius: 0.5rem;
  }
  .result-claim { font-weight: 600; }
  .result-backers { font-size: var(--t-support); color: var(--mut); }
  .result-yours { font-size: var(--t-support); color: var(--mut); }
  .result-candidate form { margin: 0 0 0 auto; }
  .result-final { font-size: 1.25rem; font-weight: 600; margin: 0.4rem 0 0.2rem; }
  .result-confidence { font-size: var(--t-support); color: var(--mut); margin: 0; }
  .result-note { font-size: var(--t-support); color: var(--mut); }
  .result-score { display: flex; flex-wrap: wrap; align-items: end; gap: 0.9rem; }
  .result-score label { display: grid; gap: 0.3rem; }
  .result-score input { width: 4.5rem; }
`;
```

Add `RESULT_CSS` to `PAGE_STYLE_BLOCKS`, **before** `FRESHNESS_CSS`. Position matters: the array's order is the cascade order, and nothing in this block should ever be able to override the freshness bar's own rules.

- [ ] **Step 4: Implement the view**

Create `src/views/result.ts`:

```ts
import type { DerivedResult, OutcomeCandidate, ResultOutcome } from "../domain/result.js";
import { MAX_SCORE } from "../domain/result.js";
import { escapeHtml } from "./layout.js";

/**
 * What this game calls each of the three things that can have happened.
 *
 * `draw` is not a side, so it takes a fixed word — the game names its two
 * teams, not the absence of a winner.
 */
export function outcomeNames(game: {
  teamAName: string;
  teamBName: string;
}): Record<ResultOutcome, string> {
  return { a: game.teamAName, b: game.teamBName, draw: "Draw" };
}

/**
 * The words for one stored outcome, or null when this build has none.
 *
 * `fixture_result_claims.outcome` is a bare `text NOT NULL` with no CHECK
 * constraint, so a row can carry a value the union says is impossible;
 * indexing the record would then yield `undefined`, and `escapeHtml(undefined)`
 * calls `.replace` on it and 500s the page. Callers branch on null and say
 * nothing rather than guessing — a result this build cannot name is one it
 * cannot announce.
 */
export function outcomeLabel(
  names: Record<ResultOutcome, string>,
  outcome: ResultOutcome,
): string | null {
  return names[outcome] ?? null;
}

function claimWords(
  names: Record<ResultOutcome, string>,
  outcome: ResultOutcome,
  scoreA: number | null,
  scoreB: number | null,
): string | null {
  const label = outcomeLabel(names, outcome);
  if (label === null) return null;
  if (scoreA === null || scoreB === null) return outcome === "draw" ? "Draw" : `${label} won`;
  // An en dash, matching how every other score-like pair reads in this app.
  const score = `${scoreA}–${scoreB}`;
  return outcome === "draw" ? `Draw ${score}` : `${label} won ${score}`;
}

export interface ResultPanelParams {
  names: Record<ResultOutcome, string>;
  /** From `tally()`, most-backed first. Empty while nobody has filed. */
  candidates: readonly OutcomeCandidate[];
  /** From `deriveResult()`. Non-null whenever anybody has filed. */
  derived: DerivedResult | null;
  locked: boolean;
  writable: boolean;
  /** Whether the viewer may file at all (BR-37 §6). */
  eligible: boolean;
  /** Whether the fixture had published teams for a roster join to reach. */
  rostered: boolean;
  yourPlayerId: string;
  /** Already through `formatLocalDateTime` (TR-5). */
  deadlineLocal: string;
  actionPath: string;
  clearPath: string;
}

function renderAgreeForm(
  params: ResultPanelParams,
  outcome: ResultOutcome,
  scoreA: number | null,
  scoreB: number | null,
): string {
  if (!params.writable || !params.eligible) return "";
  const score =
    scoreA === null || scoreB === null
      ? ""
      : `<input type="hidden" name="scoreA" value="${escapeHtml(String(scoreA))}">
         <input type="hidden" name="scoreB" value="${escapeHtml(String(scoreB))}">`;
  return `
    <form method="post" action="${escapeHtml(params.actionPath)}">
      <input type="hidden" name="outcome" value="${escapeHtml(outcome)}">
      ${score}
      <button type="submit" class="button">Agree</button>
    </form>
  `;
}

function renderRow(
  params: ResultPanelParams,
  outcome: ResultOutcome,
  scoreA: number | null,
  scoreB: number | null,
  backers: readonly string[],
): string {
  const words = claimWords(params.names, outcome, scoreA, scoreB);
  if (words === null) return "";
  const yours = backers.includes(params.yourPlayerId)
    ? `<span class="result-yours">your pick</span>`
    : "";
  return `
    <li class="result-candidate">
      <span class="result-claim">${escapeHtml(words)}</span>
      <span class="result-backers">${escapeHtml(String(backers.length))} ${backers.length === 1 ? "backer" : "backers"}</span>
      ${yours}
      ${renderAgreeForm(params, outcome, scoreA, scoreB)}
    </li>
  `;
}

function renderCandidates(params: ResultPanelParams): string {
  const rows = params.candidates
    .flatMap((candidate) => [
      ...candidate.scores.map((score) =>
        renderRow(params, candidate.outcome, score.scoreA, score.scoreB, score.backers),
      ),
      candidate.unscoredBackers > 0
        ? renderRow(
            params,
            candidate.outcome,
            null,
            null,
            candidate.backers.filter(
              (backer) => !candidate.scores.some((score) => score.backers.includes(backer)),
            ),
          )
        : "",
    ])
    .join("");
  return rows === "" ? "" : `<ul class="result-candidates">${rows}</ul>`;
}

function renderFileForm(params: ResultPanelParams): string {
  if (!params.writable || !params.eligible) return "";
  const options = (["a", "b", "draw"] as const)
    .map((outcome) => {
      const label = outcomeLabel(params.names, outcome);
      if (label === null) return "";
      const words = outcome === "draw" ? "Draw" : `${label} won`;
      return `<label><input type="radio" name="outcome" value="${escapeHtml(outcome)}"> ${escapeHtml(words)}</label>`;
    })
    .join("");

  return `
    <form method="post" action="${escapeHtml(params.actionPath)}">
      <h3>What happened?</h3>
      <div class="result-score">
        <label>${escapeHtml(params.names.a)}
          <input type="number" name="scoreA" min="0" max="${escapeHtml(String(MAX_SCORE))}" inputmode="numeric">
        </label>
        <label>${escapeHtml(params.names.b)}
          <input type="number" name="scoreB" min="0" max="${escapeHtml(String(MAX_SCORE))}" inputmode="numeric">
        </label>
      </div>
      <p class="result-note">Or, if nobody remembers the score, just say who won:</p>
      ${options}
      <p><button type="submit" class="button">Record it</button></p>
    </form>
  `;
}

function renderClearForm(params: ResultPanelParams): string {
  const youFiled = params.candidates.some((candidate) =>
    candidate.backers.includes(params.yourPlayerId),
  );
  if (!params.writable || !params.eligible || !youFiled) return "";
  return `
    <form method="post" action="${escapeHtml(params.clearPath)}">
      <button type="submit" class="danger-link">Withdraw my answer</button>
    </form>
  `;
}

function renderLocked(params: ResultPanelParams): string {
  const derived = params.derived;
  if (derived === null) return "";
  const words = claimWords(params.names, derived.outcome, derived.scoreA, derived.scoreB);
  if (words === null) return `<p class="result-note">This fixture's result can't be shown.</p>`;

  const margin =
    derived.scoreA === null
      ? `<p class="result-confidence">Score not agreed.</p>`
      : `<p class="result-confidence">Score ${escapeHtml(String(derived.marginBackers))} of ${escapeHtml(String(derived.voterCount))}</p>`;

  const unrostered = params.rostered
    ? ""
    : `<p class="result-note">Teams weren't picked in the app for this fixture, so we don't know who played on which side.</p>`;

  return `
    <p class="result-final">${escapeHtml(words)}</p>
    <p class="result-confidence">Result ${escapeHtml(String(derived.outcomeBackers))} of ${escapeHtml(String(derived.voterCount))}</p>
    ${margin}
    ${unrostered}
  `;
}

/**
 * The result of one played fixture (BR-37), for both the player fixture page
 * and the organiser's.
 *
 * Three states, and the third is not an error: a fixture whose window has
 * passed with nothing filed is still writable, because there was nothing to
 * lock (`isResultLocked`). It says so and keeps the form.
 */
export function renderResultPanel(params: ResultPanelParams): string {
  if (params.locked) {
    return `<section><h2>Result</h2>${renderLocked(params)}</section>`;
  }

  const nothingYet =
    params.candidates.length === 0 ? `<p class="result-note">No result recorded yet.</p>` : "";
  const deadline =
    params.candidates.length === 0
      ? ""
      : `<p class="result-note">Locks ${escapeHtml(params.deadlineLocal)}.</p>`;

  return `
    <section>
      <h2>Result</h2>
      ${nothingYet}
      ${deadline}
      ${renderCandidates(params)}
      ${renderFileForm(params)}
      ${renderClearForm(params)}
    </section>
  `;
}
```

The "shows the deadline while the window is open" test in Step 1 expects the deadline on an empty panel. Reconcile them by rendering the deadline line unconditionally while the panel is writable — adjust the implementation, not the test: somebody who has just been nudged and sees an empty panel is exactly the person who needs to know how long they have.

- [ ] **Step 5: Add the stored-lookup entry**

In `test/stored-lookups.test.ts`, add a case beside the existing ones:

```ts
it("renderResultPanel survives an outcome outside the union", () => {
  const names = outcomeNames({ teamAName: "Bibs", teamBName: "Skins" });
  const claims = [
    { playerId: "p1", outcome: OUT_OF_UNION, scoreA: null, scoreB: null, filedAt: new Date() },
  ];
  expect(() =>
    renderResultPanel({
      names,
      candidates: tally(claims),
      derived: deriveResult(claims, new Set()),
      locked: true,
      writable: false,
      eligible: true,
      rostered: true,
      yourPlayerId: "p1",
      deadlineLocal: "Sat 15 Aug, 7:00pm",
      actionPath: "/g/g1/f/f1/result",
      clearPath: "/g/g1/f/f1/result/clear",
    }),
  ).not.toThrow();
});
```

Add the imports it needs at the top of that file.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run test/views/result-panel.test.ts test/stored-lookups.test.ts test/views/style-cascade.test.ts test/security/csp.test.ts && npx tsc --noEmit && npm run lint`

Expected: PASS. If `style-cascade` fails, it has found a genuine collision — read its output and either reorder `PAGE_STYLE_BLOCKS` or list the collision with a reason, as that file instructs. If `csp.test.ts` fails, `RESULT_CSS` is not in `PAGE_STYLE_BLOCKS`.

- [ ] **Step 7: Commit**

```bash
git add src/views/result.ts src/views/styles.ts test/views/result-panel.test.ts test/stored-lookups.test.ts
git commit -m "feat: the result panel (M25)"
```

---

### Task 7: The player fixture page

**Files:**
- Create: `src/views/player-fixture.ts`
- Modify: `src/views/fixture.ts` (`renderPublishedTeamsSection` gains a tense)
- Test: `test/views/player-fixture.test.ts` (create)

**Interfaces:**
- Consumes: `renderResultPanel`, `ResultPanelParams` (Task 6); `renderPublishedTeamsSection`, `fixtureStatusWords` from `src/views/fixture.js`; `renderFreshness` from `src/views/freshness.js`; `layout`, `PageNav`, `escapeHtml` from `src/views/layout.js`; `FRESHNESS_JS` from `src/views/scripts.js`.
- Produces: `renderPlayerFixturePage(params: PlayerFixtureParams): string`, and `PlayerFixtureParams` with the fields the test below names.

- [ ] **Step 1: Change the teams section's tense**

`renderPublishedTeamsSection` currently renders `You're on Bibs.` unconditionally. On a played fixture that tells somebody they are about to play a game that finished on Thursday.

Open `src/views/fixture.ts`, find `renderPublishedTeamsSection`, and add a third parameter `tense: "future" | "past" = "future"`. When `past`, the own-side line reads `You were on ${name}.` and the awaiting-side line is omitted entirely — "your side hasn't been picked yet" is meaningless once the game is over. Every existing caller keeps working because the parameter is defaulted; do not change any of them.

Add to `test/views/` wherever that function's existing tests live (find them first) two cases: past tense renders "You were on", and past tense renders no "hasn't been picked yet" for an `awaitingSide` viewer.

- [ ] **Step 2: Write the failing page test**

Create `test/views/player-fixture.test.ts`. Build a `PlayerFixtureParams` factory in the file and assert:

```ts
it("names the fixture, the venue and the viewer's own status", …)
it("shows the published teams for a played fixture", …)         // the whole point: they survive kickoff now
it("shows no teams when the pick was never published", …)
it("renders the result panel", …)                                // assert on a string only renderResultPanel emits
it("renders the squad when the game shows it, and not when it doesn't", …)  // squad: null
it("carries the freshness bar", …)                               // assert FRESHNESS_ATTRIBUTE is present
it("escapes a venue name containing markup", …)
it("survives a lifecycle this build cannot name", …)             // fixtureStatusWords' stored-lookup case
```

Write each of these out in full — no `…` in the file you commit.

- [ ] **Step 3: Implement**

Create `src/views/player-fixture.ts`. Model its parameter interface and structure on `src/views/player-game.ts`, which is the closest sibling: same `nav`, same `escapeHtml` discipline, same freshness call at the foot. Its `pageStyles` are `[FIXTURE_STYLES_CSS, SQUAD_STYLES_CSS, FORM_CSS, RESULT_CSS, FRESHNESS_CSS]` and its `pageScripts` are `[FRESHNESS_JS]`.

Document at the top of the file, in the module comment, the fact that earns it:

```
 * The first per-fixture URL a player has ever had.
 *
 * Until M25 their only stable per-fixture link was `/r/:token`, out of an
 * email — and `/g/:id` shows only the *open* fixture, so the published teams
 * vanished from a player's view the moment `retirePastFixtures` flipped it to
 * `played`. "I lost the email, which side am I on?" had an answer for about
 * two hours a week.
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/views/player-fixture.test.ts test/views/ && npx tsc --noEmit && npm run lint`
Expected: PASS. If a `fixture.ts` sibling test breaks on the new parameter, it is asserting the old signature — update it.

- [ ] **Step 5: Commit**

```bash
git add src/views/player-fixture.ts src/views/fixture.ts test/views/
git commit -m "feat: the player fixture page (M25)"
```

---

### Task 8: The GET dispatch, and the path rename

**Files:**
- Modify: `src/auth/paths.ts`
- Modify: `src/routes/games.ts`
- Modify: every file naming `ownerFixturePath` (30 references across `src` and `test`)
- Test: `test/routes/player-fixture.test.ts` (create)

**Interfaces:**
- Produces: `fixturePath(gameId, fixtureId)` replacing `ownerFixturePath`; `resultPath(gameId, fixtureId)`; `resultClearPath(gameId, fixtureId)`.

- [ ] **Step 1: Write the failing test**

Create `test/routes/player-fixture.test.ts`:

```ts
describe("GET /g/:id/f/:fixtureId", () => {
  it("gives an active owner the organiser's page", …)     // assert on a string only owner-fixture emits
  it("gives an active squad member the player page", …)   // assert on a string only player-fixture emits
  it("404s someone who is not a member", …)
  it("404s a signed-in stranger", …)
  it("404s when the fixture belongs to another game", …)
  it("serves a played fixture, not only an open one", …)
});
```

Write them out in full, following `test/routes/owner-fixture.test.ts` for the sign-in and seeding shape.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/routes/player-fixture.test.ts`
Expected: FAIL — a member currently gets 404 from `loadFixtureTarget`.

- [ ] **Step 3: Rename the path helper**

`/g/:id/f/:fixtureId` is no longer owner-only, and a helper called `ownerFixturePath` on a shared URL is a comment that lies. Rename it:

```bash
grep -rl "ownerFixturePath" src test | xargs sed -i 's/ownerFixturePath/fixturePath/g'
```

Then open `src/auth/paths.ts` and rewrite the doc comment, which currently says "seen by its owner (J6b §3)":

```ts
/**
 * One fixture of a game.
 *
 * **Not owner-only since M25.** The route dispatches by role, as `/g/:id`
 * does: an active owner gets the management page, an active squad member gets
 * their own read-mostly view, and anyone else gets a 404. It was
 * `ownerFixturePath` until then, which is why older comments and emails talk
 * about the owner's fixture page.
 *
 * `/f/` rather than `/fixtures/` to keep a link that lands in a group chat
 * short; nested under the game because the entitlement check is the game's,
 * and a fixture id alone would invite a route that forgets to scope it.
 */
export function fixturePath(gameId: string, fixtureId: string): string {
  return `/g/${gameId}/f/${fixtureId}`;
}

/** Where a result claim posts (BR-37). Values, never a candidate id. */
export function resultPath(gameId: string, fixtureId: string): string {
  return `${fixturePath(gameId, fixtureId)}/result`;
}

/** Where "withdraw my answer" posts (BR-37). */
export function resultClearPath(gameId: string, fixtureId: string): string {
  return `${fixturePath(gameId, fixtureId)}/result/clear`;
}
```

- [ ] **Step 4: Dispatch the GET**

In `src/routes/games.ts`, change the `GET /g/:id/f/:fixtureId` handler so that a failed `loadFixtureTarget` falls through to a member view rather than answering 404 — the same shape `GET /g/:id` already uses:

```ts
gamesRoutes.get("/g/:id/f/:fixtureId", requirePlayer, async (c) => {
  const now = new Date(Date.now());
  const player = c.get("player")!;
  const target = await loadFixtureTarget(c, c.req.param("id"), c.req.param("fixtureId"));
  if (target !== null) return renderOwnerFixture(c, target, now);

  // Not an owner. A member gets their own page; everyone else gets the same
  // 404 an owner-entitlement failure gets, so the two are indistinguishable
  // and a fixture id cannot be probed (TR-18).
  const game = await findGameForMember(getDb(c.env.DB), c.req.param("id"), player.id);
  if (game === null) return c.text("Not found", 404);
  return renderPlayerFixture(c, game, c.req.param("fixtureId"), player.id, now);
});
```

Write `renderPlayerFixture` beside it. It must, in this order: load the fixture and confirm `fixture.gameId === game.id` (404 otherwise — a fixture id from another game must not render); `getFixtureWithSquad`; `listResultClaims`; `resultElectorate`; then build the panel params from `tally`, `deriveResult`, `isResultLocked`, `resultWritable`, `resultDeadline` and `formatLocalDateTime(deadline, game.timezone)`. `rostered` is `fixture.teamsPublishedAt !== null`.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/routes/ && npx tsc --noEmit && npm run lint`
Expected: PASS. `tsc` catches every missed rename.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: /g/:id/f/:fixtureId dispatches by role (M25)"
```

---

### Task 9: The write routes

**Files:**
- Create: `src/routes/results.ts`
- Modify: `src/app.ts` (mount it), `src/domain/audit.ts` (four actions)
- Test: `test/routes/results.test.ts` (create)

**Interfaces:**
- Consumes: `parseClaim` (Task 3); `resultWritable`, `isResultLocked` (Task 4); `findResultClaim`, `putResultClaim`, `deleteResultClaim`, `listResultClaims`, `resultElectorate` (Task 5); `recordAudit` from `src/db/audit.js`; `wrongOrigin` from `src/auth/origin.js`.
- Produces: `resultsRoutes` (a `Hono<AppEnv>`).

- [ ] **Step 1: Write the failing test**

Create `test/routes/results.test.ts`. Cover **every row of spec §7's refusal table** plus the happy paths:

```ts
it("files a claim and redirects back to the fixture", …)             // 303 to fixturePath
it("derives the outcome from the score and ignores a contradicting one", …)
it("moves an existing claim rather than adding a second", …)         // one row after two posts
it("agreeing posts values and joins the existing candidate", …)
it("withdraws the caller's own claim only", …)
it("404s a non-member", …)
it("404s a member who was neither in nor an owner", …)
it("404s when the fixture is open, scheduled or cancelled", …)
it("422s once the result is locked, and writes nothing", …)
it("422s half a score, and writes nothing", …)
it("403s a request from the wrong origin", …)
it("is idempotent under a replayed form", …)
it("writes fixture.result_filed then fixture.result_changed to audit_log", …)
it("lets an organiser who did not play file", …)
```

Write each out in full.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/routes/results.test.ts`
Expected: FAIL — 404 on every POST; the routes do not exist.

- [ ] **Step 3: Add the audit actions**

In `src/domain/audit.ts`, append to `AUDIT_ACTIONS`, with a comment naming what each records:

```ts
  // M25 (BR-37). Recorded against the fixture, so one fixture's whole result
  // history reads in `entity_id` order. `result_changed` carries the claim
  // before and after — it is the flip history, which is what lets
  // `fixture_result_claims` stay one row per player with no `superseded_at`
  // column for every read to remember to filter.
  "fixture.result_filed",
  "fixture.result_changed",
  "fixture.result_cleared",
  // Written by the sweep with a null actor, like every other system action.
  "fixture.result_locked",
```

`AUDIT_ENTITY_TYPES` already contains `fixture` and needs no change. No migration: `text({ enum })` emits no SQL CHECK on SQLite, as that module's own comment records.

- [ ] **Step 4: Implement the routes**

Create `src/routes/results.ts`. Both handlers follow the same sequence, and **the order is load-bearing**, for the reason the publish route documents at length:

1. `wrongOrigin(c)` → 403.
2. Entitlement: `findGameForOwner` **or** `findGameForMember` → 404 for neither. Loading the fixture and confirming `fixture.gameId === game.id` → 404.
3. `resultElectorate` → 404 if the caller is not in `eligibleIds`. This must come **before** anything that reads or reports the claims, or a refusal leaks how many people voted.
4. `resultWritable(fixture.lifecycle, fixture.kicksOffAt, claims.length, now)` → 422 re-rendering the page with a `problem`.
5. `parseClaim` → 422 re-rendering the page with `parsed.problem`.
6. `findResultClaim` for the before-value, then `putResultClaim`, then `recordAudit` with `fixture.result_filed` or `fixture.result_changed` depending on whether there was a before.
7. `c.redirect(fixturePath(gameId, fixtureId), 303)`.

`/result/clear` is the same through step 4, then `deleteResultClaim` and `fixture.result_cleared` when it removed something, and the same redirect either way — a withdraw of a claim that is already gone is not an error worth a page.

The 422 path re-renders the player fixture page with the problem. Extract the render from Task 8's `renderPlayerFixture` into an exported helper both files can call rather than duplicating it, following how `renderOwnerFixture` is shared between `games.ts`'s GET and its refusal paths.

Mount it in `src/app.ts` immediately after `broadcast`, with a comment matching that one's:

```ts
  // `/g/:id/f/:fixtureId/result` (M25), under the same `/g/*` prefix as
  // `gamesRoutes` and so behind the same session mount and `private,
  // no-store` header — the panel shows who voted for what, which is squad
  // membership by another name.
  app.route("/", resultsRoutes);
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/routes/ test/security/ && npx tsc --noEmit && npm run lint`
Expected: PASS, clean, clean.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: file, change, agree and withdraw a result claim (M25)"
```

---

### Task 10: The result panel on the organiser's fixture page

**Files:**
- Modify: `src/views/owner-fixture.ts`, `src/routes/games.ts`
- Modify: `test/routes/owner-fixture.test.ts`

**Interfaces:**
- Consumes: `renderResultPanel`, `ResultPanelParams` (Task 6).
- Produces: `OwnerFixtureParams` gains an optional `result?: ResultPanelParams`.

- [ ] **Step 1: Write the failing test**

Add to `test/routes/owner-fixture.test.ts`:

```ts
it("shows the result panel on a played fixture", …)
it("shows no result panel on an open fixture", …)
it("lets an organiser who did not play agree from their own page", …)
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/routes/owner-fixture.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Add `result?: ResultPanelParams` to `OwnerFixtureParams` and render `renderResultPanel(params.result)` when present, below the teams section. Add `RESULT_CSS` to that page's `pageStyles`, in the same relative position it holds in `PAGE_STYLE_BLOCKS`.

In `games.ts`'s `ownerFixtureParams`, populate `result` only when `fixture.lifecycle === "played"` — an open fixture has nothing to have a result about, and rendering an empty panel there would invite claims the route would refuse.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/routes/owner-fixture.test.ts test/views/ && npx tsc --noEmit && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: the result panel on the organiser's fixture page (M25)"
```

---

### Task 11: Materialising the cache

**Files:**
- Create: `src/sweep/result-cache.ts`
- Modify: `src/cron/handler.ts`
- Test: `test/sweep/result-cache.test.ts` (create)

**Interfaces:**
- Consumes: `deriveResult` (Task 3); `isResultLocked`, `resultLockedAt` (Task 4); `listResultClaims`, `resultElectorate` (Task 5); `announcementOutstanding`, `listTeamAssignments` from the teams modules; `chunk`, `INSERT_CHUNK_SIZE` from `src/db/chunk.js`.
- Produces: `materialiseResults(db: Db, now: Date): Promise<MaterialiseResultsOutcome>` where `MaterialiseResultsOutcome = { considered: number; written: number; failures: SweepFailure[] }`.

- [ ] **Step 1: Write the failing test**

Create `test/sweep/result-cache.test.ts`:

```ts
it("writes nothing before the deadline", …)
it("writes the derived result once the deadline has passed", …)
it("writes nothing for a fixture nobody filed on", …)         // claims.length === 0 is not locked
it("writes for a fixture whose only claim was filed late, immediately", …)
it("does not rewrite a row it has already written", …)         // run twice, materialisedAt unchanged
it("records the turnout denominator as the electorate, not the voters", …)
it("records rostered:false when the teams were never published", …)
it("records teamsAccurate:false when a player who has a side is no longer in", …)
it("records teamsAccurate:true for a clean published pick", …)
it("stores exactly what deriveResult says", …)                 // the consistency assertion
it("isolates a failure to one fixture and still processes the rest", …)
it("writes a fixture.result_locked audit row with a null actor", …)
```

The consistency test is the one that matters most — it is what makes "only a cache" true rather than aspirational:

```ts
it("stores exactly what deriveResult says", async () => {
  const db = testDb();
  // …seed a fixture with five claims across two outcomes and three scores…
  await materialiseResults(db, AFTER_DEADLINE);

  const [stored] = await db.select().from(fixtureResults);
  const claims = await listResultClaims(db, fixtureId);
  const { organiserIds } = await resultElectorate(db, gameId, fixtureId);
  const derived = deriveResult(claims, organiserIds)!;

  expect(stored).toMatchObject({
    outcome: derived.outcome,
    scoreA: derived.scoreA,
    scoreB: derived.scoreB,
    outcomeBackers: derived.outcomeBackers,
    marginBackers: derived.marginBackers,
    voterCount: derived.voterCount,
    distinctOutcomes: derived.distinctOutcomes,
    distinctScores: derived.distinctScores,
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/sweep/result-cache.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/sweep/result-cache.ts`. Model the selection on `retirePastFixtures`: select the candidates, filter in JS against `now.getTime()` so the boundary comparison is exact, and chunk the writes.

Select `played` fixtures with no `fixture_results` row (a left join, or a select of existing ids and a JS filter — either is fine at this table's size; say which you chose in a comment). For each: read the claims, skip when `!isResultLocked(...)`, then derive, then insert.

Wrap each fixture's work so one bad row cannot take down the pass, and return its failure in `failures` — the pattern `sendOwnerAttention` documents.

The module comment must carry the argument, because the next person to read this file will wonder why a sweep writes something nothing reads:

```
 * Materialise the derived result of every fixture whose window has closed
 * (BR-37, M25).
 *
 * **Nothing reads what this writes to decide anything.** Every page and every
 * refusal derives the result from the claims; `fixture_results` is a cache,
 * and a run that fails or never happens costs a row the next run writes — not
 * a fixture stuck in a wrong state with nothing to notice it. That is the
 * whole reason the lock is a predicate rather than a stored state.
 *
 * It exists because a purely derived result is a function evaluated at read
 * time: change the tie-break rule in eighteen months, or fix a bug in it, and
 * last season's results silently change underneath anything fitted on them,
 * with no row edited and no test failing. This row is the derivation pinned to
 * the instant it froze.
```

Wire it into `src/cron/handler.ts` in the `CRON_SWEEP` case, **after** `retirePastFixtures` (which is what makes a fixture `played`) and **before** the erasures, logging its result the way every other step does.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/sweep/ test/cron/ && npx tsc --noEmit && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: materialise the locked result as a recomputable cache (M25)"
```

---

### Task 12: N-12, the "how did it go?" nudge

**Files:**
- Create: `src/notify/send-result-nudge.ts`, `src/notify/templates/result-nudge.ts`
- Modify: `src/notify/dedupe-key.ts`, `src/notify/push-copy.ts`, `src/domain/audit.ts`, `src/cron/handler.ts`
- Test: `test/notify/result-nudge.test.ts` (create)

**Interfaces:**
- Consumes: `insertQueuedLogRows`, `applySendResult`, `playersWithPushSubscriptions`, `SITE_ORIGIN`, `PendingNotification` from `src/notify/delivery.js`; `Notifier`; `resultElectorate` (Task 5); `fixturePath` (Task 8).
- Produces: `RESULT_NUDGE_WINDOW_MS`; `resultNudgeKey(fixtureId, playerId)`; `sendResultNudges(db, notifier, now): Promise<ResultNudgeResult>`.

- [ ] **Step 1: Write the failing test**

Create `test/notify/result-nudge.test.ts`:

```ts
it("nudges everyone who was in, once", …)
it("nudges an active organiser who did not play", …)
it("never nudges a guest", …)
it("never nudges a player with no email and no device", …)      // BR-32
it("does not nudge twice across two sweep runs", …)             // the dedupe key
it("ignores a fixture whose full time was more than twelve hours ago", …)
it("ignores a cancelled fixture", …)
it("records fixture.result_nudge_email_deferred when the ceiling refuses", …)
it("links to the fixture page", …)
```

The suite's `fetch` stub, if it needs one, **must be an ordinary function that checks its receiver** — see `test/notify/push-notifier.test.ts`. An arrow-function stub reads a method call and a free call identically, which is how `Illegal invocation` broke every push from M14 until it was found in production `notification_log`.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/notify/result-nudge.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Register the notification type and its key**

In `src/notify/dedupe-key.ts`:

```ts
export const NOTIFICATION_TYPES = ["n1", …, "n11", "n12"] as const;

/**
 * N-12 "how did it go?": once per player per fixture, ever.
 *
 * No timestamp, like N-4 and unlike N-2: there is one full-time per fixture,
 * and a second prompt to record a result somebody has already chosen not to
 * record is nagging.
 */
export function resultNudgeKey(fixtureId: string, playerId: string): string {
  return `n12:${fixtureId}:${playerId}`;
}
```

Add `n12` to `PUSH_COPY` in `src/notify/push-copy.ts`, following the shape of `groupNudge` beside it. Copy: title `How did it go?`, body `Tell us the score for <game name>.`

Add to `AUDIT_ACTIONS` in `src/domain/audit.ts`, beside the other deferral actions and with a comment in their style:

```ts
  // N-12 (M25). Deferred by TR-31's daily ceiling, which deletes the
  // `notification_log` row so a retry stays possible — this is the only
  // durable trace that anybody was ever owed the prompt. The mildest of the
  // deferrals: nothing depends on it, and the panel is on the fixture page
  // whenever they next open it.
  "fixture.result_nudge_email_deferred",
```

- [ ] **Step 4: Write the email template**

Create `src/notify/templates/result-nudge.ts`. Open `src/notify/templates/teams.ts` first and mirror its structure, helpers and escaping exactly — do not invent a different shape. Copy:

- Subject: `How did it go? <game name>, <local date>`
- Body: one line naming the fixture, one sentence — `Somebody needs to say what the score was. Whoever gets there first, everyone else can agree or put them right.` — and a link to `fixturePath`, absolute against `SITE_ORIGIN`.
- A closing line: `This closes 48 hours after kick-off.`

- [ ] **Step 5: Implement the send**

Create `src/notify/send-result-nudge.ts`, modelled on `src/notify/send-teams.ts` for the message-building and on `src/sweep/group-nudge.ts` for the sweep-facing shape.

```ts
/**
 * How far back a fixture's full time may be and still earn its squad a nudge.
 *
 * **Selection is bounded by this window, not by "fixtures this run retired".**
 * `retire.ts` documents the hazard from the other direction: a cron backlog
 * mailing people about games that finished days ago. A first deploy that
 * selected every played fixture ever would mail the entire user base about
 * last season. Twelve hours because the sweep is hourly, so a fixture gets
 * twelve chances to be picked up and a run missed for any reason costs nobody
 * their nudge.
 */
export const RESULT_NUDGE_WINDOW_MS = 12 * 60 * 60 * 1000;
```

Select `played` fixtures whose `kicks_off_at + duration_minutes` falls between `now - RESULT_NUDGE_WINDOW_MS` and `now`, filtering in JS against `now.getTime()` as `retirePastFixtures` does. For each, take `resultElectorate(db, gameId, fixtureId).eligibleIds`, drop anyone already holding an N-12 row, build one message per remaining player on their own channel, and run `insertQueuedLogRows` → send → `applySendResult` in that order (BR-19: insert before send).

Wire it into `src/cron/handler.ts` alongside Task 11's step, wrapped whole in the same way, and log its result.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run test/notify/ test/cron/ && npx tsc --noEmit && npm run lint`
Expected: PASS. `test/notify/dedupe-key.test.ts` may enumerate `NOTIFICATION_TYPES`; if it fails, it has correctly noticed the new member — add `n12`'s expected key there.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: N-12, the how-did-it-go nudge (M25)"
```

---

### Task 13: The other surfaces

**Files:**
- Modify: `src/views/player-game.ts`, `src/views/game-overview.ts`, `src/views/account.ts`, `src/views/dashboard.ts`
- Modify: `src/routes/games.ts`, `src/routes/account.ts`, `src/routes/dashboard.ts`, `src/db/dashboard-queries.ts`
- Modify: `test/routes/player-game.test.ts`, `test/routes/account.test.ts`, `test/routes/dashboard.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// player-game + game-overview
it("shows the last played fixture's result and links to it", …)
it("shows nothing when the last fixture has no result yet", …)

// account
it("links each history row to its fixture, not to the game", …)
it("shows the result on a locked row", …)

// dashboard
it("lists a played fixture the viewer has not filed a result on", …)
it("does not list one they have already filed on", …)
it("does not list one that is locked", …)
it("does not list a fixture from a game they have left", …)   // memberships.active
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/routes/player-game.test.ts test/routes/account.test.ts test/routes/dashboard.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

**Game pages.** Add a "last result" line for the most recent `played` fixture, linking to `fixturePath`. One extra query in each route; do not fold it into `listUpcomingFixtures`, whose contract is "from `now` onward".

**Account history.** Change `renderFixture` in `src/views/account.ts` so the row links to `fixturePath(row.gameId, row.fixtureId)` and carries the result when there is one. `AccountFixtureRow` will need `fixtureId` if it does not already carry it — check `DashboardFixture` in `src/db/dashboard-queries.ts` before adding a column.

**Dashboard.** Widen the caller-supplied lifecycle filter to include `played` for a new "results needed" list. Add a comment naming why this is safe, because it looks like a widening of a security boundary and is not:

```ts
// M11 moved the lifecycle filter out to the caller *specifically* so that a
// caller could widen what it shows without widening what it may reach: the
// three conditions in `entitledTo` — the viewer's own response row, an active
// membership, and `withdrawn` excluded — are untouched by this and stay the
// only thing deciding which rows exist to be shown.
```

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: PASS. This is the first full-suite run of the milestone; it takes over two minutes. **Wait for it — never background it and end the turn.**

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: surface results on the game, account and dashboard pages (M25)"
```

---

### Task 14: The browser tier

**Files:**
- Create: `test/browser/result.spec.ts`
- Modify: `docs/known-issues.md` if the capture reveals a layout problem

- [ ] **Step 1: Write the spec**

Create `test/browser/result.spec.ts`, following `test/browser/layout.spec.ts` for seeding and viewport setup:

```ts
test("a player records a result and another agrees", …)
test("the whole flow works with JavaScript disabled", …)      // context({ javaScriptEnabled: false })
test("candidate rows have the same shape whatever the claim's length", …)
```

The third is the one string assertions cannot make. Seed a fixture with a long side name and five candidates of differing widths, then compare each row's control offsets *relative to its own box* and fail if they differ — exactly what `layout.spec.ts` does for the squad rows, which is how the ragged-wrap defect in `known-issues.md` was found.

- [ ] **Step 2: Capture and look at the page**

Add a temporary screenshot step at 390×844, run it, and **open the PNG and read it**. `CLAUDE.md`'s third rule: string assertions cannot see an unstyled input, a control invisible against its track, or a row whose shape depends on its content.

Check specifically: the two score inputs are styled and side by side; the radio labels are legible; the Agree buttons line up; the locked result's two confidence lines do not read as one sentence; the freshness bar is not crowded by the panel above it.

Fix what the picture shows, then delete the temporary screenshot step.

- [ ] **Step 3: Run the browser suite**

Run: `npx playwright test`
Expected: PASS (~5min).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "test: browser coverage for the result panel (M25)"
```

---

### Task 15: Documentation

**Files:**
- Modify: `screens.md`, `docs/known-issues.md`, `docs/guide/`
- Modify: `docs/superpowers/specs/2026-08-10-make-the-team-design.md` (BR-37, N-12, the milestone table)

- [ ] **Step 1: The master spec**

Add **BR-37** to the business-rules list and **N-12** to the notification catalogue, both in the style of their neighbours, and add M25 to the milestone table with its definition of done. Update the line reading "Score recording and the funding page come after" to say score recording was delivered as M25.

- [ ] **Step 2: `screens.md`**

Add the player fixture page as a new screen, and add the result panel to the organiser's fixture page entry. Follow the existing entries' shape: who reaches it, what it contains, what it refuses.

- [ ] **Step 3: `docs/known-issues.md`**

**Close carry-forward note 2** with the reasoning, rather than deleting it — that file exists so nobody re-litigates:

```
2. ~~`responses.team` records the teams as *published*, not as *played*~~ —
   **closed by M25, and not in the way this note expected.** It asked for a
   flag stored on the result. No column was needed: every input to the
   judgement — `teams_published_at`, `teams_saved_at`, and every
   `responses.status`/`team` — is frozen once a fixture is `played`, so
   `announcementOutstanding` answers it forever from rows we already have.
   `test/played-fixture-freeze.test.ts` is what makes that true rather than
   assumed; if it ever fails, this note comes back and the column with it.
   `fixture_results.teams_accurate` caches the answer at lock, but only so a
   future change to the predicate cannot rewrite history — nothing reads it to
   decide anything.
```

**Add the ratings-and-erasure position** as a decided item with its reasoning:

```
| **A future ratings model fitted on M25's results attaches a derived
judgement about a person to rows that survive erasure.** `erasePlayer`
deliberately keeps a played fixture's participants. **Decided, not deferred:
this is accepted.** The judgement attaches to a row whose name is the
placeholder and whose email, `auth_user_id` and `email_verified_at` are all
null — a pseudonym, not a person — and `test/domain/erase-player.test.ts`
already asserts no row survives that identifies anyone. Recorded here so the
milestone that fits a model finds the question answered rather than answering
it in passing. |
```

- [ ] **Step 4: The guide**

Add a section on recording a result to the relevant chapter of `docs/guide/` — find which chapter covers what happens after a fixture, rather than assuming. Cover: who can record, that a score fills in who won automatically, that disagreeing means saying what you think happened, and that it settles two days after kick-off.

Then run: `npm run guide:capture`

- [ ] **Step 5: Final verification**

```bash
npm run lint && npx tsc --noEmit && npm test && npx playwright test
```

All four must pass. Report the actual counts.

- [ ] **Step 6: Commit and merge**

```bash
git add -A
git commit -m "docs: M25 — screens, guide, and the two known-issues notes"
```

Then merge fast-forward to `main` per the milestone workflow. **Pushing `main` deploys to production**, and this milestone includes a migration — apply it with `npm run db:migrate:remote` and confirm the two tables exist before pushing the code that reads them.

---

## Self-review

**Spec coverage.** §2 → Task 2. §2.1 → Tasks 2, 6. §2.2 → Task 3. §3 → Task 3. §4 → Task 4. §5 → Tasks 2, 11. §6 → Task 5. §7 → Tasks 8, 9. §8 → Task 7. §9 → Task 13. §10 → Tasks 11, 12. §11 → Tasks 9, 12. §12 → Tasks 1, 11, 15. §13 → Task 15. §14 → every task. §15 (not-in-this) → nothing built. §16's ten done-conditions map to Tasks 7–9 (1–4), 4 and 11 (5–6), 6 (7), 12 (8), 11 (9), 1 (10).

**Known gaps, stated rather than hidden.**

- Tasks 7, 8, 9, 10 and 13 name their tests by intent and require the implementer to write them out in full, instead of pasting them here. That is deliberate for the route suites: their sign-in and seeding boilerplate is long, differs between files, and a pasted approximation of it would be wrong in a way that costs a correction round-trip — `CLAUDE.md`'s fourth rule. Every one names the file to read first. It is nonetheless the weakest part of this plan, and a reviewer should hold those tasks to the same standard as Tasks 1–6.
- Task 6, Step 4 contains a deliberate contradiction between a test and the implementation, flagged inline, with the resolution given. It is there because the empty-panel deadline is a real product decision and the implementer should make it consciously.
- Task 12's email template is specified by its copy and by "mirror `teams.ts`" rather than as pasted code, because I have not read that template and will not put a detail in a brief I have not read from source.

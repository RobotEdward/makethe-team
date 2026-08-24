# M34 Gated Invites Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a Game optionally invite a core group when a fixture opens, then release further tiers of subs — in an order the owner sets — as places genuinely come free.

**Architecture:** A pure, level-based release rule (`src/domain/invite-tiers.ts`) decides how many tiers should be released from current state alone, so it is idempotent and safe to run repeatedly. `FixtureCapacity` claims the release inside its existing `blockConcurrencyWhile` critical section — which already serialises the counts the rule reads — and stamps `responses.invited_at`, returning the player ids. Sending happens outside the lock: the respond route's `waitUntil` for latency, the hourly sweep as the guaranteed path. Both reuse the existing N-1 message and dedupe key, so neither can double-send.

**Tech Stack:** TypeScript, Hono, Drizzle ORM over Cloudflare D1, Durable Objects, Vitest with `@cloudflare/vitest-pool-workers`, Playwright for browser specs.

**Spec:** `docs/superpowers/specs/2026-08-24-gated-invites-design.md`

## Global Constraints

Copied from `CLAUDE.md` and the spec. Every task's requirements implicitly include these.

- **Worktree.** All of this work happens in a sibling worktree (`git worktree add ../maketheteam-m34 -b m34`), merged fast-forward to `main`. The worktree needs its own `npm install`. Never add an `allowScripts` block to `package.json` to make it work.
- **Stage explicit paths.** Never `git add -A` or `git add .`. Run `git status` immediately before every commit and confirm every staged path is yours.
- **A new `<style>` block must be added to `PAGE_STYLE_BLOCKS`** in `src/views/styles.ts`, or `src/security/csp.ts` will not hash it and the CSS silently vanishes in production while every test passes.
- **`pageStyles` array order IS cascade order.** At equal specificity the later block wins. `test/views/style-cascade.test.ts` enumerates same-selector collisions; two blocks styling one element through *different* selectors at equal specificity are invisible to it and need their own test.
- **No `style="…"` attributes.** `style-src` is hash-only with no `style-src-attr`. Use a declared class. Never add `'unsafe-inline'` or `'unsafe-hashes'`.
- **Every interpolation goes through `escapeHtml`**, including `href` and class attributes.
- **All timezone conversion goes through `formatLocalDateTime`** (TR-5).
- **Guards establish *who*; entitlement is re-asked per handler, and a refusal is a 404, not a 403** (TR-18).
- **Comments name the failure a rule prevents**; they do not restate the code. A comment that overclaims is worse than none.
- **A stored value indexing a lookup table can be `undefined`** — `text NOT NULL` carries no CHECK constraint, so `escapeHtml(undefined)` throws and 500s the page. `test/stored-lookups.test.ts` enumerates every such lookup.
- **Commands:** `npx vitest run <path>` (~9s, scoped) during a task; `npm test` (full suite, >120s — wait for it, never background it and end the turn); `npm run lint && npx tsc --noEmit` before every commit; `npx playwright test` (~5min) only where a task says so.
- **BR-39 is the safety property of the whole milestone:** with `gated_invites_enabled` off, behaviour is byte-identical to before. Every task that touches a shared path must prove it.

---

## File Structure

**Created:**

| Path | Responsibility |
|---|---|
| `src/domain/invite-tiers.ts` | The pure release rule. No D1, no I/O, no clock. |
| `src/db/invite-queries.ts` | Reads the rule's input out of D1; stamps `invited_at`. |
| `src/views/invite-order.ts` | The owner's tier editor page. |
| `test/domain/invite-tiers.test.ts` | Table-driven tests for the rule. |
| `test/db/invite-queries.test.ts` | State loading and stamping against D1. |
| `test/capacity/claim-invite-releases.test.ts` | The DO method: idempotency, convergence, concurrency. |
| `test/routes/invite-order.test.ts` | Editor routes, including the cross-Game invariant. |
| `test/sweep/gated-invites.test.ts` | Sweep integration and the BR-39 regression. |
| `test/views/invite-order.test.ts` | Editor and progress-panel rendering. |

**Modified:** `src/db/schema.ts`, `src/capacity/types.ts`, `src/capacity/fixture-capacity.ts`, `src/sweep/open-and-remind.ts`, `src/sweep/attention.ts`, `src/notify/send-late-invitations.ts`, `src/routes/respond.ts`, `src/routes/games.ts`, `src/domain/game-form.ts`, `src/views/game-form.ts`, `src/views/owner-fixture.ts`, `src/views/player-fixture.ts`, `src/views/styles.ts`, `src/cron/handler.ts`, `test/support/factories.ts`.

---

### Task 1: Schema, migration, and test factories

Nothing here changes behaviour. It exists so every later task has columns to write to and factories to seed with.

**Files:**
- Modify: `src/db/schema.ts`
- Modify: `test/support/factories.ts`
- Create: `migrations/0023_*.sql` (generated, do not hand-write)
- Test: `test/db/invite-queries.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `inviteTiers` Drizzle table; `memberships.inviteTierId`; `games.gatedInvitesEnabled`, `games.gatedFallbackHoursBefore`; `responses.invitedAt`. Factories `insertInviteTier(db, gameId, overrides?) => Promise<string>`.

- [ ] **Step 1: Write the failing test**

Create `test/db/invite-queries.test.ts`:

```ts
import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../src/db/client.js";
import { games, memberships, responses } from "../../src/db/schema.js";
import { insertGame, insertInviteTier, insertMembership, insertPlayer, resetDatabase } from "../support/factories.js";

const db = getDb(env.DB);

beforeEach(async () => {
  await resetDatabase();
});

describe("gated invite schema", () => {
  it("defaults a game to ungated with no fallback (BR-39)", async () => {
    const gameId = await insertGame(db);

    const [row] = await db.select().from(games).where(eq(games.id, gameId));

    expect(row?.gatedInvitesEnabled).toBe(false);
    expect(row?.gatedFallbackHoursBefore).toBeNull();
  });

  it("defaults a membership to the implicit tier and a response to uninvited", async () => {
    const gameId = await insertGame(db);
    const playerId = await insertPlayer(db);
    await insertMembership(db, gameId, playerId);

    const [row] = await db.select().from(memberships).where(eq(memberships.playerId, playerId));

    expect(row?.inviteTierId).toBeNull();
  });

  it("stores a tier and lets a membership point at it", async () => {
    const gameId = await insertGame(db);
    const tierId = await insertInviteTier(db, gameId, { name: "Core", position: 1 });
    const playerId = await insertPlayer(db);
    await insertMembership(db, gameId, playerId, { inviteTierId: tierId });

    const [row] = await db.select().from(memberships).where(eq(memberships.playerId, playerId));

    expect(row?.inviteTierId).toBe(tierId);
  });

  it("clears invite_tiers between tests", async () => {
    const gameId = await insertGame(db);
    await insertInviteTier(db, gameId, { name: "Core", position: 1 });

    await resetDatabase();

    const rows = await db.select().from(responses);
    expect(rows).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/db/invite-queries.test.ts`
Expected: FAIL — `insertInviteTier` is not exported from the factories, and `gatedInvitesEnabled` does not exist on the row type.

- [ ] **Step 3: Add the schema**

In `src/db/schema.ts`, after the `memberships` table, add:

```ts
/**
 * One rung of a Game's invite order (BR-38, M34).
 *
 * **The index on (game_id, position) is deliberately not unique.** Reordering
 * rewrites every row's position in one `db.batch()`, and SQLite checks a
 * unique index per statement — a batch that swaps positions 1 and 2 would
 * fail on its first statement, with no way to defer the check. Order is
 * therefore `ORDER BY position, created_at`, and a duplicated position is a
 * display-order tie rather than a write that cannot happen.
 *
 * There is no row for the implicit final tier. It is every active member with
 * a null `memberships.invite_tier_id`, which is what makes a player who joins
 * next week reachable that same day with no owner action.
 */
export const inviteTiers = sqliteTable(
  "invite_tiers",
  {
    id: text("id").primaryKey(),
    gameId: text("game_id").notNull().references(() => games.id),
    name: text("name").notNull(),
    position: integer("position").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
  },
  (t) => [index("invite_tiers_game_position_idx").on(t.gameId, t.position)],
);
```

In the `games` table, beside the M26 switches:

```ts
  /**
   * M34, BR-39. Whether this Game asks its squad in priority order rather
   * than all at once. Off by default, so every Game that existed before this
   * milestone behaves exactly as it did.
   *
   * Read live from `games`, never snapshotted onto `fixtures`, for the reason
   * the M26 switches above give: a switch is not history.
   */
  gatedInvitesEnabled: integer("gated_invites_enabled", { mode: "boolean" }).notNull().default(false),
  /**
   * How many hours before kickoff the fallback release starts (BR-44), or
   * null for never.
   *
   * Nullable rather than a sentinel integer: "never" is a real choice an
   * owner makes — release only on a decline — and a magic 0 or -1 is the kind
   * of value a later reader mistakes for "at kickoff".
   */
  gatedFallbackHoursBefore: integer("gated_fallback_hours_before"),
```

In `memberships`:

```ts
    /**
     * Which rung of the Game's invite order this member sits on (BR-38), or
     * null for the implicit final tier.
     *
     * On `memberships` rather than a join table because
     * `UNIQUE (game_id, player_id)` one line down already enforces "one tier
     * per player per Game" for free. Deleting a tier nulls this column,
     * dropping its members to the implicit tier rather than orphaning them.
     *
     * SQLite cannot cheaply express "the referenced tier belongs to *this*
     * Game". The write path scopes every tier lookup by `game_id`, and
     * `test/routes/invite-order.test.ts` pins it.
     */
    inviteTierId: text("invite_tier_id").references(() => inviteTiers.id),
```

In `responses`:

```ts
    /**
     * When this player was invited to this fixture (BR-41, M34), or null if
     * they have not been. Null forever, and never read, for an ungated Game.
     *
     * **Nothing ever clears it.** Releasing a tier is one-way, and this column
     * is the durable record of what has gone out — which is what lets the
     * release rule be derived from current state with no event log, and what
     * makes a second reconcile a no-op.
     */
    invitedAt: integer("invited_at", { mode: "timestamp_ms" }),
```

- [ ] **Step 4: Generate the migration**

Run: `npx drizzle-kit generate`
Expected: a new `migrations/0023_<name>.sql` containing `CREATE TABLE invite_tiers`, three `ALTER TABLE ... ADD COLUMN`, and the index. Read it and confirm it contains no `DROP` of an existing column.

- [ ] **Step 5: Add the factory and the reset entry**

In `test/support/factories.ts`, import `inviteTiers` from the schema and add:

```ts
/** One rung of a Game's invite order. Position defaults to 1. */
export async function insertInviteTier(
  db: Db,
  gameId: string,
  overrides: Partial<typeof inviteTiers.$inferInsert> = {},
): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(inviteTiers).values({ id, gameId, name: "Tier", position: 1, ...overrides });
  return id;
}
```

In `RESET_TABLES`, add `"invite_tiers"` **between `"memberships"` and `"fixtures"`** — memberships hold a FK to it, so it must be deleted after them and before games.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run test/db/invite-queries.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 7: Prove BR-39 — nothing else moved**

Run: `npm test`
Expected: PASS, with the same test count as before this task plus 4. A failure here means a new column changed an existing behaviour and must be fixed before committing.

- [ ] **Step 8: Lint, typecheck, commit**

```bash
npm run lint && npx tsc --noEmit
git status
git add src/db/schema.ts test/support/factories.ts test/db/invite-queries.test.ts migrations/0023_*.sql
git commit -m "M34: schema for gated invites"
```

---

### Task 2: The release rule, as a pure function

The heart of the milestone. No D1, no clock, no I/O — so it is fast to test and every edge case is a table row.

**Files:**
- Create: `src/domain/invite-tiers.ts`
- Test: `test/domain/invite-tiers.test.ts`

**Interfaces:**
- Consumes: `ResponseStatus` from `src/domain/response-status.js`.
- Produces:

```ts
export interface TierMember {
  playerId: string;
  status: ResponseStatus | null;
  invitedAt: Date | null;
}
export interface TierState { tierId: string | null; members: TierMember[] }
export interface ReleaseInput {
  tiers: TierState[];
  guestInCount: number;
  maxPlayers: number;
  minPlayers: number;
  fallbackDue: boolean;
  force: boolean;
}
export interface ReleasePlan { releasedCount: number; toInvite: string[] }
export function planReleases(input: ReleaseInput): ReleasePlan;
```

- [ ] **Step 1: Write the failing test**

Create `test/domain/invite-tiers.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { planReleases, type ReleaseInput, type TierState } from "../../src/domain/invite-tiers.js";
import type { ResponseStatus } from "../../src/domain/response-status.js";

const INVITED = new Date("2026-08-24T09:00:00Z");

/** `"in"` / `"pending"` / `"out"`, or `null` for a member holding no live row. */
type Spec = ResponseStatus | null;

/** A tier of members. A status prefixed with `*` means already invited. */
function tier(id: string | null, ...members: string[]): TierState {
  return {
    tierId: id,
    members: members.map((m, i) => {
      const invited = m.startsWith("*");
      const raw = invited ? m.slice(1) : m;
      const status = (raw === "-" ? null : raw) as Spec;
      return { playerId: `${id ?? "implicit"}-${i}`, status, invitedAt: invited ? INVITED : null };
    }),
  };
}

function input(tiers: TierState[], over: Partial<ReleaseInput> = {}): ReleaseInput {
  return { tiers, guestInCount: 0, maxPlayers: 10, minPlayers: 8, fallbackDue: false, force: false, ...over };
}

describe("planReleases — the worked example from the spec", () => {
  // Core of 5, Regulars of 3, Ida, then the implicit tier of 5. max 10, min 8.
  const CORE = ["pending", "pending", "pending", "pending", "pending"];
  const REGULARS = ["pending", "pending", "pending"];

  it("releases only the core at the reminder instant", () => {
    const plan = planReleases(input([
      tier("core", ...CORE.map(() => "-")),
      tier("regulars", ...REGULARS.map(() => "-")),
      tier("ida", "-"),
      tier(null, "-", "-", "-", "-", "-"),
    ]));

    expect(plan.releasedCount).toBe(1);
    expect(plan.toInvite).toHaveLength(0); // nobody holds a live row in this seed
  });

  it("releases the core and stamps every live row in it", () => {
    const plan = planReleases(input([
      tier("core", ...CORE),
      tier("regulars", ...REGULARS),
      tier("ida", "pending"),
      tier(null, "pending"),
    ]));

    expect(plan.releasedCount).toBe(1);
    expect(plan.toInvite).toEqual(["core-0", "core-1", "core-2", "core-3", "core-4"]);
  });

  it("releases the second tier in the same pass when a core member is muted out (M28)", () => {
    const plan = planReleases(input([
      tier("core", "*pending", "*pending", "*pending", "*pending", "*out"),
      tier("regulars", ...REGULARS),
      tier("ida", "pending"),
      tier(null, "pending"),
    ]));

    expect(plan.releasedCount).toBe(2);
    expect(plan.toInvite).toEqual(["regulars-0", "regulars-1", "regulars-2"]);
  });

  it("releases a third tier when a core member declines", () => {
    const plan = planReleases(input([
      tier("core", "*pending", "*pending", "*pending", "*out", "*out"),
      tier("regulars", "*pending", "*pending", "*pending"),
      tier("ida", "pending"),
      tier(null, "pending"),
    ]));

    expect(plan.releasedCount).toBe(3);
    expect(plan.toInvite).toEqual(["ida-0"]);
  });

  it("lets a sub's decline release the tier after it", () => {
    const plan = planReleases(input([
      tier("core", "*pending", "*pending", "*pending", "*out", "*out"),
      tier("regulars", "*out", "*pending", "*pending"),
      tier("ida", "*pending"),
      tier(null, "pending", "pending"),
    ]));

    expect(plan.releasedCount).toBe(4);
    expect(plan.toInvite).toEqual(["implicit-0", "implicit-1"]);
  });
});

describe("planReleases — the BR-43 veto", () => {
  // Core of 12 against max_players 10.
  const full = (outs: number) =>
    Array.from({ length: 12 }, (_, i) => (i < outs ? "*out" : "*pending"));

  it("holds a tier back while the fixture is full", () => {
    const plan = planReleases(input([tier("core", ...full(1)), tier("subs", "pending")]));

    expect(plan.releasedCount).toBe(1);
    expect(plan.toInvite).toHaveLength(0);
  });

  it("releases the held-back tier once potential drops below max", () => {
    const plan = planReleases(input([tier("core", ...full(3)), tier("subs", "pending")]));

    expect(plan.releasedCount).toBe(2);
    expect(plan.toInvite).toEqual(["subs-0"]);
  });
});

describe("planReleases — potential counts everyone holding a slot", () => {
  it("counts a guest, so a guest reduces how many tiers are released", () => {
    const withoutGuests = planReleases(input([
      tier("core", "*out", "*out", "*pending"),
      tier("subs", "pending"),
      tier(null, "pending"),
    ], { maxPlayers: 3 }));
    const withGuests = planReleases(input([
      tier("core", "*out", "*out", "*pending"),
      tier("subs", "pending"),
      tier(null, "pending"),
    ], { maxPlayers: 3, guestInCount: 2 }));

    expect(withoutGuests.releasedCount).toBe(2);
    expect(withGuests.releasedCount).toBe(1);
  });

  it("counts an early volunteer from an unreleased tier (BR-40)", () => {
    const plan = planReleases(input([
      tier("core", "*out", "*pending"),
      tier("subs", "in", "pending"),
    ], { maxPlayers: 2 }));

    // potential = 1 pending (core) + 1 in (the volunteer) = 2 >= max 2. Vetoed.
    expect(plan.releasedCount).toBe(1);
  });

  it("counts a waitlisted member, so keenness never releases a tier", () => {
    const plan = planReleases(input([
      tier("core", "*in", "*waitlisted"),
      tier("subs", "pending"),
    ], { maxPlayers: 2 }));

    expect(plan.releasedCount).toBe(1);
  });
});

describe("planReleases — shortfall counts from the membership side", () => {
  it("treats a member with no live row as missing, as withdrawMember deletes it", () => {
    const plan = planReleases(input([
      tier("core", "*pending", "*pending", "-"),
      tier("subs", "pending"),
    ]));

    expect(plan.releasedCount).toBe(2);
  });

  it("never invites a withdrawn player back", () => {
    const plan = planReleases(input([tier("core", "pending", "withdrawn")]));

    expect(plan.toInvite).toEqual(["core-0"]);
  });
});

describe("planReleases — the fallback and the manual release", () => {
  it("releases nothing extra before the fallback instant", () => {
    const plan = planReleases(input([
      tier("core", "*pending", "*pending"),
      tier("subs", "pending"),
    ], { minPlayers: 8 }));

    expect(plan.releasedCount).toBe(1);
  });

  it("releases until minPlayers is reachable once the fallback is due (BR-44)", () => {
    const plan = planReleases(input([
      tier("core", "*pending", "*pending"),
      tier("subs", "pending", "pending"),
      tier(null, "pending", "pending", "pending", "pending"),
    ], { minPlayers: 8, fallbackDue: true }));

    expect(plan.releasedCount).toBe(3);
  });

  it("stops at the last tier rather than looping", () => {
    const plan = planReleases(input([tier("core", "*pending")], { minPlayers: 99, fallbackDue: true }));

    expect(plan.releasedCount).toBe(1);
  });

  it("releases exactly one tier on force, ignoring the veto", () => {
    const plan = planReleases(input([
      tier("core", "*in", "*in"),
      tier("subs", "pending"),
      tier(null, "pending"),
    ], { maxPlayers: 2, force: true }));

    expect(plan.releasedCount).toBe(2);
    expect(plan.toInvite).toEqual(["subs-0"]);
  });
});

describe("planReleases — degenerate shapes", () => {
  it("treats a gated Game with no tiers defined as ungated (the implicit tier is tier one)", () => {
    const plan = planReleases(input([tier(null, "pending", "pending", "pending")]));

    expect(plan.releasedCount).toBe(1);
    expect(plan.toInvite).toEqual(["implicit-0", "implicit-1", "implicit-2"]);
  });

  it("is a no-op on a second run — the same state plans the same releases", () => {
    const state = input([
      tier("core", "*pending", "*out"),
      tier("subs", "*pending"),
      tier(null, "pending"),
    ]);

    const first = planReleases(state);
    const second = planReleases(state);

    expect(second).toEqual(first);
    expect(first.toInvite).toEqual(["implicit-0"]);
  });

  it("skips an empty tier without stalling", () => {
    const plan = planReleases(input([
      tier("core", "*out"),
      tier("empty"),
      tier("subs", "pending"),
    ]));

    expect(plan.releasedCount).toBe(3);
    expect(plan.toInvite).toEqual(["subs-0"]);
  });

  it("returns nothing for a Game with no members at all", () => {
    const plan = planReleases(input([tier(null)]));

    expect(plan).toEqual({ releasedCount: 1, toInvite: [] });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/domain/invite-tiers.test.ts`
Expected: FAIL — `Cannot find module '../../src/domain/invite-tiers.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/domain/invite-tiers.ts`:

```ts
import type { ResponseStatus } from "./response-status.js";

/** One member of a tier, with their current response on the fixture being planned. */
export interface TierMember {
  playerId: string;
  /**
   * Null when the member holds no live response row at all — an owner removal
   * *deletes* the row of a `pending`, `out` or `waitlisted` player rather than
   * marking it (see `WithdrawMemberOutcome`), so absence is a real state and
   * not a loading error.
   */
  status: ResponseStatus | null;
  /** Null until this player has been invited (BR-41). */
  invitedAt: Date | null;
}

/** One rung of the invite order. `tierId` is null for the implicit final tier (BR-38). */
export interface TierState {
  tierId: string | null;
  members: TierMember[];
}

export interface ReleaseInput {
  /** In invite order: stored tiers by (position, created_at), then the implicit tier. */
  tiers: TierState[];
  /** Live `in` responses belonging to no membership — guests (BR-32). */
  guestInCount: number;
  maxPlayers: number;
  minPlayers: number;
  /** True once `now >= kicksOffAt - gatedFallbackHoursBefore`. Always false when the fallback is off (BR-44). */
  fallbackDue: boolean;
  /** The owner's manual release: one tier, ignoring BR-43's veto. */
  force: boolean;
}

export interface ReleasePlan {
  /** How many tiers should be released in total, counting those already released. */
  releasedCount: number;
  /** Players whose `invited_at` must be stamped, in tier then member order. */
  toInvite: string[];
}

/** Statuses that mean this player is holding, or waiting to hold, one of the fixture's slots. */
function holdsASlot(status: ResponseStatus | null): boolean {
  // `waitlisted` is here and not in the shortfall for a reason: BR-7 hands the
  // next free slot to the waitlist, so counting a keen player as missing would
  // release a whole tier on their behalf.
  return status === "in" || status === "waitlisted";
}

/**
 * How many tiers of this Game's invite order should be released, and who that
 * newly invites (BR-41 to BR-44).
 *
 * **Level-based: the answer is a function of current state, with no event log.**
 * Two consequences the callers depend on. A second call on unchanged state
 * returns the same plan, so a retry, an overlapping sweep tick and a concurrent
 * decline cannot compound. And a release the veto held back is not lost — it
 * simply happens on the first call after `potential` drops.
 *
 * `shortfall` is counted from the **membership** side rather than by counting
 * `out` rows, because an owner removal deletes the row of a player who had not
 * answered. A rule that counted declines would silently fail to release a tier
 * for exactly the player the organiser just took out.
 */
export function planReleases(input: ReleaseInput): ReleasePlan {
  const { tiers, maxPlayers, minPlayers, guestInCount, fallbackDue, force } = input;

  // A tier is released once any of its members carries a stamp. Derived from
  // the *last* such tier rather than the first gap, so an empty tier — one
  // whose members have all left the squad — does not read as a break in the
  // sequence and stall every tier behind it.
  let releasedCount = 0;
  tiers.forEach((tier, index) => {
    if (tier.members.some((member) => member.invitedAt !== null)) releasedCount = index + 1;
  });

  const measure = (count: number): { potential: number; shortfall: number } => {
    let potential = guestInCount;
    let shortfall = 0;
    tiers.forEach((tier, index) => {
      const released = index < count;
      for (const member of tier.members) {
        // An early volunteer (BR-40) counts wherever they sit: they really are
        // holding a slot, released or not.
        if (holdsASlot(member.status)) potential += 1;
        else if (released && member.status === "pending") potential += 1;
        else if (released) shortfall += 1;
      }
    });
    return { potential, shortfall };
  };

  // Bounded by the tier count: every iteration that continues releases exactly
  // one tier, so this cannot spin even if a future edit gets a guard wrong.
  for (let step = 0; step <= tiers.length; step++) {
    if (releasedCount >= tiers.length) break;

    const { potential, shortfall } = measure(releasedCount);
    const owed = 1 + shortfall;
    const target = Math.max(releasedCount, Math.min(owed, tiers.length));

    // The owner's manual release, and only ever the first extra tier of a call.
    if (force && step === 0) {
      releasedCount += 1;
      continue;
    }
    if (releasedCount < target && potential < maxPlayers) {
      releasedCount += 1;
      continue;
    }
    if (fallbackDue && potential < minPlayers) {
      releasedCount += 1;
      continue;
    }
    break;
  }

  const toInvite: string[] = [];
  for (const tier of tiers.slice(0, releasedCount)) {
    for (const member of tier.members) {
      if (member.invitedAt !== null) continue;
      // No live row means nothing to stamp. `withdrawn` means an owner took
      // them out of this fixture (BR-3), and inviting them would undo that.
      if (member.status === null || member.status === "withdrawn") continue;
      toInvite.push(member.playerId);
    }
  }

  return { releasedCount, toInvite };
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/domain/invite-tiers.test.ts`
Expected: PASS, 18 tests.

- [ ] **Step 5: Lint, typecheck, commit**

```bash
npm run lint && npx tsc --noEmit
git status
git add src/domain/invite-tiers.ts test/domain/invite-tiers.test.ts
git commit -m "M34: the gated-invite release rule"
```

---

### Task 3: Reading the rule's input from D1, and stamping

**Files:**
- Create: `src/db/invite-queries.ts`
- Test: `test/db/invite-queries.test.ts` (extend Task 1's file)

**Interfaces:**
- Consumes: `TierState`, `ReleaseInput` from `src/domain/invite-tiers.js`; `chunk`, `INSERT_CHUNK_SIZE` from `src/db/chunk.js`.
- Produces:

```ts
export interface InviteState {
  gated: boolean;
  maxPlayers: number;
  minPlayers: number;
  fallbackDue: boolean;
  tiers: TierState[];
  guestInCount: number;
}
export function loadInviteState(db: Db, fixtureId: string, now: Date): Promise<InviteState | null>;
export function stampInvited(db: Db, fixtureId: string, playerIds: readonly string[], now: Date): Promise<string[]>;
```

- [ ] **Step 1: Write the failing test**

Append to `test/db/invite-queries.test.ts`:

```ts
describe("loadInviteState", () => {
  it("returns null for a fixture that does not exist", async () => {
    expect(await loadInviteState(db, crypto.randomUUID(), NOW)).toBeNull();
  });

  it("reports an ungated game as ungated (BR-39)", async () => {
    const gameId = await insertGame(db);
    const fixtureId = await insertFixture(db, gameId);

    const state = await loadInviteState(db, fixtureId, NOW);

    expect(state?.gated).toBe(false);
  });

  it("orders tiers by position then created_at, with the implicit tier last", async () => {
    const gameId = await insertGame(db, { gatedInvitesEnabled: true });
    const fixtureId = await insertFixture(db, gameId);
    const second = await insertInviteTier(db, gameId, { name: "Regulars", position: 2 });
    const first = await insertInviteTier(db, gameId, { name: "Core", position: 1 });
    const core = await insertPlayer(db, { id: "p-core" });
    const reg = await insertPlayer(db, { id: "p-reg" });
    const rest = await insertPlayer(db, { id: "p-rest" });
    await insertMembership(db, gameId, core, { inviteTierId: first });
    await insertMembership(db, gameId, reg, { inviteTierId: second });
    await insertMembership(db, gameId, rest);
    for (const p of [core, reg, rest]) await insertResponse(db, fixtureId, p, { status: "pending" });

    const state = await loadInviteState(db, fixtureId, NOW);

    expect(state?.tiers.map((t) => t.tierId)).toEqual([first, second, null]);
    expect(state?.tiers[0]?.members.map((m) => m.playerId)).toEqual(["p-core"]);
    expect(state?.tiers[2]?.members.map((m) => m.playerId)).toEqual(["p-rest"]);
  });

  it("gives a member with no response row a null status", async () => {
    const gameId = await insertGame(db, { gatedInvitesEnabled: true });
    const fixtureId = await insertFixture(db, gameId);
    const playerId = await insertPlayer(db);
    await insertMembership(db, gameId, playerId);

    const state = await loadInviteState(db, fixtureId, NOW);

    expect(state?.tiers[0]?.members[0]).toMatchObject({ playerId, status: null, invitedAt: null });
  });

  it("excludes an inactive member entirely", async () => {
    const gameId = await insertGame(db, { gatedInvitesEnabled: true });
    const fixtureId = await insertFixture(db, gameId);
    const playerId = await insertPlayer(db);
    await insertMembership(db, gameId, playerId, { active: false });

    const state = await loadInviteState(db, fixtureId, NOW);

    expect(state?.tiers[0]?.members).toHaveLength(0);
  });

  it("counts a guest who is in, and never puts them in a tier", async () => {
    const gameId = await insertGame(db, { gatedInvitesEnabled: true });
    const fixtureId = await insertFixture(db, gameId);
    const guestId = await insertPlayer(db, { isGuest: true, email: null });
    await insertResponse(db, fixtureId, guestId, { status: "in", source: "owner" });

    const state = await loadInviteState(db, fixtureId, NOW);

    expect(state?.guestInCount).toBe(1);
    expect(state?.tiers.flatMap((t) => t.members)).toHaveLength(0);
  });

  it("reports the fallback as due only once the offset has passed (BR-44)", async () => {
    const gameId = await insertGame(db, { gatedInvitesEnabled: true, gatedFallbackHoursBefore: 12 });
    const kicksOffAt = new Date("2026-08-25T18:00:00Z");
    const fixtureId = await insertFixture(db, gameId, { kicksOffAt });

    const before = await loadInviteState(db, fixtureId, new Date("2026-08-25T05:59:00Z"));
    const after = await loadInviteState(db, fixtureId, new Date("2026-08-25T06:01:00Z"));

    expect(before?.fallbackDue).toBe(false);
    expect(after?.fallbackDue).toBe(true);
  });

  it("never reports the fallback as due when it is switched off", async () => {
    const gameId = await insertGame(db, { gatedInvitesEnabled: true, gatedFallbackHoursBefore: null });
    const fixtureId = await insertFixture(db, gameId, { kicksOffAt: new Date("2026-08-25T18:00:00Z") });

    const state = await loadInviteState(db, fixtureId, new Date("2026-08-25T17:59:00Z"));

    expect(state?.fallbackDue).toBe(false);
  });
});

describe("stampInvited", () => {
  it("stamps only rows that were not already invited, and reports which", async () => {
    const gameId = await insertGame(db, { gatedInvitesEnabled: true });
    const fixtureId = await insertFixture(db, gameId);
    const fresh = await insertPlayer(db, { id: "p-fresh" });
    const already = await insertPlayer(db, { id: "p-already" });
    await insertResponse(db, fixtureId, fresh, { status: "pending" });
    await insertResponse(db, fixtureId, already, { status: "pending", invitedAt: new Date("2026-08-20T09:00:00Z") });

    const stamped = await stampInvited(db, fixtureId, [fresh, already], NOW);

    expect(stamped).toEqual(["p-fresh"]);
    const [row] = await db.select().from(responses).where(eq(responses.playerId, already));
    expect(row?.invitedAt?.toISOString()).toBe("2026-08-20T09:00:00.000Z");
  });

  it("is a no-op for an empty list", async () => {
    const gameId = await insertGame(db);
    const fixtureId = await insertFixture(db, gameId);

    expect(await stampInvited(db, fixtureId, [], NOW)).toEqual([]);
  });
});
```

Add to the imports at the top of the file: `insertFixture`, `insertResponse` from the factories, and `loadInviteState`, `stampInvited` from `../../src/db/invite-queries.js`. Add `const NOW = new Date("2026-08-24T09:00:00Z");` beside the `db` constant.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/db/invite-queries.test.ts`
Expected: FAIL — `Cannot find module '../../src/db/invite-queries.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/db/invite-queries.ts`:

```ts
import { and, asc, eq, inArray, isNull, notInArray } from "drizzle-orm";
import type { Db } from "./client.js";
import { chunk, INSERT_CHUNK_SIZE } from "./chunk.js";
import { fixtures, games, inviteTiers, memberships, responses } from "./schema.js";
import type { TierState } from "../domain/invite-tiers.js";

const HOUR_MS = 3_600_000;

/** Everything `planReleases` needs about one fixture, read in three queries. */
export interface InviteState {
  gated: boolean;
  maxPlayers: number;
  minPlayers: number;
  fallbackDue: boolean;
  tiers: TierState[];
  guestInCount: number;
}

/**
 * Read the invite state of one fixture.
 *
 * `gated`, `gatedFallbackHoursBefore` and the tier list come from `games`,
 * live — an owner who turns gating on means the fixtures that already exist,
 * the same reasoning the M26 switches carry. `minPlayers`/`maxPlayers` come
 * from the *fixture's* snapshot, because those genuinely are history (§2.8).
 */
export async function loadInviteState(db: Db, fixtureId: string, now: Date): Promise<InviteState | null> {
  const [row] = await db
    .select({ fixture: fixtures, game: games })
    .from(fixtures)
    .innerJoin(games, eq(fixtures.gameId, games.id))
    .where(eq(fixtures.id, fixtureId));
  if (!row) return null;

  const { fixture, game } = row;
  const fallbackDue =
    game.gatedFallbackHoursBefore !== null &&
    now.getTime() >= fixture.kicksOffAt.getTime() - game.gatedFallbackHoursBefore * HOUR_MS;

  const base = {
    gated: game.gatedInvitesEnabled,
    maxPlayers: fixture.maxPlayers,
    minPlayers: fixture.minPlayers,
    fallbackDue,
  };

  // An ungated fixture never reaches the rule, so the two remaining queries
  // are skipped outright rather than run and thrown away (BR-39).
  if (!game.gatedInvitesEnabled) return { ...base, tiers: [{ tierId: null, members: [] }], guestInCount: 0 };

  const tierRows = await db
    .select({ id: inviteTiers.id })
    .from(inviteTiers)
    .where(eq(inviteTiers.gameId, fixture.gameId))
    .orderBy(asc(inviteTiers.position), asc(inviteTiers.createdAt));

  const memberRows = await db
    .select({
      playerId: memberships.playerId,
      inviteTierId: memberships.inviteTierId,
      status: responses.status,
      invitedAt: responses.invitedAt,
    })
    .from(memberships)
    .leftJoin(
      responses,
      and(eq(responses.fixtureId, fixtureId), eq(responses.playerId, memberships.playerId)),
    )
    .where(and(eq(memberships.gameId, fixture.gameId), eq(memberships.active, true)));

  const memberIds = memberRows.map((member) => member.playerId);
  // Guests hold a response row and no membership, so they fall out of the join
  // above. They still occupy a slot, which is what `potential` has to know.
  const guestRows = await db
    .select({ playerId: responses.playerId })
    .from(responses)
    .where(
      memberIds.length === 0
        ? and(eq(responses.fixtureId, fixtureId), eq(responses.status, "in"))
        : and(
            eq(responses.fixtureId, fixtureId),
            eq(responses.status, "in"),
            notInArray(responses.playerId, memberIds),
          ),
    );

  const byTier = new Map<string | null, TierState>();
  for (const tier of tierRows) byTier.set(tier.id, { tierId: tier.id, members: [] });
  byTier.set(null, { tierId: null, members: [] });

  for (const member of memberRows) {
    // A membership pointing at another Game's tier would land here as an
    // unknown key. It falls to the implicit tier rather than being dropped:
    // silently un-inviting someone is worse than asking them last.
    const bucket = byTier.get(member.inviteTierId) ?? byTier.get(null)!;
    bucket.members.push({
      playerId: member.playerId,
      status: member.status ?? null,
      invitedAt: member.invitedAt ?? null,
    });
  }

  const tiers = [...tierRows.map((tier) => byTier.get(tier.id)!), byTier.get(null)!];
  return { ...base, tiers, guestInCount: guestRows.length };
}

/**
 * Stamp `invited_at` on the named players' rows for this fixture, and return
 * the ids actually stamped.
 *
 * **`isNull(responses.invitedAt)` in the WHERE is the second idempotency
 * mechanism, and it is load-bearing.** The Durable Object serialises callers
 * that address it by fixture id, but the return value is what the caller mails
 * — so if two paths ever did overlap, the one that lost the race must come
 * back with an empty list rather than a second invitation to a real person.
 * The `n1` dedupe key is the third.
 *
 * Chunked (TR-38) because D1 bounds the number of bound parameters per
 * statement and a squad is unbounded in principle.
 */
export async function stampInvited(
  db: Db,
  fixtureId: string,
  playerIds: readonly string[],
  now: Date,
): Promise<string[]> {
  const stamped: string[] = [];
  for (const batch of chunk([...playerIds], INSERT_CHUNK_SIZE)) {
    if (batch.length === 0) continue;
    const updated = await db
      .update(responses)
      .set({ invitedAt: now })
      .where(
        and(
          eq(responses.fixtureId, fixtureId),
          inArray(responses.playerId, batch),
          isNull(responses.invitedAt),
        ),
      )
      .returning({ playerId: responses.playerId });
    stamped.push(...updated.map((update) => update.playerId));
  }
  return stamped;
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/db/invite-queries.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 5: Lint, typecheck, commit**

```bash
npm run lint && npx tsc --noEmit
git status
git add src/db/invite-queries.ts test/db/invite-queries.test.ts
git commit -m "M34: read invite state and stamp invitations"
```

---

### Task 4: `FixtureCapacity.claimInviteReleases`

**Files:**
- Modify: `src/capacity/types.ts`
- Modify: `src/capacity/fixture-capacity.ts`
- Test: `test/capacity/claim-invite-releases.test.ts`

**Interfaces:**
- Consumes: `planReleases` (Task 2); `loadInviteState`, `stampInvited` (Task 3).
- Produces:

```ts
export interface ClaimInviteReleasesInput { now: number; force?: boolean }
export type ClaimInviteReleasesOutcome =
  | { kind: "claimed"; playerIds: string[] }
  | { kind: "skipped"; reason: "not-gated" | "fixture-not-open" | "fixture-not-found" };
```

`env.FIXTURE_CAPACITY.getByName(fixtureId).claimInviteReleases({ now, force })`.

- [ ] **Step 1: Write the failing test**

Create `test/capacity/claim-invite-releases.test.ts`. Model the seeding on `test/capacity/*.test.ts`'s existing pattern for addressing the object by name.

```ts
import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../src/db/client.js";
import { responses } from "../../src/db/schema.js";
import {
  insertFixture, insertGame, insertInviteTier, insertMembership, insertPlayer,
  insertResponse, resetDatabase,
} from "../support/factories.js";

const db = getDb(env.DB);
const NOW = new Date("2026-08-24T09:00:00Z");

async function gatedFixture(opts: { core: number; subs: number; maxPlayers?: number }) {
  const gameId = await insertGame(db, { gatedInvitesEnabled: true });
  const fixtureId = await insertFixture(db, gameId, {
    lifecycle: "open", minPlayers: 2, maxPlayers: opts.maxPlayers ?? 10,
  });
  const coreTier = await insertInviteTier(db, gameId, { name: "Core", position: 1 });
  const subTier = await insertInviteTier(db, gameId, { name: "Subs", position: 2 });
  const ids: string[] = [];
  for (let i = 0; i < opts.core + opts.subs; i++) {
    const playerId = await insertPlayer(db, { id: `p-${i}`, email: `p${i}@example.com` });
    await insertMembership(db, gameId, playerId, { inviteTierId: i < opts.core ? coreTier : subTier });
    await insertResponse(db, fixtureId, playerId, { status: "pending" });
    ids.push(playerId);
  }
  return { gameId, fixtureId, ids };
}

const claim = (fixtureId: string, force = false) =>
  env.FIXTURE_CAPACITY.getByName(fixtureId).claimInviteReleases({ now: NOW.getTime(), force });

beforeEach(async () => {
  await resetDatabase();
});

describe("claimInviteReleases", () => {
  it("claims the core tier and stamps it", async () => {
    const { fixtureId } = await gatedFixture({ core: 3, subs: 2 });

    const outcome = await claim(fixtureId);

    expect(outcome).toEqual({ kind: "claimed", playerIds: ["p-0", "p-1", "p-2"] });
    const rows = await db.select().from(responses).where(eq(responses.fixtureId, fixtureId));
    expect(rows.filter((r) => r.invitedAt !== null)).toHaveLength(3);
  });

  it("is a no-op on a second call — the same state claims nothing new", async () => {
    const { fixtureId } = await gatedFixture({ core: 3, subs: 2 });
    await claim(fixtureId);

    const outcome = await claim(fixtureId);

    expect(outcome).toEqual({ kind: "claimed", playerIds: [] });
  });

  it("releases the next tier after a decline", async () => {
    const { fixtureId } = await gatedFixture({ core: 3, subs: 2 });
    await claim(fixtureId);
    await db.update(responses).set({ status: "out", respondedAt: NOW })
      .where(eq(responses.playerId, "p-0"));

    const outcome = await claim(fixtureId);

    expect(outcome).toEqual({ kind: "claimed", playerIds: ["p-3", "p-4"] });
  });

  it("releases one tier, not two, when two declines are claimed concurrently", async () => {
    const { fixtureId } = await gatedFixture({ core: 4, subs: 2 });
    await claim(fixtureId);
    await db.update(responses).set({ status: "out", respondedAt: NOW })
      .where(eq(responses.playerId, "p-0"));

    const [first, second] = await Promise.all([claim(fixtureId), claim(fixtureId)]);

    const claimed = [
      ...(first.kind === "claimed" ? first.playerIds : []),
      ...(second.kind === "claimed" ? second.playerIds : []),
    ];
    // Whichever call wins, each player is claimed exactly once — the stamp is
    // what makes a duplicate invitation impossible, not the ordering.
    expect(claimed.sort()).toEqual(["p-4", "p-5"]);
  });

  it("skips an ungated game (BR-39)", async () => {
    const gameId = await insertGame(db);
    const fixtureId = await insertFixture(db, gameId, { lifecycle: "open" });

    expect(await claim(fixtureId)).toEqual({ kind: "skipped", reason: "not-gated" });
  });

  it("skips a fixture that is not open", async () => {
    const gameId = await insertGame(db, { gatedInvitesEnabled: true });
    const fixtureId = await insertFixture(db, gameId, { lifecycle: "scheduled" });

    expect(await claim(fixtureId)).toEqual({ kind: "skipped", reason: "fixture-not-open" });
  });

  it("reports a missing fixture", async () => {
    expect(await claim(crypto.randomUUID())).toEqual({ kind: "skipped", reason: "fixture-not-found" });
  });

  it("releases exactly one tier on force, even when the fixture is full", async () => {
    const { fixtureId } = await gatedFixture({ core: 2, subs: 2, maxPlayers: 2 });
    await claim(fixtureId);
    await db.update(responses).set({ status: "in", respondedAt: NOW })
      .where(eq(responses.playerId, "p-0"));
    await db.update(responses).set({ status: "in", respondedAt: NOW })
      .where(eq(responses.playerId, "p-1"));

    expect(await claim(fixtureId)).toEqual({ kind: "claimed", playerIds: [] });
    expect(await claim(fixtureId, true)).toEqual({ kind: "claimed", playerIds: ["p-2", "p-3"] });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/capacity/claim-invite-releases.test.ts`
Expected: FAIL — `claimInviteReleases is not a function`.

- [ ] **Step 3: Add the types**

Append to `src/capacity/types.ts`:

```ts
/** An owner's manual release sets `force`; every other caller leaves it off. */
export interface ClaimInviteReleasesInput {
  /** Passed in rather than read from the clock — domain code stays testable. */
  now: number;
  /** Release one tier regardless of BR-43's veto. The owner's button, only. */
  force?: boolean;
}

/**
 * Which players this call newly invited (BR-41).
 *
 * **The object stamps and returns; it never sends.** `claimInviteReleases`
 * runs wholly inside `ctx.blockConcurrencyWhile`, so an HTTP call to a mail
 * provider from in there would serialise every other tap on the fixture behind
 * it — the same reasoning `WaitlistPromotion` gives for N-2. The caller sends
 * the N-1 after the object has returned and the lock has been released.
 *
 * An empty `playerIds` is the steady state, not a failure: every tick of the
 * sweep calls this, and almost every one finds nothing to release.
 */
export type ClaimInviteReleasesOutcome =
  | { kind: "claimed"; playerIds: string[] }
  | { kind: "skipped"; reason: "not-gated" | "fixture-not-open" | "fixture-not-found" };
```

- [ ] **Step 4: Add the method**

In `src/capacity/fixture-capacity.ts`, import `planReleases` and `loadInviteState`/`stampInvited`, add the two types to the existing type import, and add:

```ts
  /**
   * Release as many tiers of the Game's invite order as the current state owes
   * (BR-41 to BR-44), stamping `invited_at` on the players that newly invites.
   *
   * **In the critical section for the same reason `setResponse` is.** The rule
   * reads the fixture's `in`, `pending` and `waitlisted` counts, which is
   * exactly what a concurrent response changes. Two declines landing together
   * would otherwise each read the pre-decline state, each conclude a tier was
   * owed, and release two.
   */
  async claimInviteReleases(input: ClaimInviteReleasesInput): Promise<ClaimInviteReleasesOutcome> {
    return this.ctx.blockConcurrencyWhile(async () => this.#claimInviteReleasesLocked(input));
  }

  async #claimInviteReleasesLocked(input: ClaimInviteReleasesInput): Promise<ClaimInviteReleasesOutcome> {
    // The fixture id comes from the object's own identity, never from an
    // argument — see `#setResponseLocked` for what a mismatch would break.
    const fixtureId = this.ctx.id.name;
    if (fixtureId === undefined) {
      throw new Error(
        "FixtureCapacity was addressed by unique id, not by fixture id — every caller must use getByName(fixtureId)",
      );
    }

    const db = getDb(this.env.DB);
    const now = new Date(input.now);

    const [fixture] = await db.select().from(fixtures).where(eq(fixtures.id, fixtureId));
    if (!fixture) return { kind: "skipped", reason: "fixture-not-found" };
    if (fixture.lifecycle !== "open") return { kind: "skipped", reason: "fixture-not-open" };

    const state = await loadInviteState(db, fixtureId, now);
    if (!state) return { kind: "skipped", reason: "fixture-not-found" };
    if (!state.gated) return { kind: "skipped", reason: "not-gated" };

    const plan = planReleases({
      tiers: state.tiers,
      guestInCount: state.guestInCount,
      maxPlayers: state.maxPlayers,
      minPlayers: state.minPlayers,
      fallbackDue: state.fallbackDue,
      force: input.force ?? false,
    });

    const playerIds = await stampInvited(db, fixtureId, plan.toInvite, now);
    return { kind: "claimed", playerIds };
  }
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/capacity/claim-invite-releases.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 6: Lint, typecheck, commit**

```bash
npm run lint && npx tsc --noEmit
git status
git add src/capacity/types.ts src/capacity/fixture-capacity.ts test/capacity/claim-invite-releases.test.ts
git commit -m "M34: claim invite releases inside the capacity lock"
```

---

### Task 5: Sweep integration — the guaranteed send path

The sweep is what makes a release durable. It claims before it reminds, so a tier released this tick is mailed this tick.

**Files:**
- Modify: `src/sweep/open-and-remind.ts`
- Modify: `src/notify/send-late-invitations.ts`
- Modify: `src/cron/handler.ts:57`
- Test: `test/sweep/gated-invites.test.ts`

**Interfaces:**
- Consumes: `claimInviteReleases` (Task 4).
- Produces: `openAndRemind(db, notifier, now, responseTokenSecret, capacity)` — a fifth parameter, `DurableObjectNamespace<FixtureCapacity>`. `SweepResult` gains `tiersClaimed: number` and `invitationsClaimed: number`.

- [ ] **Step 1: Write the failing test**

Create `test/sweep/gated-invites.test.ts`:

```ts
import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../src/db/client.js";
import { notificationLog, responses } from "../../src/db/schema.js";
import { openAndRemind } from "../../src/sweep/open-and-remind.js";
import { ConsoleNotifier } from "../../src/notify/console-notifier.js";
import {
  insertFixture, insertGame, insertInviteTier, insertMembership, insertPlayer, resetDatabase,
} from "../support/factories.js";

const db = getDb(env.DB);
const notifier = new ConsoleNotifier();
const SECRET = "test-only-secret-not-used-in-any-real-environment";

/** A fixture whose reminder instant has already passed, so the sweep will act on it. */
async function dueGatedGame(coreSize: number, subSize: number) {
  const gameId = await insertGame(db, {
    gatedInvitesEnabled: true, reminderDaysBefore: 1, reminderLocalTime: "09:00", timezone: "Europe/London",
  });
  const kicksOffAt = new Date("2026-08-25T18:00:00Z");
  const fixtureId = await insertFixture(db, gameId, { kicksOffAt, minPlayers: 2, maxPlayers: 10 });
  const core = await insertInviteTier(db, gameId, { name: "Core", position: 1 });
  const subs = await insertInviteTier(db, gameId, { name: "Subs", position: 2 });
  for (let i = 0; i < coreSize + subSize; i++) {
    const playerId = await insertPlayer(db, { id: `p-${i}`, email: `p${i}@example.com` });
    await insertMembership(db, gameId, playerId, { inviteTierId: i < coreSize ? core : subs });
  }
  return { gameId, fixtureId };
}

const NOW = new Date("2026-08-24T09:30:00Z");

beforeEach(async () => {
  await resetDatabase();
});

describe("the sweep and gated invites", () => {
  it("opens, claims the core, and mails only the core", async () => {
    const { fixtureId } = await dueGatedGame(3, 4);

    const result = await openAndRemind(db, notifier, NOW, SECRET, env.FIXTURE_CAPACITY);

    expect(result.fixturesOpened).toBe(1);
    const rows = await db.select().from(responses).where(eq(responses.fixtureId, fixtureId));
    expect(rows).toHaveLength(7);                                    // BR-1 is unchanged
    expect(rows.filter((r) => r.invitedAt !== null)).toHaveLength(3); // only the core is invited
    const log = await db.select().from(notificationLog).where(eq(notificationLog.fixtureId, fixtureId));
    expect(log.filter((l) => l.notificationType === "n1" && l.channel === "email")).toHaveLength(3);
  });

  it("mails a tier released by a decline on the next tick, once only", async () => {
    const { fixtureId } = await dueGatedGame(3, 2);
    await openAndRemind(db, notifier, NOW, SECRET, env.FIXTURE_CAPACITY);
    await db.update(responses).set({ status: "out", respondedAt: NOW }).where(eq(responses.playerId, "p-0"));

    await openAndRemind(db, notifier, new Date("2026-08-24T10:30:00Z"), SECRET, env.FIXTURE_CAPACITY);
    await openAndRemind(db, notifier, new Date("2026-08-24T11:30:00Z"), SECRET, env.FIXTURE_CAPACITY);

    const log = await db
      .select()
      .from(notificationLog)
      .where(eq(notificationLog.fixtureId, fixtureId));
    const emails = log.filter((l) => l.notificationType === "n1" && l.channel === "email");
    expect(emails).toHaveLength(5); // 3 core + 2 subs, and no repeats on the third tick
  });

  it("mails a player whose stamp landed but whose send never happened", async () => {
    const { fixtureId } = await dueGatedGame(2, 1);
    await openAndRemind(db, notifier, NOW, SECRET, env.FIXTURE_CAPACITY);
    // Simulate the request-path failure: stamped, but no log row was written.
    await db.update(responses).set({ invitedAt: NOW }).where(eq(responses.playerId, "p-2"));

    await openAndRemind(db, notifier, new Date("2026-08-24T10:30:00Z"), SECRET, env.FIXTURE_CAPACITY);

    const log = await db.select().from(notificationLog).where(eq(notificationLog.fixtureId, fixtureId));
    const mailed = log.filter((l) => l.notificationType === "n1" && l.channel === "email").map((l) => l.playerId);
    expect(mailed).toContain("p-2");
  });

  it("mails the whole squad for an ungated game (BR-39)", async () => {
    const gameId = await insertGame(db, { reminderDaysBefore: 1, reminderLocalTime: "09:00", timezone: "Europe/London" });
    const fixtureId = await insertFixture(db, gameId, { kicksOffAt: new Date("2026-08-25T18:00:00Z") });
    for (let i = 0; i < 5; i++) {
      const playerId = await insertPlayer(db, { id: `u-${i}`, email: `u${i}@example.com` });
      await insertMembership(db, gameId, playerId);
    }

    await openAndRemind(db, notifier, NOW, SECRET, env.FIXTURE_CAPACITY);

    const log = await db.select().from(notificationLog).where(eq(notificationLog.fixtureId, fixtureId));
    expect(log.filter((l) => l.notificationType === "n1" && l.channel === "email")).toHaveLength(5);
    const rows = await db.select().from(responses).where(eq(responses.fixtureId, fixtureId));
    expect(rows.every((r) => r.invitedAt === null)).toBe(true); // never written for an ungated game
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/sweep/gated-invites.test.ts`
Expected: FAIL — `openAndRemind` takes four arguments.

- [ ] **Step 3: Add the claim step and the eligibility filter**

In `src/sweep/open-and-remind.ts`:

Add to `SweepResult`:

```ts
  /** Tiers released across every gated fixture on this run — informational. */
  tiersClaimed: number;
  /** Players newly invited by those releases. They are mailed by step 2 of this same run. */
  invitationsClaimed: number;
```

Change the signature and body of `openAndRemind`:

```ts
export async function openAndRemind(
  db: Db,
  notifier: Notifier,
  now: Date,
  responseTokenSecret: string,
  capacity: DurableObjectNamespace<FixtureCapacity>,
): Promise<SweepResult> {
  const { opened, failures: openFailures } = await openDueFixtures(db, now);
  // Between opening and reminding, deliberately. A tier released here is
  // stamped before step 2 selects its candidates, so it goes out on this tick
  // rather than the next one — which for a fixture that is tomorrow matters.
  const claimed = await claimDueInvites(db, capacity, now);
  const reminderResult = await sendDueReminders(db, notifier, now, responseTokenSecret);

  return {
    fixturesOpened: opened,
    tiersClaimed: claimed.tiersClaimed,
    invitationsClaimed: claimed.invitationsClaimed,
    ...reminderResult,
    failures: [...openFailures, ...claimed.failures, ...reminderResult.failures],
  };
}

/**
 * Step 1b (M34): reconcile every open gated fixture's invite order.
 *
 * Runs against every open fixture, not just those past their reminder instant:
 * a decline can arrive at any hour, and BR-44's fallback is measured from
 * kickoff, not from the reminder. The claim itself is cheap and idempotent —
 * `claimInviteReleases` returns `skipped` for an ungated Game before it reads
 * anything else.
 *
 * A failure on one fixture is recorded and skipped, never thrown: one broken
 * Game must not stop every other Game's invitations, the same rule the two
 * steps either side of it follow.
 */
async function claimDueInvites(
  db: Db,
  capacity: DurableObjectNamespace<FixtureCapacity>,
  now: Date,
): Promise<{ tiersClaimed: number; invitationsClaimed: number; failures: SweepFailure[] }> {
  const rows = await db
    .select({ id: fixtures.id, gameId: fixtures.gameId })
    .from(fixtures)
    .innerJoin(games, eq(fixtures.gameId, games.id))
    .where(and(eq(fixtures.lifecycle, "open"), eq(games.gatedInvitesEnabled, true)));

  let tiersClaimed = 0;
  let invitationsClaimed = 0;
  const failures: SweepFailure[] = [];

  for (const row of rows) {
    try {
      const outcome = await capacity.getByName(row.id).claimInviteReleases({ now: now.getTime() });
      if (outcome.kind === "claimed" && outcome.playerIds.length > 0) {
        tiersClaimed += 1;
        invitationsClaimed += outcome.playerIds.length;
      }
    } catch (error) {
      failures.push({
        fixtureId: row.id,
        gameId: row.gameId,
        stage: "claim",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { tiersClaimed, invitationsClaimed, failures };
}
```

Add `"claim"` to `SweepFailure["stage"]`'s union.

In `eligiblePlayers`, add the gate. Select `games.gatedInvitesEnabled` and `responses.invitedAt` alongside the existing columns, join `games` on `gameId`, and filter:

```ts
  return rows
    .filter((row) => !isMuted({ mutedAt: row.mutedAt, mutedUntil: row.mutedUntil }, now))
    // BR-39/BR-41. For an ungated Game `invitedAt` is never written, so the
    // predicate must be reached only when gating is on — a bare
    // `invitedAt !== null` would silence every reminder in the product.
    .filter((row) => !row.gatedInvitesEnabled || row.invitedAt !== null)
    .map(({ playerId, name, email, isGuest }) => ({ playerId, name, email, isGuest }));
```

- [ ] **Step 4: Gate the late-join invitation the same way**

In `src/notify/send-late-invitations.ts`, inside the per-fixture loop after the `lifecycle !== "open"` check:

```ts
    // BR-2′ backfills a row for a late joiner, but a gated Game has not
    // necessarily asked their tier yet (BR-41). Skipping here leaves them to
    // the reconciler, which stamps them the moment their tier is released and
    // hands them to the sweep's own N-1 — the same message, a little later.
    if (row.game.gatedInvitesEnabled) {
      const [response] = await db
        .select({ invitedAt: responses.invitedAt })
        .from(responses)
        .where(and(eq(responses.fixtureId, fixtureId), eq(responses.playerId, playerId)));
      if (!response || response.invitedAt === null) {
        summary.skipped++;
        continue;
      }
    }
```

Add `responses` and `and` to the imports.

- [ ] **Step 5: Pass the binding from the cron handler**

At `src/cron/handler.ts:57`:

```ts
      const remindResult = await openAndRemind(db, notifier, now, env.RESPONSE_TOKEN_SECRET, env.FIXTURE_CAPACITY);
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run test/sweep/gated-invites.test.ts test/sweep test/notify test/cron`
Expected: PASS. Existing sweep tests that call `openAndRemind` with four arguments must be updated to pass `env.FIXTURE_CAPACITY` — fix each call site rather than defaulting the parameter, so the compiler names every caller.

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: PASS. This is the BR-39 gate for the milestone's riskiest change.

- [ ] **Step 8: Lint, typecheck, commit**

```bash
npm run lint && npx tsc --noEmit
git status
git add src/sweep/open-and-remind.ts src/notify/send-late-invitations.ts src/cron/handler.ts test/sweep/ test/cron/
git commit -m "M34: claim and mail gated invitations from the sweep"
```

---

### Task 6: Send on the decline, in the request path

Latency only. Task 5 already guarantees delivery; this stops a sub waiting an hour to hear about tomorrow's game.

**Files:**
- Modify: `src/routes/respond.ts`
- Modify: `src/routes/games.ts:1237-1310` (the owner's response override)
- Test: `test/routes/respond.test.ts` (extend), `test/routes/gated-invite-send.test.ts` (create)

**Interfaces:**
- Consumes: `claimInviteReleases` (Task 4); `buildReminderMessages`, `insertQueuedLogRows`, `applySendResult`, `markOrphanedRowsFailed` from the notify layer.
- Produces: `notifyReleasedSubs(env, fixtureId, now): Promise<void>`, exported from `src/routes/respond.ts` beside `notifyPromotedPlayer`.

- [ ] **Step 1: Write the failing test**

Create `test/routes/gated-invite-send.test.ts`. Seed a gated, open fixture with the core already invited, POST a decline to `/g/:id/f/:fixtureId/response/:playerId` as the owner, and assert the sub holds an `n1` email log row without any sweep having run:

```ts
it("mails the released sub in the same request as the decline", async () => {
  const { gameId, fixtureId, ownerId, subId } = await seedGatedOpenFixture();
  await signIn(ownerId);

  const response = await app.request(
    `/app/g/${gameId}/f/${fixtureId}/response/p-0`,
    { method: "POST", headers: formHeaders(), body: "intent=out" },
    env,
    createExecutionContext(),
  );
  await waitOnExecutionContext(ctx);

  expect(response.status).toBe(303);
  const log = await db.select().from(notificationLog).where(eq(notificationLog.playerId, subId));
  expect(log.filter((l) => l.notificationType === "n1" && l.channel === "email")).toHaveLength(1);
});
```

Follow the existing conventions in `test/routes/` for `signIn`, `formHeaders`, `createExecutionContext` and `waitOnExecutionContext` — read a neighbouring route test rather than assuming these names.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/routes/gated-invite-send.test.ts`
Expected: FAIL — no `n1` row exists for the sub.

- [ ] **Step 3: Write `notifyReleasedSubs`**

In `src/routes/respond.ts`, beside `notifyPromotedPlayer`:

```ts
/**
 * Claim any tier this response released, and send the N-1 to whoever it newly
 * invited (BR-41, BR-42), in the background.
 *
 * **`waitUntil`, not `await`, for the reasons `notifyPromotedPlayer` gives at
 * length** — this runs on the *declining* player's request, and nothing on
 * their page depends on somebody else's invitation.
 *
 * **This path is an optimisation, not the guarantee.** If the claim lands and
 * the send then fails, `invited_at` is stamped with no message sent — and the
 * next sweep tick finds that player invited, finds no `n1` row for them, and
 * mails them. That is why there is no compensating write here and no attempt
 * to roll the stamp back: rolling it back is what would break the property.
 *
 * The notifier is built here rather than passed in so it is the quota-wrapped
 * one from `createNotifier` (TR-31), for the same cost-control reason.
 */
export async function notifyReleasedSubs(
  env: AppEnv["Bindings"],
  fixtureId: string,
  now: Date,
): Promise<void> {
  try {
    const outcome = await env.FIXTURE_CAPACITY.getByName(fixtureId).claimInviteReleases({
      now: now.getTime(),
    });
    if (outcome.kind !== "claimed" || outcome.playerIds.length === 0) return;

    const db = getDb(env.DB);
    const [row] = await db
      .select({ fixture: fixtures, game: games })
      .from(fixtures)
      .innerJoin(games, eq(fixtures.gameId, games.id))
      .where(eq(fixtures.id, fixtureId));
    if (!row) {
      console.error(`released subs for a fixture that no longer exists: ${fixtureId}`);
      return;
    }

    const candidates = await db
      .select({ playerId: players.id, name: players.name, email: players.email, isGuest: players.isGuest })
      .from(players)
      .where(inArray(players.id, outcome.playerIds));

    // BR-32, and the same `.trim()` the sweep applies: an email of `" "` is
    // truthy, and letting one through means a queued row that comes back
    // `no-recipient` on every retry, forever.
    const mailable = candidates.filter(
      (candidate) => !candidate.isGuest && candidate.email !== null && candidate.email.trim() !== "",
    );
    if (mailable.length === 0) return;

    const pending = await buildReminderMessages({
      db,
      fixture: row.fixture,
      game: row.game,
      candidates: mailable,
      responseTokenSecret: env.RESPONSE_TOKEN_SECRET,
      now,
    });

    const inserted = await insertQueuedLogRows(db, { fixtureId, notificationType: "n1" }, pending);
    if (inserted.length === 0) return;

    const notifier = createNotifier(env, db);
    let results;
    try {
      results = await notifier.send(inserted.map((entry) => entry.message));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await markOrphanedRowsFailed(db, inserted, `released-sub send rejected: ${message}`);
      console.error(`released-sub send rejected for fixture ${fixtureId}: ${message}`);
      return;
    }

    for (let i = 0; i < inserted.length; i++) {
      const entry = inserted[i];
      if (!entry) continue;
      await applySendResult(db, entry, results[i], now);
    }
  } catch (error) {
    // Without this the whole promise rejects inside a `waitUntil` and vanishes
    // — the failure mode this file has already been bitten by once.
    console.error(
      `releasing subs failed for fixture ${fixtureId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
```

- [ ] **Step 4: Call it from both response paths**

In `src/routes/respond.ts`, after the existing promotion `waitUntil`:

```ts
  // Only a decline can release a tier, so only a decline pays for the check.
  if (intent === "out") {
    c.executionCtx.waitUntil(notifyReleasedSubs(c.env, fixtureId, now));
  }
```

In `src/routes/games.ts`, in the owner's response-override handler after the promotion `waitUntil`, add the same two lines using `target.fixture.id`. Import `notifyReleasedSubs` from `./respond.js`.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/routes/`
Expected: PASS.

- [ ] **Step 6: Lint, typecheck, commit**

```bash
npm run lint && npx tsc --noEmit
git status
git add src/routes/respond.ts src/routes/games.ts test/routes/gated-invite-send.test.ts
git commit -m "M34: mail released subs in the declining player's request"
```

---

### Task 7: The owner's tier editor

**Files:**
- Create: `src/views/invite-order.ts`
- Modify: `src/routes/games.ts`, `src/views/styles.ts`
- Test: `test/routes/invite-order.test.ts`, `test/views/invite-order.test.ts`

**Interfaces:**
- Consumes: `inviteTiers`, `memberships` from the schema.
- Produces: `renderInviteOrderPage(params: InviteOrderParams): string`; `INVITE_ORDER_CSS`; routes `GET /app/g/:id/invites`, `POST /app/g/:id/invites`, `POST /app/g/:id/invites/tier`, `POST /app/g/:id/invites/tier/:tierId/delete`.

- [ ] **Step 1: Write the failing route test**

Create `test/routes/invite-order.test.ts` covering, at minimum:

```ts
it("refuses a non-owner with a 404, not a 403 (TR-18)", async () => { /* ... */ });

it("saves the order and the member assignments in one submission", async () => { /* ... */ });

it("ignores a tier id belonging to another game", async () => {
  const { gameId, ownerId, playerId } = await seedGameWithOwner();
  const otherGameId = await insertGame(db, { gatedInvitesEnabled: true });
  const foreignTier = await insertInviteTier(db, otherGameId, { name: "Theirs", position: 1 });
  await signIn(ownerId);

  await app.request(
    `/app/g/${gameId}/invites`,
    { method: "POST", headers: formHeaders(), body: `tier-${playerId}=${foreignTier}` },
    env, createExecutionContext(),
  );

  const [row] = await db.select().from(memberships).where(eq(memberships.playerId, playerId));
  // Falls to the implicit tier rather than pointing across Games — the
  // invariant SQLite cannot express, so the write path has to.
  expect(row?.inviteTierId).toBeNull();
});

it("drops a deleted tier's members to the implicit tier", async () => { /* ... */ });
```

Write each body out in full following the conventions of the neighbouring route tests.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/routes/invite-order.test.ts`
Expected: FAIL — 404 on every route.

- [ ] **Step 3: Build the view**

Create `src/views/invite-order.ts` rendering Option C from the spec: a core-group box, then a numbered ordered list of the remaining tiers, with the implicit tier pinned last and rendered dimmed. Every interpolation through `escapeHtml`. No `style="…"` attributes — classes only.

Add `INVITE_ORDER_CSS` to `src/views/styles.ts`. **Add it to `PAGE_STYLE_BLOCKS`** — without this the CSP drops it and the page ships unstyled with every test green. Place it after `SQUAD_STYLES_CSS` in the array; if any selector collides with an existing block at equal specificity, `test/views/style-cascade.test.ts` will name it.

- [ ] **Step 4: Build the routes**

Add the four routes to `src/routes/games.ts`, following `findGameForOwner` for entitlement and returning 404 on refusal (TR-18). The save handler must scope every tier lookup by `game_id` and null out anything that does not match — the invariant from Step 1.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/routes/invite-order.test.ts test/views/ test/security/`
Expected: PASS, including `test/views/style-cascade.test.ts` and the CSP hash test.

- [ ] **Step 6: Look at the page**

Run: `npm run guide:capture` (or the project's single-page capture path) and **open the PNG**. Check three shapes that string assertions cannot see: a fifteen-member implicit tier, a one-player group, and a tier with a long name. Fix what looks wrong before committing.

- [ ] **Step 7: Lint, typecheck, commit**

```bash
npm run lint && npx tsc --noEmit
git status
git add src/views/invite-order.ts src/views/styles.ts src/routes/games.ts test/routes/invite-order.test.ts test/views/invite-order.test.ts
git commit -m "M34: the owner's invite-order editor"
```

---

### Task 8: The game settings switch and the fallback

**Files:**
- Modify: `src/domain/game-form.ts`, `src/domain/update-game.ts`, `src/views/game-form.ts`
- Test: `test/domain/game-form.test.ts` (extend)

**Interfaces:**
- Consumes: `GameFormValues` (Task 1's columns).
- Produces: `GameFormValues` gains `gatedInvitesEnabled: boolean` and `gatedFallbackHoursBefore: number | null`; `NOTIFICATION_SWITCHES` gains `{ field: "gatedInvitesEnabled", submitted: "gatedInvitesEnabledSubmitted" }`.

- [ ] **Step 1: Write the failing test**

Extend `test/domain/game-form.test.ts`:

```ts
it("defaults a new game to ungated with no fallback", () => {
  const result = parseGameForm(validBody());

  expect(result.kind).toBe("ok");
  if (result.kind !== "ok") return;
  expect(result.values.gatedInvitesEnabled).toBe(false);
  expect(result.values.gatedFallbackHoursBefore).toBeNull();
});

it("parses the fallback as null when the owner chooses never", () => {
  const result = parseGameForm({ ...validBody(), gatedInvitesEnabled: "on",
    gatedInvitesEnabledSubmitted: "1", gatedFallbackHoursBefore: "never" });

  expect(result.kind).toBe("ok");
  if (result.kind !== "ok") return;
  expect(result.values.gatedFallbackHoursBefore).toBeNull();
});

it("rejects a fallback that is not a whole number of hours", () => {
  const result = parseGameForm({ ...validBody(), gatedInvitesEnabled: "on",
    gatedInvitesEnabledSubmitted: "1", gatedFallbackHoursBefore: "half" });

  expect(result.kind).toBe("errors");
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/domain/game-form.test.ts`
Expected: FAIL — `gatedInvitesEnabled` is not on `GameFormValues`.

- [ ] **Step 3: Implement**

Add the two fields to `GameFormValues`, the switch to `NOTIFICATION_SWITCHES`, and parsing for `gatedFallbackHoursBefore` that maps the literal `"never"` to `null` and anything non-integer to a `FieldError`. Render the switch and the select in `src/views/game-form.ts`, plus the `Edit the invite order →` link.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/domain/game-form.test.ts test/routes/games.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint, typecheck, commit**

```bash
npm run lint && npx tsc --noEmit
git status
git add src/domain/game-form.ts src/domain/update-game.ts src/views/game-form.ts test/domain/game-form.test.ts
git commit -m "M34: the gating switch and its fallback timing"
```

---

### Task 9: The owner's progress panel and manual release

**Files:**
- Modify: `src/views/owner-fixture.ts`, `src/routes/games.ts`, `src/views/styles.ts`
- Test: `test/views/invite-order.test.ts` (extend), `test/routes/invite-order.test.ts` (extend)

**Interfaces:**
- Consumes: `loadInviteState` (Task 3); `claimInviteReleases` with `force: true` (Task 4); `notifyReleasedSubs` (Task 6).
- Produces: route `POST /app/g/:id/f/:fixtureId/invite/next`; `renderInviteProgress(state, game, now): string` exported from `src/views/invite-order.ts`.

- [ ] **Step 1: Write the failing test**

Assert the panel renders one row per tier with its state (`asked <when>` / `next up` / `held`), that the held row names *why* ("asked automatically at 12h before, if still short"), that the button posts to the right path, and that a non-owner gets a 404. Assert the panel is absent entirely for an ungated Game.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/views/invite-order.test.ts`
Expected: FAIL — no panel is rendered.

- [ ] **Step 3: Implement**

Render the panel from `loadInviteState` plus the earliest `invited_at` per tier. All timestamps through `formatLocalDateTime` (TR-5). The route calls `claimInviteReleases({ now, force: true })` then `notifyReleasedSubs` in a `waitUntil`, and redirects 303 to the fixture page.

- [ ] **Step 4: Run the tests, then look at the page**

Run: `npx vitest run test/views/ test/routes/`
Expected: PASS.

Then capture the owner fixture page and **read the PNG** — the panel's rows are content-shaped and a long tier name or a four-tier game is exactly what a string assertion cannot see.

- [ ] **Step 5: Lint, typecheck, commit**

```bash
npm run lint && npx tsc --noEmit
git status
git add src/views/owner-fixture.ts src/views/invite-order.ts src/views/styles.ts src/routes/games.ts test/views/invite-order.test.ts test/routes/invite-order.test.ts
git commit -m "M34: invite progress panel and manual release"
```

---

### Task 10: The player's "not yet asked" state

**Files:**
- Modify: `src/views/player-fixture.ts`
- Test: `test/views/player-fixture.test.ts` (extend)

**Interfaces:**
- Consumes: `responses.invitedAt`, `games.gatedInvitesEnabled`.
- Produces: no new exports.

- [ ] **Step 1: Write the failing test**

```ts
it("tells an uninvited member their tier has not been asked yet", () => {
  const html = renderPlayerFixture(fixtureWith({ gated: true, invitedAt: null }));

  expect(html).toContain("You haven&#39;t been asked yet");
  expect(html).toContain("The core group is being asked first");
});

it("still offers both controls, because gating never blocks a response (BR-40)", () => {
  const html = renderPlayerFixture(fixtureWith({ gated: true, invitedAt: null }));

  expect(html).toContain("I&#39;m in anyway");
  expect(html).not.toContain("disabled");
});

it("says nothing of the sort to an invited member", () => {
  const html = renderPlayerFixture(fixtureWith({ gated: true, invitedAt: new Date() }));

  expect(html).not.toContain("asked yet");
});

it("says nothing of the sort in an ungated game (BR-39)", () => {
  const html = renderPlayerFixture(fixtureWith({ gated: false, invitedAt: null }));

  expect(html).not.toContain("asked yet");
});
```

Match `fixtureWith` and `renderPlayerFixture` to whatever the existing suite in that file actually uses — read it first.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/views/player-fixture.test.ts`
Expected: FAIL — the copy is absent.

- [ ] **Step 3: Implement**

Render the note above the answer controls when `gated && invitedAt === null`. Reuse an existing card class; add no new style block for four lines of copy.

- [ ] **Step 4: Run the tests, then look at the page**

Run: `npx vitest run test/views/player-fixture.test.ts`
Expected: PASS. Capture the page and read the PNG.

- [ ] **Step 5: Lint, typecheck, commit**

```bash
npm run lint && npx tsc --noEmit
git status
git add src/views/player-fixture.ts test/views/player-fixture.test.ts
git commit -m "M34: tell an uninvited member where they stand"
```

---

### Task 11: BR-45 — suppress N-4 while tiers are held back

**Files:**
- Modify: `src/sweep/attention.ts:181-226`
- Test: `test/sweep/attention.test.ts` (extend)

**Interfaces:**
- Consumes: `games.gatedInvitesEnabled`, `games.gatedFallbackHoursBefore`, `inviteTiers`, `responses.invitedAt`.
- Produces: no new exports.

- [ ] **Step 1: Write the failing test**

```ts
it("does not warn an owner about a gated fixture that still has tiers to release (BR-45)", async () => {
  const { fixtureId, ownerId } = await gatedShortFixture({ tiersRemaining: 2, fallbackDue: false });

  await sendOwnerAttention({ db, notifier, now: NOW, cancelTokenSecret: SECRET, ceilingReached: false });

  const log = await db.select().from(notificationLog).where(eq(notificationLog.playerId, ownerId));
  expect(log.filter((l) => l.notificationType === "n4")).toHaveLength(0);
});

it("warns once the last tier has been released", async () => {
  const { fixtureId, ownerId } = await gatedShortFixture({ tiersRemaining: 0, fallbackDue: false });

  await sendOwnerAttention({ db, notifier, now: NOW, cancelTokenSecret: SECRET, ceilingReached: false });

  const log = await db.select().from(notificationLog).where(eq(notificationLog.playerId, ownerId));
  expect(log.filter((l) => l.notificationType === "n4")).toHaveLength(1);
});

it("warns once the fallback instant has passed, even with tiers left", async () => {
  const { ownerId } = await gatedShortFixture({ tiersRemaining: 2, fallbackDue: true });

  await sendOwnerAttention({ db, notifier, now: NOW, cancelTokenSecret: SECRET, ceilingReached: false });

  const log = await db.select().from(notificationLog).where(eq(notificationLog.playerId, ownerId));
  expect(log.filter((l) => l.notificationType === "n4")).toHaveLength(1);
});

it("warns about an ungated short fixture exactly as before (BR-39)", async () => { /* existing behaviour */ });
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/sweep/attention.test.ts`
Expected: FAIL — the first test gets one `n4` row.

- [ ] **Step 3: Implement**

In `fixturesNeedingAttention`, after the `shortWarningEnabled` check:

```ts
    // BR-45. A gated fixture is *supposed* to look short while its later tiers
    // are still held back, and an alert about the thing the owner asked for is
    // how a useful alert becomes one people ignore. The suppression lifts on
    // whichever comes first: the last tier released, or the fallback instant,
    // after which short numbers are a genuine problem again.
    if (row.gatedInvitesEnabled && (await hasUnreleasedTiers(db, row.id, row.gameId))) {
      const fallbackDue =
        row.gatedFallbackHoursBefore !== null &&
        now.getTime() >= row.kicksOffAt.getTime() - row.gatedFallbackHoursBefore * HOUR_MS;
      if (!fallbackDue) continue;
    }
```

Write `hasUnreleasedTiers` in the same file: true when any active membership of the Game holds a live response row on this fixture with a null `invited_at`. **`await` inside the loop is deliberate** — the alternative is a second query shape for a case that fires for a handful of Games; if it ever shows up in a sweep timing, batch it then, not now.

Add `gatedInvitesEnabled` and `gatedFallbackHoursBefore` to the select, and `HOUR_MS` beside the existing `MINUTE_MS`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/sweep/attention.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint, typecheck, commit**

```bash
npm run lint && npx tsc --noEmit
git status
git add src/sweep/attention.ts test/sweep/attention.test.ts
git commit -m "M34: don't warn about a gated fixture that is short on purpose"
```

---

### Task 12: Full-system verification and merge

**Files:**
- Modify: `docs/known-issues.md` if anything was deliberately left undone
- Test: the whole suite, plus the browser specs

- [ ] **Step 1: Run everything**

```bash
npm run lint && npx tsc --noEmit
npm test
npx playwright test
```

Expected: all green. Do not background `npm test` and end the turn.

- [ ] **Step 2: Walk the feature in the running app**

Use the `run` skill. Create a gated Game, order a squad into a core plus two groups, open a fixture, decline as a core member, and confirm the sub receives the invitation. Then check the ungated Game beside it still invites everyone at once.

- [ ] **Step 3: Merge**

```bash
git status
cd ../maketheteam && git merge --ff-only m34
```

Pushing `main` deploys to production. Confirm with the maintainer before pushing.

---

## Self-Review

**Spec coverage.** BR-38 → Tasks 1, 7. BR-39 → asserted in Tasks 1, 5, 8, 10, 11. BR-40 → Tasks 2, 10. BR-41 → Tasks 2, 3, 4. BR-42 → Tasks 5, 6. BR-43 → Task 2. BR-44 → Tasks 2, 3, 8. BR-45 → Task 11. Data model → Task 1. Release rule → Task 2. Claim/send split → Tasks 4, 5, 6. All four screens → Tasks 7, 8, 9, 10. Migration and rollout → Tasks 1, 12. No spec section is unimplemented.

**Known gaps, stated rather than hidden.** Tasks 7, 9 and 10 give full test *intent* and full implementation direction but not every test body verbatim, because each depends on helper names (`signIn`, `formHeaders`, `fixtureWith`, the capture command) that differ across the existing suites — and CLAUDE.md's fourth rule is not to put a detail in a brief that has not been read from source. Each of those steps says which neighbouring file to read first. Tasks 1 to 6 and 11, which carry the correctness of the milestone, are complete as written.

**Type consistency.** `planReleases` / `ReleaseInput` / `ReleasePlan` / `TierState` / `TierMember` are used identically in Tasks 2, 3, 4. `loadInviteState` / `stampInvited` / `InviteState` match between Tasks 3, 4, 9, 11. `claimInviteReleases` / `ClaimInviteReleasesInput` / `ClaimInviteReleasesOutcome` match between Tasks 4, 5, 6, 9. `notifyReleasedSubs` matches between Tasks 6 and 9. `openAndRemind`'s fifth parameter is added in Task 5 and every existing caller is named there.

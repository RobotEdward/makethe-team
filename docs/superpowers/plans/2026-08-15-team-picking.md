# Team Picking (BR-35) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An organiser splits an open fixture's confirmed players into two named sides, publishes them, and everyone playing is emailed and can see which side they are on.

**Architecture:** A team assignment is a nullable `team` column on `responses` — the row that already *is* the (fixture, player) pair, guests included. Team names live on `games`; `fixtures.teams_published_at` records whether the current pick has been announced. Staleness after a late drop-out is derived from the response rows, never stored, so nothing in this milestone writes to `FixtureCapacity`, `removeMember`, `setResponse` or `withdrawMember`.

**Tech Stack:** Cloudflare Workers, Hono, D1 + Drizzle, Durable Objects, Better Auth. Vitest via `@cloudflare/vitest-pool-workers` (runs inside workerd); Playwright against `wrangler dev`.

**Spec:** `docs/superpowers/specs/2026-08-15-team-picking-design.md`. Read it before Task 1 — it carries the reasoning this plan only implements.

## Global Constraints

- **Nothing in this milestone writes to `FixtureCapacity`, `removeMember`, `setResponse` or `withdrawMember`.** A team assignment must never affect capacity accounting. If a task seems to need one of those, stop and report rather than reaching for it.
- **A departed player's `team` value is deliberately never cleared.** The orphaned value is the only signal that published teams no longer match the squad. Code that "tidies" it is deleting the feature.
- **The picker works with JavaScript disabled.** Every row is a radio group in one form; the script is an enhancement that moves radio state. Save must behave identically either way.
- **Only `in` players appear in the picker.** A waitlisted player has no place yet, and offering one would promise it.
- **Saving a partial pick is allowed; publishing one is refused**, naming who is unassigned, rendered on the page rather than as a bare error.
- Team names default to exactly `Team A` and `Team B`.
- **Never message a guest** (BR-32). Guests can be put on a side; they are never sent N-9.
- `new Date()` with no arguments is banned by an eslint rule (`no-restricted-syntax` in `eslint.config.js`). Domain code takes `now: Date`; `new Date(Date.now())` at a route or cron edge is the permitted form.
- Pages are server-rendered; the only script is the one Task 7 adds, via `PAGE_SCRIPT_BLOCKS` so the CSP hashes it from source.
- **Run test suites in the foreground.** Backgrounding `npx playwright test` has stalled several previous implementers indefinitely.
- Commands: `npm test`, `npx playwright test`, `npm run lint`, `npm run typecheck`, `npm run db:generate`, `npm run db:migrate:local`.

---

### Task 1: Columns, team names, and the game form

**Files:**
- Modify: `src/db/schema.ts` (`responses`, `fixtures`, `games`)
- Create: `migrations/0010_*.sql` (generated — do not hand-write)
- Modify: `src/domain/game-form.ts`, `src/views/game-form.ts`
- Test: `test/domain/game-form.test.ts` (extend)

**Interfaces:**
- Produces: `responses.team` (`'a' | 'b'`, nullable), `fixtures.teamsPublishedAt` (nullable timestamp), `games.teamAName` / `games.teamBName` (non-null, defaulting to `Team A` / `Team B`), and both names parsed and rendered by the game form.

- [ ] **Step 1: Write the failing tests**

Extend `test/domain/game-form.test.ts` — read it first for the shape its existing cases use:

```ts
it("defaults the team names when the form omits them", () => {
  const result = parseGameForm({ ...validValues(), teamAName: "", teamBName: "" });
  expect(result.kind).toBe("ok");
  if (result.kind !== "ok") return;
  expect(result.values.teamAName).toBe("Team A");
  expect(result.values.teamBName).toBe("Team B");
});

it("keeps the names an organiser chose", () => {
  const result = parseGameForm({ ...validValues(), teamAName: "Bibs", teamBName: "Skins" });
  expect(result.kind).toBe("ok");
  if (result.kind !== "ok") return;
  expect(result.values.teamAName).toBe("Bibs");
  expect(result.values.teamBName).toBe("Skins");
});

// Names reach an email subject line and a page heading, so an unbounded
// string is a layout problem as well as a storage one.
it("rejects a team name longer than 40 characters", () => {
  const result = parseGameForm({ ...validValues(), teamAName: "x".repeat(41) });
  expect(result.kind).toBe("error");
});
```

Match `validValues()` to whatever helper that file already uses; if it has none, build the values object inline the way its existing tests do.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run test/domain/game-form.test.ts`
Expected: FAIL — `teamAName` is not on the parsed values.

- [ ] **Step 3: Add the three schema changes**

In `src/db/schema.ts`, in the `responses` table, after `source`:

```ts
    /**
     * Which side this player is on for this fixture (BR-35, M9). Null until an
     * organiser picks teams.
     *
     * On `responses` rather than a table of its own because this row already
     * *is* the (fixture, player) pair an assignment hangs off — guests
     * included, since `addGuest` writes one — and an assignment should die
     * with the response it belongs to.
     *
     * **Deliberately not cleared when a player leaves.** A row whose `team` is
     * set but whose `status` is no longer `in` is the only signal that the
     * published teams no longer match the squad (spec §3.1). Clearing it here,
     * or in `withdrawMember`, deletes that signal. It also means a player who
     * drops out and comes back is back on their old side, with no special case.
     */
    team: text("team", { enum: ["a", "b"] }),
```

In `fixtures`, after `openedAt`:

```ts
    /**
     * When the current pick was announced (BR-35, M9), or null.
     *
     * Saving assignments clears it and publishing sets it, so "the organiser
     * has changed the teams and not told anyone" is a state the data states
     * outright rather than one that has to be inferred.
     */
    teamsPublishedAt: integer("teams_published_at", { mode: "timestamp_ms" }),
```

In `games`, after `squadVisibleToPlayers`:

```ts
  /**
   * What this game calls its two sides (BR-35, M9). Game-level, not
   * per-fixture: a game that plays Bibs against Skins plays it every week, and
   * a per-fixture override is a field nobody would use twice.
   */
  teamAName: text("team_a_name").notNull().default("Team A"),
  teamBName: text("team_b_name").notNull().default("Team B"),
```

- [ ] **Step 4: Generate and apply the migration**

Run: `npm run db:generate`
Expected: `migrations/0010_<name>.sql` with exactly four `ALTER TABLE` statements — two on `games`, one on `responses`, one on `fixtures`. If it proposes anything else, STOP and report: that means the schema and migrations had already drifted.

Then: `npm run db:migrate:local`

- [ ] **Step 5: Parse and render the names**

In `src/domain/game-form.ts`, add `teamAName` and `teamBName` to the parsed values. Both trim; both fall back to `Team A` / `Team B` when empty or absent; both reject over 40 characters with the same error shape the other fields use. Read the file's existing validation to match it rather than inventing a second style.

In `src/views/game-form.ts`, add two text inputs beside the `squadVisibleToPlayers` checkbox, using the existing `field(...)` helper, labelled so an organiser understands they name the two sides of a picked team.

- [ ] **Step 6: Run and commit**

```bash
npx vitest run test/domain/game-form.test.ts
npm test && npm run lint && npm run typecheck
git add src/db/schema.ts src/domain/game-form.ts src/views/game-form.ts migrations/ test/domain/game-form.test.ts
git commit -m "feat: add team columns and owner-set team names (BR-35)"
```

---

### Task 2: The team domain module

Every question about teams, answered by pure functions in one place, so the picker, the publish guard, the player view and the email cannot disagree.

**Files:**
- Create: `src/domain/teams.ts`
- Modify: `src/db/queries.ts` (add `listTeamAssignments`, extend `SquadMember` and `getFixtureWithSquad`)
- Test: `test/domain/teams.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const TEAM_IDS = ["a", "b"] as const;
  export type TeamId = (typeof TEAM_IDS)[number];
  export function isTeamId(value: unknown): value is TeamId;

  /** The minimum a staleness or counting question needs about one response row. */
  export interface TeamAssignment {
    playerId: string;
    status: ResponseStatus;
    team: TeamId | null;
  }

  export function unassignedIn(rows: readonly TeamAssignment[]): readonly TeamAssignment[];
  export function assignedButNotIn(rows: readonly TeamAssignment[]): readonly TeamAssignment[];
  export function teamsNeedAnotherLook(rows: readonly TeamAssignment[]): boolean;
  export function sideCounts(rows: readonly TeamAssignment[]): { a: number; b: number };
  export function teamNames(game: { teamAName: string; teamBName: string }): Record<TeamId, string>;
  ```
- Also produces `listTeamAssignments(db, fixtureId): Promise<TeamAssignment[]>` in `src/db/queries.ts`, and `team: TeamId | null` added to `SquadMember` and selected by `getFixtureWithSquad`.

**⚠️ The single most important thing in this task.** `getFixtureWithSquad` filters out `status = 'withdrawn'` rows. Leaving a game (M7a), being removed by an organiser (J6a) and being erased (M7b) **all** write `withdrawn`. So the staleness check must NOT read its rows from `getFixtureWithSquad` — doing so would miss the most common way teams go stale, and the bug would be invisible in any test that only drops players to `out`. `listTeamAssignments` exists for exactly this reason and must include withdrawn rows.

- [ ] **Step 1: Write the failing tests**

Create `test/domain/teams.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  assignedButNotIn,
  sideCounts,
  teamNames,
  teamsNeedAnotherLook,
  unassignedIn,
  type TeamAssignment,
} from "../../src/domain/teams.js";

const row = (over: Partial<TeamAssignment> = {}): TeamAssignment => ({
  playerId: crypto.randomUUID(),
  status: "in",
  team: "a",
  ...over,
});

describe("teamsNeedAnotherLook", () => {
  it("is false for a complete, current pick", () => {
    expect(teamsNeedAnotherLook([row({ team: "a" }), row({ team: "b" })])).toBe(false);
  });

  // Condition 1: a waitlist promotion or a new guest arrived after the pick.
  it("is true when someone is in with no side", () => {
    expect(teamsNeedAnotherLook([row({ team: "a" }), row({ team: null })])).toBe(true);
  });

  // Condition 2, the ordinary drop-out.
  it("is true when someone has a side but answered out", () => {
    expect(teamsNeedAnotherLook([row({ team: "a" }), row({ team: "b", status: "out" })])).toBe(true);
  });

  // Condition 2, the case a filtered query would miss. Leaving a game,
  // being removed by an organiser, and being erased ALL write `withdrawn`,
  // so this is the most common way teams go stale — not an edge case.
  it("is true when someone has a side but was withdrawn", () => {
    expect(teamsNeedAnotherLook([row({ team: "a" }), row({ team: "b", status: "withdrawn" })])).toBe(true);
  });

  // A waitlisted player is not offered a side, so their absence from one is
  // not a change to react to.
  it("is false when a waitlisted player has no side", () => {
    expect(teamsNeedAnotherLook([row({ team: "a" }), row({ team: null, status: "waitlisted" })])).toBe(false);
  });

  it("is false for a fixture nobody has picked at all", () => {
    expect(teamsNeedAnotherLook([row({ team: null }), row({ team: null })])).toBe(false);
  });
});

describe("unassignedIn", () => {
  it("returns only in players with no side", () => {
    const waiting = row({ team: null, status: "waitlisted" });
    const needed = row({ team: null });
    expect(unassignedIn([row(), needed, waiting]).map((r) => r.playerId)).toEqual([needed.playerId]);
  });
});

describe("assignedButNotIn", () => {
  it("includes withdrawn as well as out", () => {
    const gone = row({ team: "a", status: "withdrawn" });
    const dropped = row({ team: "b", status: "out" });
    expect(assignedButNotIn([row(), gone, dropped]).map((r) => r.playerId).sort()).toEqual(
      [gone.playerId, dropped.playerId].sort(),
    );
  });
});

describe("sideCounts", () => {
  // Only `in` players count. A withdrawn player keeps their team value, and
  // counting them would report a side that is one bigger than turns up.
  it("counts only players who are in", () => {
    expect(
      sideCounts([row({ team: "a" }), row({ team: "a", status: "withdrawn" }), row({ team: "b" })]),
    ).toEqual({ a: 1, b: 1 });
  });
});

describe("teamNames", () => {
  it("maps each side to the game's name for it", () => {
    expect(teamNames({ teamAName: "Bibs", teamBName: "Skins" })).toEqual({ a: "Bibs", b: "Skins" });
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run test/domain/teams.test.ts`
Expected: FAIL — cannot resolve `src/domain/teams.js`.

- [ ] **Step 3: Write the module**

Create `src/domain/teams.ts`. Implement the interfaces above as pure functions with no I/O and no clock. The module doc comment must state the two staleness conditions and why a departed player's `team` is left in place — the same reasoning as the schema comment, because this is the file a reader will open when they wonder what that column is for.

`sideCounts` counts only `status === "in"`. `unassignedIn` returns rows with `status === "in"` and `team === null`. `assignedButNotIn` returns rows with `team !== null` and `status !== "in"`. `teamsNeedAnotherLook` is true when either of the latter two is non-empty.

- [ ] **Step 4: Add the query and widen the squad type**

In `src/db/queries.ts`:

```ts
/**
 * Every response row's team assignment for one fixture, **including
 * `withdrawn` ones** (BR-35, M9).
 *
 * That inclusion is the whole reason this exists rather than reusing
 * `getFixtureWithSquad`, which filters `withdrawn` out. Leaving a game (M7a),
 * being removed by an organiser (J6a) and being erased (M7b) all write
 * `withdrawn` — so a staleness check built on the filtered set would miss the
 * most common way published teams stop matching the squad, and would look
 * correct in any test that only drops players to `out`.
 */
export async function listTeamAssignments(db: Db, fixtureId: string): Promise<TeamAssignment[]> {
  return db
    .select({ playerId: responses.playerId, status: responses.status, team: responses.team })
    .from(responses)
    .where(eq(responses.fixtureId, fixtureId));
}
```

Add `team: TeamId | null` to the `SquadMember` interface with a short comment, and select `responses.team` in `getFixtureWithSquad`'s row query so the picker and the player view both have it.

- [ ] **Step 5: Run and commit**

```bash
npx vitest run test/domain/teams.test.ts
npm test && npm run lint && npm run typecheck
git add src/domain/teams.ts src/db/queries.ts test/domain/teams.test.ts
git commit -m "feat: add the team domain module and its unfiltered query (BR-35)"
```

---

### Task 3: The picker, and saving a pick

**Files:**
- Create: `src/views/team-picker.ts`
- Modify: `src/routes/games.ts` (one new POST), `src/auth/paths.ts`, `src/views/owner-fixture.ts`, `src/domain/audit.ts`
- Test: `test/routes/team-picker.test.ts`

**Interfaces:**
- Consumes: everything from Task 2.
- Produces: `ownerTeamsPath(gameId, fixtureId)` → `/g/:gameId/f/:fixtureId/teams` in `src/auth/paths.ts`; `renderTeamPicker(params)` in `src/views/team-picker.ts`; the audit action `fixture.teams_saved`.

- [ ] **Step 1: Add the path and the audit action**

In `src/auth/paths.ts`, beside `ownerGuestPath`:

```ts
/** Where the team picker's Save posts (BR-35 §4). */
export function ownerTeamsPath(gameId: string, fixtureId: string): string {
  return `/g/${gameId}/f/${fixtureId}/teams`;
}
```

In `src/domain/audit.ts`, add to `AUDIT_ACTIONS`:

```ts
  // M9 (BR-35). Who put someone on which side is exactly the question an audit
  // trail exists to answer, and both actions are organiser actions on a
  // fixture (BR-27). Saving and publishing are separate because only one of
  // them emails anybody.
  "fixture.teams_saved",
  "fixture.teams_published",
```

- [ ] **Step 2: Write the failing tests**

Create `test/routes/team-picker.test.ts`. Model the signed-in owner setup on `test/routes/games.test.ts` — read it first. Cover:

1. The picker renders on an `open` fixture, listing each `in` player with two radio inputs whose `name` is the player id and whose values are `a` and `b`.
2. A waitlisted player does **not** appear in the picker.
3. Posting assignments writes `responses.team` for each named player.
4. Posting assignments sets `teams_published_at` back to `NULL` on a fixture that had it set.
5. Posting writes exactly one `fixture.teams_saved` audit row.
6. A partial pick saves — a player left unassigned keeps `team` null and the request still succeeds.
7. The picker is not rendered, and the POST is refused, on a `scheduled`, `played` and `cancelled` fixture.
8. A signed-in player who is not an organiser of the game gets 404 from the POST.
9. A cross-origin `Origin` header gets 403.

- [ ] **Step 3: Write the view**

Create `src/views/team-picker.ts`. One exported `renderTeamPicker(params)` returning a fragment (not a whole page) that `owner-fixture.ts` embeds, since the picker lives on the fixture page.

```ts
export interface TeamPickerParams {
  gameId: string;
  fixtureId: string;
  /** From `teamNames(game)` — the labels for the two columns. */
  names: Record<TeamId, string>;
  /** Only `in` players, in the order the squad list shows them. */
  members: readonly { playerId: string; name: string; erasedAt: Date | null; isGuest: boolean; team: TeamId | null }[];
  counts: { a: number; b: number };
  /** True when the game prefers even numbers and the sides are uneven. */
  uneven: boolean;
  /** Set when a publish was refused: the names with no side yet. */
  unassignedProblem?: readonly string[];
}
```

Markup requirements:
- One `<form method="post" action="${ownerTeamsPath(...)}">` wrapping everything, with a single Save button.
- One row per member: the name, and a radio group named exactly the player id with values `a` and `b`, plus an "unassigned" radio (value `""`) so a partial pick is expressible without JavaScript. Mark the current assignment `checked`.
- Names go through `displayName(member.name, member.erasedAt)`, never `member.name` — an erased player who played is a live case on any squad list (BR-34 §4).
- Each side's heading shows its name and its count.
- When `uneven`, one line saying the sides are uneven. Wording is yours; keep it neutral, since BR-29 makes parity advisory.
- No `<script>` and no inline event handlers — Task 7 adds the script separately.

- [ ] **Step 4: Write the route**

In `src/routes/games.ts`, add `POST /g/:gameId/f/:fixtureId/teams` beside the existing guest and response routes, reusing whatever helper those use to establish that the viewer owns the game (read them; do not write a second entitlement check).

The handler must:
- Apply the same `Origin` check the sibling routes use.
- Refuse on a fixture that is not `open`, via the same predicate the other controls gate on.
- Read the form, accepting only keys that are player ids of currently-`in` members of this fixture, and only values `a`, `b` or `""`. **Anything else is ignored, not an error** — a stale form from a player who has since dropped out must not 500.
- Write the assignments and set `teamsPublishedAt: null` in one `db.batch()` with the `fixture.teams_saved` audit row.
- Redirect 303 back to the owner fixture page.

- [ ] **Step 5: Embed it in the fixture page**

In `src/views/owner-fixture.ts`, render the picker below the squad, gated on the existing `takingChanges(view)` predicate. On a fixture that is not taking changes, render the teams read-only instead (names and sides, no form) when any assignment exists, and nothing at all when none does.

- [ ] **Step 6: Run and commit**

```bash
npx vitest run test/routes/team-picker.test.ts
npm test && npm run lint && npm run typecheck
git add src/views/team-picker.ts src/routes/games.ts src/auth/paths.ts src/views/owner-fixture.ts src/domain/audit.ts test/routes/team-picker.test.ts
git commit -m "feat: add the team picker and saving a pick (BR-35)"
```

---

### Task 4: N-9, the teams-published email

**Files:**
- Modify: `src/notify/dedupe-key.ts`
- Create: `src/notify/templates/teams.ts`, `src/notify/send-teams.ts`
- Test: `test/notify/send-teams.test.ts`

**Interfaces:**
- Produces: `teamsKey(fixtureId, playerId, publishedAt)` → `` `n9:${fixtureId}:${playerId}:${publishedAt}` ``; `renderTeamsEmail(params)`; `sendTeamsEmails(params): Promise<TeamsSendResult>`.

**Read `src/notify/send-promotion.ts` and `src/notify/send-welcome.ts` first.** This sender is closer to the promotion one because it sends to many recipients at once; follow its batching, its `insertQueuedLogRows` call, and its `applySendResult` handling rather than inventing a variant.

- [ ] **Step 1: Add the type and key**

`NOTIFICATION_TYPES` gains `"n9"`. Then:

```ts
/**
 * N-9 teams published: once per player per publish (BR-35, M9).
 *
 * `publishedAt` is load-bearing, as in N-2 and N-8. Re-publishing after a late
 * drop-out must genuinely re-send — that is the entire point of the organiser
 * being asked to publish again — and a key without the timestamp would be
 * swallowed by the unique index on `notification_log.dedupe_key`, leaving the
 * squad holding an email describing teams that have since changed.
 */
export function teamsKey(fixtureId: string, playerId: string, publishedAt: string): string {
  return `n9:${fixtureId}:${playerId}:${publishedAt}`;
}
```

- [ ] **Step 2: Write the template**

Create `src/notify/templates/teams.ts`, modelled on `src/notify/templates/promotion.ts`.

```ts
export interface TeamsEmailParams {
  playerName: string;
  gameName: string;
  whenLocal: string;
  venueName: string;
  /** The recipient's own side, by name. Always shown. */
  yourSideName: string;
  /**
   * Both line-ups, or null when the game hides its squad from players
   * (BR-33). Null renders the recipient's own side and nothing else — never
   * an empty list, which would read as "nobody else is playing".
   */
  lineUps: { name: string; players: readonly string[] }[] | null;
  leaveUrl: string;
}
```

The recipient's own side comes first and is stated plainly — that is the one thing every recipient must get from this message. It carries a leave link like every other game-scoped notification (BR-22).

- [ ] **Step 3: Write the sender**

Create `src/notify/send-teams.ts`. It takes the fixture, the publish instant, and the quota-wrapped notifier, and sends one message per `in` player **with a usable address**.

Guests are skipped before a message is built and before any row is written — copy `send-welcome.ts`'s guard exactly, including its `.trim()`, since an address of `" "` is truthy.

BR-33 is applied here, once: if the game hides its squad, `lineUps` is `null` for every recipient. A player's own side is always named regardless.

- [ ] **Step 4: Write the tests**

`test/notify/send-teams.test.ts` covering: one `n9` row per eligible player with the fixture id set; guests skipped with no row; a second publish at a different instant sending again rather than returning `already-logged`; a squad-hidden game producing a message that names the recipient's own side and does not contain the other side's player names; and the daily-ceiling deferral path.

- [ ] **Step 5: Run and commit**

```bash
npx vitest run test/notify/send-teams.test.ts
npm test && npm run lint && npm run typecheck
git add src/notify/ test/notify/send-teams.test.ts
git commit -m "feat: add N-9, the teams-published email (BR-35)"
```

---

### Task 5: Publishing

**Files:**
- Modify: `src/routes/games.ts`, `src/auth/paths.ts`, `src/views/team-picker.ts`
- Test: `test/routes/team-publish.test.ts`

**Interfaces:**
- Consumes: `sendTeamsEmails` (Task 4), `unassignedIn`, `teamsNeedAnotherLook` (Task 2).
- Produces: `ownerTeamsPublishPath(gameId, fixtureId)` → `/g/:gameId/f/:fixtureId/teams/publish`.

- [ ] **Step 1: Write the failing tests**

Create `test/routes/team-publish.test.ts` covering:

1. Publishing a complete pick sets `teams_published_at` and writes one `fixture.teams_published` audit row.
2. Publishing sends one N-9 per `in` player with an address, and none to a guest.
3. **Publishing a partial pick is refused**: `teams_published_at` stays null, no email is sent, and the response body names each unassigned player.
4. Publishing twice, with a save in between, sends a second round of emails — assert the two dedupe keys differ.
5. Publishing is refused on a fixture that is not `open`.
6. A non-organiser gets 404; a cross-origin `Origin` gets 403.

- [ ] **Step 2: Write the route**

`POST /g/:gameId/f/:fixtureId/teams/publish`, beside the save route and using the same entitlement helper and `Origin` check.

Order matters and should be commented: check entitlement, check the fixture is open, then call `unassignedIn(await listTeamAssignments(db, fixtureId))`. If it is non-empty, re-render the fixture page at 422 with the names — the same shape `renderDashboard(c, problem)` uses for its refusal, never a bare error page.

Otherwise set `teamsPublishedAt: now` in a `db.batch()` with the audit row, then send. Use `c.executionCtx.waitUntil` for the send, matching how the dashboard sends its promotion emails: no correctness property depends on delivery, and a slow provider must not hold up the redirect.

Then 303 back to the fixture page.

- [ ] **Step 3: Add the publish control and the staleness prompt**

In `src/views/team-picker.ts`, add a Publish button in its own form posting to `ownerTeamsPublishPath`, and — when `teamsNeedAnotherLook` is true — a line above it saying the teams have changed since they were last sent out and asking whether to send again. When `teamsPublishedAt` is null and no assignment exists, neither appears.

- [ ] **Step 4: Run and commit**

```bash
npx vitest run test/routes/team-publish.test.ts
npm test && npm run lint && npm run typecheck
git add src/routes/games.ts src/auth/paths.ts src/views/team-picker.ts test/routes/team-publish.test.ts
git commit -m "feat: publish picked teams and email the squad (BR-35)"
```

---

### Task 6: What players see

**Files:**
- Modify: `src/views/fixture.ts`, `src/views/player-game.ts`, `src/routes/respond.ts`
- Test: `test/routes/respond.test.ts` (extend), `test/views/fixture.test.ts` (extend)

**Interfaces:**
- Consumes: `teamNames`, `TeamId` (Task 2); `squadForViewer` (`src/domain/squad-visibility.ts`, M8).

**The rule, from spec §5, and it has two halves that must not be conflated.** A player's own side is **always** visible to them. The other side's names follow BR-33's squad-visibility setting. This is a refinement of BR-33, not an exception: BR-33 governs seeing *other people*, and a player's own assignment is not somebody else's data. Hiding it would make the page contradict the email, and the email cannot be un-sent.

- [ ] **Step 1: Write the failing tests**

Extend `test/routes/respond.test.ts`: a player following their response link to a fixture with published teams sees the name of their own side; in a game with `squadVisibleToPlayers` false they see their own side's name and **not** the other side's player names; and a fixture whose teams have not been published shows no team information at all, even though assignments exist in the database.

That last case is the one most likely to be got wrong and matters most: a saved-but-unpublished pick must be invisible to players, or an organiser cannot try an arrangement without announcing it.

- [ ] **Step 2: Implement**

Show teams on the player-facing fixture view only when `teamsPublishedAt` is non-null. Reuse `squadForViewer` for the other-people question rather than writing a second visibility rule — it is the single decision point M8 built for this, and a second one is how the two drift apart.

- [ ] **Step 3: Run and commit**

```bash
npm test && npm run lint && npm run typecheck
git add src/views/fixture.ts src/views/player-game.ts src/routes/respond.ts test/
git commit -m "feat: show published teams to players, own side always (BR-35)"
```

---

### Task 7: Drag-and-drop, and the browser suite

**Files:**
- Modify: `src/views/scripts.ts`, `src/views/team-picker.ts`, `test/browser/catalogue.spec.ts`, `test/browser/catalogue.ts`, `test/browser/journeys.spec.ts`
- Test: the browser suite

- [ ] **Step 1: Write the script**

Add `TEAM_PICKER_JS` to `src/views/scripts.ts`, following `COPY_INVITE_JS`'s shape exactly: an IIFE, feature-detect and return early, no `fetch` (so `connect-src` is untouched), and no silent `catch`. Add it to `PAGE_SCRIPT_BLOCKS` — the CSP hashes `SCRIPT_BLOCKS` from source, and the existing tripwire fails if it is added in one place and not the other.

Behaviour: make each name draggable, make the two side columns drop targets, and **on drop, set the corresponding radio's `checked` and move the element**. The radios remain the source of truth; the script never posts anything and never disables the form. If anything it needs is missing, it returns and leaves a working radio form behind.

- [ ] **Step 2: Add the catalogue entry**

Register the picker page in `test/browser/catalogue.spec.ts`'s `CONSTANTS` and `ROUTE_TO_ID`, and add its `CATALOGUE` entry, following the `PASSKEYS_PATH` precedent. Note the picker lives on the owner fixture page, which may already be catalogued — if so, extend that entry rather than adding a second.

- [ ] **Step 3: Two journeys**

In `test/browser/journeys.spec.ts`:

**JavaScript off** — the organiser opens the fixture, assigns every player with the radios, saves, publishes, and the page shows the teams as published. This is the guarantee that matters and it must pass with `javaScriptEnabled: false`, like the M7a leave journey.

**JavaScript on** — drag one name from one column to the other and assert **the underlying radio's `checked` state followed it**, then save and assert the stored assignment matches. Assert the radio state, not anything visual: the form is the source of truth, and that is what makes the two paths provably equivalent.

This is the only JavaScript-on journey in the suite. Its comment must say so and say why, because every other test here is deliberately JS-off and a reader will otherwise assume it is a mistake.

- [ ] **Step 4: Run both suites in the foreground**

```bash
npm test
npx playwright test
npm run lint && npm run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add src/views/scripts.ts src/views/team-picker.ts test/browser/
git commit -m "feat: upgrade the team picker to drag-and-drop (BR-35)"
```

---

### Task 8: The guide and the master spec

**Files:**
- Modify: `docs/guide/` (the organiser chapter and the players' chapter — read the directory to find their real filenames)
- Modify: `docs/superpowers/specs/2026-08-10-make-the-team-design.md`

- [ ] **Step 1: The guide**

Add an organiser section on picking teams: naming the sides, that only confirmed players appear, that saving and publishing are separate, and that a late drop-out prompts rather than rearranges. Add to the players' chapter what the email tells them and where to find their side. Read both chapters in full first and match their voice — they are written for a non-technical reader.

- [ ] **Step 2: The master spec**

- Add **BR-35** after BR-34: an organiser may assign each `in` player of an open fixture to one of two named sides; saving is private and publishing emails everyone playing; a player always sees their own side, and the other side's names follow BR-33; nothing rebalances or re-sends automatically; and a late change is surfaced to the organiser rather than acted on.
- Add **N-9** to the notification catalogue table and to the dedupe-key table as `n9:<fixture_id>:<player_id>:<published_at>`.
- Update §308's team-picking entry to record what was built and what was deliberately left — per-player ratings and algorithmic balancing remain future work.

- [ ] **Step 3: Run everything and commit**

```bash
npm test
npx playwright test
npm run lint && npm run typecheck
git add docs/
git commit -m "docs: cover team picking in the guide and master spec (BR-35)"
```

---

## Self-review

**Spec coverage.** §2 columns and names → Task 1; `responses.team` reasoning → Tasks 1 and 2. §3 published/stale → Task 1 (column), Task 3 (save clears), Task 5 (publish sets). §3.1 derived staleness → Task 2, with the withdrawn hazard called out as its headline. §3.2 nothing rebalances → Task 5's prompt, and the Global Constraint forbidding capacity writes. §4 the screen → Task 3; §4.1 uneven → Task 3 step 3; §4.2 availability → Task 3 steps 4 and 5. §4's waitlist and partial-pick rules → Task 3 (save) and Task 5 (publish refusal). §5 player visibility → Task 6. §6 N-9 → Tasks 4 and 5. §7 audit → Task 3 step 1, written in Tasks 3 and 5. §8 testing → each task, plus Task 7. §9 not-in-this → nothing here builds ratings, balancing, scores, a third team, or per-fixture names. §10 definition of done → items 1–2 Tasks 3 and 7, 3 Task 5, 4 Tasks 2 and 5, 5 Task 6, 6 Task 8.

**Type consistency.** `TeamId` is defined once, in Task 2, and used by Tasks 3–7. `TeamAssignment` is Task 2's and is what `listTeamAssignments` returns and what every predicate takes. `teamNames(game)` returns `Record<TeamId, string>`, which is what Task 3's `names` and Task 6's rendering both consume. `teamsKey(fixtureId, playerId, publishedAt)` takes the ISO string of the same instant Task 5 writes to `teams_published_at`.

**One risk worth stating plainly.** Task 7's JavaScript-on journey is the only one of its kind in this suite and is the most likely thing in this plan to be flaky. It is scoped to a single assertion about radio state for that reason. If it proves unstable in practice, the JS-off journey is the one that protects the feature, and the JS-on one can be reduced rather than retried.

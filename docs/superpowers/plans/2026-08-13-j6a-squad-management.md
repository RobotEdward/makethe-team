# J6a — Squad Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a game's owner the two squad controls the product has been missing — remove a member (with BR-3's full consequence pass) and change who is an organiser — plus the email that tells a removed player it happened.

**Architecture:** A new `FixtureCapacity.withdrawMember` Durable Object method does the per-fixture half (TR-12: every capacity-affecting write enters through the object). A domain orchestrator deactivates the membership *first*, then loops the game's open fixtures calling that method once each, then hands promotions and the removal email to the caller to send. Three new routes hang off the existing `/g/:id` owner page. One invariant — a game always keeps at least one active owner — is checked in one place and refuses three operations.

**Tech Stack:** Cloudflare Workers, Hono, D1 + Drizzle, Durable Objects, Vitest via `@cloudflare/vitest-pool-workers`.

**Spec:** `docs/superpowers/specs/2026-08-13-j6a-squad-management-design.md`. Read the spec section named in each task before starting it; this plan is the *how*, the spec is the *why*.

## Global Constraints

- **TR-18 — entitlement is re-checked per row, and a failure is 404, never 403.** Middleware establishes *who*; every handler establishes *whether* against the row it is about. 403 confirms a resource exists and lets ids be probed.
- **TR-12 — every write that can affect a fixture's capacity goes through `FixtureCapacity`.** Never write `responses.status` or `fixtures.in_count` from a route or a domain module.
- **TR-29 — route tests drive through `SELF.fetch` from `cloudflare:test`.** Never the Hono test client.
- **TR-38 — D1 rejects more than 100 bound parameters per statement.** Chunk multi-row inserts with `chunk(rows, INSERT_CHUNK_SIZE)` from `src/db/chunk.ts`.
- **`db.batch()` is D1's only atomicity primitive.** There are no interactive transactions. Anything that must succeed or fail together goes in one `batch()`.
- **BR-27 — every owner action is audited**, with actor, timestamp and previous value.
- **BR-32 — no message is ever sent to a player with a null email.** Skip *before* a `Message` is constructed; a skipped guest is not a send failure and gets no `notification_log` row.
- **BR-26 — public pages never show surnames or addresses.** `/g/*` is owner-only and shows full names; nothing in this plan renders a name on a public page.
- **No new dependencies.** J6a adds none.
- **JavaScript policy** — server-rendered HTML and real form posts. Convenience JS is allowed; anything a player or owner *must* be able to do has to work with JS off. Every control in this plan is a plain `<form>`.
- **Vocabulary** — "player", "game", "fixture", "squad", "organiser" in user-facing copy. Never "user" outside Better Auth's own tables.
- **Commands** — `npm test` (full suite), `npm run lint`, `npm run typecheck`. All three must be green before any commit.

---

## File Structure

**Create:**

| File | Responsibility |
| --- | --- |
| `src/domain/last-owner.ts` | The one invariant: is this member the game's last active owner? |
| `src/domain/remove-member.ts` | BR-3 orchestration: deactivate membership, then loop open fixtures. |
| `src/domain/change-role.ts` | Promote/demote, guarded by the invariant. |
| `src/notify/templates/removed.ts` | N-7's copy. Pure — no clock, no db, no bindings. |
| `src/notify/send-removed.ts` | N-7's send path: log row, send, record result. |
| `src/views/remove-member.ts` | The removal confirmation page. |
| `test/domain/last-owner.test.ts`, `test/domain/remove-member.test.ts`, `test/domain/change-role.test.ts`, `test/capacity/withdraw-member.test.ts`, `test/notify/removed.test.ts`, `test/views/remove-member.test.ts`, `test/routes/squad.test.ts` | Tests for the above. |

**Modify:**

| File | Change |
| --- | --- |
| `src/domain/audit.ts` | Two new actions; correct the `membership.joined` comment. |
| `src/domain/join-squad.ts` | Invite-link joins record a null actor and `via: "invite_link"`. |
| `src/capacity/types.ts` | `WithdrawMemberInput`, `WithdrawMemberOutcome`. |
| `src/capacity/fixture-capacity.ts` | The `withdrawMember` method. |
| `src/notify/dedupe-key.ts` | `"n7"` in `NOTIFICATION_TYPES`; `removalKey`. |
| `src/db/queries.ts` | `findMembershipInGame`, `countActiveOwners`, `listOpenFixtureIds`, `countCommitments`. |
| `src/auth/paths.ts` | `memberRolePath`, `memberRemovePath`. |
| `src/views/game-overview.ts` | Per-row role and remove controls. |
| `src/routes/games.ts` | Three new routes. |
| `test/security/csp.test.ts` | The new page joins both page enumerations. |
| `docs/known-issues.md` | Row 25 amended; one new row for the partial-failure case. |

---

## Task 1: Audit actions, and the invite-join actor fix

**Spec:** §6.1, §6.2.

**Files:**
- Modify: `src/domain/audit.ts`
- Modify: `src/domain/join-squad.ts`
- Test: `test/domain/join-squad.test.ts` (existing — the join audit assertions change)

**Interfaces:**
- Produces: `AUDIT_ACTIONS` gains `"membership.removed"` and `"membership.role_changed"`. Later tasks use both.

No migration is needed. Drizzle's `text({ enum })` emits no SQL `CHECK` on SQLite, so the enum is a TypeScript-only narrowing — M6a added five actions the same way.

- [ ] **Step 1: Find the existing join-audit assertions**

Run: `grep -n "membership.joined\|membership.rejoined\|actorPlayerId" test/domain/join-squad.test.ts`

These currently assert `actorPlayerId` is the joining player. Task 1 inverts that assertion; read them before editing so you change the right ones.

- [ ] **Step 2: Write the failing tests**

Replace the existing actor assertions in `test/domain/join-squad.test.ts` with these, and add the `via` ones. Keep every other assertion in that file untouched.

```ts
it("records a join with no actor — the joiner is an anonymous link holder", async () => {
  const db = testDb();
  const gameId = await insertGame(db);
  await joinSquad({ db, gameId, name: "Sam Okafor", email: "sam@example.com", now: NOW });

  const [row] = await db.select().from(auditLog).where(eq(auditLog.action, "membership.joined"));
  // Null, not the joining player: whoever pasted the invite link is
  // unidentified, and recording the joiner as the actor asserts they added
  // themselves — which is exactly what the leaked-link case makes false.
  expect(row!.actorPlayerId).toBeNull();
  expect(JSON.parse(row!.afterJson!)).toMatchObject({ via: "invite_link" });
});

it("records a rejoin the same way", async () => {
  const db = testDb();
  const gameId = await insertGame(db);
  const first = await joinSquad({ db, gameId, name: "Sam Okafor", email: "sam@example.com", now: NOW });
  await db
    .update(memberships)
    .set({ active: false, leftAt: NOW })
    .where(eq(memberships.id, "membershipId" in first ? first.membershipId : ""));
  await joinSquad({ db, gameId, name: "Sam Okafor", email: "sam@example.com", now: NOW });

  const [row] = await db.select().from(auditLog).where(eq(auditLog.action, "membership.rejoined"));
  expect(row!.actorPlayerId).toBeNull();
  expect(JSON.parse(row!.afterJson!)).toMatchObject({ via: "invite_link" });
});

it("never writes the invite token into the audit log", async () => {
  const db = testDb();
  const [game] = await db.select().from(games).where(eq(games.id, await insertGame(db)));
  await joinSquad({ db, gameId: game!.id, name: "Sam Okafor", email: "sam@example.com", now: NOW });

  const rows = await db.select().from(auditLog);
  const serialised = JSON.stringify(rows);
  // The token is a live capability; audit_log is durable and widely read.
  expect(serialised).not.toContain(game!.inviteToken);
});
```

Add `games` to that file's `../../src/db/schema.js` import if it is not already there.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/domain/join-squad.test.ts`
Expected: FAIL — the actor assertions get a player id where `null` is expected.

- [ ] **Step 4: Extend the audit action enum**

In `src/domain/audit.ts`, replace the `membership.joined` comment and the two membership entries with:

```ts
  // A join through the public invite link. `actor_player_id` is **null**: the
  // actor is whoever was holding the link, and they are unidentified. It was
  // originally the joining player, on the reasoning that "nobody else acted" —
  // which is false for the case that matters. `joinSquad` reuses any existing
  // `players` row matching the submitted address, so someone holding a leaked
  // link can attach a real person's account to a squad they never asked to
  // join, and an actor of the joining player made the trail assert that the
  // victim added themselves. `via: "invite_link"` in `after_json`
  // distinguishes a null actor here from a cron or system action.
  "membership.joined",
  "membership.rejoined",
  // J6a. Owner actions on someone else's membership, so both carry a real
  // actor. `membership.removed` carries `active`/`left_at` before and after;
  // `membership.role_changed` carries `role`.
  "membership.removed",
  "membership.role_changed",
```

- [ ] **Step 5: Make the join audit honest**

In `src/domain/join-squad.ts`, in **both** `buildAuditInsert` calls (the rejoin batch and the join batch), change `actorPlayerId: playerId` to `actorPlayerId: null` and add `via` to the `after` object:

```ts
      buildAuditInsert(db, {
        // Null, not `playerId`. See the `membership.joined` comment in
        // `src/domain/audit.ts`: whoever holds the invite link is anonymous,
        // and naming the joiner as actor asserts a consent that may not exist.
        actorPlayerId: null,
        entityType: "membership",
        entityId: membership.id,
        action: "membership.rejoined",
        after: { gameId, playerId, via: "invite_link" },
        now,
      }),
```

and the same three changes (`actorPlayerId: null`, `via: "invite_link"`, action `"membership.joined"`) in the insert batch below it. Do **not** put the invite token in `after`.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS. If another test asserted the old actor, fix that assertion — do not revert the change.

- [ ] **Step 7: Lint, typecheck, commit**

```bash
npm run lint && npm run typecheck
git add src/domain/audit.ts src/domain/join-squad.ts test/domain/join-squad.test.ts
git commit -m "fix: an invite-link join has no identified actor"
```

---

## Task 2: The queries squad management needs

**Spec:** §2.1, §3.3, §4.

**Files:**
- Modify: `src/db/queries.ts`
- Test: `test/db/queries.test.ts` (existing file — append)

**Interfaces:**
- Produces:
  ```ts
  export interface MembershipInGame {
    membershipId: string;
    playerId: string;
    name: string;
    email: string | null;
    isGuest: boolean;
    role: "player" | "owner";
    active: boolean;
  }
  export async function findMembershipInGame(db: Db, gameId: string, playerId: string): Promise<MembershipInGame | null>;
  export async function countActiveOwners(db: Db, gameId: string): Promise<number>;
  export async function listOpenFixtureIds(db: Db, gameId: string): Promise<string[]>;
  export async function countCommitments(db: Db, gameId: string, playerId: string): Promise<{ in: number; waitlisted: number }>;
  ```

- [ ] **Step 1: Write the failing tests**

Append to `test/db/queries.test.ts`:

```ts
describe("findMembershipInGame", () => {
  beforeEach(resetDatabase);

  it("finds an active member of that game", async () => {
    const db = testDb();
    const gameId = await insertGame(db);
    const playerId = await insertPlayer(db, { name: "Sam Okafor" });
    const membershipId = await insertMembership(db, gameId, playerId, { role: "owner" });

    const found = await findMembershipInGame(db, gameId, playerId);
    expect(found).toMatchObject({ membershipId, playerId, name: "Sam Okafor", role: "owner", active: true });
  });

  it("returns null for a membership in a different game", async () => {
    const db = testDb();
    const [mine, theirs] = [await insertGame(db), await insertGame(db)];
    const playerId = await insertPlayer(db);
    await insertMembership(db, theirs, playerId);

    // The scoping that stops `:playerId` reading as a global identifier.
    expect(await findMembershipInGame(db, mine, playerId)).toBeNull();
  });

  it("returns an inactive membership rather than hiding it", async () => {
    const db = testDb();
    const gameId = await insertGame(db);
    const playerId = await insertPlayer(db);
    await insertMembership(db, gameId, playerId, { active: false });

    // Callers decide what an inactive membership means; this query reports it.
    expect(await findMembershipInGame(db, gameId, playerId)).toMatchObject({ active: false });
  });
});

describe("countActiveOwners", () => {
  beforeEach(resetDatabase);

  it("counts only active owners of that game", async () => {
    const db = testDb();
    const gameId = await insertGame(db);
    const other = await insertGame(db);
    await insertMembership(db, gameId, await insertPlayer(db), { role: "owner" });
    await insertMembership(db, gameId, await insertPlayer(db), { role: "owner", active: false });
    await insertMembership(db, gameId, await insertPlayer(db), { role: "player" });
    await insertMembership(db, other, await insertPlayer(db), { role: "owner" });

    expect(await countActiveOwners(db, gameId)).toBe(1);
  });
});

describe("listOpenFixtureIds", () => {
  beforeEach(resetDatabase);

  it("returns only this game's open fixtures", async () => {
    const db = testDb();
    const gameId = await insertGame(db);
    const other = await insertGame(db);
    const open = await insertFixture(db, gameId, { lifecycle: "open" });
    await insertFixture(db, gameId, { lifecycle: "scheduled" });
    await insertFixture(db, gameId, { lifecycle: "cancelled" });
    await insertFixture(db, gameId, { lifecycle: "played" });
    await insertFixture(db, other, { lifecycle: "open" });

    expect(await listOpenFixtureIds(db, gameId)).toEqual([open]);
  });
});

describe("countCommitments", () => {
  beforeEach(resetDatabase);

  it("counts a player's in and waitlisted rows on this game's open fixtures", async () => {
    const db = testDb();
    const gameId = await insertGame(db);
    const playerId = await insertPlayer(db);
    const a = await insertFixture(db, gameId, { lifecycle: "open" });
    const b = await insertFixture(db, gameId, { lifecycle: "open" });
    const c = await insertFixture(db, gameId, { lifecycle: "open" });
    await insertResponse(db, a, playerId, { status: "in" });
    await insertResponse(db, b, playerId, { status: "waitlisted", waitlistPosition: 1 });
    await insertResponse(db, c, playerId, { status: "pending" });

    expect(await countCommitments(db, gameId, playerId)).toEqual({ in: 1, waitlisted: 1 });
  });
});
```

- [ ] **Step 2: Add the two missing test factories**

`insertFixture` and `insertResponse` may not exist yet. Check with `grep -n "insertFixture\|insertResponse" test/support/factories.ts`. If either is missing, add it to `test/support/factories.ts`:

```ts
export async function insertFixture(
  db: Db,
  gameId: string,
  overrides: Partial<typeof fixtures.$inferInsert> = {},
): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(fixtures).values({
    id,
    gameId,
    kicksOffAt: new Date("2026-08-20T18:00:00Z"),
    minPlayers: 10,
    maxPlayers: 14,
    prefersEvenNumbers: true,
    shortWarningOffsetHours: 12,
    durationMinutes: 60,
    ...overrides,
  });
  return id;
}

export async function insertResponse(
  db: Db,
  fixtureId: string,
  playerId: string,
  overrides: Partial<typeof responses.$inferInsert> = {},
): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(responses).values({ id, fixtureId, playerId, source: "system", ...overrides });
  return id;
}
```

Add `fixtures` and `responses` to that file's schema import. **Two fixtures on one game must not share a `kicks_off_at`** — `fixtures_game_kickoff_unique` forbids it — so tests inserting several pass distinct `kicksOffAt` values.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/db/queries.test.ts`
Expected: FAIL — the four functions are not exported.

- [ ] **Step 4: Implement the queries**

Append to `src/db/queries.ts`:

```ts
export interface MembershipInGame {
  membershipId: string;
  playerId: string;
  name: string;
  email: string | null;
  isGuest: boolean;
  role: "player" | "owner";
  active: boolean;
}

/**
 * One player's membership of one game, active or not, or `null`.
 *
 * Scoped by `gameId` as well as `playerId`, which is the whole point: the
 * squad routes take two ids in the path, and without this scoping `:playerId`
 * would read as a global identifier and one owner could act on another
 * squad's membership. The caller answers 404 on `null` (TR-18).
 *
 * Reports an inactive membership rather than hiding it, so a caller can tell
 * "not in this squad" from "was, and left" and answer each correctly.
 */
export async function findMembershipInGame(
  db: Db,
  gameId: string,
  playerId: string,
): Promise<MembershipInGame | null> {
  const [row] = await db
    .select({
      membershipId: memberships.id,
      playerId: memberships.playerId,
      name: players.name,
      email: players.email,
      isGuest: players.isGuest,
      role: memberships.role,
      active: memberships.active,
    })
    .from(memberships)
    .innerJoin(players, eq(players.id, memberships.playerId))
    .where(and(eq(memberships.gameId, gameId), eq(memberships.playerId, playerId)))
    .limit(1);
  return row ?? null;
}

/** How many active owners this game has. The input to J6a's one invariant. */
export async function countActiveOwners(db: Db, gameId: string): Promise<number> {
  const rows = await db
    .select({ id: memberships.id })
    .from(memberships)
    .where(
      and(eq(memberships.gameId, gameId), eq(memberships.active, true), eq(memberships.role, "owner")),
    );
  return rows.length;
}

/**
 * Every `open` fixture of this game — the exact set BR-3's consequence pass
 * walks.
 *
 * `scheduled` fixtures are excluded because they hold no response rows at all
 * (BR-1 writes them when a fixture opens), and `cancelled`/`played` because
 * they are terminal and rewriting their rows would be rewriting history.
 */
export async function listOpenFixtureIds(db: Db, gameId: string): Promise<string[]> {
  const rows = await db
    .select({ id: fixtures.id })
    .from(fixtures)
    .where(and(eq(fixtures.gameId, gameId), eq(fixtures.lifecycle, "open")))
    .orderBy(fixtures.kicksOffAt);
  return rows.map((row) => row.id);
}

/**
 * What a player currently holds on this game's open fixtures: confirmed places
 * and waitlist places. Read only to make the removal confirmation page state
 * consequences in specifics rather than in general terms.
 */
export async function countCommitments(
  db: Db,
  gameId: string,
  playerId: string,
): Promise<{ in: number; waitlisted: number }> {
  const rows = await db
    .select({ status: responses.status })
    .from(responses)
    .innerJoin(fixtures, eq(fixtures.id, responses.fixtureId))
    .where(
      and(
        eq(fixtures.gameId, gameId),
        eq(fixtures.lifecycle, "open"),
        eq(responses.playerId, playerId),
      ),
    );
  return {
    in: rows.filter((row) => row.status === "in").length,
    waitlisted: rows.filter((row) => row.status === "waitlisted").length,
  };
}
```

Add `responses` to that file's schema import if it is not already there.

- [ ] **Step 5: Run the tests and the full suite**

Run: `npx vitest run test/db/queries.test.ts && npm test`
Expected: PASS.

- [ ] **Step 6: Lint, typecheck, commit**

```bash
npm run lint && npm run typecheck
git add src/db/queries.ts test/db/queries.test.ts test/support/factories.ts
git commit -m "feat: the queries squad management needs"
```

---

## Task 3: `FixtureCapacity.withdrawMember`

**Spec:** §3.1, §3.2. Read both before starting — §3.1 is the decision that an `out` row is *deleted*, which is the part BR-3 does not state.

**Files:**
- Modify: `src/capacity/types.ts`
- Modify: `src/capacity/fixture-capacity.ts`
- Test: `test/capacity/withdraw-member.test.ts` (create)

**Interfaces:**
- Consumes: `WaitlistPromotion` from `src/capacity/types.ts` (existing).
- Produces:
  ```ts
  export interface WithdrawMemberInput { playerId: string; actorPlayerId: string; now: number }
  export type WithdrawMemberOutcome =
    | { kind: "removed"; previousStatus: "pending" | "in" | "out" | "waitlisted"; inCount: number; promoted?: WaitlistPromotion }
    | { kind: "no-op"; reason: "no-response-row" | "fixture-not-open" | "fixture-not-found" };
  ```

Read `#setResponseLocked` in `src/capacity/fixture-capacity.ts` first. `withdrawMember` follows its structure exactly — the `blockConcurrencyWhile` wrapper, the `this.ctx.id.name` guard, the read-everything-once pattern, the single `db.batch()`, and carrying the promotion out rather than sending anything.

- [ ] **Step 1: Write the failing tests**

Create `test/capacity/withdraw-member.test.ts`:

```ts
import { env } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../src/db/client.js";
import { fixtures, responses } from "../../src/db/schema.js";
import { insertFixture, insertGame, insertPlayer, insertResponse, resetDatabase, testDb } from "../support/factories.js";

const NOW = new Date("2026-08-13T12:00:00Z");
const OWNER = "owner-player-id";

function withdraw(fixtureId: string, playerId: string) {
  return env.FIXTURE_CAPACITY.getByName(fixtureId).withdrawMember({
    playerId,
    actorPlayerId: OWNER,
    now: NOW.getTime(),
  });
}

async function rowFor(fixtureId: string, playerId: string) {
  const [row] = await testDb()
    .select()
    .from(responses)
    .where(and(eq(responses.fixtureId, fixtureId), eq(responses.playerId, playerId)));
  return row ?? null;
}

describe("FixtureCapacity.withdrawMember", () => {
  beforeEach(resetDatabase);

  it("turns an `in` row into `withdrawn` and frees the slot", async () => {
    const db = testDb();
    const gameId = await insertGame(db);
    const fixtureId = await insertFixture(db, gameId, { lifecycle: "open", inCount: 1 });
    const playerId = await insertPlayer(db);
    await insertResponse(db, fixtureId, playerId, { status: "in" });

    const outcome = await withdraw(fixtureId, playerId);

    expect(outcome).toMatchObject({ kind: "removed", previousStatus: "in", inCount: 0 });
    const row = await rowFor(fixtureId, playerId);
    // `withdrawn`, never `out` — a leaver is never recorded as a decline (§1.5).
    expect(row).toMatchObject({ status: "withdrawn", setByPlayerId: OWNER, source: "owner" });
    const [fixture] = await db.select().from(fixtures).where(eq(fixtures.id, fixtureId));
    expect(fixture!.inCount).toBe(0);
  });

  it("deletes a `pending` row", async () => {
    const db = testDb();
    const fixtureId = await insertFixture(db, await insertGame(db), { lifecycle: "open" });
    const playerId = await insertPlayer(db);
    await insertResponse(db, fixtureId, playerId, { status: "pending" });

    expect(await withdraw(fixtureId, playerId)).toMatchObject({ kind: "removed", previousStatus: "pending" });
    expect(await rowFor(fixtureId, playerId)).toBeNull();
  });

  it("deletes an `out` row, so an ex-member never shows as having declined", async () => {
    const db = testDb();
    const fixtureId = await insertFixture(db, await insertGame(db), { lifecycle: "open" });
    const playerId = await insertPlayer(db);
    await insertResponse(db, fixtureId, playerId, { status: "out" });

    // §3.1: BR-3 does not name this case; the spec's decision is to delete it.
    expect(await withdraw(fixtureId, playerId)).toMatchObject({ kind: "removed", previousStatus: "out" });
    expect(await rowFor(fixtureId, playerId)).toBeNull();
  });

  it("deletes a `waitlisted` row without promoting anyone", async () => {
    const db = testDb();
    const fixtureId = await insertFixture(db, await insertGame(db), {
      lifecycle: "open",
      maxPlayers: 1,
      inCount: 1,
      waitlistCount: 1,
    });
    const holder = await insertPlayer(db);
    const waiter = await insertPlayer(db);
    await insertResponse(db, fixtureId, holder, { status: "in" });
    await insertResponse(db, fixtureId, waiter, { status: "waitlisted", waitlistPosition: 1 });

    const outcome = await withdraw(fixtureId, waiter);

    // No slot was freed, so nobody moves.
    expect(outcome).toMatchObject({ kind: "removed", previousStatus: "waitlisted", inCount: 1 });
    expect("promoted" in outcome && outcome.promoted).toBeFalsy();
    expect(await rowFor(fixtureId, holder)).toMatchObject({ status: "in" });
    const [fixture] = await db.select().from(fixtures).where(eq(fixtures.id, fixtureId));
    expect(fixture!.waitlistCount).toBe(0);
  });

  it("promotes the longest-waiting player when an `in` row gives up its slot", async () => {
    const db = testDb();
    const fixtureId = await insertFixture(db, await insertGame(db), {
      lifecycle: "open",
      maxPlayers: 1,
      inCount: 1,
      waitlistCount: 2,
    });
    const leaving = await insertPlayer(db);
    const first = await insertPlayer(db);
    const second = await insertPlayer(db);
    await insertResponse(db, fixtureId, leaving, { status: "in" });
    // Position 5 is *lower* than 9 and therefore the earlier arrival — the
    // positions are gappy, so "longest waiting" is the lowest live number and
    // never the smallest index or the first row returned.
    await insertResponse(db, fixtureId, first, { status: "waitlisted", waitlistPosition: 5 });
    await insertResponse(db, fixtureId, second, { status: "waitlisted", waitlistPosition: 9 });

    const outcome = await withdraw(fixtureId, leaving);

    expect(outcome).toMatchObject({
      kind: "removed",
      previousStatus: "in",
      inCount: 1,
      promoted: { playerId: first, previousWaitlistPosition: 5, promotedAt: NOW.getTime() },
    });
    expect(await rowFor(fixtureId, first)).toMatchObject({ status: "in", waitlistPosition: null, source: "system" });
    expect(await rowFor(fixtureId, second)).toMatchObject({ status: "waitlisted", waitlistPosition: 9 });
    const [fixture] = await db.select().from(fixtures).where(eq(fixtures.id, fixtureId));
    expect(fixture!.inCount).toBe(1);
    expect(fixture!.waitlistCount).toBe(1);
  });

  it("is a no-op on a second call", async () => {
    const db = testDb();
    const fixtureId = await insertFixture(db, await insertGame(db), { lifecycle: "open", inCount: 1 });
    const playerId = await insertPlayer(db);
    await insertResponse(db, fixtureId, playerId, { status: "in" });

    await withdraw(fixtureId, playerId);
    // Idempotence is what makes a partly-failed removal safe to retry (§3.3).
    // The `withdrawn` row is not a row to act on again.
    expect(await withdraw(fixtureId, playerId)).toEqual({ kind: "no-op", reason: "no-response-row" });
  });

  it("is a no-op for a player with no row", async () => {
    const db = testDb();
    const fixtureId = await insertFixture(db, await insertGame(db), { lifecycle: "open" });
    expect(await withdraw(fixtureId, await insertPlayer(db))).toEqual({
      kind: "no-op",
      reason: "no-response-row",
    });
  });

  it("is a no-op on a scheduled fixture", async () => {
    const db = testDb();
    const fixtureId = await insertFixture(db, await insertGame(db), { lifecycle: "scheduled" });
    expect(await withdraw(fixtureId, await insertPlayer(db))).toEqual({
      kind: "no-op",
      reason: "fixture-not-open",
    });
  });

  it("is a no-op on a cancelled fixture, so history is never rewritten", async () => {
    const db = testDb();
    const gameId = await insertGame(db);
    const fixtureId = await insertFixture(db, gameId, { lifecycle: "cancelled", inCount: 1 });
    const playerId = await insertPlayer(db);
    await insertResponse(db, fixtureId, playerId, { status: "in" });

    expect(await withdraw(fixtureId, playerId)).toEqual({ kind: "no-op", reason: "fixture-not-open" });
    expect(await rowFor(fixtureId, playerId)).toMatchObject({ status: "in" });
  });

  it("is a no-op for a fixture that does not exist", async () => {
    expect(await withdraw(crypto.randomUUID(), crypto.randomUUID())).toEqual({
      kind: "no-op",
      reason: "fixture-not-found",
    });
  });

  it("touches only the addressed fixture", async () => {
    const db = testDb();
    const gameId = await insertGame(db);
    const target = await insertFixture(db, gameId, { lifecycle: "open", inCount: 1 });
    const other = await insertFixture(db, gameId, {
      lifecycle: "open",
      inCount: 1,
      kicksOffAt: new Date("2026-08-27T18:00:00Z"),
    });
    const playerId = await insertPlayer(db);
    await insertResponse(db, target, playerId, { status: "in" });
    await insertResponse(db, other, playerId, { status: "in" });

    await withdraw(target, playerId);

    expect(await rowFor(other, playerId)).toMatchObject({ status: "in" });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/capacity/withdraw-member.test.ts`
Expected: FAIL — `withdrawMember` is not a function.

- [ ] **Step 3: Add the types**

Append to `src/capacity/types.ts`:

```ts
/** What an owner's removal of a squad member does to one fixture (BR-3, J6a §3.2). */
export interface WithdrawMemberInput {
  playerId: string;
  /** The owner performing the removal. Recorded on the withdrawn row (BR-27). */
  actorPlayerId: string;
  /** Passed in rather than read from the clock — domain code stays testable. */
  now: number;
}

export type WithdrawMemberOutcome =
  | {
      // "removed", not "withdrawn": `withdrawn` is only one of the four things
      // this does to the row (a `pending`, `out` or `waitlisted` row is
      // deleted), so naming the whole outcome after it would make the deleted
      // cases read as a different result than they are.
      kind: "removed";
      /** The status the row held before this call. */
      previousStatus: "pending" | "in" | "out" | "waitlisted";
      inCount: number;
      /**
       * Present only when freeing this slot promoted a waitlisted player
       * (BR-7). Carried out of the lock for the caller to act on — the object
       * sends nothing, for the reason `WaitlistPromotion` documents.
       */
      promoted?: WaitlistPromotion;
    }
  /** Nothing to do. Not an error: a removal walks every open fixture, and most hold no row for the player. */
  | { kind: "no-op"; reason: "no-response-row" | "fixture-not-open" | "fixture-not-found" };
```

- [ ] **Step 4: Implement the method**

Add to `src/capacity/fixture-capacity.ts`, alongside `setResponse`. Extend the imports: `and`, `eq` from `drizzle-orm`, and the two new types.

```ts
  /**
   * Remove a squad member's stake in this fixture (BR-3, J6a §3.2).
   *
   * A separate method rather than a `setResponse` variant: `setResponse` takes
   * an `in`/`out` intent and rejects any player without an existing row, which
   * is close to the opposite of what removal needs. It is in the Durable
   * Object at all because it both frees a slot and fills one, and TR-12 admits
   * no capacity write outside here.
   *
   * `blockConcurrencyWhile` is load-bearing for the same reason it is on
   * `setResponse` — read that method's comment. The critical section awaits
   * D1, which is an external call and is not covered by input gating, so
   * without the block a concurrent self-response could read a slot this
   * removal is about to free and both writers could claim it.
   */
  async withdrawMember(input: WithdrawMemberInput): Promise<WithdrawMemberOutcome> {
    return this.ctx.blockConcurrencyWhile(async () => this.#withdrawMemberLocked(input));
  }

  async #withdrawMemberLocked(input: WithdrawMemberInput): Promise<WithdrawMemberOutcome> {
    // From the object's own identity, never from an argument — see
    // `#setResponseLocked` for the full reasoning. The lock is keyed by this
    // name, so a mutation keyed on anything else is not covered by it.
    const fixtureId = this.ctx.id.name;
    if (fixtureId === undefined) {
      throw new Error(
        "FixtureCapacity was addressed by unique id, not by fixture id — every caller must use getByName(fixtureId)",
      );
    }

    const db = getDb(this.env.DB);
    const now = new Date(input.now);

    const [fixture] = await db.select().from(fixtures).where(eq(fixtures.id, fixtureId));
    if (!fixture) return { kind: "no-op", reason: "fixture-not-found" };
    // `scheduled` holds no response rows; `cancelled` and `played` are
    // terminal and rewriting them would be rewriting history.
    if (fixture.lifecycle !== "open") return { kind: "no-op", reason: "fixture-not-open" };

    const all = await db
      .select({
        id: responses.id,
        playerId: responses.playerId,
        status: responses.status,
        waitlistPosition: responses.waitlistPosition,
      })
      .from(responses)
      .where(eq(responses.fixtureId, fixtureId));

    const existing = all.find((row) => row.playerId === input.playerId);
    // No row, or a row already `withdrawn`: nothing left to act on. This is
    // what makes a second call safe, which is what makes a partly-failed
    // removal safe to retry (§3.3).
    if (!existing || existing.status === "withdrawn") return { kind: "no-op", reason: "no-response-row" };
    const previousStatus = existing.status;

    const others = all.filter((row) => row.id !== existing.id);
    const inCountWithoutThisPlayer = others.filter((row) => row.status === "in").length;
    const waitlistedWithoutThisPlayer = others.filter((row) => row.status === "waitlisted");

    // Only an `in` row held a slot, so only an `in` row can free one (BR-7).
    // `occupiesSlot` rather than a literal `=== "in"`, to stay in step with
    // the one definition of what holds a slot.
    const freesASlot = occupiesSlot(previousStatus);
    const liveWaitlistCandidates = waitlistedWithoutThisPlayer.filter(
      (row): row is (typeof waitlistedWithoutThisPlayer)[number] & { waitlistPosition: number } =>
        row.waitlistPosition !== null,
    );
    // Longest waiting is the **lowest live position**. Positions are permanent
    // and gappy — the next joiner takes the highest live position plus one —
    // so the lowest live number is always the earliest arrival (BR-6).
    const promotedRow = freesASlot
      ? liveWaitlistCandidates.reduce<(typeof liveWaitlistCandidates)[number] | null>(
          (best, row) => (best === null || row.waitlistPosition < best.waitlistPosition ? row : best),
          null,
        )
      : null;

    const inCount = inCountWithoutThisPlayer + (promotedRow ? 1 : 0);
    const waitlistCount = waitlistedWithoutThisPlayer.length - (promotedRow ? 1 : 0);

    // One batch: D1 has no interactive transactions, so this is the only way
    // to make the withdrawal and the promotion succeed or fail together. Split
    // in two, a failure between them would free a slot nobody took or fill one
    // that was never freed, and the cached counts would disagree either way.
    await db.batch([
      previousStatus === "in"
        ? db
            .update(responses)
            .set({
              status: "withdrawn",
              waitlistPosition: null,
              respondedAt: now,
              setByPlayerId: input.actorPlayerId,
              source: "owner",
            })
            .where(eq(responses.id, existing.id))
        : // `pending`, `out` and `waitlisted` rows are deleted outright (§3.1).
          // None of them holds a slot, so none needs the `withdrawn` marker —
          // and deleting the `out` row is what stops an ex-member showing as
          // having declined.
          db.delete(responses).where(eq(responses.id, existing.id)),
      // The promoted player's `responded_at` is left alone deliberately: it
      // records when *they* said yes, and this is not a new answer from them.
      // `source` is "system" because nobody asked for this write.
      ...(promotedRow
        ? [
            db
              .update(responses)
              .set({ status: "in", waitlistPosition: null, source: "system" })
              .where(eq(responses.id, promotedRow.id)),
          ]
        : []),
      db.update(fixtures).set({ inCount, waitlistCount }).where(eq(fixtures.id, fixtureId)),
    ]);

    return {
      kind: "removed",
      previousStatus,
      inCount,
      // Carried out, never acted on in here: an HTTP call to a mail provider
      // inside `blockConcurrencyWhile` would put every other tap on this
      // fixture behind the provider's latency.
      ...(promotedRow
        ? {
            promoted: {
              playerId: promotedRow.playerId,
              previousWaitlistPosition: promotedRow.waitlistPosition,
              promotedAt: input.now,
            },
          }
        : {}),
    };
  }
```

- [ ] **Step 5: Run the tests, then the full suite**

Run: `npx vitest run test/capacity/withdraw-member.test.ts && npm test`
Expected: PASS. `test/capacity/fixture-capacity.test.ts` asserts the object's source contains no network call — `withdrawMember` makes none, so that assertion should still hold; if it fails, you have added a `fetch` and must remove it.

- [ ] **Step 6: Lint, typecheck, commit**

```bash
npm run lint && npm run typecheck
git add src/capacity/types.ts src/capacity/fixture-capacity.ts test/capacity/withdraw-member.test.ts test/support/factories.ts
git commit -m "feat: withdrawMember, BR-3's per-fixture half"
```

---

## Task 4: The removal orchestrator

**Spec:** §3.3, §3.4, §4. Read §3.3 carefully — the *order* of the two writes is the design.

**Files:**
- Create: `src/domain/last-owner.ts`
- Create: `src/domain/remove-member.ts`
- Test: `test/domain/last-owner.test.ts`, `test/domain/remove-member.test.ts`

**Interfaces:**
- Consumes: `findMembershipInGame`, `countActiveOwners`, `listOpenFixtureIds` (Task 2); `WithdrawMemberOutcome`, `WaitlistPromotion` (Task 3); `buildAuditInsert` from `src/db/audit.ts`.
- Produces:
  ```ts
  export async function isLastActiveOwner(db: Db, gameId: string, member: { role: "player" | "owner"; active: boolean }): Promise<boolean>;

  export interface FixturePromotion { fixtureId: string; promoted: WaitlistPromotion }
  export interface RemoveMemberParams {
    db: Db;
    gameId: string;
    playerId: string;
    actorPlayerId: string;
    now: Date;
    withdraw: (fixtureId: string) => Promise<WithdrawMemberOutcome>;
  }
  export type RemoveMemberResult =
    | { kind: "removed"; membershipId: string; leftAt: Date; promotions: FixturePromotion[] }
    | { kind: "refused"; reason: "last-owner" }
    | { kind: "not-a-member" };
  ```

`withdraw` is injected as a function rather than the domain module reaching for `env.FIXTURE_CAPACITY`, so this module stays free of Workers bindings and a test can drive it with the real object or a stub.

- [ ] **Step 1: Write the failing test for the invariant**

Create `test/domain/last-owner.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { isLastActiveOwner } from "../../src/domain/last-owner.js";
import { insertGame, insertMembership, insertPlayer, resetDatabase, testDb } from "../support/factories.js";

describe("isLastActiveOwner", () => {
  beforeEach(resetDatabase);

  it("is true for the only owner", async () => {
    const db = testDb();
    const gameId = await insertGame(db);
    await insertMembership(db, gameId, await insertPlayer(db), { role: "owner" });
    await insertMembership(db, gameId, await insertPlayer(db), { role: "player" });

    expect(await isLastActiveOwner(db, gameId, { role: "owner", active: true })).toBe(true);
  });

  it("is false when a co-owner remains", async () => {
    const db = testDb();
    const gameId = await insertGame(db);
    await insertMembership(db, gameId, await insertPlayer(db), { role: "owner" });
    await insertMembership(db, gameId, await insertPlayer(db), { role: "owner" });

    expect(await isLastActiveOwner(db, gameId, { role: "owner", active: true })).toBe(false);
  });

  it("is false for an ordinary player, however few owners there are", async () => {
    const db = testDb();
    const gameId = await insertGame(db);
    await insertMembership(db, gameId, await insertPlayer(db), { role: "owner" });

    expect(await isLastActiveOwner(db, gameId, { role: "player", active: true })).toBe(false);
  });

  it("is false for an already-inactive owner, who is not counted", async () => {
    const db = testDb();
    const gameId = await insertGame(db);
    await insertMembership(db, gameId, await insertPlayer(db), { role: "owner" });

    expect(await isLastActiveOwner(db, gameId, { role: "owner", active: false })).toBe(false);
  });
});
```

- [ ] **Step 2: Implement the invariant**

Create `src/domain/last-owner.ts`:

```ts
import { countActiveOwners } from "../db/queries.js";
import type { Db } from "../db/client.js";

/**
 * J6a's one invariant, in one place: **a game always keeps at least one active
 * owner.**
 *
 * Both squad operations consult it — removing a member and demoting an owner —
 * so the three refusals it produces (demote the last owner, remove the last
 * owner, and therefore a solo owner removing themselves) share a single
 * implementation and cannot drift apart.
 *
 * Takes the member's role and active flag rather than re-reading them: every
 * caller has already loaded the membership to answer TR-18's entitlement
 * question, and a second read could see a different row.
 */
export async function isLastActiveOwner(
  db: Db,
  gameId: string,
  member: { role: "player" | "owner"; active: boolean },
): Promise<boolean> {
  // An ordinary player is never the last owner, and neither is an owner who is
  // already inactive — `countActiveOwners` does not count them, so treating
  // them as one would refuse an operation that changes nothing.
  if (member.role !== "owner" || !member.active) return false;
  return (await countActiveOwners(db, gameId)) <= 1;
}
```

- [ ] **Step 3: Run it**

Run: `npx vitest run test/domain/last-owner.test.ts`
Expected: PASS.

- [ ] **Step 4: Write the failing tests for the orchestrator**

Create `test/domain/remove-member.test.ts`:

```ts
import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { auditLog, memberships, responses } from "../../src/db/schema.js";
import { removeMember } from "../../src/domain/remove-member.js";
import {
  insertFixture,
  insertGame,
  insertMembership,
  insertPlayer,
  insertResponse,
  resetDatabase,
  testDb,
} from "../support/factories.js";

const NOW = new Date("2026-08-13T12:00:00Z");

/** The real Durable Object, addressed the way the route will address it. */
const withdraw = (fixtureId: string) =>
  env.FIXTURE_CAPACITY.getByName(fixtureId).withdrawMember({
    playerId: CURRENT_PLAYER,
    actorPlayerId: CURRENT_ACTOR,
    now: NOW.getTime(),
  });

let CURRENT_PLAYER = "";
let CURRENT_ACTOR = "";

async function remove(gameId: string, playerId: string, actorPlayerId: string) {
  CURRENT_PLAYER = playerId;
  CURRENT_ACTOR = actorPlayerId;
  return removeMember({ db: testDb(), gameId, playerId, actorPlayerId, now: NOW, withdraw });
}

describe("removeMember", () => {
  beforeEach(resetDatabase);

  it("deactivates the membership and audits it", async () => {
    const db = testDb();
    const gameId = await insertGame(db);
    const owner = await insertPlayer(db);
    const player = await insertPlayer(db);
    await insertMembership(db, gameId, owner, { role: "owner" });
    const membershipId = await insertMembership(db, gameId, player);

    const result = await remove(gameId, player, owner);

    expect(result).toMatchObject({ kind: "removed", membershipId, leftAt: NOW, promotions: [] });
    const [row] = await db.select().from(memberships).where(eq(memberships.id, membershipId));
    expect(row).toMatchObject({ active: false, leftAt: NOW });

    const [audit] = await db.select().from(auditLog).where(eq(auditLog.action, "membership.removed"));
    expect(audit).toMatchObject({ actorPlayerId: owner, entityType: "membership", entityId: membershipId });
    expect(JSON.parse(audit!.beforeJson!)).toMatchObject({ active: true });
    expect(JSON.parse(audit!.afterJson!)).toMatchObject({ active: false });
  });

  it("applies BR-3 to every open fixture and reports each promotion", async () => {
    const db = testDb();
    const gameId = await insertGame(db);
    const owner = await insertPlayer(db);
    const player = await insertPlayer(db);
    const waiter = await insertPlayer(db);
    await insertMembership(db, gameId, owner, { role: "owner" });
    await insertMembership(db, gameId, player);

    const a = await insertFixture(db, gameId, { lifecycle: "open", maxPlayers: 1, inCount: 1, waitlistCount: 1 });
    const b = await insertFixture(db, gameId, {
      lifecycle: "open",
      inCount: 1,
      kicksOffAt: new Date("2026-08-27T18:00:00Z"),
    });
    const scheduled = await insertFixture(db, gameId, {
      lifecycle: "scheduled",
      kicksOffAt: new Date("2026-09-03T18:00:00Z"),
    });
    await insertResponse(db, a, player, { status: "in" });
    await insertResponse(db, a, waiter, { status: "waitlisted", waitlistPosition: 3 });
    await insertResponse(db, b, player, { status: "pending" });

    const result = await remove(gameId, player, owner);

    expect(result).toMatchObject({
      kind: "removed",
      promotions: [{ fixtureId: a, promoted: { playerId: waiter, previousWaitlistPosition: 3 } }],
    });
    const rows = await db.select().from(responses).where(eq(responses.playerId, player));
    // The `in` row became `withdrawn`; the `pending` row is gone; the
    // `scheduled` fixture never had a row to begin with (BR-1).
    expect(rows.map((row) => row.status)).toEqual(["withdrawn"]);
    expect(rows[0]!.fixtureId).toBe(a);
    expect(scheduled).toBeDefined();
  });

  it("touches only the target game's fixtures", async () => {
    const db = testDb();
    const owner = await insertPlayer(db);
    const player = await insertPlayer(db);
    const target = await insertGame(db);
    const other = await insertGame(db);
    await insertMembership(db, target, owner, { role: "owner" });
    await insertMembership(db, target, player);
    await insertMembership(db, other, player);
    const mine = await insertFixture(db, target, { lifecycle: "open", inCount: 1 });
    const theirs = await insertFixture(db, other, { lifecycle: "open", inCount: 1 });
    await insertResponse(db, mine, player, { status: "in" });
    await insertResponse(db, theirs, player, { status: "in" });

    await remove(target, player, owner);

    const [untouched] = await db.select().from(responses).where(eq(responses.fixtureId, theirs));
    // Removal from one squad must not disturb the same person's place in
    // another. A `listOpenFixtureIds` that lost its gameId filter fails here.
    expect(untouched).toMatchObject({ status: "in" });
    const [stillAMember] = await db.select().from(memberships).where(eq(memberships.gameId, other));
    expect(stillAMember!.active).toBe(true);
  });

  it("refuses to remove the last active owner", async () => {
    const db = testDb();
    const gameId = await insertGame(db);
    const owner = await insertPlayer(db);
    const membershipId = await insertMembership(db, gameId, owner, { role: "owner" });

    expect(await remove(gameId, owner, owner)).toEqual({ kind: "refused", reason: "last-owner" });
    const [row] = await db.select().from(memberships).where(eq(memberships.id, membershipId));
    expect(row!.active).toBe(true);
    expect(await db.select().from(auditLog)).toHaveLength(0);
  });

  it("allows an owner to remove themselves when a co-owner remains", async () => {
    const db = testDb();
    const gameId = await insertGame(db);
    const leaving = await insertPlayer(db);
    const staying = await insertPlayer(db);
    await insertMembership(db, gameId, leaving, { role: "owner" });
    await insertMembership(db, gameId, staying, { role: "owner" });

    expect(await remove(gameId, leaving, leaving)).toMatchObject({ kind: "removed" });
  });

  it("reports a player who is not in this squad", async () => {
    const db = testDb();
    const gameId = await insertGame(db);
    expect(await remove(gameId, await insertPlayer(db), await insertPlayer(db))).toEqual({ kind: "not-a-member" });
  });

  it("reports an already-inactive membership as not-a-member", async () => {
    const db = testDb();
    const gameId = await insertGame(db);
    const player = await insertPlayer(db);
    await insertMembership(db, gameId, player, { active: false });

    expect(await remove(gameId, player, await insertPlayer(db))).toEqual({ kind: "not-a-member" });
  });
});
```

- [ ] **Step 5: Run the tests to verify they fail**

Run: `npx vitest run test/domain/remove-member.test.ts`
Expected: FAIL — the module does not exist.

- [ ] **Step 6: Implement the orchestrator**

Create `src/domain/remove-member.ts`:

```ts
import { eq } from "drizzle-orm";
import { buildAuditInsert } from "../db/audit.js";
import type { Db } from "../db/client.js";
import { findMembershipInGame, listOpenFixtureIds } from "../db/queries.js";
import { memberships } from "../db/schema.js";
import type { WaitlistPromotion, WithdrawMemberOutcome } from "../capacity/types.js";
import { isLastActiveOwner } from "./last-owner.js";

/** One fixture on which this removal promoted a waitlisted player (BR-7). */
export interface FixturePromotion {
  fixtureId: string;
  promoted: WaitlistPromotion;
}

export interface RemoveMemberParams {
  db: Db;
  gameId: string;
  playerId: string;
  /** The owner performing the removal. */
  actorPlayerId: string;
  now: Date;
  /**
   * Applies BR-3 to one fixture. Injected rather than reached for, so this
   * module holds no Workers binding: the route passes
   * `(id) => env.FIXTURE_CAPACITY.getByName(id).withdrawMember({...})`.
   */
  withdraw: (fixtureId: string) => Promise<WithdrawMemberOutcome>;
}

export type RemoveMemberResult =
  | {
      kind: "removed";
      membershipId: string;
      /** The `left_at` written. Part of N-7's dedupe key — see `removalKey`. */
      leftAt: Date;
      /** Every promotion this removal caused. The caller sends the N-2s. */
      promotions: FixturePromotion[];
    }
  | { kind: "refused"; reason: "last-owner" }
  | { kind: "not-a-member" };

/**
 * Remove a player from a squad, with BR-3's full consequence pass (J6a §3.3).
 *
 * **The order of the two writes is the design.** A removal spans one
 * membership row and N open fixtures, each behind its own Durable Object, and
 * D1 has no cross-object transaction — so the operation cannot be made atomic
 * and this chooses resumability instead:
 *
 * 1. The membership is deactivated **first**, in one `db.batch()` with its
 *    audit row. From that instant the player is out of the squad: they are not
 *    eligible when the next fixture opens (BR-2), and no later failure can
 *    leave them half-in.
 * 2. Only then are the open fixtures walked. `withdrawMember` is idempotent —
 *    a second call finds no row and returns `no-op` — so a failure partway
 *    through leaves *work a retry would finish*, not a corrupted state.
 *
 * It **sends nothing**. Promotions are returned for the caller to notify, for
 * the same reason `FixtureCapacity` returns them: a mail provider's latency
 * must not sit inside a lock, and a mail failure must not roll back a
 * membership change.
 *
 * It does not send N-4 either. If a removal drops a fixture below
 * `min_players`, the owner-attention email is the cron sweep's job, and BR-31
 * caps it at one per fixture ever — so on a fixture already warned about there
 * is no second warning (§3.4).
 */
export async function removeMember(params: RemoveMemberParams): Promise<RemoveMemberResult> {
  const { db, gameId, playerId, actorPlayerId, now, withdraw } = params;

  const member = await findMembershipInGame(db, gameId, playerId);
  // An inactive membership is reported as `not-a-member` too: they are already
  // out of the squad, and the caller answers 404 for both (TR-18).
  if (member === null || !member.active) return { kind: "not-a-member" };

  if (await isLastActiveOwner(db, gameId, member)) return { kind: "refused", reason: "last-owner" };

  await db.batch([
    db.update(memberships).set({ active: false, leftAt: now }).where(eq(memberships.id, member.membershipId)),
    buildAuditInsert(db, {
      actorPlayerId,
      entityType: "membership",
      entityId: member.membershipId,
      action: "membership.removed",
      before: { active: true, leftAt: null, role: member.role },
      after: { active: false, leftAt: now.toISOString(), role: member.role },
      now,
    }),
  ]);

  // Sequential, not concurrent: each call takes a different object's lock, and
  // a squad's open fixtures number in the low single digits. Firing them
  // together would buy nothing and would make a partial failure harder to read
  // in the logs.
  const promotions: FixturePromotion[] = [];
  for (const fixtureId of await listOpenFixtureIds(db, gameId)) {
    const outcome = await withdraw(fixtureId);
    if (outcome.kind === "removed" && outcome.promoted) {
      promotions.push({ fixtureId, promoted: outcome.promoted });
    }
  }

  return { kind: "removed", membershipId: member.membershipId, leftAt: now, promotions };
}
```

- [ ] **Step 7: Run the tests, then the full suite**

Run: `npx vitest run test/domain/remove-member.test.ts && npm test`
Expected: PASS.

- [ ] **Step 8: Lint, typecheck, commit**

```bash
npm run lint && npm run typecheck
git add src/domain/last-owner.ts src/domain/remove-member.ts test/domain/last-owner.test.ts test/domain/remove-member.test.ts
git commit -m "feat: removeMember, BR-3 end to end"
```

---

## Task 5: Changing a member's role

**Spec:** §4.

**Files:**
- Create: `src/domain/change-role.ts`
- Test: `test/domain/change-role.test.ts`

**Interfaces:**
- Consumes: `findMembershipInGame` (Task 2), `isLastActiveOwner` (Task 4), `buildAuditInsert`.
- Produces:
  ```ts
  export type MemberRole = "player" | "owner";
  export function parseRole(value: unknown): MemberRole | null;
  export type ChangeRoleResult =
    | { kind: "changed"; role: MemberRole }
    | { kind: "unchanged"; role: MemberRole }
    | { kind: "refused"; reason: "last-owner" }
    | { kind: "not-a-member" };
  export async function changeMemberRole(params: {
    db: Db; gameId: string; playerId: string; actorPlayerId: string; role: MemberRole; now: Date;
  }): Promise<ChangeRoleResult>;
  ```

- [ ] **Step 1: Write the failing tests**

Create `test/domain/change-role.test.ts`:

```ts
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { auditLog, memberships } from "../../src/db/schema.js";
import { changeMemberRole, parseRole } from "../../src/domain/change-role.js";
import { insertGame, insertMembership, insertPlayer, resetDatabase, testDb } from "../support/factories.js";

const NOW = new Date("2026-08-13T12:00:00Z");

describe("parseRole", () => {
  it("accepts exactly the two roles", () => {
    expect(parseRole("owner")).toBe("owner");
    expect(parseRole("player")).toBe("player");
  });

  it("rejects anything else", () => {
    for (const value of ["Owner", "admin", "", undefined, null, 1, ["owner"]]) {
      expect(parseRole(value)).toBeNull();
    }
  });
});

describe("changeMemberRole", () => {
  beforeEach(resetDatabase);

  it("promotes a player to owner and audits it", async () => {
    const db = testDb();
    const gameId = await insertGame(db);
    const actor = await insertPlayer(db);
    const player = await insertPlayer(db);
    await insertMembership(db, gameId, actor, { role: "owner" });
    const membershipId = await insertMembership(db, gameId, player);

    expect(await changeMemberRole({ db, gameId, playerId: player, actorPlayerId: actor, role: "owner", now: NOW }))
      .toEqual({ kind: "changed", role: "owner" });

    const [row] = await db.select().from(memberships).where(eq(memberships.id, membershipId));
    expect(row!.role).toBe("owner");
    const [audit] = await db.select().from(auditLog).where(eq(auditLog.action, "membership.role_changed"));
    expect(audit).toMatchObject({ actorPlayerId: actor, entityId: membershipId });
    expect(JSON.parse(audit!.beforeJson!)).toMatchObject({ role: "player" });
    expect(JSON.parse(audit!.afterJson!)).toMatchObject({ role: "owner" });
  });

  it("demotes an owner when a co-owner remains", async () => {
    const db = testDb();
    const gameId = await insertGame(db);
    const actor = await insertPlayer(db);
    const other = await insertPlayer(db);
    await insertMembership(db, gameId, actor, { role: "owner" });
    await insertMembership(db, gameId, other, { role: "owner" });

    expect(await changeMemberRole({ db, gameId, playerId: other, actorPlayerId: actor, role: "player", now: NOW }))
      .toEqual({ kind: "changed", role: "player" });
  });

  it("refuses to demote the last active owner", async () => {
    const db = testDb();
    const gameId = await insertGame(db);
    const actor = await insertPlayer(db);
    const membershipId = await insertMembership(db, gameId, actor, { role: "owner" });

    expect(await changeMemberRole({ db, gameId, playerId: actor, actorPlayerId: actor, role: "player", now: NOW }))
      .toEqual({ kind: "refused", reason: "last-owner" });
    const [row] = await db.select().from(memberships).where(eq(memberships.id, membershipId));
    expect(row!.role).toBe("owner");
    expect(await db.select().from(auditLog)).toHaveLength(0);
  });

  it("writes nothing when the role is already what was asked for", async () => {
    const db = testDb();
    const gameId = await insertGame(db);
    const actor = await insertPlayer(db);
    const other = await insertPlayer(db);
    await insertMembership(db, gameId, actor, { role: "owner" });
    await insertMembership(db, gameId, other, { role: "owner" });

    expect(await changeMemberRole({ db, gameId, playerId: other, actorPlayerId: actor, role: "owner", now: NOW }))
      .toEqual({ kind: "unchanged", role: "owner" });
    // No audit row: nothing changed, and an audit trail of non-events is noise.
    expect(await db.select().from(auditLog)).toHaveLength(0);
  });

  it("reports a player who is not in this squad", async () => {
    const db = testDb();
    const gameId = await insertGame(db);
    expect(
      await changeMemberRole({
        db,
        gameId,
        playerId: await insertPlayer(db),
        actorPlayerId: await insertPlayer(db),
        role: "owner",
        now: NOW,
      }),
    ).toEqual({ kind: "not-a-member" });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/domain/change-role.test.ts`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement it**

Create `src/domain/change-role.ts`:

```ts
import { eq } from "drizzle-orm";
import { buildAuditInsert } from "../db/audit.js";
import type { Db } from "../db/client.js";
import { findMembershipInGame } from "../db/queries.js";
import { memberships } from "../db/schema.js";
import { isLastActiveOwner } from "./last-owner.js";

export type MemberRole = "player" | "owner";

/**
 * The submitted role, or `null`.
 *
 * Exact-match only — no case folding, no trimming. The value comes from a
 * `<select>` this application rendered, so anything else is a hand-built
 * request and gets a 400 rather than a guess at what was meant.
 */
export function parseRole(value: unknown): MemberRole | null {
  return value === "owner" || value === "player" ? value : null;
}

export type ChangeRoleResult =
  | { kind: "changed"; role: MemberRole }
  | { kind: "unchanged"; role: MemberRole }
  | { kind: "refused"; reason: "last-owner" }
  | { kind: "not-a-member" };

/**
 * Promote a player to organiser, or demote one back (J6a §4).
 *
 * One function for both directions, deliberately: promotion and demotion
 * differ only in the target value, and two functions would eventually
 * disagree about the guard. The guard is the project's one squad invariant —
 * a game always keeps at least one active owner — which here refuses exactly
 * the demotion of the last owner.
 *
 * Promotion is unrestricted in the other direction. One-way promotion was
 * considered and rejected: promote the wrong person with no way back and the
 * mistake is permanent short of a hand edit of D1.
 */
export async function changeMemberRole(params: {
  db: Db;
  gameId: string;
  playerId: string;
  actorPlayerId: string;
  role: MemberRole;
  now: Date;
}): Promise<ChangeRoleResult> {
  const { db, gameId, playerId, actorPlayerId, role, now } = params;

  const member = await findMembershipInGame(db, gameId, playerId);
  if (member === null || !member.active) return { kind: "not-a-member" };
  if (member.role === role) return { kind: "unchanged", role };

  // Only a demotion can break the invariant; `isLastActiveOwner` is false for
  // anyone who is not an active owner, so a promotion never reaches a refusal.
  if (role === "player" && (await isLastActiveOwner(db, gameId, member))) {
    return { kind: "refused", reason: "last-owner" };
  }

  await db.batch([
    db.update(memberships).set({ role }).where(eq(memberships.id, member.membershipId)),
    buildAuditInsert(db, {
      actorPlayerId,
      entityType: "membership",
      entityId: member.membershipId,
      action: "membership.role_changed",
      before: { role: member.role },
      after: { role },
      now,
    }),
  ]);

  return { kind: "changed", role };
}
```

- [ ] **Step 4: Run the tests, then the full suite**

Run: `npx vitest run test/domain/change-role.test.ts && npm test`
Expected: PASS.

- [ ] **Step 5: Lint, typecheck, commit**

```bash
npm run lint && npm run typecheck
git add src/domain/change-role.ts test/domain/change-role.test.ts
git commit -m "feat: promote and demote a squad member"
```

---

## Task 6: N-7's key and copy

**Spec:** §5.

**Files:**
- Modify: `src/notify/dedupe-key.ts`
- Create: `src/notify/templates/removed.ts`
- Test: `test/notify/removed.test.ts` (create), `test/notify/dedupe-key.test.ts` (existing — append)

**Interfaces:**
- Produces:
  ```ts
  export function removalKey(membershipId: string, leftAt: string): string; // `n7:<membershipId>:<leftAt>`
  export interface RemovedEmailPayload { playerName: string; gameName: string }
  export interface RemovedEmail { subject: string; html: string; text: string }
  export function renderRemovedEmail(payload: RemovedEmailPayload): RemovedEmail;
  ```

Read `src/notify/templates/welcome.ts` first — N-7 is modelled on N-6 and should read like its sibling, not like a new author's work.

- [ ] **Step 1: Write the failing tests**

Append to `test/notify/dedupe-key.test.ts`:

```ts
describe("removalKey", () => {
  it("names the removal, not merely the membership", () => {
    expect(removalKey("m-1", "2026-08-13T12:00:00.000Z")).toBe("n7:m-1:2026-08-13T12:00:00.000Z");
  });

  it("differs across a join → remove → rejoin → remove cycle", () => {
    // UNIQUE (game_id, player_id) forces a rejoin to reuse the membership row,
    // so the id alone is the same string both times and the unique index on
    // `dedupe_key` would silently drop the second removal email. This is the
    // identical trap N-6 hit; `left_at` is the identical fix.
    expect(removalKey("m-1", "2026-08-13T12:00:00.000Z")).not.toBe(
      removalKey("m-1", "2026-09-01T09:00:00.000Z"),
    );
  });
});
```

Create `test/notify/removed.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { renderRemovedEmail } from "../../src/notify/templates/removed.js";

describe("renderRemovedEmail", () => {
  const rendered = renderRemovedEmail({ playerName: "Sam Okafor", gameName: "Thursday 7-a-side" });

  it("names the game in the subject", () => {
    expect(rendered.subject).toContain("Thursday 7-a-side");
  });

  it("greets the player and says they will get no more email about it", () => {
    expect(rendered.text).toContain("Sam Okafor");
    expect(rendered.text).toContain("Thursday 7-a-side");
    expect(rendered.text.toLowerCase()).toContain("no more");
  });

  it("carries no leave link, because there is nothing left to leave", () => {
    // The one email in the catalogue for which BR-22 is satisfied by the
    // subject matter. See the module comment.
    expect(rendered.html).not.toContain("/leave/");
    expect(rendered.text).not.toContain("/leave/");
  });

  it("escapes a name containing markup", () => {
    const nasty = renderRemovedEmail({ playerName: "<script>alert(1)</script>", gameName: "A & B" });
    expect(nasty.html).not.toContain("<script>");
    expect(nasty.html).toContain("&amp;");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/notify/removed.test.ts test/notify/dedupe-key.test.ts`
Expected: FAIL — neither `removalKey` nor the template exists.

- [ ] **Step 3: Add the type and the key**

In `src/notify/dedupe-key.ts`, extend the enum and append the key builder:

```ts
export const NOTIFICATION_TYPES = ["n1", "n2", "n3", "n4", "n5", "n6", "n7"] as const;
```

```ts
/**
 * N-7, the removal email: once per removal.
 *
 * `leftAt`, not the membership id alone, for exactly the reason `welcomeKey`
 * takes `joinedAt`. `UNIQUE (game_id, player_id)` on `memberships` forces a
 * rejoin to reactivate the existing row, so across a join → remove → rejoin →
 * remove cycle the membership id is the same string both times, and the unique
 * index on `dedupe_key` would silently drop the second email. Passed as an ISO
 * string by every caller.
 */
export function removalKey(membershipId: string, leftAt: string): string {
  return `n7:${membershipId}:${leftAt}`;
}
```

- [ ] **Step 4: Write the template**

Create `src/notify/templates/removed.ts`:

```ts
import { escapeHtml } from "../../views/layout.js";

/**
 * Everything the removal email (N-7) needs. Pure (TR-20): no clock, no
 * bindings, no database, no lookups — every string arriving here is already
 * exactly what should be shown.
 *
 * The second email in the catalogue with no Fixture behind it, after N-6:
 * being removed from a squad is a membership event, and it may happen when the
 * game has no fixture at all.
 *
 * **No leave or unsubscribe link.** Every other notification carries one under
 * BR-22, and its absence here is deliberate rather than an omission: there is
 * nothing left to leave. This is the one message in the system whose subject
 * matter satisfies BR-22 on its own — it *is* the confirmation that no further
 * mail about this game is coming.
 *
 * No dashboard link either, unlike N-6. The dashboard shows the games a player
 * belongs to, and this one is no longer among them; sending them there to find
 * nothing would be a worse answer than the sentence in the copy.
 */
export interface RemovedEmailPayload {
  /** The player this copy is for. Shown only in a plain greeting. */
  playerName: string;
  gameName: string;
}

export interface RemovedEmail {
  subject: string;
  html: string;
  text: string;
}

/**
 * Render the email telling a player they have been removed from a squad
 * (N-7, J6a §5).
 *
 * The copy states the fact and stops. It does not say who removed them or
 * why: the organiser knows both, this is usually the tail of a conversation
 * that already happened, and speculating in either direction would be worse
 * than the plain sentence.
 */
export function renderRemovedEmail(payload: RemovedEmailPayload): RemovedEmail {
  const { playerName, gameName } = payload;

  const text = [
    `Hi ${playerName},`,
    "",
    `You've been removed from the squad for ${gameName}.`,
    "",
    "You'll get no more email about this game. If you think it was a mistake,",
    "ask the organiser — they can send you the invite link again.",
  ].join("\n");

  const html = [
    `<p>Hi ${escapeHtml(playerName)},</p>`,
    `<p>You've been removed from the squad for ${escapeHtml(gameName)}.</p>`,
    "<p>You'll get no more email about this game. If you think it was a mistake, ask the organiser — they can send you the invite link again.</p>",
  ].join("\n");

  return { subject: `You've been removed from ${gameName}`, html, text };
}
```

- [ ] **Step 5: Run the tests, then the full suite**

Run: `npx vitest run test/notify && npm test`
Expected: PASS. If a test enumerates `NOTIFICATION_TYPES` and asserts a length or an exact array, update it to include `"n7"` — that is the enumeration doing its job.

- [ ] **Step 6: Lint, typecheck, commit**

```bash
npm run lint && npm run typecheck
git add src/notify/dedupe-key.ts src/notify/templates/removed.ts test/notify/removed.test.ts test/notify/dedupe-key.test.ts
git commit -m "feat: N-7's dedupe key and copy"
```

---

## Task 7: Sending N-7

**Spec:** §5.

**Files:**
- Create: `src/notify/send-removed.ts`
- Test: `test/notify/send-removed.test.ts`

**Interfaces:**
- Consumes: `removalKey`, `renderRemovedEmail` (Task 6); `insertQueuedLogRows`, `applySendResult`, `PendingNotification` from `src/notify/delivery.js`; `Notifier`.
- Produces:
  ```ts
  export type RemovedSendOutcome =
    | { kind: "sent" } | { kind: "deferred" } | { kind: "failed"; reason: string }
    | { kind: "already-logged" } | { kind: "skipped-no-recipient" };
  export async function sendRemovedEmail(params: {
    db: Db; notifier: Notifier; gameId: string; playerId: string;
    membershipId: string; leftAt: Date; now: Date;
  }): Promise<RemovedSendOutcome>;
  ```

**Read `src/notify/send-welcome.ts` in full before writing this.** N-7's send path is N-6's with a different key, template and type; every ordering decision, every outcome branch and the `.trim()` on the address are copied from it deliberately, not reinvented. Look at how the existing `test/notify/send-welcome.test.ts` builds its notifier stub and mirror it.

- [ ] **Step 1: Write the failing tests**

Create `test/notify/send-removed.test.ts`. Match the notifier stub style already used in `test/notify/send-welcome.test.ts` (run `grep -n "notifier\|Notifier" test/notify/send-welcome.test.ts` and copy its shape rather than inventing another).

```ts
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { notificationLog } from "../../src/db/schema.js";
import { sendRemovedEmail } from "../../src/notify/send-removed.js";
import type { Message, Notifier } from "../../src/notify/notifier.js";
import { insertGame, insertPlayer, resetDatabase, testDb } from "../support/factories.js";

const NOW = new Date("2026-08-13T12:00:00Z");
const LEFT_AT = new Date("2026-08-13T11:59:00Z");

function recordingNotifier(): Notifier & { sent: Message[] } {
  const sent: Message[] = [];
  return {
    sent,
    async send(messages: Message[]) {
      sent.push(...messages);
      return messages.map((message) => ({ kind: "sent" as const, dedupeKey: message.dedupeKey }));
    },
  };
}

describe("sendRemovedEmail", () => {
  beforeEach(resetDatabase);

  it("sends the email and records a sent log row with no fixture", async () => {
    const db = testDb();
    const gameId = await insertGame(db, { name: "Thursday 7-a-side" });
    const playerId = await insertPlayer(db, { name: "Sam Okafor", email: "sam@example.com" });
    const notifier = recordingNotifier();

    const outcome = await sendRemovedEmail({
      db, notifier, gameId, playerId, membershipId: "m-1", leftAt: LEFT_AT, now: NOW,
    });

    expect(outcome).toEqual({ kind: "sent" });
    expect(notifier.sent[0]).toMatchObject({ to: "sam@example.com" });
    expect(notifier.sent[0]!.subject).toContain("Thursday 7-a-side");

    const [row] = await db.select().from(notificationLog);
    expect(row).toMatchObject({
      notificationType: "n7",
      // Null, like N-6: a removal is not fixture-scoped, and naming a fixture
      // would make the row a lie.
      fixtureId: null,
      playerId,
      status: "sent",
      dedupeKey: `n7:m-1:${LEFT_AT.toISOString()}`,
    });
  });

  it("skips a player with no address and writes no row at all (BR-32)", async () => {
    const db = testDb();
    const gameId = await insertGame(db);
    const playerId = await insertPlayer(db, { name: "Ringer", email: null, isGuest: true });
    const notifier = recordingNotifier();

    expect(
      await sendRemovedEmail({ db, notifier, gameId, playerId, membershipId: "m-1", leftAt: LEFT_AT, now: NOW }),
    ).toEqual({ kind: "skipped-no-recipient" });
    expect(notifier.sent).toHaveLength(0);
    // Not a failure and not retryable, so not a row — a row here would be
    // noise that something later has to clean up.
    expect(await db.select().from(notificationLog)).toHaveLength(0);
  });

  it("skips a blank address, which is truthy but unusable", async () => {
    const db = testDb();
    const gameId = await insertGame(db);
    const playerId = await insertPlayer(db, { email: "   " });
    const notifier = recordingNotifier();

    expect(
      await sendRemovedEmail({ db, notifier, gameId, playerId, membershipId: "m-1", leftAt: LEFT_AT, now: NOW }),
    ).toEqual({ kind: "skipped-no-recipient" });
  });

  it("does not send twice for the same removal", async () => {
    const db = testDb();
    const gameId = await insertGame(db);
    const playerId = await insertPlayer(db);
    const notifier = recordingNotifier();
    const args = { db, notifier, gameId, playerId, membershipId: "m-1", leftAt: LEFT_AT, now: NOW };

    await sendRemovedEmail(args);
    // The unique index on `dedupe_key`, not any cleverness here, is what makes
    // this safe under concurrency.
    expect(await sendRemovedEmail(args)).toEqual({ kind: "already-logged" });
    expect(notifier.sent).toHaveLength(1);
  });

  it("sends again after a rejoin and a second removal", async () => {
    const db = testDb();
    const gameId = await insertGame(db);
    const playerId = await insertPlayer(db);
    const notifier = recordingNotifier();
    const base = { db, notifier, gameId, playerId, membershipId: "m-1", now: NOW };

    await sendRemovedEmail({ ...base, leftAt: LEFT_AT });
    await sendRemovedEmail({ ...base, leftAt: new Date("2026-09-01T09:00:00Z") });

    expect(notifier.sent).toHaveLength(2);
  });

  it("reports a game that has vanished, without writing a row", async () => {
    const db = testDb();
    const playerId = await insertPlayer(db);
    const notifier = recordingNotifier();

    expect(
      await sendRemovedEmail({
        db, notifier, gameId: crypto.randomUUID(), playerId, membershipId: "m-1", leftAt: LEFT_AT, now: NOW,
      }),
    ).toEqual({ kind: "failed", reason: "game-not-found" });
    expect(await db.select().from(notificationLog)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/notify/send-removed.test.ts`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement the sender**

Create `src/notify/send-removed.ts`:

```ts
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { games, notificationLog, players } from "../db/schema.js";
import { removalKey } from "./dedupe-key.js";
import { applySendResult, insertQueuedLogRows, type PendingNotification } from "./delivery.js";
import type { Notifier } from "./notifier.js";
import { renderRemovedEmail } from "./templates/removed.js";

/**
 * What the N-7 send attempt did. Every branch is a value rather than a throw,
 * for the same reason as N-6: this runs *after* the removal is committed, so
 * there is no caller left who could usefully handle an exception — but there
 * is a reader of logs who needs to know which of these happened. An email that
 * never arrives must never be what undoes a removal.
 */
export type RemovedSendOutcome =
  | { kind: "sent" }
  | { kind: "deferred" }
  | { kind: "failed"; reason: string }
  | { kind: "already-logged" }
  | { kind: "skipped-no-recipient" };

export interface SendRemovedEmailParams {
  db: Db;
  /** Always the quota-wrapped notifier from `createNotifier` — never a raw provider. */
  notifier: Notifier;
  gameId: string;
  playerId: string;
  /** From `RemoveMemberResult`. Part of the dedupe key, with `leftAt`. */
  membershipId: string;
  /** The `memberships.left_at` this removal wrote. Part of the dedupe key — see `removalKey`. */
  leftAt: Date;
  now: Date;
}

/**
 * Tell a player they have been removed from a squad (N-7, J6a §5).
 *
 * N-6's send path with a different key, template and type, and deliberately no
 * other differences — read `src/notify/send-welcome.ts` for the reasoning
 * behind each step, which applies here unchanged:
 *
 * - `fixtureId: null`, because a removal is about a *membership*.
 * - The dedupe key carries `leftAt`, so a rejoin and a second removal are a
 *   second email rather than one the unique index silently drops.
 * - The ordering is the sweep's (BR-19): `queued` row first, send second,
 *   result recorded third — inheriting the retryability asymmetry, where a
 *   ceiling refusal removes the row so a later attempt is possible and a
 *   provider error leaves it `failed` forever, because an ambiguous failure
 *   may already have reached the inbox.
 */
export async function sendRemovedEmail(params: SendRemovedEmailParams): Promise<RemovedSendOutcome> {
  const { db, notifier, gameId, playerId, membershipId, leftAt, now } = params;

  const [player] = await db
    .select({ name: players.name, email: players.email, isGuest: players.isGuest })
    .from(players)
    .where(eq(players.id, playerId));

  // BR-32: a guest, or anyone whose address is missing or blank, is skipped
  // before a message is built and before anything is written. The `.trim()`
  // matches every other sender's and is load-bearing for the same reason: an
  // email of `" "` is truthy, and letting it through would produce a `queued`
  // row and a `no-recipient` result nothing usefully acts on.
  const email = player?.email?.trim() ?? "";
  if (player === undefined || player.isGuest || email === "") return { kind: "skipped-no-recipient" };

  const [game] = await db.select({ name: games.name }).from(games).where(eq(games.id, gameId));
  // Unreachable in practice — the caller has just updated a membership row
  // whose FK points at this game — so it is reported rather than branched on.
  if (!game) return { kind: "failed", reason: "game-not-found" };

  const rendered = renderRemovedEmail({ playerName: player.name, gameName: game.name });

  const dedupeKey = removalKey(membershipId, leftAt.toISOString());
  const pending: PendingNotification = {
    logId: crypto.randomUUID(),
    dedupeKey,
    playerId,
    message: {
      channel: "email",
      to: email,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      dedupeKey,
    },
  };

  const [inserted] = await insertQueuedLogRows(db, { fixtureId: null, notificationType: "n7" }, [pending]);
  if (!inserted) return { kind: "already-logged" };

  let results;
  try {
    results = await notifier.send([inserted.message]);
  } catch (error) {
    // The notifier rejected — e.g. `QuotaNotifier.reserve()` hitting a D1
    // error. Whether the message reached a provider first is unknowable from
    // here, so the row is left `failed` (ambiguous, never retried), exactly as
    // every other sender does with the same situation.
    const reason = error instanceof Error ? error.message : String(error);
    await db
      .update(notificationLog)
      .set({ status: "failed", error: reason })
      .where(eq(notificationLog.id, inserted.logId));
    return { kind: "failed", reason };
  }

  return applySendResult(db, inserted, results[0], now);
}
```

- [ ] **Step 4: Run the tests, then the full suite**

Run: `npx vitest run test/notify/send-removed.test.ts && npm test`
Expected: PASS.

- [ ] **Step 5: Lint, typecheck, commit**

```bash
npm run lint && npm run typecheck
git add src/notify/send-removed.ts test/notify/send-removed.test.ts
git commit -m "feat: send N-7 when a member is removed"
```

---

## Task 8: The confirmation page

**Spec:** §2 (the "GET-then-POST" paragraph).

**Files:**
- Modify: `src/auth/paths.ts`
- Create: `src/views/remove-member.ts`
- Test: `test/views/remove-member.test.ts`

**Interfaces:**
- Consumes: `escapeHtml`, `layout` from `src/views/layout.js`; `FORM_CSS` is already registered — check whether `renderGameOverviewPage` passes a stylesheet argument to `layout` and match it exactly.
- Produces:
  ```ts
  export function memberRolePath(gameId: string, playerId: string): string;   // /g/<id>/squad/<pid>/role
  export function memberRemovePath(gameId: string, playerId: string): string; // /g/<id>/squad/<pid>/remove
  export interface RemoveMemberPageParams {
    gameId: string; playerId: string; gameName: string; memberName: string; isOwner: boolean;
    commitments: { in: number; waitlisted: number };
  }
  export function renderRemoveMemberPage(params: RemoveMemberPageParams): string;
  ```

Read `src/views/game-overview.ts` and `src/views/cancel.ts` first, and match how they call `layout` — this page must not be the one that introduces a different page shell.

- [ ] **Step 1: Write the failing tests**

Create `test/views/remove-member.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { memberRemovePath, memberRolePath } from "../../src/auth/paths.js";
import { renderRemoveMemberPage } from "../../src/views/remove-member.js";

const BASE = {
  gameId: "g-1",
  playerId: "p-1",
  gameName: "Thursday 7-a-side",
  memberName: "Sam Okafor",
  isOwner: false,
};

describe("paths", () => {
  it("builds the two squad paths", () => {
    expect(memberRolePath("g-1", "p-1")).toBe("/g/g-1/squad/p-1/role");
    expect(memberRemovePath("g-1", "p-1")).toBe("/g/g-1/squad/p-1/remove");
  });
});

describe("renderRemoveMemberPage", () => {
  it("names the member and the game, and posts back to the same path", () => {
    const html = renderRemoveMemberPage({ ...BASE, commitments: { in: 0, waitlisted: 0 } });
    expect(html).toContain("Sam Okafor");
    expect(html).toContain("Thursday 7-a-side");
    expect(html).toContain('method="post"');
    expect(html).toContain('action="/g/g-1/squad/p-1/remove"');
  });

  it("states a confirmed place in the singular", () => {
    const html = renderRemoveMemberPage({ ...BASE, commitments: { in: 1, waitlisted: 0 } });
    expect(html).toContain("1 upcoming fixture");
    expect(html).not.toContain("1 upcoming fixtures");
  });

  it("states several confirmed places in the plural", () => {
    const html = renderRemoveMemberPage({ ...BASE, commitments: { in: 2, waitlisted: 0 } });
    expect(html).toContain("2 upcoming fixtures");
  });

  it("mentions the waiting list only when they are on one", () => {
    const none = renderRemoveMemberPage({ ...BASE, commitments: { in: 1, waitlisted: 0 } });
    expect(none.toLowerCase()).not.toContain("waiting list");
    const some = renderRemoveMemberPage({ ...BASE, commitments: { in: 0, waitlisted: 2 } });
    expect(some.toLowerCase()).toContain("waiting list");
  });

  it("says plainly when there is nothing upcoming to affect", () => {
    // Rather than a sentence about freed places that quietly does not apply.
    const html = renderRemoveMemberPage({ ...BASE, commitments: { in: 0, waitlisted: 0 } });
    expect(html).toContain("no upcoming fixtures");
  });

  it("warns when the member being removed is an organiser", () => {
    const html = renderRemoveMemberPage({ ...BASE, isOwner: true, commitments: { in: 0, waitlisted: 0 } });
    expect(html.toLowerCase()).toContain("organiser");
  });

  it("offers a way back that changes nothing", () => {
    const html = renderRemoveMemberPage({ ...BASE, commitments: { in: 0, waitlisted: 0 } });
    expect(html).toContain('href="/g/g-1"');
  });

  it("escapes a name containing markup", () => {
    const html = renderRemoveMemberPage({
      ...BASE,
      memberName: "<script>alert(1)</script>",
      commitments: { in: 0, waitlisted: 0 },
    });
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  it("uses no inline style attribute (style-src hashes do not cover attributes)", () => {
    const html = renderRemoveMemberPage({ ...BASE, commitments: { in: 1, waitlisted: 1 } });
    expect(html).not.toMatch(/style="/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/views/remove-member.test.ts`
Expected: FAIL — neither the paths nor the view exist.

- [ ] **Step 3: Add the paths**

Append to `src/auth/paths.ts`:

```ts
/**
 * The two squad-management controls on a game's own page (J6a).
 *
 * Both take the *player* id rather than the membership id: the owner page
 * already lists players, and a membership id is an internal identifier that
 * would have to be plumbed through the view for no gain. Both handlers scope
 * the lookup by game id as well, so a player id in the path can neither be
 * probed nor used against another squad (TR-18).
 */
export function memberRolePath(gameId: string, playerId: string): string {
  return `/g/${gameId}/squad/${playerId}/role`;
}

export function memberRemovePath(gameId: string, playerId: string): string {
  return `/g/${gameId}/squad/${playerId}/remove`;
}
```

- [ ] **Step 4: Write the view**

Create `src/views/remove-member.ts`. Match `src/views/game-overview.ts`'s `layout(...)` call signature exactly — copy it rather than guessing.

```ts
import { gamePath, memberRemovePath } from "../auth/paths.js";
import { escapeHtml, layout } from "./layout.js";
import { FORM_CSS } from "./styles.js";

export interface RemoveMemberPageParams {
  gameId: string;
  /** The member being removed. In the form's `action`, so it cannot be omitted. */
  playerId: string;
  gameName: string;
  memberName: string;
  /** Whether the member being removed is an organiser. Changes the warning, not the outcome. */
  isOwner: boolean;
  /** What they hold on this game's open fixtures right now, from `countCommitments`. */
  commitments: { in: number; waitlisted: number };
}

/** "1 upcoming fixture" / "2 upcoming fixtures" — never "1 upcoming fixtures". */
function fixtures(count: number): string {
  return `${count} upcoming fixture${count === 1 ? "" : "s"}`;
}

/**
 * The removal confirmation (J6a §2).
 *
 * A served page and a real form post, not a `confirm()` dialog: removal is
 * destructive, the owner cannot undo it (only the removed player can rejoin,
 * via the invite link), and everything a person *must* be able to do has to
 * work with JavaScript off.
 *
 * The consequences are stated in specifics computed from live rows rather than
 * in general terms, because "this may affect upcoming fixtures" is exactly the
 * warning people click past. A member with nothing upcoming is told *that*,
 * rather than shown a sentence about freed places that quietly does not apply
 * to them.
 */
export function renderRemoveMemberPage(params: RemoveMemberPageParams): string {
  const { gameId, playerId, gameName, memberName, isOwner, commitments } = params;
  const name = escapeHtml(memberName);

  const consequences: string[] = [];
  if (commitments.in > 0) {
    consequences.push(
      `<p>${name} holds a confirmed place in ${fixtures(commitments.in)}. Removing them frees ${
        commitments.in === 1 ? "it" : "them"
      }, and the next person on each waiting list takes the place.</p>`,
    );
  }
  if (commitments.waitlisted > 0) {
    consequences.push(
      `<p>${name} is on the waiting list for ${fixtures(commitments.waitlisted)}. Those places on the list go.</p>`,
    );
  }
  if (consequences.length === 0) {
    consequences.push(`<p>${name} has no upcoming fixtures, so nothing else changes.</p>`);
  }

  const ownerWarning = isOwner
    ? `<p class="nudge">${name} is an organiser of this game. Removing them takes that away too.</p>`
    : "";

  const body = `
    <h1>Remove ${name}?</h1>
    <p>They'll be taken out of the squad for ${escapeHtml(gameName)} and told by email.</p>
    ${ownerWarning}
    ${consequences.join("\n    ")}
    <p>They can join again themselves with the invite link. You can't put them back.</p>
    <form method="post" action="${escapeHtml(memberRemovePath(gameId, playerId))}">
      <button class="button primary" type="submit">Remove ${name}</button>
    </form>
    <p><a href="${escapeHtml(gamePath(gameId))}">No, leave the squad as it is</a></p>
  `;

  return layout({ title: `Remove ${memberName}`, body, pageStyles: [FORM_CSS] });
}
```

`pageStyles`, not `styles` — `layout`'s destructured options are
`{ title, body, pageStyles, pageScripts }` (`src/views/layout.ts:129`). Every
entry in `pageStyles` must already be registered in `PAGE_STYLE_BLOCKS`
(`src/views/styles.ts`) or the CSP will not carry its hash and the browser will
drop the stylesheet — `FORM_CSS` is registered, which is why this page reuses
it rather than introducing a block of its own.

- [ ] **Step 5: Run the tests, then the full suite**

Run: `npx vitest run test/views/remove-member.test.ts && npm test`
Expected: PASS.

- [ ] **Step 6: Lint, typecheck, commit**

```bash
npm run lint && npm run typecheck
git add src/auth/paths.ts src/views/remove-member.ts test/views/remove-member.test.ts
git commit -m "feat: the removal confirmation page"
```

---

## Task 9: The three routes

**Spec:** §2, §2.1, §4, §7.

**Files:**
- Modify: `src/routes/games.ts`
- Test: `test/routes/squad.test.ts` (create)

**Interfaces:**
- Consumes: everything from Tasks 2, 4, 5, 7, 8; `notifyPromotedPlayer` exported from `src/routes/respond.ts`; `createNotifier` from `src/notify/factory.js`; `wrongOrigin`, `requirePlayer`, `findGameForOwner` already in `src/routes/games.ts`.

Registration order still matters — read the module comment at the top of `src/routes/games.ts`. These routes go **after** `NEW_GAME_PATH`, alongside the existing `/g/:id` handlers.

- [ ] **Step 1: Write the failing tests**

Create `test/routes/squad.test.ts`. Copy the `post` helper and the `signIn` usage from `test/routes/games.test.ts` verbatim rather than inventing another shape.

```ts
import { env, SELF } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
// Deliberately no `notificationLog` here: N-7 is sent from a `waitUntil`, and
// a route test that reads that table races the send — a row landing after
// `resetDatabase()` breaks the next test's reset on a foreign key. That
// behaviour belongs to `test/notify/send-removed.test.ts`.
import { auditLog, memberships, players, responses } from "../../src/db/schema.js";
import {
  insertFixture,
  insertGame,
  insertMembership,
  insertPlayer,
  insertResponse,
  resetDatabase,
  testDb,
} from "../support/factories.js";
import { ALLOWED, ORIGIN, signIn } from "../support/sign-in.js";

async function post(path: string, cookie: string, fields: Record<string, string> = {}) {
  return SELF.fetch(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, cookie },
    body: new URLSearchParams(fields),
    redirect: "manual",
  });
}

/** A game owned by the signed-in player, plus one ordinary member. */
async function ownedGame() {
  const { cookie } = await signIn();
  const db = testDb();
  const [viewer] = await db.select().from(players).where(eq(players.email, ALLOWED));
  const gameId = await insertGame(db, { name: "Thursday 7-a-side" });
  await insertMembership(db, gameId, viewer!.id, { role: "owner" });
  const memberId = await insertPlayer(db, { name: "Sam Okafor", email: "sam@example.com" });
  await insertMembership(db, gameId, memberId);
  return { cookie, gameId, ownerId: viewer!.id, memberId, db };
}

describe("GET /g/:id/squad/:playerId/remove", () => {
  beforeEach(resetDatabase);

  it("shows the confirmation with the member's commitments", async () => {
    const { cookie, gameId, memberId, db } = await ownedGame();
    const fixtureId = await insertFixture(db, gameId, { lifecycle: "open", inCount: 1 });
    await insertResponse(db, fixtureId, memberId, { status: "in" });

    const response = await SELF.fetch(`${ORIGIN}/g/${gameId}/squad/${memberId}/remove`, { headers: { cookie } });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Sam Okafor");
    expect(html).toContain("1 upcoming fixture");
  });

  it("404s for a game the viewer does not own", async () => {
    const { cookie } = await signIn();
    const db = testDb();
    const gameId = await insertGame(db);
    const memberId = await insertPlayer(db);
    await insertMembership(db, gameId, memberId);

    // 404, not 403: a 403 confirms the game exists (TR-18).
    const response = await SELF.fetch(`${ORIGIN}/g/${gameId}/squad/${memberId}/remove`, { headers: { cookie } });
    expect(response.status).toBe(404);
  });

  it("404s for a player who is in another game's squad", async () => {
    const { cookie, gameId } = await ownedGame();
    const db = testDb();
    const stranger = await insertPlayer(db);
    await insertMembership(db, await insertGame(db), stranger);

    const response = await SELF.fetch(`${ORIGIN}/g/${gameId}/squad/${stranger}/remove`, { headers: { cookie } });
    expect(response.status).toBe(404);
  });

  it("redirects an anonymous visitor to sign in", async () => {
    const db = testDb();
    const gameId = await insertGame(db);
    const response = await SELF.fetch(`${ORIGIN}/g/${gameId}/squad/${crypto.randomUUID()}/remove`, {
      redirect: "manual",
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/sign-in");
  });
});

describe("POST /g/:id/squad/:playerId/remove", () => {
  beforeEach(resetDatabase);

  it("removes the member, frees their place and redirects", async () => {
    const { cookie, gameId, memberId, db } = await ownedGame();
    const fixtureId = await insertFixture(db, gameId, { lifecycle: "open", inCount: 1 });
    await insertResponse(db, fixtureId, memberId, { status: "in" });

    const response = await post(`/g/${gameId}/squad/${memberId}/remove`, cookie);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`/g/${gameId}`);

    const [membership] = await db.select().from(memberships).where(eq(memberships.playerId, memberId));
    expect(membership!.active).toBe(false);
    const [row] = await db.select().from(responses).where(eq(responses.playerId, memberId));
    expect(row!.status).toBe("withdrawn");
  });

  it("redirects a self-removing owner to the dashboard, not to a page they can no longer see", async () => {
    const { cookie, gameId, ownerId, db } = await ownedGame();
    await insertMembership(db, gameId, await insertPlayer(db), { role: "owner" });

    const response = await post(`/g/${gameId}/squad/${ownerId}/remove`, cookie);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/app");
  });

  it("refuses to remove the last organiser, with the reason on the page", async () => {
    const { cookie, gameId, ownerId, db } = await ownedGame();

    const response = await post(`/g/${gameId}/squad/${ownerId}/remove`, cookie);
    expect(response.status).toBe(422);
    expect((await response.text()).toLowerCase()).toContain("at least one organiser");
    const [membership] = await db.select().from(memberships).where(eq(memberships.playerId, ownerId));
    expect(membership!.active).toBe(true);
  });

  it("rejects a cross-site post", async () => {
    const { cookie, gameId, memberId } = await ownedGame();
    const response = await SELF.fetch(`${ORIGIN}/g/${gameId}/squad/${memberId}/remove`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example", cookie },
      body: new URLSearchParams(),
      redirect: "manual",
    });
    expect(response.status).toBe(403);
  });

  it("404s for a member of another game", async () => {
    const { cookie, gameId } = await ownedGame();
    const db = testDb();
    const stranger = await insertPlayer(db);
    await insertMembership(db, await insertGame(db), stranger);

    expect((await post(`/g/${gameId}/squad/${stranger}/remove`, cookie)).status).toBe(404);
  });
});

describe("POST /g/:id/squad/:playerId/role", () => {
  beforeEach(resetDatabase);

  it("promotes a player to organiser", async () => {
    const { cookie, gameId, memberId, db } = await ownedGame();

    const response = await post(`/g/${gameId}/squad/${memberId}/role`, cookie, { role: "owner" });
    expect(response.status).toBe(303);
    const [membership] = await db.select().from(memberships).where(eq(memberships.playerId, memberId));
    expect(membership!.role).toBe("owner");
    const [audit] = await db.select().from(auditLog).where(eq(auditLog.action, "membership.role_changed"));
    expect(audit).toBeDefined();
  });

  it("refuses to demote the last organiser", async () => {
    const { cookie, gameId, ownerId, db } = await ownedGame();

    const response = await post(`/g/${gameId}/squad/${ownerId}/role`, cookie, { role: "player" });
    expect(response.status).toBe(422);
    const [membership] = await db.select().from(memberships).where(eq(memberships.playerId, ownerId));
    expect(membership!.role).toBe("owner");
  });

  it("400s on a role it did not offer", async () => {
    const { cookie, gameId, memberId } = await ownedGame();
    expect((await post(`/g/${gameId}/squad/${memberId}/role`, cookie, { role: "admin" })).status).toBe(400);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/routes/squad.test.ts`
Expected: FAIL — the routes 404.

- [ ] **Step 3: Add the routes**

Append to `src/routes/games.ts`. Extend the imports with `DASHBOARD_PATH` from `../auth/paths.js`, `countCommitments` and `findMembershipInGame` from `../db/queries.js`, `changeMemberRole`/`parseRole` from `../domain/change-role.js`, `removeMember` from `../domain/remove-member.js`, `renderRemoveMemberPage` from `../views/remove-member.js`, `createNotifier` from `../notify/factory.js`, `sendRemovedEmail` from `../notify/send-removed.js`, `notifyPromotedPlayer` from `./respond.js`, and `getDb`.

```ts
/**
 * The squad-management routes (J6a).
 *
 * Each one answers TR-18 twice: `findGameForOwner` establishes that the signed-in
 * player owns this game, and `findMembershipInGame` establishes that
 * `:playerId` is in *that* game's squad. Both failures are 404, never 403 — a
 * 403 confirms a resource exists, and these paths carry two ids either of
 * which could otherwise be probed.
 */
async function loadSquadTarget(c: Context<AppEnv>) {
  // `Context` is a type-only import from "hono"; add
  // `import type { Context } from "hono";` at the top of this file.
  const db = getDb(c.env.DB);
  const game = await findGameForOwner(db, c.req.param("id"), c.get("player")!.id);
  if (game === null) return null;
  const member = await findMembershipInGame(db, game.id, c.req.param("playerId"));
  if (member === null || !member.active) return null;
  return { db, game, member };
}

gamesRoutes.get("/g/:id/squad/:playerId/remove", requirePlayer, async (c) => {
  const target = await loadSquadTarget(c);
  if (target === null) return c.text("Not found", 404);

  const commitments = await countCommitments(target.db, target.game.id, target.member.playerId);
  return c.html(
    renderRemoveMemberPage({
      gameId: target.game.id,
      playerId: target.member.playerId,
      gameName: target.game.name,
      memberName: target.member.name,
      isOwner: target.member.role === "owner",
      commitments,
    }),
  );
});

gamesRoutes.post("/g/:id/squad/:playerId/remove", requirePlayer, async (c) => {
  if (wrongOrigin(c)) return c.text("Forbidden", 403);

  const target = await loadSquadTarget(c);
  if (target === null) return c.text("Not found", 404);

  const now = new Date(Date.now());
  const actor = c.get("player")!;
  const result = await removeMember({
    db: target.db,
    gameId: target.game.id,
    playerId: target.member.playerId,
    actorPlayerId: actor.id,
    now,
    // The binding is supplied here and nowhere deeper: `removeMember` stays a
    // domain module with no Workers dependency (TR-12 still holds — this is
    // the object, addressed by fixture id).
    withdraw: (fixtureId) =>
      c.env.FIXTURE_CAPACITY.getByName(fixtureId).withdrawMember({
        playerId: target.member.playerId,
        actorPlayerId: actor.id,
        now: now.getTime(),
      }),
  });

  if (result.kind === "not-a-member") return c.text("Not found", 404);
  if (result.kind === "refused") return renderSquadRefusal(c, target.game.id, now);

  // Handed to `waitUntil` for the reason `POST /r/:token` and `POST /j/:token`
  // do the same: everything the owner is waiting for is already committed, and
  // what is left is HTTP calls to a mail provider on other people's behalf.
  // Every outcome is durable in `notification_log` and every non-success is
  // logged, so a failure here is diagnosable rather than invisible.
  for (const { fixtureId, promoted } of result.promotions) {
    c.executionCtx.waitUntil(notifyPromotedPlayer(c.env, fixtureId, promoted, now));
  }
  c.executionCtx.waitUntil(
    notifyRemovedPlayer(c.env, target.game.id, target.member.playerId, result.membershipId, result.leftAt, now),
  );

  // An owner who removed themselves can no longer pass `/g/:id`'s entitlement
  // check, so sending them there would 404 them with their own successful
  // action. Everyone else goes back to the squad they just changed.
  const removedSelf = target.member.playerId === actor.id;
  return c.redirect(removedSelf ? DASHBOARD_PATH : gamePath(target.game.id), 303);
});

gamesRoutes.post("/g/:id/squad/:playerId/role", requirePlayer, async (c) => {
  if (wrongOrigin(c)) return c.text("Forbidden", 403);

  const target = await loadSquadTarget(c);
  if (target === null) return c.text("Not found", 404);

  const form = await c.req.parseBody();
  const role = parseRole(form["role"]);
  // The value comes from a `<select>` this application rendered, so anything
  // else is a hand-built request and gets a 400 rather than a guess.
  if (role === null) return c.text('Bad Request: "role" must be exactly "owner" or "player"', 400);

  const now = new Date(Date.now());
  const result = await changeMemberRole({
    db: target.db,
    gameId: target.game.id,
    playerId: target.member.playerId,
    actorPlayerId: c.get("player")!.id,
    role,
    now,
  });

  if (result.kind === "not-a-member") return c.text("Not found", 404);
  if (result.kind === "refused") return renderSquadRefusal(c, target.game.id, now);

  return c.redirect(gamePath(target.game.id), 303);
});
```

Then add the two helpers at the bottom of the file:

```ts
/**
 * The one refusal J6a's invariant produces, rendered as the game page again at
 * 422 with the reason on it — never a bare error and never a dead end. The
 * owner is one click from the fix (make someone else an organiser), and that
 * is the page the fix lives on.
 */
async function renderSquadRefusal(
  c: Context<AppEnv>,
  gameId: string,
  now: Date,
) {
  const db = getDb(c.env.DB);
  const game = await findGameForOwner(db, gameId, c.get("player")!.id);
  if (game === null) return c.text("Not found", 404);
  const [squad, upcoming] = await Promise.all([listSquad(db, game.id), listUpcomingFixtures(db, game.id, now)]);
  return c.html(
    renderGameOverviewPage({
      gameId: game.id,
      gameName: game.name,
      venueName: game.venueName,
      venueAddress: game.venueAddress,
      timezone: game.timezone,
      maxPlayers: game.maxPlayers,
      prefersEvenNumbers: game.prefersEvenNumbers,
      inviteToken: game.inviteToken,
      squad,
      upcoming,
      problem: "A game needs at least one organiser. Make someone else an organiser first.",
    }),
    422,
  );
}

/**
 * Send N-7 in the background, logging every non-success on one greppable line.
 *
 * The `catch` is not decoration: a rejected promise inside a `waitUntil`
 * resolves into nothing, and a thrown D1 error here would otherwise vanish
 * entirely — this codebase has been bitten by exactly that before. The
 * notifier is built here rather than passed in because it must be the
 * quota-wrapped one from `createNotifier` (TR-31).
 */
export async function notifyRemovedPlayer(
  env: AppEnv["Bindings"],
  gameId: string,
  playerId: string,
  membershipId: string,
  leftAt: Date,
  now: Date,
): Promise<void> {
  const who = `game ${gameId}, player ${playerId}`;
  try {
    const db = getDb(env.DB);
    const result = await sendRemovedEmail({
      db,
      notifier: createNotifier(env, db, now),
      gameId,
      playerId,
      membershipId,
      leftAt,
      now,
    });
    if (result.kind === "failed") console.error(`n7 removal email failed for ${who}: ${result.reason}`);
    if (result.kind === "deferred") console.error(`n7 removal email deferred by the daily ceiling for ${who}`);
    if (result.kind === "skipped-no-recipient") console.error(`n7 removal email skipped, no address, for ${who}`);
  } catch (error) {
    console.error(
      `n7 removal email threw for ${who}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
  }
}
```

`renderSquadRefusal` passes a `problem` string to `renderGameOverviewPage`; Task 10 adds that parameter. Add it as an optional field now (`problem?: string`, rendered as `<p class="nudge">` when present) so this task's tests pass, and Task 10 builds on it.

- [ ] **Step 4: Run the tests, then the full suite**

Run: `npx vitest run test/routes/squad.test.ts && npm test`
Expected: PASS.

If a test that reads `notification_log` immediately after a POST is flaky, that is the `waitUntil` race M6a hit: a row landing after `resetDatabase()` breaks the next test's reset on a foreign key. Do not assert on N-7 rows from a route test — `test/notify/send-removed.test.ts` owns that behaviour.

- [ ] **Step 5: Lint, typecheck, commit**

```bash
npm run lint && npm run typecheck
git add src/routes/games.ts src/views/game-overview.ts test/routes/squad.test.ts
git commit -m "feat: the squad management routes"
```

---

## Task 10: The controls on the game page

**Spec:** §2.

**Files:**
- Modify: `src/views/game-overview.ts`
- Test: `test/views/game-overview.test.ts` (existing — append), `test/routes/squad.test.ts` (append)

**Interfaces:**
- Consumes: `memberRolePath`, `memberRemovePath` (Task 8); `listSquad`'s row shape, which already carries `playerId`.
- Produces: `GameOverviewParams` gains `viewerPlayerId: string` and (from Task 9) `problem?: string`.

- [ ] **Step 1: Write the failing tests**

Append to `test/views/game-overview.test.ts` — read the file's existing `BASE`/params object first and extend it rather than defining a second one:

```ts
describe("squad controls", () => {
  const squad = [
    { playerId: "p-owner", name: "Edward Charles", role: "owner" as const, isGuest: false },
    { playerId: "p-sam", name: "Sam Okafor", role: "player" as const, isGuest: false },
  ];

  it("offers a remove link for each member", () => {
    const html = renderGameOverviewPage({ ...BASE, viewerPlayerId: "p-owner", squad });
    expect(html).toContain('href="/g/g-1/squad/p-sam/remove"');
    expect(html).toContain('href="/g/g-1/squad/p-owner/remove"');
  });

  it("offers promotion for a player and demotion for an organiser", () => {
    const html = renderGameOverviewPage({ ...BASE, viewerPlayerId: "p-owner", squad });
    expect(html).toContain('action="/g/g-1/squad/p-sam/role"');
    expect(html).toContain('value="owner"');
    expect(html).toContain('action="/g/g-1/squad/p-owner/role"');
    expect(html).toContain('value="player"');
  });

  it("marks the viewer's own row so they know which one they are", () => {
    const html = renderGameOverviewPage({ ...BASE, viewerPlayerId: "p-owner", squad });
    expect(html).toContain("(you)");
  });

  it("shows a problem message when one is passed", () => {
    const html = renderGameOverviewPage({ ...BASE, viewerPlayerId: "p-owner", squad, problem: "Nope." });
    expect(html).toContain("Nope.");
  });

  it("shows no problem message otherwise", () => {
    expect(renderGameOverviewPage({ ...BASE, viewerPlayerId: "p-owner", squad })).not.toContain("class=\"problem\"");
  });

  it("uses no inline style attribute", () => {
    expect(renderGameOverviewPage({ ...BASE, viewerPlayerId: "p-owner", squad })).not.toMatch(/style="/);
  });
});
```

Append to `test/routes/squad.test.ts`:

```ts
describe("the game page's squad controls", () => {
  beforeEach(resetDatabase);

  it("renders a remove link and a role form for each member", async () => {
    const { cookie, gameId, memberId } = await ownedGame();
    const html = await (await SELF.fetch(`${ORIGIN}/g/${gameId}`, { headers: { cookie } })).text();
    expect(html).toContain(`/g/${gameId}/squad/${memberId}/remove`);
    expect(html).toContain(`/g/${gameId}/squad/${memberId}/role`);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/views/game-overview.test.ts test/routes/squad.test.ts`
Expected: FAIL — the controls are not rendered.

- [ ] **Step 3: Render the controls**

In `src/views/game-overview.ts`, add `viewerPlayerId: string` to `GameOverviewParams` (and `problem?: string` if Task 9 has not already), and replace the `squadItems` construction:

```ts
  // One row per member, each carrying its two controls. Plain links and a
  // plain form: the remove link goes to a confirmation page rather than
  // posting straight away, because removal is destructive and must be
  // confirmable with JavaScript off.
  const squadItems = squad
    .map((member) => {
      const name = escapeHtml(member.name);
      const you = member.playerId === viewerPlayerId ? " (you)" : "";
      const guest = member.isGuest ? " (guest)" : "";
      const organiser = member.role === "owner" ? " — organiser" : "";
      const nextRole = member.role === "owner" ? "player" : "owner";
      const roleLabel = member.role === "owner" ? "Make an ordinary member" : "Make an organiser";
      return `<li>
        <span class="member">${name}${organiser}${guest}${you}</span>
        <form method="post" action="${escapeHtml(memberRolePath(gameId, member.playerId))}">
          <input type="hidden" name="role" value="${nextRole}">
          <button class="button" type="submit">${roleLabel}</button>
        </form>
        <a href="${escapeHtml(memberRemovePath(gameId, member.playerId))}">Remove</a>
      </li>`;
    })
    .join("");
```

and render the problem message just below the `<h1>`:

```ts
  // The invariant's refusal, when the last handler bounced one back here at
  // 422. Rendered from the *request*, not stored, so a refresh clears it.
  const problem =
    params.problem === undefined ? "" : `<p class="problem">${escapeHtml(params.problem)}</p>`;
```

Import `memberRemovePath` and `memberRolePath` from `../auth/paths.js`. Add a `.problem` rule to `FORM_CSS` in `src/views/styles.ts` if the class has no styling — the CSP hashes `FORM_CSS` from source, so editing it needs no other change.

- [ ] **Step 4: Pass the viewer through**

In `src/routes/games.ts`, add `viewerPlayerId: player.id` to the `renderGameOverviewPage` call in `GET /g/:id`, and `viewerPlayerId: c.get("player")!.id` in `renderSquadRefusal`. The typecheck will name any call site you miss.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Lint, typecheck, commit**

```bash
npm run lint && npm run typecheck
git add src/views/game-overview.ts src/views/styles.ts src/routes/games.ts test/views/game-overview.test.ts test/routes/squad.test.ts
git commit -m "feat: squad controls on the game page"
```

---

## Task 11: Security coverage, the dashboard check, and the docs

**Spec:** §7, §8, §9.

**Files:**
- Modify: `test/security/csp.test.ts`
- Modify: `docs/known-issues.md`
- Test: `test/routes/dashboard.test.ts` (existing — append)

- [ ] **Step 1: Add the new page to the CSP suite**

In `test/security/csp.test.ts`, find the `describe("Content-Security-Policy")` block's `/g/*` cases (around the `seedOwnedGame()` calls) and add one for the confirmation page, following the shape of its neighbours exactly:

```ts
  it("serves the removal confirmation under the production policy", async () => {
    const { gameId, cookie } = await seedOwnedGame();
    const db = testDb();
    const memberId = await insertPlayer(db, { name: "Sam Okafor" });
    await insertMembership(db, gameId, memberId);

    const response = await SELF.fetch(`https://makethe.team/g/${gameId}/squad/${memberId}/remove`, {
      headers: { cookie },
    });
    expect(response.status).toBe(200);
    expectFixedDirectives(response.headers.get("content-security-policy"));
  });
```

- [ ] **Step 2: Close the gap in the inline-style enumeration**

The `describe("no inline style attribute on any served page")` enumeration covers eight public pages and **no `/g/*` page at all** — `capture` sends no cookie, so the authenticated pages were never added when M6a introduced them. Fix that while adding the new page. Give `capture` an optional cookie:

```ts
    async function capture(name: string, distinctive: RegExp, url: string, cookie?: string) {
      const html = await (await SELF.fetch(url, cookie ? { headers: { cookie } } : {})).text();
      pages.push({ name, html, distinctive });
    }
```

then add four captures and their four names to the expected list:

```ts
    const owned = await seedOwnedGame();
    const memberId = await insertPlayer(db, { name: "Sam Okafor" });
    await insertMembership(db, owned.gameId, memberId);
    await capture("new game form", /Set up a game/, "https://makethe.team/g/new", owned.cookie);
    await capture("game overview", /Invite people/, `https://makethe.team/g/${owned.gameId}`, owned.cookie);
    await capture(
      "remove member",
      /Remove Sam Okafor\?/,
      `https://makethe.team/g/${owned.gameId}/squad/${memberId}/remove`,
      owned.cookie,
    );
    await capture("invite page", /Thursday 7-a-side/, `https://makethe.team/j/${owned.inviteToken}`);
```

Each `distinctive` regex must be phrasing unique to that page, so a 404 or an empty body can never masquerade as coverage. Run the suite and adjust each regex to what the page actually renders — do not weaken one to make it pass.

- [ ] **Step 3: Pin the dashboard behaviour**

Append to `test/routes/dashboard.test.ts`, matching that file's existing helpers:

```ts
it("no longer shows a game the player has been removed from", async () => {
  const { cookie } = await signIn();
  const db = testDb();
  const [viewer] = await db.select().from(players).where(eq(players.email, ALLOWED));
  const gameId = await insertGame(db, { name: "Thursday 7-a-side" });
  await insertMembership(db, gameId, viewer!.id, { active: false, leftAt: new Date() });

  const html = await (await SELF.fetch(`${ORIGIN}/app`, { headers: { cookie } })).text();
  // The membership filter should already do this — "should already" is how the
  // connect-src bug shipped, so it is asserted rather than assumed.
  expect(html).not.toContain("Thursday 7-a-side");
});
```

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS. If the dashboard test fails, that is a real bug in the dashboard query — fix the query, not the test.

- [ ] **Step 5: Update the known issues**

In `docs/known-issues.md`:

1. **Amend row 25** (leaked-invite abuse). Do not close it. Add: J6a ships the owner's remedy — rotate the link, then remove the unwanted member — and corrects the audit record, which now names no actor for an invite-link join and carries `via: "invite_link"`. State plainly that **rows written before J6a still carry the joining player as actor and must not be read as evidence of who acted**, and that J6a does not prevent the join.
2. **Add a row** for the partial-failure case: a removal that fails partway through its fixture loop leaves the membership inactive (correctly) but stale response rows on the fixtures it did not reach. `withdrawMember` is idempotent so a retry would finish the job, but the member no longer appears in the squad list and there is no UI path to retry. Files: `src/domain/remove-member.ts`, `src/routes/games.ts`. Trigger: before a second owner exists. Note the durable fix — a reconciliation pass, the same shape the ghost-fixture row already wants.
3. **Amend the BR-22 row** to record that N-7 carries no leave link *by design*, because there is nothing left to leave — so it is not a third omission alongside N-6's.

- [ ] **Step 6: Commit**

```bash
npm run lint && npm run typecheck
git add test/security/csp.test.ts test/routes/dashboard.test.ts docs/known-issues.md
git commit -m "test: cover the new page's CSP, and record what J6a leaves open"
```

- [ ] **Step 7: Final gate**

```bash
npm run lint && npm run typecheck && npm test
git log --oneline main..HEAD
```

Expected: lint and typecheck clean, every test passing, eleven commits.

---

## Manual verification

`npm run dev` and, in a browser:

1. `/g/:id` — the squad list shows a control pair per row, your own row is marked "(you)".
2. Promote a member; the page comes back with them marked as an organiser.
3. Demote yourself while they are an organiser — allowed. Try to demote the last organiser — 422 with the reason on the page.
4. Remove a member who holds a place on an open fixture; check the confirmation names the right number of fixtures, then confirm and check their response row is `withdrawn` and someone was promoted.
5. **Open the devtools console on the confirmation page and check for CSP violations.** M6a's manual check skipped this step and the project's worst production bug to date was a CSP violation that every server test passed through.
6. Disable JavaScript and repeat steps 2 and 4. Both must work — they are plain forms.

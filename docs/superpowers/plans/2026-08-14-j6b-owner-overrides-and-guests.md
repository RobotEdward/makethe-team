# J6b — Owner Overrides, Guests and Over-Capacity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An owner can open any fixture of a game they own, mark players in or out on their behalf, add a one-off guest, and deliberately exceed `max_players` — completing M6.

**Architecture:** A new owner-facing fixture page (`GET /g/:id/f/:fixtureId`) hosts every control. Capacity decisions stay inside the `FixtureCapacity` Durable Object: `setResponse` gains an explicit `whenFull` input with three values, and a new `addGuest` method creates the guest's `players` row and their `in` response row in one batch inside the lock. Attribution is one query change in `getFixtureWithSquad` feeding two pages.

**Tech Stack:** TypeScript strict, Cloudflare Workers, Hono, D1 + Drizzle, Durable Objects, Vitest with `@cloudflare/vitest-pool-workers`, Playwright against `wrangler dev`.

**Spec:** `docs/superpowers/specs/2026-08-14-j6b-owner-overrides-and-guests-design.md`. Read the section named in each task.

## Global Constraints

- **No migration.** `AUDIT_ACTIONS` and `AUDIT_ENTITY_TYPES` are TypeScript-only narrowings (`text({ enum })` emits no SQL CHECK on SQLite). Nothing in this milestone adds a column. If you believe you need a migration, stop and escalate.
- **Every capacity write goes through the Durable Object** (TR-12). No route may `UPDATE responses.status` or write `fixtures.in_count` directly.
- **Every control works with JavaScript off** (TR-4, TR-15). Plain `<form method="post">`. No `<script>` on any page this milestone adds.
- **No new notification type.** §1.11's catalogue is closed. The only email this milestone can cause is N-2, via the existing `notifyPromotedPlayer`.
- **404, never 403, for every entitlement failure** on `/g/*` (TR-18): no such game, not a member, not an owner, deactivated owner, fixture belonging to another game — one answer for all five.
- **`escapeHtml` every interpolated value** in views. No exceptions, including names the owner typed.
- **State-changing POSTs check `wrongOrigin(c)` and return 403** — mirror the existing handlers in `src/routes/games.ts`.
- **Guests are one fixture only**: `players` row with `is_guest: true` and `email: null`, no `memberships` row, ever.
- **Copy rule:** product words only. A player never reads "waitlisted position", "lifecycle", "BR-8", or a route pattern.
- **Commit messages:** lower-case conventional prefix, imperative, no trailing period on the subject.
- **Never `git add -A`.** Stage explicit paths only.
- **Never use bare `new Date()`** — ESLint's `no-restricted-syntax` bans it. Use `new Date(Date.now())` in routes, and pass `now` into domain code.

## File Structure

**Created**
- `src/views/owner-fixture.ts` — renders the owner's fixture page: header, counts and flags, squad rows with controls, the over-capacity confirmation banner.
- `src/domain/guest-name.ts` — parses and validates a typed guest name.
- `test/capacity/add-guest.test.ts`, `test/routes/owner-fixture.test.ts`, `test/domain/guest-name.test.ts`, `test/views/owner-fixture.test.ts`.

**Modified**
- `src/capacity/types.ts` — `whenFull` on `SetResponseInput`; `would-exceed-capacity` rejection; `AddGuestInput`/`AddGuestOutcome`.
- `src/capacity/fixture-capacity.ts` — honour `whenFull`; add `addGuest`.
- `src/db/queries.ts` — `SquadMember` gains `setBy`, `source`, `isGuest`.
- `src/db/schema.ts` — no change. Listed only to say so.
- `src/domain/audit.ts` — three new actions.
- `src/auth/paths.ts` — `ownerFixturePath`, `ownerResponsePath`, `ownerGuestPath`, `ownerGuestRemovePath`.
- `src/routes/games.ts` — the four new handlers.
- `src/routes/respond.ts`, `src/routes/dashboard.ts` — pass `whenFull: "waitlist"`.
- `src/views/fixture.ts` — attribution line, over-capacity line.
- `src/views/game-overview.ts` — fixture rows become links.
- `src/views/styles.ts` — styles for the new page.
- `test/browser/catalogue.ts`, `test/browser/journeys.spec.ts`, `test/browser/world.ts`.
- `docs/guide/05-running-your-squad.md`, `test/browser/guide-shots.ts`, `test/browser/guide-world.ts`.
- `docs/superpowers/specs/2026-08-10-make-the-team-design.md` — §2.14 status.
- `docs/known-issues.md`.

---

### Task 1: `whenFull` — the capacity decision becomes an explicit input

**Spec:** §4.1.

**Files:**
- Modify: `src/capacity/types.ts`
- Modify: `src/capacity/fixture-capacity.ts:119-130`
- Modify: `src/routes/respond.ts:200`, `src/routes/dashboard.ts` (its `setResponse` call)
- Test: `test/capacity/set-response.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `SetResponseInput.whenFull: "waitlist" | "refuse" | "exceed"` (required), and the new outcome member `{ kind: "rejected"; reason: "would-exceed-capacity" }` alongside the three existing reasons.

`whenFull` is **required, not optional with a default**. A default is what lets a fourth caller inherit a capacity policy it never chose. Making it required means the compiler names every call site, which is the point.

- [ ] **Step 1: Write the failing tests**

Add to `test/capacity/set-response.test.ts`. The existing helpers `accept` and `decline` gain a `whenFull` parameter; add these three tests in a new `describe`:

```ts
describe("whenFull (BR-8)", () => {
  it("refuses without writing when an owner marks in on a full fixture", async () => {
    const fixtureId = await seedOpenFixture(5, 2);
    await accept(fixtureId, "p-0");
    await accept(fixtureId, "p-1");

    const outcome = await stubFor(fixtureId).setResponse({
      playerId: "p-2", intent: "in", actorPlayerId: "p-0", source: "owner",
      whenFull: "refuse", now: NOW.getTime(),
    });

    expect(outcome).toEqual({ kind: "rejected", reason: "would-exceed-capacity" });
    // Nothing written: the row is untouched and the cached count did not move.
    const [row] = await db.select().from(responses)
      .where(and(eq(responses.fixtureId, fixtureId), eq(responses.playerId, "p-2")));
    expect(row?.status).toBe("pending");
    expect(row?.respondedAt).toBeNull();
    expect(await counts(fixtureId)).toEqual({ inCount: 2, cached: 2 });
  });

  it("goes over capacity when the owner confirms", async () => {
    const fixtureId = await seedOpenFixture(5, 2);
    await accept(fixtureId, "p-0");
    await accept(fixtureId, "p-1");

    const outcome = await stubFor(fixtureId).setResponse({
      playerId: "p-2", intent: "in", actorPlayerId: "p-0", source: "owner",
      whenFull: "exceed", now: NOW.getTime(),
    });

    expect(outcome).toMatchObject({ kind: "recorded", status: "in", inCount: 3, spotsLeft: 0 });
    expect(await counts(fixtureId)).toEqual({ inCount: 3, cached: 3 });
    const [row] = await db.select().from(responses)
      .where(and(eq(responses.fixtureId, fixtureId), eq(responses.playerId, "p-2")));
    expect(row?.setByPlayerId).toBe("p-0");
    expect(row?.source).toBe("owner");
    expect(row?.waitlistPosition).toBeNull();
  });

  it("still waitlists a player answering for themselves", async () => {
    const fixtureId = await seedOpenFixture(5, 2);
    await accept(fixtureId, "p-0");
    await accept(fixtureId, "p-1");

    const outcome = await accept(fixtureId, "p-2");

    expect(outcome).toMatchObject({ kind: "waitlisted", waitlistPosition: 1 });
  });

  it("marks in normally when the fixture is not full, whatever whenFull says", async () => {
    const fixtureId = await seedOpenFixture(5, 10);

    const outcome = await stubFor(fixtureId).setResponse({
      playerId: "p-0", intent: "in", actorPlayerId: "p-1", source: "owner",
      whenFull: "refuse", now: NOW.getTime(),
    });

    expect(outcome).toMatchObject({ kind: "recorded", status: "in", inCount: 1 });
  });

  it("refuses `out` never — whenFull only governs taking a slot", async () => {
    const fixtureId = await seedOpenFixture(5, 2);
    await accept(fixtureId, "p-0");
    await accept(fixtureId, "p-1");

    const outcome = await stubFor(fixtureId).setResponse({
      playerId: "p-1", intent: "out", actorPlayerId: "p-0", source: "owner",
      whenFull: "refuse", now: NOW.getTime(),
    });

    expect(outcome).toMatchObject({ kind: "recorded", status: "out" });
  });
});
```

Update the two existing helpers so every current test keeps its meaning:

```ts
function accept(fixtureId: string, playerId: string, now: number = NOW.getTime()) {
  return stubFor(fixtureId).setResponse({
    playerId, intent: "in", actorPlayerId: null, source: "token", whenFull: "waitlist", now,
  });
}

function decline(fixtureId: string, playerId: string, now: number = NOW.getTime()) {
  return stubFor(fixtureId).setResponse({
    playerId, intent: "out", actorPlayerId: null, source: "token", whenFull: "waitlist", now,
  });
}
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run test/capacity/set-response.test.ts`
Expected: FAIL — `whenFull` is not a known property, and the two new outcomes do not exist.

- [ ] **Step 3: Add the type**

In `src/capacity/types.ts`, add to `SetResponseInput`:

```ts
  /**
   * What to do when the fixture is already at `max_players` and this response
   * would take a slot.
   *
   * `waitlist` is BR-5: a player answering for themselves joins the waitlist.
   * `refuse` writes nothing and returns `would-exceed-capacity` — an owner's
   * mark-in, so that BR-8's override is a second, explicit act rather than a
   * silent consequence of the first. `exceed` **is** that second act: the
   * player goes `in` regardless of `max_players`.
   *
   * Required rather than defaulted on purpose. A default is exactly what lets
   * a future caller inherit a capacity policy it never chose; requiring it
   * makes the compiler name every call site.
   *
   * It governs only *taking* a slot. An `out` intent frees one and is never
   * refused.
   */
  whenFull: "waitlist" | "refuse" | "exceed";
```

And extend the rejection member:

```ts
  | {
      kind: "rejected";
      reason: "fixture-not-open" | "not-eligible" | "fixture-not-found" | "would-exceed-capacity";
    };
```

- [ ] **Step 4: Honour it in the Durable Object**

In `src/capacity/fixture-capacity.ts`, replace the full-fixture branch (currently `} else if (inCountWithoutThisPlayer >= fixture.maxPlayers) {`) with:

```ts
    } else if (inCountWithoutThisPlayer >= fixture.maxPlayers) {
      // Full. What happens now is the caller's declared policy, decided in
      // here rather than in the route because a route-level capacity check
      // would be a genuine TOCTOU race against a concurrent tap — this branch
      // runs under `blockConcurrencyWhile`, so the decision is atomic with the
      // count it is deciding against.
      if (input.whenFull === "refuse") return { kind: "rejected", reason: "would-exceed-capacity" };
      if (input.whenFull === "exceed") {
        // BR-8. The fixture goes over capacity, and `fixtureView` derives the
        // `over_capacity` flag from the counts — nothing is stored to say so.
        status = "in";
      } else {
        // BR-4/BR-5/BR-6: appended to the end of the waitlist and told so
        // explicitly, never silently.
        const highest = waitlistedWithoutThisPlayer.reduce(
          (max, r) => Math.max(max, r.waitlistPosition ?? 0),
          0,
        );
        status = "waitlisted";
        waitlistPosition = highest + 1;
      }
    } else {
```

Also update the already-waitlisted branch above it, which re-checks capacity: `if (inCountWithoutThisPlayer >= fixture.maxPlayers)` should keep returning the existing waitlisted state for `whenFull: "waitlist"`, but an owner using `exceed` on a waitlisted player must promote them. Replace that branch's condition with:

```ts
      if (inCountWithoutThisPlayer >= fixture.maxPlayers && input.whenFull !== "exceed") {
        if (input.whenFull === "refuse") return { kind: "rejected", reason: "would-exceed-capacity" };
        return {
          kind: "waitlisted",
          waitlistPosition: existing.waitlistPosition ?? 1,
          inCount: inCountWithoutThisPlayer,
        };
      }
```

- [ ] **Step 5: Update the two production call sites**

`src/routes/respond.ts` (the `POST /r/:token` handler) and `src/routes/dashboard.ts` both call `setResponse` for a player answering for themselves. Add `whenFull: "waitlist"` to both. Nothing else about them changes.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS, including the five new tests. If `test/routes/respond-post.test.ts`, `respond-get.test.ts` or `dashboard.test.ts` fail to typecheck, add `whenFull: "waitlist"` to their `setResponse` calls — they are all self-response paths.

- [ ] **Step 7: Lint and typecheck**

Run: `npm run lint && npm run typecheck`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add src/capacity/types.ts src/capacity/fixture-capacity.ts src/routes/respond.ts src/routes/dashboard.ts test/capacity/set-response.test.ts test/routes/respond-post.test.ts test/routes/respond-get.test.ts test/routes/dashboard.test.ts
git commit -m "feat(capacity): let a caller declare what happens on a full fixture"
```

---

### Task 2: `addGuest` and guest-name parsing

**Spec:** §5.

**Files:**
- Create: `src/domain/guest-name.ts`
- Create: `test/domain/guest-name.test.ts`
- Create: `test/capacity/add-guest.test.ts`
- Modify: `src/capacity/types.ts`, `src/capacity/fixture-capacity.ts`

**Interfaces:**
- Consumes: `whenFull` from Task 1 (`"refuse" | "exceed"` only — a guest never waitlists).
- Produces:
  - `parseGuestName(raw: unknown): { ok: true; name: string } | { ok: false; problem: string }`
  - `FixtureCapacity.addGuest(input: AddGuestInput): Promise<AddGuestOutcome>`
  - `AddGuestInput = { name: string; actorPlayerId: string; whenFull: "refuse" | "exceed"; now: number }`
  - `AddGuestOutcome = { kind: "added"; playerId: string; inCount: number; spotsLeft: number } | { kind: "rejected"; reason: "would-exceed-capacity" | "fixture-not-open" | "fixture-not-found" }`

- [ ] **Step 1: Write the failing name-parser test**

Create `test/domain/guest-name.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseGuestName } from "../../src/domain/guest-name.js";

describe("parseGuestName", () => {
  it("accepts an ordinary name", () => {
    expect(parseGuestName("Sam Whitlock")).toEqual({ ok: true, name: "Sam Whitlock" });
  });

  it("trims surrounding whitespace", () => {
    expect(parseGuestName("  Sam  ")).toEqual({ ok: true, name: "Sam" });
  });

  it("refuses an empty name", () => {
    expect(parseGuestName("")).toEqual({ ok: false, problem: "Give your guest a name." });
  });

  it("refuses whitespace only", () => {
    expect(parseGuestName("   ")).toEqual({ ok: false, problem: "Give your guest a name." });
  });

  it("refuses a name longer than 80 characters", () => {
    expect(parseGuestName("x".repeat(81))).toEqual({
      ok: false,
      problem: "That name is too long — keep it under 80 characters.",
    });
  });

  it("accepts exactly 80 characters", () => {
    expect(parseGuestName("x".repeat(80))).toEqual({ ok: true, name: "x".repeat(80) });
  });

  it("refuses a non-string, which is what a hand-built request sends", () => {
    expect(parseGuestName(undefined)).toEqual({ ok: false, problem: "Give your guest a name." });
    expect(parseGuestName(42)).toEqual({ ok: false, problem: "Give your guest a name." });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/domain/guest-name.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the parser**

Create `src/domain/guest-name.ts`:

```ts
/** The longest guest name the form accepts. Generous, and bounded. */
const MAX_GUEST_NAME = 80;

export type GuestNameResult = { ok: true; name: string } | { ok: false; problem: string };

/**
 * Parse the one field the add-a-guest form has (§5).
 *
 * Returns a message the page can render rather than throwing: an owner
 * mistyping a name is an ordinary event on an ordinary form, not an error.
 * Escaping is `escapeHtml`'s job at render time, as everywhere else — this
 * function decides what is *acceptable*, never what is *safe to print*.
 */
export function parseGuestName(raw: unknown): GuestNameResult {
  if (typeof raw !== "string") return { ok: false, problem: "Give your guest a name." };
  const name = raw.trim();
  if (name === "") return { ok: false, problem: "Give your guest a name." };
  if (name.length > MAX_GUEST_NAME) {
    return { ok: false, problem: "That name is too long — keep it under 80 characters." };
  }
  return { ok: true, name };
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run test/domain/guest-name.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Write the failing `addGuest` tests**

Create `test/capacity/add-guest.test.ts`. Copy `seedOpenFixture`, `stubFor` and `counts` from `test/capacity/set-response.test.ts` — the two files are separate suites over the same fixture shape, and sharing through a helper module is a refactor this task does not own.

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

beforeEach(async () => {
  await resetDatabase();
});

describe("addGuest", () => {
  it("creates the player and the in response together", async () => {
    const fixtureId = await seedOpenFixture(3);

    const outcome = await stubFor(fixtureId).addGuest({
      name: "Sam Whitlock", actorPlayerId: "p-0", whenFull: "refuse", now: NOW.getTime(),
    });

    expect(outcome).toMatchObject({ kind: "added", inCount: 1, spotsLeft: 13 });
    const guestId = outcome.kind === "added" ? outcome.playerId : "";
    const [player] = await db.select().from(players).where(eq(players.id, guestId));
    expect(player).toMatchObject({ name: "Sam Whitlock", email: null, isGuest: true });
    const [response] = await db.select().from(responses)
      .where(and(eq(responses.fixtureId, fixtureId), eq(responses.playerId, guestId)));
    expect(response).toMatchObject({ status: "in", source: "owner", setByPlayerId: "p-0" });
    const [fixture] = await db.select().from(fixtures).where(eq(fixtures.id, fixtureId));
    expect(fixture?.inCount).toBe(1);
  });

  it("gives a guest no membership — they are one fixture only", async () => {
    const fixtureId = await seedOpenFixture(3);

    const outcome = await stubFor(fixtureId).addGuest({
      name: "Sam Whitlock", actorPlayerId: "p-0", whenFull: "refuse", now: NOW.getTime(),
    });
    const guestId = outcome.kind === "added" ? outcome.playerId : "";

    const rows = await db.select().from(memberships).where(eq(memberships.playerId, guestId));
    expect(rows).toEqual([]);
  });

  it("refuses on a full fixture and leaves no orphaned player row", async () => {
    const fixtureId = await seedOpenFixture(2, 2);
    await stubFor(fixtureId).setResponse({
      playerId: "p-0", intent: "in", actorPlayerId: null, source: "token", whenFull: "waitlist", now: NOW.getTime(),
    });
    await stubFor(fixtureId).setResponse({
      playerId: "p-1", intent: "in", actorPlayerId: null, source: "token", whenFull: "waitlist", now: NOW.getTime(),
    });
    const playersBefore = (await db.select().from(players)).length;

    const outcome = await stubFor(fixtureId).addGuest({
      name: "Sam Whitlock", actorPlayerId: "p-0", whenFull: "refuse", now: NOW.getTime(),
    });

    expect(outcome).toEqual({ kind: "rejected", reason: "would-exceed-capacity" });
    // The whole point of creating the row inside the lock: a refusal leaves
    // no person behind in the database.
    expect((await db.select().from(players)).length).toBe(playersBefore);
  });

  it("goes over capacity when the owner confirms", async () => {
    const fixtureId = await seedOpenFixture(2, 2);
    await stubFor(fixtureId).setResponse({
      playerId: "p-0", intent: "in", actorPlayerId: null, source: "token", whenFull: "waitlist", now: NOW.getTime(),
    });
    await stubFor(fixtureId).setResponse({
      playerId: "p-1", intent: "in", actorPlayerId: null, source: "token", whenFull: "waitlist", now: NOW.getTime(),
    });

    const outcome = await stubFor(fixtureId).addGuest({
      name: "Sam Whitlock", actorPlayerId: "p-0", whenFull: "exceed", now: NOW.getTime(),
    });

    expect(outcome).toMatchObject({ kind: "added", inCount: 3, spotsLeft: 0 });
  });

  it("refuses on a fixture that is not open", async () => {
    const gameId = await insertGame(db);
    const fixtureId = crypto.randomUUID();
    await db.insert(fixtures).values({
      id: fixtureId, gameId, kicksOffAt: KICKOFF, minPlayers: 10, maxPlayers: 14,
      prefersEvenNumbers: true, shortWarningOffsetHours: 12, durationMinutes: 60,
    });

    const outcome = await stubFor(fixtureId).addGuest({
      name: "Sam Whitlock", actorPlayerId: "p-0", whenFull: "refuse", now: NOW.getTime(),
    });

    expect(outcome).toEqual({ kind: "rejected", reason: "fixture-not-open" });
  });

  it("adds the same name twice as two separate guests", async () => {
    const fixtureId = await seedOpenFixture(3);

    const first = await stubFor(fixtureId).addGuest({
      name: "Sam Whitlock", actorPlayerId: "p-0", whenFull: "refuse", now: NOW.getTime(),
    });
    const second = await stubFor(fixtureId).addGuest({
      name: "Sam Whitlock", actorPlayerId: "p-0", whenFull: "refuse", now: NOW.getTime(),
    });

    // Two people can genuinely share a name, and deduplicating would guess
    // otherwise. Both occupy a slot (§5).
    expect(first.kind).toBe("added");
    expect(second).toMatchObject({ kind: "added", inCount: 2 });
  });
});
```

- [ ] **Step 6: Run them and watch them fail**

Run: `npx vitest run test/capacity/add-guest.test.ts`
Expected: FAIL — `addGuest` is not a function on the stub.

- [ ] **Step 7: Add the types**

Append to `src/capacity/types.ts`:

```ts
/** An Owner adding a one-off guest to a single fixture (J6b §5). */
export interface AddGuestInput {
  /** Already parsed and trimmed by `parseGuestName`. */
  name: string;
  /** The owner doing it. Recorded on the response row (BR-27). */
  actorPlayerId: string;
  /**
   * A guest never waitlists — they have no email address, so a guest who
   * landed on a waitlist would be a person nobody could ever tell they got
   * in. So `refuse`, and then `exceed` once the owner has confirmed.
   */
  whenFull: "refuse" | "exceed";
  now: number;
}

export type AddGuestOutcome =
  | { kind: "added"; playerId: string; inCount: number; spotsLeft: number }
  /** No `promoted` variant: adding a guest only ever takes a slot, never frees one. */
  | { kind: "rejected"; reason: "would-exceed-capacity" | "fixture-not-open" | "fixture-not-found" };
```

- [ ] **Step 8: Implement `addGuest`**

In `src/capacity/fixture-capacity.ts`, add imports for `players` and the new types, then add these two methods after `withdrawMember`:

```ts
  /**
   * Add a one-off guest to this fixture (J6b §5).
   *
   * **Why the `players` row is created in here.** It stretches this object's
   * "capacity only" remit, and both alternatives are worse. Creating the
   * person in the route first means a refused over-capacity add leaves an
   * orphaned human being in the database; pre-checking capacity in the route
   * to avoid that is exactly the TOCTOU race `whenFull` exists to close. The
   * guest and the slot they occupy are one fact, so they are one batch.
   *
   * `blockConcurrencyWhile` is load-bearing here for the same reason it is on
   * `setResponse` — read that method's comment.
   */
  async addGuest(input: AddGuestInput): Promise<AddGuestOutcome> {
    return this.ctx.blockConcurrencyWhile(async () => this.#addGuestLocked(input));
  }

  async #addGuestLocked(input: AddGuestInput): Promise<AddGuestOutcome> {
    // From the object's own identity, never from an argument — see
    // `#setResponseLocked` for the full reasoning.
    const fixtureId = this.ctx.id.name;
    if (fixtureId === undefined) {
      throw new Error(
        "FixtureCapacity was addressed by unique id, not by fixture id — every caller must use getByName(fixtureId)",
      );
    }

    const db = getDb(this.env.DB);
    const now = new Date(input.now);

    const [fixture] = await db.select().from(fixtures).where(eq(fixtures.id, fixtureId));
    if (!fixture) return { kind: "rejected", reason: "fixture-not-found" };
    if (fixture.lifecycle !== "open") return { kind: "rejected", reason: "fixture-not-open" };

    const all = await db
      .select({ status: responses.status })
      .from(responses)
      .where(eq(responses.fixtureId, fixtureId));
    const currentIn = all.filter((row) => row.status === "in").length;

    if (currentIn >= fixture.maxPlayers && input.whenFull === "refuse") {
      return { kind: "rejected", reason: "would-exceed-capacity" };
    }

    const playerId = crypto.randomUUID();
    const inCount = currentIn + 1;

    // One batch. The person and their slot commit together or not at all —
    // which is what makes the refusal above leave nothing behind.
    await db.batch([
      db.insert(players).values({ id: playerId, name: input.name, email: null, isGuest: true }),
      db.insert(responses).values({
        id: crypto.randomUUID(),
        fixtureId,
        playerId,
        status: "in",
        respondedAt: now,
        setByPlayerId: input.actorPlayerId,
        source: "owner",
      }),
      db.update(fixtures).set({ inCount }).where(eq(fixtures.id, fixtureId)),
    ]);

    return {
      kind: "added",
      playerId,
      inCount,
      spotsLeft: Math.max(0, fixture.maxPlayers - inCount),
    };
  }
```

Note `waitlistCount` is deliberately not written: adding a guest cannot change how many people are waitlisted.

- [ ] **Step 9: Run the tests**

Run: `npx vitest run test/capacity/add-guest.test.ts test/domain/guest-name.test.ts`
Expected: PASS (6 + 7 tests).

- [ ] **Step 10: Full suite, lint, typecheck**

Run: `npm test && npm run lint && npm run typecheck`
Expected: all clean. `test/capacity/set-response.test.ts` asserts the Durable Object's source contains no `fetch(` — `addGuest` makes no network call, so that assertion stays true.

- [ ] **Step 11: Commit**

```bash
git add src/domain/guest-name.ts src/capacity/types.ts src/capacity/fixture-capacity.ts test/domain/guest-name.test.ts test/capacity/add-guest.test.ts
git commit -m "feat(capacity): add a one-off guest and their slot in one batch"
```

---

### Task 3: Attribution data and the player-facing lines

**Spec:** §6.

**Files:**
- Modify: `src/db/queries.ts:5-16` (`SquadMember`), `:105-200` (`getFixtureWithSquad`)
- Modify: `src/views/fixture.ts:165-176` (`renderSquadList`), `:191` area (`renderStatusLine` caller)
- Test: `test/db/queries.test.ts` (or the existing file covering `getFixtureWithSquad`), `test/views/` for the fixture view

**Interfaces:**
- Consumes: nothing from Tasks 1–2.
- Produces: `SquadMember` gains `setBy: { playerId: string; name: string } | null`, `source: ResponseSource`, `isGuest: boolean`. Task 4's view consumes all three.

- [ ] **Step 1: Write the failing query test**

Find the existing test covering `getFixtureWithSquad` (`grep -rl getFixtureWithSquad test/`) and add:

```ts
it("reports who set a response when an owner set it", async () => {
  // Seed: owner `o-1` marks `p-1` in. Use the Durable Object so the row is
  // written the way production writes it.
  const result = await getFixtureWithSquad(db, fixtureId);
  const member = result!.squad.find((m) => m.playerId === "p-1")!;

  expect(member.setBy).toEqual({ playerId: "o-1", name: "Olivia Nightingale" });
  expect(member.source).toBe("owner");
  expect(member.isGuest).toBe(false);
});

it("reports no setter for a player who answered for themselves", async () => {
  const result = await getFixtureWithSquad(db, fixtureId);
  const member = result!.squad.find((m) => m.playerId === "p-2")!;

  expect(member.setBy).toBeNull();
  expect(member.source).toBe("token");
});

it("marks a guest as one", async () => {
  const result = await getFixtureWithSquad(db, fixtureId);
  const guest = result!.squad.find((m) => m.name === "Sam Whitlock")!;

  expect(guest.isGuest).toBe(true);
});
```

Write the seeding for each using the existing factories in that file. The owner-set row needs `setByPlayerId` and `source: "owner"`; the guest needs `players.isGuest = true`.

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run test/db/`
Expected: FAIL — `setBy` does not exist on `SquadMember`.

- [ ] **Step 3: Extend the query**

In `src/db/queries.ts`, extend the interface:

```ts
export interface SquadMember {
  playerId: string;
  name: string;
  status: ResponseStatus;
  /** Rank among current waitlisted members, 1-based. Null unless waitlisted.
   *  Computed here, never the stored column — see spec amendment 5. */
  waitlistRank: number | null;
  /**
   * Who set this response, when it was not the player themselves (BR-27).
   * Null for every self-response, which is the overwhelming majority.
   */
  setBy: { playerId: string; name: string } | null;
  /** How the response came to be set. `owner` is what makes `setBy` worth showing. */
  source: ResponseSource;
  /** A one-off guest (J6b §5). Never emailed, occupies a slot. */
  isGuest: boolean;
}
```

Add the self-join. Drizzle needs an alias for the second `players` reference:

```ts
import { alias } from "drizzle-orm/sqlite-core";

const setter = alias(players, "setter");
```

and in `getFixtureWithSquad`'s second query:

```ts
  const rows = await db
    .select({
      playerId: responses.playerId,
      name: players.name,
      status: responses.status,
      waitlistPosition: responses.waitlistPosition,
      source: responses.source,
      isGuest: players.isGuest,
      setByPlayerId: setter.id,
      setByName: setter.name,
    })
    .from(responses)
    .innerJoin(players, eq(responses.playerId, players.id))
    // Left, not inner: `set_by_player_id` is null for every self-response, and
    // an inner join would silently drop all of them from the squad.
    .leftJoin(setter, eq(responses.setByPlayerId, setter.id))
    .where(and(eq(responses.fixtureId, fixtureId), ne(responses.status, "withdrawn")))
    .orderBy(asc(responses.respondedAt), asc(responses.createdAt));
```

and in the mapping:

```ts
  const squad: SquadMember[] = rows.map((r) => ({
    playerId: r.playerId,
    name: r.name,
    status: r.status,
    waitlistRank: waitlistRanks.get(r.playerId) ?? null,
    setBy:
      r.setByPlayerId === null || r.setByName === null
        ? null
        : { playerId: r.setByPlayerId, name: r.setByName },
    source: r.source,
    isGuest: r.isGuest,
  }));
```

Import `ResponseSource` from `../domain/response-status.js` alongside `ResponseStatus`.

- [ ] **Step 4: Run and watch it pass**

Run: `npx vitest run test/db/`
Expected: PASS.

- [ ] **Step 5: Write the failing view test**

In the existing fixture-view test file (`grep -rl renderFixturePage test/`), add:

```ts
it("names the organiser who answered for a player", () => {
  const html = renderFixturePage(optionsWith({
    squad: [{
      playerId: "p-1", name: "Priya Raman", status: "in", waitlistRank: null,
      setBy: { playerId: "o-1", name: "Jamie Alderton" }, source: "owner", isGuest: false,
    }],
  }));

  expect(html).toContain("marked in by Jamie Alderton");
});

it("says nothing about who set a self-response", () => {
  const html = renderFixturePage(optionsWith({
    squad: [{
      playerId: "p-1", name: "Priya Raman", status: "in", waitlistRank: null,
      setBy: null, source: "token", isGuest: false,
    }],
  }));

  expect(html).not.toContain("marked in by");
});

it("words an owner-set out as marked out", () => {
  const html = renderFixturePage(optionsWith({
    squad: [{
      playerId: "p-1", name: "Priya Raman", status: "out", waitlistRank: null,
      setBy: { playerId: "o-1", name: "Jamie Alderton" }, source: "owner", isGuest: false,
    }],
  }));

  expect(html).toContain("marked out by Jamie Alderton");
});

it("escapes a setter's name", () => {
  const html = renderFixturePage(optionsWith({
    squad: [{
      playerId: "p-1", name: "Priya Raman", status: "in", waitlistRank: null,
      setBy: { playerId: "o-1", name: "<script>x</script>" }, source: "owner", isGuest: false,
    }],
  }));

  expect(html).not.toContain("<script>x</script>");
  expect(html).toContain("&lt;script&gt;");
});

it("says a fixture is over capacity", () => {
  const html = renderFixturePage(optionsWith({
    view: { status: "confirmed", flags: ["over_capacity"], spotsLeft: 0, needsOwnerAttention: false },
  }));

  expect(html).toContain("more players in than there are places");
});
```

Use whatever `optionsWith`-style helper that file already has; if it has none, build the full `FixturePageOptions` inline as its existing tests do.

- [ ] **Step 6: Run and watch it fail**

Run: `npx vitest run test/views/`
Expected: FAIL — no attribution or over-capacity text is rendered.

- [ ] **Step 7: Render both lines**

In `src/views/fixture.ts`, add above `renderSquadList`:

```ts
/**
 * BR-27's visible attribution, on the *player's* page and not only the
 * owner's.
 *
 * With §1.11's notification catalogue closed, no email tells a player that
 * somebody answered for them — so this line is the only way they can ever find
 * out. Shown only for `source === "owner"`: a `system` source is a waitlist
 * promotion, which the player's own headline already explains, and `token` and
 * `web` are the player themselves.
 */
function attribution(member: SquadMember): string {
  if (member.source !== "owner" || member.setBy === null) return "";
  const verb = member.status === "in" ? "marked in" : "marked out";
  return `<span class="set-by">${escapeHtml(`${verb} by ${member.setBy.name}`)}</span>`;
}
```

and use it in `renderSquadList`'s `map`:

```ts
      (member) =>
        `<li><span class="name">${escapeHtml(member.name)}${member.isGuest ? " (guest)" : ""}</span><span class="status status-${member.status}">${escapeHtml(squadStatusLabel(member))}</span>${attribution(member)}</li>`,
```

Add the over-capacity line beside `renderNudge`:

```ts
/**
 * BR-8's required visibility, on the page a player actually reads. An owner
 * has deliberately gone past `max_players`, and a player looking at a squad
 * longer than the game's own limit deserves to be told why rather than left
 * to count.
 */
function renderOverCapacity(view: FixtureView): string {
  if (!view.flags.includes("over_capacity")) return "";
  return `<p class="nudge">There are more players in than there are places — the organiser has added someone over the limit.</p>`;
}
```

and call it in `renderFixturePage`'s body immediately after `${renderNudge(view)}`.

Add `.set-by` to `SQUAD_STYLES_CSS` in `src/views/styles.ts`, muted and smaller:

```css
.squad .set-by { display: block; font-size: 0.85rem; color: var(--muted); }
```

Use whatever the existing muted colour variable in that file is called; if there is none, reuse the same colour `.muted` already sets.

- [ ] **Step 8: Run and watch them pass**

Run: `npx vitest run test/views/ test/db/`
Expected: PASS.

- [ ] **Step 9: Full suite, lint, typecheck**

Run: `npm test && npm run lint && npm run typecheck`
Expected: clean. `test/security/csp.test.ts` hashes `STYLE_BLOCKS` from source, so the new CSS is picked up automatically — but if a CSP test fails, that is the tripwire working and the fix is in that file, not a suppression.

- [ ] **Step 10: Commit**

```bash
git add src/db/queries.ts src/views/fixture.ts src/views/styles.ts test/db test/views
git commit -m "feat: name the organiser who answered for a player"
```

---

### Task 4: The owner fixture page (read-only)

**Spec:** §3.

**Files:**
- Create: `src/views/owner-fixture.ts`
- Create: `test/routes/owner-fixture.test.ts`
- Modify: `src/auth/paths.ts`, `src/routes/games.ts`, `src/views/game-overview.ts`, `src/views/styles.ts`, `test/browser/catalogue.ts`

**Interfaces:**
- Consumes: `SquadMember` with `setBy`/`source`/`isGuest` (Task 3).
- Produces:
  - `ownerFixturePath(gameId: string, fixtureId: string): string` → `/g/{gameId}/f/{fixtureId}`
  - `renderOwnerFixturePage(params: OwnerFixtureParams): string`
  - `OwnerFixtureParams = { gameId: string; gameName: string; fixtureId: string; kicksOffAtLocal: string; venueName: string; inCount: number; maxPlayers: number; view: FixtureView; squad: readonly SquadMember[]; viewerPlayerId: string; confirm?: { playerId: string | null; name: string; intent: "in" }; problem?: string }` — `confirm` and `problem` are Task 5/6's, and `inCount`/`maxPlayers` are what the confirmation banner's wording needs; declare all of them now so the view is written once.
  - A `loadFixtureTarget` helper in `src/routes/games.ts` returning `{ db, game, fixture } | null`.

This task ships the page **read-only**: no controls yet. That keeps the entitlement work, the view and the catalogue entry reviewable on their own, before any write path exists.

- [ ] **Step 1: Add the path helpers**

In `src/auth/paths.ts`, after `memberRemovePath`:

```ts
/**
 * One fixture of a game, seen by its owner (J6b §3).
 *
 * `/f/` rather than `/fixtures/` to keep a link that lands in a group chat
 * short; nested under the game because the entitlement check is the game's,
 * and a fixture id alone would invite a route that forgets to scope it.
 */
export function ownerFixturePath(gameId: string, fixtureId: string): string {
  return `/g/${gameId}/f/${fixtureId}`;
}

/** Where an owner's mark-in/mark-out for one player posts (J6b §4). */
export function ownerResponsePath(gameId: string, fixtureId: string, playerId: string): string {
  return `/g/${gameId}/f/${fixtureId}/response/${playerId}`;
}

/** Where the add-a-guest form posts (J6b §5). */
export function ownerGuestPath(gameId: string, fixtureId: string): string {
  return `/g/${gameId}/f/${fixtureId}/guest`;
}

/** Where removing a guest posts (J6b §5). */
export function ownerGuestRemovePath(gameId: string, fixtureId: string, playerId: string): string {
  return `/g/${gameId}/f/${fixtureId}/guest/${playerId}/remove`;
}
```

- [ ] **Step 2: Write the failing route tests**

Create `test/routes/owner-fixture.test.ts`, following the shape of `test/routes/squad.test.ts` (copy its sign-in / session helpers exactly — do not invent a new way to authenticate a test request).

```ts
describe("GET /g/:id/f/:fixtureId", () => {
  it("shows the squad to an owner", async () => {
    const { gameId, fixtureId } = await seedOpenFixtureOwnedBy(OWNER_ID);

    const response = await appFetch(`/g/${gameId}/f/${fixtureId}`, { as: OWNER_ID });

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Player 0");
  });

  it("404s for a player who is not an owner", async () => {
    const { gameId, fixtureId } = await seedOpenFixtureOwnedBy(OWNER_ID);

    const response = await appFetch(`/g/${gameId}/f/${fixtureId}`, { as: MEMBER_ID });

    expect(response.status).toBe(404);
  });

  it("404s for a fixture belonging to a different game", async () => {
    const { gameId } = await seedOpenFixtureOwnedBy(OWNER_ID);
    const other = await seedOpenFixtureOwnedBy(OWNER_ID);

    // The owner owns both games, so this is specifically the scoping check:
    // the fixture is real and they are entitled to it — just not at this path.
    const response = await appFetch(`/g/${gameId}/f/${other.fixtureId}`, { as: OWNER_ID });

    expect(response.status).toBe(404);
  });

  it("404s for an unknown fixture id", async () => {
    const { gameId } = await seedOpenFixtureOwnedBy(OWNER_ID);

    const response = await appFetch(`/g/${gameId}/f/${crypto.randomUUID()}`, { as: OWNER_ID });

    expect(response.status).toBe(404);
  });

  it("redirects an anonymous visitor to sign in", async () => {
    const { gameId, fixtureId } = await seedOpenFixtureOwnedBy(OWNER_ID);

    const response = await appFetch(`/g/${gameId}/f/${fixtureId}`);

    expect(response.status).toBe(302);
  });

  it("says a fixture is over capacity", async () => {
    const { gameId, fixtureId } = await seedFullFixtureOverCapacity(OWNER_ID);

    const html = await (await appFetch(`/g/${gameId}/f/${fixtureId}`, { as: OWNER_ID })).text();

    expect(html).toContain("Over capacity");
  });
});
```

Write `seedOpenFixtureOwnedBy` and `seedFullFixtureOverCapacity` in the test file using `test/support/factories.ts` and `openFixture`.

- [ ] **Step 3: Run and watch them fail**

Run: `npx vitest run test/routes/owner-fixture.test.ts`
Expected: FAIL — 404 on every case, because the route does not exist.

- [ ] **Step 4: Write the view**

Create `src/views/owner-fixture.ts`. Model it on `src/views/game-overview.ts` for structure and on `src/views/fixture.ts` for the status line. Requirements:

- `<h1>` is the game name; below it the kickoff, the venue, and `renderStatusLine(view)` reused from `src/views/fixture.ts` (import it — do not restate the wording).
- An `over_capacity` flag renders `<p class="problem">Over capacity — ${inCount} in, ${maxPlayers} places.</p>`.
- Squad rows in a `<ul class="squad">`, each `<li>` carrying the name, a `(guest)` suffix where `isGuest`, the status label, the attribution line where `source === "owner"`, and — from Task 5 — the controls.
- A back link to `gamePath(gameId)`.
- `params.problem`, when present, renders as `<p class="problem">` near the top, escaped.
- No `<script>`. `pageStyles: [FORM_CSS, SQUAD_STYLES_CSS]`.

Export `OwnerFixtureParams` exactly as the Interfaces block above declares it.

- [ ] **Step 5: Add the route**

In `src/routes/games.ts`, add the loader beside `loadSquadTarget`:

```ts
/**
 * The game and fixture behind a `/g/:id/f/:fixtureId` path, or `null`.
 *
 * Scoped by game id as well as fixture id, which is the whole point: without
 * it a fixture id in the path would be a global identifier and one owner could
 * read another squad's fixture. `null` for every refusal — no such game, not an
 * owner, no such fixture, a fixture of a different game — and the caller
 * answers 404 for all of them (TR-18).
 */
async function loadFixtureTarget(c: Context<AppEnv>, gameId: string, fixtureId: string) {
  const db = getDb(c.env.DB);
  const game = await findGameForOwner(db, gameId, c.get("player")!.id);
  if (game === null) return null;
  const [fixture] = await db.select().from(fixtures).where(eq(fixtures.id, fixtureId));
  if (!fixture || fixture.gameId !== game.id) return null;
  return { db, game, fixture };
}
```

and the handler — **registered after `/g/new` and after the `/g/:id/squad/...` routes**, matching the registration-order warning at the top of that file:

```ts
gamesRoutes.get("/g/:id/f/:fixtureId", requirePlayer, async (c) => {
  const target = await loadFixtureTarget(c, c.req.param("id"), c.req.param("fixtureId"));
  if (target === null) return c.text("Not found", 404);

  const now = new Date(Date.now());
  const withSquad = await getFixtureWithSquad(target.db, target.fixture.id);
  if (withSquad === null) return c.text("Not found", 404);

  return c.html(renderOwnerFixturePage(ownerFixtureParams(withSquad, c.get("player")!.id, now)));
});
```

Write `ownerFixtureParams(withSquad, viewerPlayerId, now, extras?)` as a small local function that builds `OwnerFixtureParams` from a `FixtureWithSquad` — calling `fixtureView` for the `view` and `formatLocalDateTime` for the kickoff. Tasks 5 and 6 re-render the same page after a refusal, and a shared builder is what stops the three renders drifting.

- [ ] **Step 6: Run and watch them pass**

Run: `npx vitest run test/routes/owner-fixture.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 7: Link the fixtures from the game overview**

In `src/views/game-overview.ts`, replace the `fixtureItems` map so each row links:

```ts
  const fixtureItems = upcoming
    .map(
      (fixture) =>
        `<li><a href="${escapeHtml(ownerFixturePath(gameId, fixture.id))}">${escapeHtml(formatLocalDateTime(fixture.kicksOffAt, timezone))}</a> — ${escapeHtml(fixture.lifecycle)}, ${fixture.inCount} in</li>`,
    )
    .join("");
```

- [ ] **Step 8: Add the catalogue entry**

In `test/browser/catalogue.ts`, add after `game-overview`:

```ts
  {
    id: "owner-fixture",
    title: "Fixture (organiser)",
    path: (world) => `/g/${world.gameId}/f/${world.fixtureId}`,
    persona: "owner",
    note: "One fixture as its organiser sees it: everyone's state, and the controls to change it.",
  },
```

`World` already carries `gameId` and `fixtureId`, so nothing in `test/browser/world.ts` changes.

- [ ] **Step 9: Run everything, including the browser suite**

Run: `npm test && npm run lint && npm run typecheck`
then: `npx playwright test`
Expected: all pass. The new catalogue entry puts the page under the console-error and CSP gate automatically; a CSP failure here means the new CSS is not in `STYLE_BLOCKS`.

- [ ] **Step 10: Commit**

```bash
git add src/auth/paths.ts src/views/owner-fixture.ts src/views/game-overview.ts src/views/styles.ts src/routes/games.ts test/routes/owner-fixture.test.ts test/browser/catalogue.ts
git commit -m "feat(games): give an organiser a page for one fixture"
```

---

### Task 5: Overrides — mark in, mark out, and the over-capacity confirmation

**Spec:** §4, §4.2, §4.3, §7.

**Files:**
- Modify: `src/domain/audit.ts`, `src/routes/games.ts`, `src/views/owner-fixture.ts`
- Test: `test/routes/owner-fixture.test.ts`

**Interfaces:**
- Consumes: `whenFull` and `would-exceed-capacity` (Task 1); `ownerResponsePath`, `renderOwnerFixturePage`, `loadFixtureTarget`, `ownerFixtureParams` (Task 4).
- Produces: `POST /g/:id/f/:fixtureId/response/:playerId`; the audit action `fixture.response_overridden`.

- [ ] **Step 1: Write the failing tests**

Add to `test/routes/owner-fixture.test.ts`:

```ts
describe("POST /g/:id/f/:fixtureId/response/:playerId", () => {
  it("marks a player in on their behalf", async () => {
    const { gameId, fixtureId } = await seedOpenFixtureOwnedBy(OWNER_ID);

    const response = await appPost(`/g/${gameId}/f/${fixtureId}/response/p-0`, { intent: "in" }, { as: OWNER_ID });

    expect(response.status).toBe(303);
    const [row] = await db.select().from(responses)
      .where(and(eq(responses.fixtureId, fixtureId), eq(responses.playerId, "p-0")));
    expect(row).toMatchObject({ status: "in", source: "owner", setByPlayerId: OWNER_ID });
  });

  it("writes an audit row naming the previous status", async () => {
    const { gameId, fixtureId } = await seedOpenFixtureOwnedBy(OWNER_ID);

    await appPost(`/g/${gameId}/f/${fixtureId}/response/p-0`, { intent: "in" }, { as: OWNER_ID });

    const [row] = await db.select().from(auditLog)
      .where(eq(auditLog.action, "fixture.response_overridden"));
    expect(row).toMatchObject({ actorPlayerId: OWNER_ID, entityType: "fixture", entityId: fixtureId });
    expect(JSON.parse(row!.beforeJson!)).toEqual({ playerId: "p-0", status: "pending" });
    expect(JSON.parse(row!.afterJson!)).toEqual({ playerId: "p-0", status: "in", overCapacity: false });
  });

  it("asks before going over capacity, and writes nothing", async () => {
    const { gameId, fixtureId } = await seedFullFixtureOwnedBy(OWNER_ID);

    const response = await appPost(`/g/${gameId}/f/${fixtureId}/response/p-9`, { intent: "in" }, { as: OWNER_ID });

    expect(response.status).toBe(422);
    const html = await response.text();
    expect(html).toContain("is full");
    expect(html).toContain("Add them anyway");
    const [row] = await db.select().from(responses)
      .where(and(eq(responses.fixtureId, fixtureId), eq(responses.playerId, "p-9")));
    expect(row?.status).toBe("pending");
  });

  it("goes over capacity when the owner confirms", async () => {
    const { gameId, fixtureId } = await seedFullFixtureOwnedBy(OWNER_ID);

    const response = await appPost(
      `/g/${gameId}/f/${fixtureId}/response/p-9`,
      { intent: "in", override: "1" },
      { as: OWNER_ID },
    );

    expect(response.status).toBe(303);
    const [row] = await db.select().from(responses)
      .where(and(eq(responses.fixtureId, fixtureId), eq(responses.playerId, "p-9")));
    expect(row?.status).toBe("in");
    const [audit] = await db.select().from(auditLog)
      .where(eq(auditLog.action, "fixture.response_overridden"));
    expect(JSON.parse(audit!.afterJson!).overCapacity).toBe(true);
  });

  it("promotes the longest-waiting player when an override frees a slot", async () => {
    // The assertion this milestone most needs: an override touching M4's
    // waitlist behaviour must behave exactly as a self-response does.
    const { gameId, fixtureId, waitlistedId } = await seedFullFixtureWithWaitlist(OWNER_ID);

    await appPost(`/g/${gameId}/f/${fixtureId}/response/p-0`, { intent: "out" }, { as: OWNER_ID });

    const [promoted] = await db.select().from(responses)
      .where(and(eq(responses.fixtureId, fixtureId), eq(responses.playerId, waitlistedId)));
    expect(promoted?.status).toBe("in");
  });

  it("404s for a player who is not an owner", async () => {
    const { gameId, fixtureId } = await seedOpenFixtureOwnedBy(OWNER_ID);

    const response = await appPost(`/g/${gameId}/f/${fixtureId}/response/p-0`, { intent: "in" }, { as: MEMBER_ID });

    expect(response.status).toBe(404);
  });

  it("400s on an intent that is neither in nor out", async () => {
    const { gameId, fixtureId } = await seedOpenFixtureOwnedBy(OWNER_ID);

    const response = await appPost(`/g/${gameId}/f/${fixtureId}/response/p-0`, { intent: "maybe" }, { as: OWNER_ID });

    expect(response.status).toBe(400);
  });

  it("403s a cross-site post", async () => {
    const { gameId, fixtureId } = await seedOpenFixtureOwnedBy(OWNER_ID);

    const response = await appPost(
      `/g/${gameId}/f/${fixtureId}/response/p-0`,
      { intent: "in" },
      { as: OWNER_ID, origin: "https://evil.example" },
    );

    expect(response.status).toBe(403);
  });
});
```

Follow `test/routes/squad.test.ts` for how `appPost` sets the `Origin` header and the session cookie.

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run test/routes/owner-fixture.test.ts`
Expected: FAIL — the route does not exist.

- [ ] **Step 3: Add the audit action**

In `src/domain/audit.ts`, append to `AUDIT_ACTIONS`:

```ts
  // J6b. An owner answering on a player's behalf (BR-27). `before` carries the
  // status the row held, which is what BR-27's "previous value" means here;
  // `after.overCapacity` records whether this was BR-8's deliberate override
  // rather than an ordinary mark-in, because the two are indistinguishable
  // from the resulting row alone.
  "fixture.response_overridden",
```

- [ ] **Step 4: Add the handler**

In `src/routes/games.ts`, after the GET from Task 4:

```ts
gamesRoutes.post("/g/:id/f/:fixtureId/response/:playerId", requirePlayer, async (c) => {
  if (wrongOrigin(c)) return c.text("Forbidden", 403);

  const target = await loadFixtureTarget(c, c.req.param("id"), c.req.param("fixtureId"));
  if (target === null) return c.text("Not found", 404);

  const playerId = c.req.param("playerId");
  const form = await c.req.parseBody();
  const rawIntent = form["intent"];
  const intent = rawIntent === "in" || rawIntent === "out" ? rawIntent : null;
  // The value comes from a button this application rendered, so anything else
  // is a hand-built request and gets a 400 rather than a guess.
  if (intent === null) return c.text('Bad Request: "intent" must be exactly "in" or "out"', 400);

  const now = new Date(Date.now());
  const actor = c.get("player")!;
  const override = form["override"] === "1";

  // Read the previous status for the audit row *before* the write. BR-27 asks
  // for the previous value, and after the Durable Object returns it is gone.
  const before = await getFixtureWithSquad(target.db, target.fixture.id);
  const previous = before?.squad.find((m) => m.playerId === playerId);

  const outcome = await c.env.FIXTURE_CAPACITY.getByName(target.fixture.id).setResponse({
    playerId,
    intent,
    actorPlayerId: actor.id,
    source: "owner",
    whenFull: intent === "out" ? "waitlist" : override ? "exceed" : "refuse",
    now: now.getTime(),
  });

  if (outcome.kind === "rejected") {
    if (outcome.reason === "would-exceed-capacity") {
      // Not an error: the owner is one click from the thing they asked for.
      // 422, and the same page again with the question on it (§4.2).
      return renderOwnerFixture(c, target, now, {
        confirm: { playerId, name: previous?.name ?? "this player", intent: "in" },
      }, 422);
    }
    if (outcome.reason === "not-eligible") return c.text("Not found", 404);
    return renderOwnerFixture(c, target, now, {
      problem: "That fixture isn't taking answers any more.",
    }, 422);
  }

  await recordAudit(target.db, {
    actorPlayerId: actor.id,
    entityType: "fixture",
    entityId: target.fixture.id,
    action: "fixture.response_overridden",
    before: { playerId, status: previous?.status ?? "pending" },
    after: {
      playerId,
      status: outcome.kind === "waitlisted" ? "waitlisted" : outcome.status,
      overCapacity: override,
    },
    now,
  });

  // The same N-2 path a self-response takes, in the background, for the
  // reasons `notifyPromotedPlayer` documents. An override that frees a slot
  // promotes exactly as any other dropout does (BR-7).
  if (outcome.kind === "recorded" && outcome.promoted) {
    c.executionCtx.waitUntil(notifyPromotedPlayer(c.env, target.fixture.id, outcome.promoted, now));
  }

  return c.redirect(ownerFixturePath(target.game.id, target.fixture.id), 303);
});
```

Extract `renderOwnerFixture(c, target, now, extras, status = 200)` as a local helper wrapping `getFixtureWithSquad` + `ownerFixtureParams` + `c.html`, so the GET and both refusal paths render through one function.

- [ ] **Step 5: Render the controls and the confirmation**

In `src/views/owner-fixture.ts`, give each squad row its two buttons:

```ts
      const controls = member.isGuest
        ? `<form method="post" action="${escapeHtml(ownerGuestRemovePath(gameId, fixtureId, member.playerId))}"><button class="button" type="submit">Remove</button></form>`
        : `<form method="post" action="${escapeHtml(ownerResponsePath(gameId, fixtureId, member.playerId))}">
             <button class="button" type="submit" name="intent" value="in">Mark in</button>
             <button class="button" type="submit" name="intent" value="out">Mark out</button>
           </form>`;
```

A guest gets **Remove alone** — a guest is `in` from the moment they are added and there is no meaningful `out` for someone who was never invited (§3).

And render `params.confirm` as a banner above the squad:

```ts
  const confirm =
    params.confirm === undefined
      ? ""
      : `<div class="confirm">
           <p>${escapeHtml(`${params.gameName} is full (${params.inCount} of ${params.maxPlayers}). Add ${params.confirm.name} anyway?`)}</p>
           <form method="post" action="${escapeHtml(
             params.confirm.playerId === null
               ? ownerGuestPath(gameId, fixtureId)
               : ownerResponsePath(gameId, fixtureId, params.confirm.playerId),
           )}">
             <input type="hidden" name="intent" value="in">
             <input type="hidden" name="override" value="1">
             ${params.confirm.playerId === null ? `<input type="hidden" name="name" value="${escapeHtml(params.confirm.name)}">` : ""}
             <button class="button primary" type="submit">Add them anyway</button>
           </form>
           <p><a href="${escapeHtml(ownerFixturePath(gameId, fixtureId))}">No, leave it</a></p>
         </div>`;
```

`confirm.playerId === null` is Task 6's guest case; wiring it now means the banner is written once. Add `inCount` and `maxPlayers` to `OwnerFixtureParams` if Task 4 did not already include them — the banner needs both.

- [ ] **Step 6: Run and watch them pass**

Run: `npx vitest run test/routes/owner-fixture.test.ts`
Expected: PASS.

- [ ] **Step 7: Full suite, lint, typecheck**

Run: `npm test && npm run lint && npm run typecheck`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add src/domain/audit.ts src/routes/games.ts src/views/owner-fixture.ts test/routes/owner-fixture.test.ts
git commit -m "feat(games): let an organiser answer for a player, and go over capacity on purpose"
```

---

### Task 6: Guests — adding and removing

**Spec:** §5, §7.

**Files:**
- Modify: `src/domain/audit.ts`, `src/routes/games.ts`, `src/views/owner-fixture.ts`
- Test: `test/routes/owner-fixture.test.ts`

**Interfaces:**
- Consumes: `parseGuestName`, `addGuest` (Task 2); `ownerGuestPath`, `ownerGuestRemovePath`, `renderOwnerFixture` (Tasks 4–5).
- Produces: `POST /g/:id/f/:fixtureId/guest`, `POST /g/:id/f/:fixtureId/guest/:playerId/remove`; audit actions `fixture.guest_added`, `fixture.guest_removed`.

- [ ] **Step 1: Write the failing tests**

Add to `test/routes/owner-fixture.test.ts`:

```ts
describe("guests", () => {
  it("adds a guest who occupies a slot", async () => {
    const { gameId, fixtureId } = await seedOpenFixtureOwnedBy(OWNER_ID);

    const response = await appPost(`/g/${gameId}/f/${fixtureId}/guest`, { name: "Sam Whitlock" }, { as: OWNER_ID });

    expect(response.status).toBe(303);
    const [guest] = await db.select().from(players).where(eq(players.isGuest, true));
    expect(guest).toMatchObject({ name: "Sam Whitlock", email: null });
    const [fixture] = await db.select().from(fixtures).where(eq(fixtures.id, fixtureId));
    expect(fixture?.inCount).toBe(1);
  });

  it("gives the guest no membership", async () => {
    const { gameId, fixtureId } = await seedOpenFixtureOwnedBy(OWNER_ID);

    await appPost(`/g/${gameId}/f/${fixtureId}/guest`, { name: "Sam Whitlock" }, { as: OWNER_ID });

    const [guest] = await db.select().from(players).where(eq(players.isGuest, true));
    expect(await db.select().from(memberships).where(eq(memberships.playerId, guest!.id))).toEqual([]);
  });

  it("writes an audit row", async () => {
    const { gameId, fixtureId } = await seedOpenFixtureOwnedBy(OWNER_ID);

    await appPost(`/g/${gameId}/f/${fixtureId}/guest`, { name: "Sam Whitlock" }, { as: OWNER_ID });

    const [row] = await db.select().from(auditLog).where(eq(auditLog.action, "fixture.guest_added"));
    expect(row).toMatchObject({ actorPlayerId: OWNER_ID, entityType: "fixture", entityId: fixtureId });
    expect(JSON.parse(row!.afterJson!).name).toBe("Sam Whitlock");
  });

  it("refuses an empty name without creating anybody", async () => {
    const { gameId, fixtureId } = await seedOpenFixtureOwnedBy(OWNER_ID);

    const response = await appPost(`/g/${gameId}/f/${fixtureId}/guest`, { name: "  " }, { as: OWNER_ID });

    expect(response.status).toBe(422);
    expect(await response.text()).toContain("Give your guest a name");
    expect(await db.select().from(players).where(eq(players.isGuest, true))).toEqual([]);
  });

  it("asks before adding a guest over capacity", async () => {
    const { gameId, fixtureId } = await seedFullFixtureOwnedBy(OWNER_ID);

    const response = await appPost(`/g/${gameId}/f/${fixtureId}/guest`, { name: "Sam Whitlock" }, { as: OWNER_ID });

    expect(response.status).toBe(422);
    expect(await response.text()).toContain("Add them anyway");
    expect(await db.select().from(players).where(eq(players.isGuest, true))).toEqual([]);
  });

  it("adds the guest over capacity once confirmed", async () => {
    const { gameId, fixtureId } = await seedFullFixtureOwnedBy(OWNER_ID);

    const response = await appPost(
      `/g/${gameId}/f/${fixtureId}/guest`,
      { name: "Sam Whitlock", override: "1" },
      { as: OWNER_ID },
    );

    expect(response.status).toBe(303);
    expect((await db.select().from(players).where(eq(players.isGuest, true))).length).toBe(1);
  });

  it("removes a guest and frees their slot", async () => {
    const { gameId, fixtureId } = await seedOpenFixtureOwnedBy(OWNER_ID);
    await appPost(`/g/${gameId}/f/${fixtureId}/guest`, { name: "Sam Whitlock" }, { as: OWNER_ID });
    const [guest] = await db.select().from(players).where(eq(players.isGuest, true));

    const response = await appPost(`/g/${gameId}/f/${fixtureId}/guest/${guest!.id}/remove`, {}, { as: OWNER_ID });

    expect(response.status).toBe(303);
    const [fixture] = await db.select().from(fixtures).where(eq(fixtures.id, fixtureId));
    expect(fixture?.inCount).toBe(0);
    const [audit] = await db.select().from(auditLog).where(eq(auditLog.action, "fixture.guest_removed"));
    expect(JSON.parse(audit!.beforeJson!).name).toBe("Sam Whitlock");
  });

  it("refuses to remove a squad member through the guest route", async () => {
    // `p-0` is a real member, not a guest. The guest route must not become a
    // second, unconfirmed way to remove people from a squad.
    const { gameId, fixtureId } = await seedOpenFixtureOwnedBy(OWNER_ID);

    const response = await appPost(`/g/${gameId}/f/${fixtureId}/guest/p-0/remove`, {}, { as: OWNER_ID });

    expect(response.status).toBe(404);
  });

  it("404s for a player who is not an owner", async () => {
    const { gameId, fixtureId } = await seedOpenFixtureOwnedBy(OWNER_ID);

    const response = await appPost(`/g/${gameId}/f/${fixtureId}/guest`, { name: "Sam" }, { as: MEMBER_ID });

    expect(response.status).toBe(404);
  });

  it("403s a cross-site post", async () => {
    const { gameId, fixtureId } = await seedOpenFixtureOwnedBy(OWNER_ID);

    const response = await appPost(
      `/g/${gameId}/f/${fixtureId}/guest`,
      { name: "Sam" },
      { as: OWNER_ID, origin: "https://evil.example" },
    );

    expect(response.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run test/routes/owner-fixture.test.ts`
Expected: FAIL on the guest describe block.

- [ ] **Step 3: Add the audit actions**

In `src/domain/audit.ts`, append:

```ts
  // J6b. A one-off guest, added to and removed from a single fixture. Both
  // carry a real actor: only an owner can do either.
  "fixture.guest_added",
  "fixture.guest_removed",
```

- [ ] **Step 4: Add the handlers**

```ts
gamesRoutes.post("/g/:id/f/:fixtureId/guest", requirePlayer, async (c) => {
  if (wrongOrigin(c)) return c.text("Forbidden", 403);

  const target = await loadFixtureTarget(c, c.req.param("id"), c.req.param("fixtureId"));
  if (target === null) return c.text("Not found", 404);

  const now = new Date(Date.now());
  const form = await c.req.parseBody();
  const parsed = parseGuestName(form["name"]);
  if (!parsed.ok) return renderOwnerFixture(c, target, now, { problem: parsed.problem }, 422);

  const override = form["override"] === "1";
  const outcome = await c.env.FIXTURE_CAPACITY.getByName(target.fixture.id).addGuest({
    name: parsed.name,
    actorPlayerId: c.get("player")!.id,
    whenFull: override ? "exceed" : "refuse",
    now: now.getTime(),
  });

  if (outcome.kind === "rejected") {
    if (outcome.reason === "would-exceed-capacity") {
      // `playerId: null` is what tells the banner to repost to the guest
      // endpoint with the name it is holding, rather than to a player.
      return renderOwnerFixture(c, target, now, {
        confirm: { playerId: null, name: parsed.name, intent: "in" },
      }, 422);
    }
    return renderOwnerFixture(c, target, now, {
      problem: "That fixture isn't taking answers any more.",
    }, 422);
  }

  await recordAudit(target.db, {
    actorPlayerId: c.get("player")!.id,
    entityType: "fixture",
    entityId: target.fixture.id,
    action: "fixture.guest_added",
    after: { playerId: outcome.playerId, name: parsed.name, overCapacity: override },
    now,
  });

  return c.redirect(ownerFixturePath(target.game.id, target.fixture.id), 303);
});

gamesRoutes.post("/g/:id/f/:fixtureId/guest/:playerId/remove", requirePlayer, async (c) => {
  if (wrongOrigin(c)) return c.text("Forbidden", 403);

  const target = await loadFixtureTarget(c, c.req.param("id"), c.req.param("fixtureId"));
  if (target === null) return c.text("Not found", 404);

  const playerId = c.req.param("playerId");
  const [player] = await target.db.select().from(players).where(eq(players.id, playerId));
  // Guests only. Squad members leave through `/g/:id/squad/:playerId/remove`,
  // which has a confirmation page; this route must not become a second,
  // unconfirmed way to take somebody out of a squad.
  if (!player || !player.isGuest) return c.text("Not found", 404);

  const now = new Date(Date.now());
  const before = await getFixtureWithSquad(target.db, target.fixture.id);
  const previous = before?.squad.find((m) => m.playerId === playerId);

  const outcome = await c.env.FIXTURE_CAPACITY.getByName(target.fixture.id).withdrawMember({
    playerId,
    actorPlayerId: c.get("player")!.id,
    now: now.getTime(),
  });

  if (outcome.kind === "removed") {
    await recordAudit(target.db, {
      actorPlayerId: c.get("player")!.id,
      entityType: "fixture",
      entityId: target.fixture.id,
      action: "fixture.guest_removed",
      before: { playerId, name: player.name, status: previous?.status ?? outcome.previousStatus },
      now,
    });

    // Removing a guest frees a slot, so it can promote (BR-7) — the same N-2
    // path every other dropout takes.
    if (outcome.promoted) {
      c.executionCtx.waitUntil(notifyPromotedPlayer(c.env, target.fixture.id, outcome.promoted, now));
    }
  }

  return c.redirect(ownerFixturePath(target.game.id, target.fixture.id), 303);
});
```

- [ ] **Step 5: Add the guest form to the view**

In `src/views/owner-fixture.ts`, below the squad list, only when the fixture is `open`:

```ts
  const guestForm =
    params.view.status === "cancelled" || params.view.status === "played" || params.view.status === "scheduled"
      ? ""
      : `<h2>Add a guest</h2>
         <p>Someone playing just this once. They won't be emailed — you'll need to tell them yourself.</p>
         <form method="post" action="${escapeHtml(ownerGuestPath(gameId, fixtureId))}" class="guest-form">
           <label for="guest-name">Their name</label>
           <input id="guest-name" name="name" type="text" maxlength="80" required>
           <button class="button" type="submit">Add guest</button>
         </form>`;
```

- [ ] **Step 6: Run and watch them pass**

Run: `npx vitest run test/routes/owner-fixture.test.ts`
Expected: PASS.

- [ ] **Step 7: Full suite, lint, typecheck**

Run: `npm test && npm run lint && npm run typecheck`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add src/domain/audit.ts src/routes/games.ts src/views/owner-fixture.ts test/routes/owner-fixture.test.ts
git commit -m "feat(games): add and remove a one-off guest on a fixture"
```

---

### Task 7: The browser journey

**Spec:** §8.

**Files:**
- Modify: `test/browser/journeys.spec.ts`
- Test: the same file

**Interfaces:**
- Consumes: everything from Tasks 4–6. `World` already carries `gameId`, `fixtureId`, `ownerPlayerId`.

- [ ] **Step 1: Write the journey**

Add to `test/browser/journeys.spec.ts`, matching the file's existing structure exactly (`observe(page)`, `signIn`, the JS-off variant):

```ts
test("an organiser answers for a player, adds a guest, and goes over capacity", async ({ page }) => {
  const seen = observe(page);
  const world = await seedWorld(page, browser);
  await signIn(page, TEST_OWNER);

  await page.goto(`/g/${world.gameId}/f/${world.fixtureId}`);

  // Mark a player in on their behalf, and see BR-27's attribution appear.
  const row = page.locator("li:has(.member)").first();
  await row.getByRole("button", { name: "Mark in" }).click();
  await expect(page.locator(".set-by").first()).toContainText("marked in by");

  // Add a guest, who occupies a slot.
  await page.fill("#guest-name", "Sam Whitlock");
  await page.getByRole("button", { name: "Add guest" }).click();
  await expect(page.locator("ul.squad")).toContainText("Sam Whitlock");

  expect(await seen.violations()).toEqual([]);
  expect(seen.errors()).toEqual([]);
});
```

Add a second test that fills the fixture to `max_players`, attempts one more mark-in, asserts the confirmation banner appears and that the squad has **not** grown, then clicks "Add them anyway" and asserts it has — with the over-capacity line visible. Fill the fixture by posting responses through minted tokens, the way `test/browser/world.ts` already does; do not click through fourteen player pages.

- [ ] **Step 2: Run the browser suite**

Run: `npx playwright test`
Expected: PASS, including the new tests and the catalogue gate over the new page.

- [ ] **Step 3: Prove the console gate can fail**

Temporarily add `console.error("deliberate")` to `renderOwnerFixturePage`'s output via a `<script>`, re-run just the catalogue spec, and confirm it fails. Revert. A gate never seen to fail is not known to work — this is the same discipline the CSP detector was proved with.

- [ ] **Step 4: Commit**

```bash
git add test/browser/journeys.spec.ts
git commit -m "test(browser): drive an override, a guest, and going over capacity"
```

---

### Task 8: The guide chapter and the milestone's paperwork

**Spec:** §8 (the guide), §10.

**Files:**
- Modify: `test/browser/guide-world.ts`, `test/browser/guide-shots.ts`, `docs/guide/05-running-your-squad.md`
- Modify: `docs/superpowers/specs/2026-08-10-make-the-team-design.md` (§2.14 status), `docs/known-issues.md`
- Regenerate: `docs/guide/images/`, `docs/guide/manifest.json`

- [ ] **Step 1: Add the shots**

In `test/browser/guide-shots.ts`, add three shots to the `05-running-your-squad` chapter:

```ts
  {
    id: "owner-fixture",
    chapter: "05-running-your-squad",
    title: "One fixture, as its organiser sees it",
    route: "/g/:id/f/:fixtureId",
    shows: "Everyone's answer for one fixture, with Mark in and Mark out beside each name",
    path: (world) => `/g/${world.gameId}/f/${world.fixtureId}`,
    persona: "owner",
  },
  {
    id: "owner-marked-in",
    chapter: "05-running-your-squad",
    title: "Answering for someone",
    route: "/g/:id/f/:fixtureId",
    shows: "A player marked in by the organiser, with the attribution line naming who did it",
    path: (world) => `/g/${world.gameId}/f/${world.fixtureId}`,
    persona: "owner",
  },
  {
    id: "owner-guest-added",
    chapter: "05-running-your-squad",
    title: "A guest for one week",
    route: "/g/:id/f/:fixtureId",
    shows: "A guest in the squad list, marked as a guest, occupying a slot",
    path: (world) => `/g/${world.gameId}/f/${world.fixtureId}`,
    persona: "owner",
  },
```

The guide world already has a fourteenth member who never answers — mark **that** player in, so the shot shows an override on someone who genuinely never responded. In `test/browser/guide-world.ts`, drive the mark-in and the guest-add through the owner page's own forms (not the API), so the screenshots depict a state the app itself produced.

- [ ] **Step 2: Run the capture**

Run: `npm run guide:capture`
Expected: three new images written, the manifest updated. Existing images change only if the pages they show changed.

- [ ] **Step 3: Look at the three new images**

Read each PNG. Check: no clipping, no placeholder text, the attribution line legible at 390px, and no name that could belong to a real person. If a shot is wrong, fix the world or the shot and recapture — do not write prose around a bad picture.

- [ ] **Step 4: Write the chapter section**

Add to `docs/guide/05-running-your-squad.md` a section covering: opening a fixture from the game page; marking someone in or out when they've told you another way; that the player sees who did it; adding a guest for one week and that guests are never emailed; and going over capacity deliberately. Plain language, organiser's point of view, no route patterns, no rule numbers. Match the voice of the existing chapters — read them first.

Be exact about the two things a reader will otherwise get wrong: **a guest is for that one fixture only** and will not be there next week, and **going over capacity is deliberate and shown as such** rather than a mistake the app tolerated.

- [ ] **Step 5: Run the guide reference checks**

Run: `npx playwright test test/browser/guide-references.spec.ts`
Expected: PASS — chapters exist, images exist, no orphans, manifest matches.

- [ ] **Step 6: Update the milestone status**

In `docs/superpowers/specs/2026-08-10-make-the-team-design.md` §2.14, replace the "M6 is half done" paragraph with a statement that M6 is complete, naming this plan as J6b's delivery alongside M6a's.

In `docs/known-issues.md`, close the row that names J6 as the trigger for squad removal (J6a already closed it) if it is still open, and check whether the leaked-invite-link row's "J6" references now need amending to say J6b shipped the rest. Do not invent new rows.

- [ ] **Step 7: Full suite one more time**

Run: `npm test && npm run lint && npm run typecheck && npx playwright test`
Expected: all clean.

- [ ] **Step 8: Commit**

```bash
git add test/browser/guide-world.ts test/browser/guide-shots.ts docs/guide docs/superpowers/specs/2026-08-10-make-the-team-design.md docs/known-issues.md
git commit -m "docs(guide): document overrides, guests and over-capacity"
```

---

## Self-review

**Spec coverage.** §2 (the gap) → Task 4. §3 (the page) → Task 4. §4/§4.1 (`whenFull`) → Task 1. §4.2 (confirmation) → Task 5. §4.3 (promotion, no new notification) → Task 5 step 1's promotion test. §5 (guests) → Tasks 2 and 6. §6 (attribution) → Task 3. §7 (audit) → Tasks 5 and 6. §8 (testing) → Tasks 7 and 8. §9 (exclusions) → nothing implements them, correctly. §10 (done) → Task 8's status update.

**Type consistency.** `whenFull` is `"waitlist" | "refuse" | "exceed"` on `SetResponseInput` and narrows to `"refuse" | "exceed"` on `AddGuestInput` — deliberate, and stated in both places. `SquadMember.setBy` is `{ playerId, name } | null` in Task 3 and consumed with that exact shape in Tasks 3 and 4. `AddGuestOutcome.playerId` exists only on the `added` variant and every consumer narrows first.

**Known soft spots for the implementer.** Task 3's test seeding and Task 4's `seedOpenFixtureOwnedBy` / `seedFullFixtureOwnedBy` / `seedFullFixtureWithWaitlist` are named but not written out — they must follow the existing helpers in the file they land in, and inventing a parallel authentication path for tests is the failure to avoid. Task 5's `renderOwnerFixture` helper is described rather than given in full; it is a three-line wrapper and writing it three different ways is the risk.

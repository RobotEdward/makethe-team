# Squad Visibility (M8) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An organiser can decide whether their players may see who else is playing, and players get a game view for the first time.

**Architecture:** One boolean column on `games`, one pure domain function that turns (game, squad, viewer) into either a squad list or `null` meaning "counts only", and two pages that render one or the other with no policy of their own. The player's game view is a separate renderer from the owner's, never a conditional inside it.

**Tech Stack:** TypeScript strict, Cloudflare Workers, Hono, D1 + Drizzle, drizzle-kit migrations, Vitest with `@cloudflare/vitest-pool-workers`, Playwright against `wrangler dev`.

**Spec:** `docs/superpowers/specs/2026-08-14-squad-visibility-design.md`. Read the section named in each task.

## Global Constraints

- **This milestone adds a migration** — one column, generated with `npm run db:generate` and applied locally with `npm run db:migrate:local`. Do not hand-write the SQL file; drizzle-kit names and journals it.
- **404, never 403, for every entitlement failure** on `/g/*` (TR-18): unknown game, non-member, removed member, inactive game — one answer for all four, so a game id cannot be probed.
- **The owner's page and the player's page are separate view modules.** The player page must not import from `src/views/game-overview.ts` and must not receive an `isOwner` flag. The owner page carries the invite link, which is a capability: anyone holding it can add people to the squad.
- **A viewer always sees their own response**, whatever the visibility setting says.
- `escapeHtml` every interpolated value. No `<script>` on any page this milestone touches. Every control works with JavaScript off.
- **Copy rule:** product words only. A player never reads "visibility flag", "lifecycle", a rule number, or a route pattern.
- Never bare `new Date()` — ESLint's `no-restricted-syntax` bans it. Use `new Date(Date.now())` in routes.
- Commit messages: lower-case conventional prefix, imperative, no trailing period on the subject.
- **Never `git add -A`.** Stage explicit paths only.
- Run long commands in the **foreground** with a raised tool timeout. `npm test` ~100s, `npx playwright test` ~3.5min. Never backgrounded, never via a monitor.

## File Structure

**Created**
- `src/domain/squad-visibility.ts` — the one decision: what squad may this viewer see.
- `src/views/player-game.ts` — a member's view of a game. Separate module by design.
- `migrations/00NN_*.sql` — generated, not written.
- `test/domain/squad-visibility.test.ts`, `test/routes/player-game.test.ts`.

**Modified**
- `src/db/schema.ts` — one column on `games`.
- `src/domain/game-form.ts` — `GameFormValues` gains the field; `parseGameForm` reads the checkbox.
- `src/views/game-form.ts` — the checkbox plus its hidden marker.
- `src/domain/update-game.ts` — persist the field; add it to `auditShape`.
- `src/db/queries.ts` — `findGameForMember`.
- `src/routes/games.ts` — the `/g/:id` audience branch.
- `src/routes/respond.ts`, `src/views/fixture.ts` — squad through the helper.
- `src/views/styles.ts`, `test/browser/catalogue.ts`, `test/browser/journeys.spec.ts`.
- `docs/guide/03-answering-a-reminder.md`, `docs/guide/05-running-your-squad.md`, `test/browser/guide-shots.ts`, `test/browser/guide-world.ts`.
- `docs/superpowers/specs/2026-08-10-make-the-team-design.md` — BR-25 amendment, new BR-33, §2.14 M8 row.

---

### Task 1: The column, the setting, and the form

**Spec:** §3, §6, §6.1.

**Files:**
- Modify: `src/db/schema.ts` (the `games` table), `src/domain/game-form.ts`, `src/views/game-form.ts`, `src/domain/update-game.ts`
- Create: `migrations/` entry via `npm run db:generate`
- Test: `test/domain/game-form.test.ts`, `test/routes/games.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `games.squadVisibleToPlayers: boolean` (column `squad_visible_to_players`, not null, default true); `GameFormValues.squadVisibleToPlayers: boolean`.

`createGame` spreads `values` straight into its insert (`src/domain/create-game.ts:65`), so adding the field to `GameFormValues` carries it into creation with no change there. `updateGame` sets columns explicitly and **does** need editing.

- [ ] **Step 1: Write the failing parser tests**

Add to `test/domain/game-form.test.ts`:

```ts
it("reads the squad-visibility checkbox when ticked", () => {
  const result = parseGameForm(bodyWith({ squadVisibleToPlayers: "on" }));
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.values.squadVisibleToPlayers).toBe(true);
});

it("treats an absent squad-visibility checkbox as off", () => {
  // An unchecked checkbox is simply absent from the POST body. This is the
  // whole reason the view needs a hidden marker field — see the view test.
  const result = parseGameForm(bodyWith({}));
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.values.squadVisibleToPlayers).toBe(false);
});
```

`bodyWith` is whatever helper that file already uses to build a valid body; if it has none, build the full valid body inline as its existing tests do.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run test/domain/game-form.test.ts`
Expected: FAIL — `squadVisibleToPlayers` is not on `GameFormValues`.

- [ ] **Step 3: Add the column**

In `src/db/schema.ts`, in the `games` table immediately after `prefersEvenNumbers`:

```ts
  // M8. Whether players may see who else is playing (BR-33). Default on:
  // the fixture page has listed the squad since M2, so defaulting off would
  // silently remove a capability players already have.
  squadVisibleToPlayers: integer("squad_visible_to_players", { mode: "boolean" })
    .notNull()
    .default(true),
```

- [ ] **Step 4: Generate and apply the migration**

Run: `npm run db:generate`
Then: `npm run db:migrate:local`

Expected: a new `migrations/00NN_*.sql` containing an `ALTER TABLE games ADD ...`, plus its `meta/` journal entry. **Do not hand-write or rename it.** Read the generated SQL and confirm it adds exactly one column with the default — if it proposes dropping or recreating the table, stop and report it.

- [ ] **Step 5: Thread it through the form**

In `src/domain/game-form.ts`, add to `GameFormValues`:

```ts
  squadVisibleToPlayers: boolean;
```

and in `parseGameForm`, beside the `prefersEvenNumbers` line:

```ts
  const squadVisibleToPlayers = typeof body["squadVisibleToPlayers"] === "string";
```

adding `squadVisibleToPlayers` to the returned `values` object.

- [ ] **Step 6: Persist it on edit and audit it**

In `src/domain/update-game.ts`, add `squadVisibleToPlayers` to the `set({...})` of the games update, to the `auditShape` parameter type, and to the object `auditShape` returns. It belongs in the audit shape for the same reason the other fields do: an edit that changes only this must still make `beforeJson` and `afterJson` differ, or the trail silently fails to record the one thing that changed.

- [ ] **Step 7: Add the checkbox, with its marker**

In `src/views/game-form.ts`, mirror the `PREFERS_EVEN_SUBMITTED` pattern exactly — do not invent a second approach:

```ts
const SQUAD_VISIBLE_SUBMITTED = "squadVisibleToPlayersSubmitted";

function squadVisibleChecked(values: Partial<Record<string, string>>): boolean {
  if (values[SQUAD_VISIBLE_SUBMITTED] !== undefined) {
    // A real submission: absent means unchecked, full stop.
    return values["squadVisibleToPlayers"] === "on";
  }
  // A fresh render. Absent means the caller said nothing, and a new game
  // shows the squad; the edit route says `""` explicitly for a saved false.
  return values["squadVisibleToPlayers"] === undefined || values["squadVisibleToPlayers"] === "on";
}
```

and the markup, beside the even-numbers field:

```html
      <div class="field">
        <input type="hidden" name="${SQUAD_VISIBLE_SUBMITTED}" value="1">
        <label for="squadVisibleToPlayers">
          <input id="squadVisibleToPlayers" name="squadVisibleToPlayers" type="checkbox"${
            squadVisibleChecked(values) ? " checked" : ""
          }>
          Let players see who else is playing
        </label>
      </div>
```

Check how the edit route populates `values` for `prefersEvenNumbers` and do the same for this field — a saved `false` must render as `""`, not be omitted.

- [ ] **Step 8: Write the failing redisplay test**

This is the bug §6.1 exists to prevent. In `test/routes/games.test.ts`:

```ts
it("keeps the squad-visibility box unticked through a 422 redisplay", async () => {
  // The trap: an unchecked box is absent from the body, so without the
  // hidden marker the redisplay re-ticks it and an owner who unticked it,
  // mistyped something else, and corrected that silently saves it back on.
  const response = await postGameForm({
    ...validGameFields,
    kickoffTime: "not a time",     // forces the 422
    // squadVisibleToPlayers deliberately absent — the box was unticked
  });

  expect(response.status).toBe(422);
  const html = await response.text();
  const box = html.match(/<input id="squadVisibleToPlayers"[^>]*>/)?.[0] ?? "";
  expect(box).not.toContain("checked");
});
```

Use whatever helper that file already has for posting the form; if none, build the request as its existing tests do.

- [ ] **Step 9: Run everything**

Run: `npx vitest run test/domain/game-form.test.ts test/routes/games.test.ts`
Expected: PASS.

Then: `npm test && npm run lint && npm run typecheck`
Expected: clean. Existing tests that build a `GameFormValues` literal will fail to typecheck until they carry the new field — add `squadVisibleToPlayers: true` to them, which preserves their current meaning.

- [ ] **Step 10: Commit**

```bash
git add src/db/schema.ts src/domain/game-form.ts src/views/game-form.ts src/domain/update-game.ts migrations test/domain/game-form.test.ts test/routes/games.test.ts
git commit -m "feat(games): let an organiser choose whether players see the squad"
```

---

### Task 2: `squadForViewer`

**Spec:** §3.1.

**Files:**
- Create: `src/domain/squad-visibility.ts`, `test/domain/squad-visibility.test.ts`

**Interfaces:**
- Consumes: `games.squadVisibleToPlayers` (Task 1); `SquadMember` from `src/db/queries.ts`.
- Produces:
  ```ts
  export function squadForViewer(
    game: { squadVisibleToPlayers: boolean },
    squad: readonly SquadMember[],
    viewer: { isOwner: boolean },
  ): readonly SquadMember[] | null;
  ```
  `null` means "counts only". Tasks 3 and 4 both consume it.

- [ ] **Step 1: Write the failing tests**

Create `test/domain/squad-visibility.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { squadForViewer } from "../../src/domain/squad-visibility.js";
import type { SquadMember } from "../../src/db/queries.js";

const SQUAD: SquadMember[] = [
  { playerId: "p-1", name: "Priya Raman", status: "in", waitlistRank: null,
    setBy: null, source: "token", isGuest: false },
];

describe("squadForViewer", () => {
  it("gives an owner the squad even when players may not see it", () => {
    expect(squadForViewer({ squadVisibleToPlayers: false }, SQUAD, { isOwner: true })).toEqual(SQUAD);
  });

  it("gives an owner the squad when players may see it", () => {
    expect(squadForViewer({ squadVisibleToPlayers: true }, SQUAD, { isOwner: true })).toEqual(SQUAD);
  });

  it("gives a player the squad when the game allows it", () => {
    expect(squadForViewer({ squadVisibleToPlayers: true }, SQUAD, { isOwner: false })).toEqual(SQUAD);
  });

  it("gives a player nothing when the game does not", () => {
    expect(squadForViewer({ squadVisibleToPlayers: false }, SQUAD, { isOwner: false })).toBeNull();
  });

  it("returns null rather than an empty list, so a caller cannot confuse hidden with empty", () => {
    // An empty array would render as "nobody is playing", which is a lie.
    expect(squadForViewer({ squadVisibleToPlayers: false }, [], { isOwner: false })).toBeNull();
  });

  it("gives an owner an empty squad as an empty list, not null", () => {
    expect(squadForViewer({ squadVisibleToPlayers: true }, [], { isOwner: false })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run test/domain/squad-visibility.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write it**

Create `src/domain/squad-visibility.ts`:

```ts
import type { SquadMember } from "../db/queries.js";

/**
 * The squad this viewer may see, or `null` for "counts only" (BR-33).
 *
 * An Owner always sees the full list — they are managing the fixture, and the
 * setting is theirs. A player sees it when their game allows it.
 *
 * **This is the only place that decides.** The pages that call it carry no
 * policy of their own: they render a list, or they render counts. A boolean
 * tested at three call sites is how one of them ends up testing it the wrong
 * way round.
 *
 * `null` rather than an empty array, deliberately: an empty list renders as
 * "nobody is playing", which is a different and false statement.
 *
 * A viewer's own response is never routed through here — it is rendered from
 * their own row, so it survives a `null` (§3.1).
 */
export function squadForViewer(
  game: { squadVisibleToPlayers: boolean },
  squad: readonly SquadMember[],
  viewer: { isOwner: boolean },
): readonly SquadMember[] | null {
  if (viewer.isOwner) return squad;
  return game.squadVisibleToPlayers ? squad : null;
}
```

- [ ] **Step 4: Run and watch them pass**

Run: `npx vitest run test/domain/squad-visibility.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/domain/squad-visibility.ts test/domain/squad-visibility.test.ts
git commit -m "feat: decide in one place what squad a viewer may see"
```

---

### Task 3: The fixture response page honours the setting

**Spec:** §5.

**Files:**
- Modify: `src/views/fixture.ts`, `src/routes/respond.ts`, `src/views/styles.ts`
- Test: `test/views/fixture.test.ts`, `test/routes/respond-get.test.ts`

**Interfaces:**
- Consumes: `squadForViewer` (Task 2).
- Produces: `FixturePageOptions.squad` becomes `readonly SquadMember[] | null`, and the interface gains `inCount: number`.

`FixturePageOptions` needs `inCount` because the hidden state still reports how many are in, and today that number is only implied by the list's length. The route has it on the fixture row it already reads.

- [ ] **Step 1: Write the failing view tests**

Add to `test/views/fixture.test.ts`:

```ts
it("lists the squad when the game allows it", () => {
  const html = renderFixturePage(optionsWith({
    squad: [{ playerId: "p-1", name: "Priya Raman", status: "in", waitlistRank: null,
              setBy: null, source: "token", isGuest: false }],
    inCount: 1,
  }));

  expect(html).toContain("Priya Raman");
});

it("names nobody when the game does not, but still says how many are in", () => {
  const html = renderFixturePage(optionsWith({ squad: null, inCount: 8 }));

  expect(html).not.toContain("Priya Raman");
  expect(html).toContain("8 in so far");
  expect(html).toContain("isn't shown for this game");
});

it("says one in, not 1 in, for a single player", () => {
  const html = renderFixturePage(optionsWith({ squad: null, inCount: 1 }));

  expect(html).toContain("1 in so far");
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run test/views/fixture.test.ts`
Expected: FAIL — `squad` does not accept `null`.

- [ ] **Step 3: Render the hidden state**

In `src/views/fixture.ts`, widen the option and add the alternative branch:

```ts
/**
 * The squad, or a count when the organiser has kept it private (BR-33).
 *
 * The count stays deliberately. "Are there enough players this week?" is the
 * question the whole product exists to answer, and hiding names is not a
 * reason to stop answering it.
 */
function renderSquadSection(squad: readonly SquadMember[] | null, inCount: number): string {
  if (squad === null) {
    return `<p class="muted">Who's playing isn't shown for this game. ${inCount} in so far.</p>`;
  }
  return renderSquadList(squad);
}
```

and call it from `renderFixturePage` where `renderSquadList(squad)` is called today, passing `options.inCount`.

- [ ] **Step 4: Pass it from the route**

In `src/routes/respond.ts`'s `renderFixtureForViewer`, wrap the squad:

```ts
    squad: squadForViewer(game, squad, { isOwner: false }),
    inCount: fixture.inCount,
```

The viewer of `/r/:token` is always a player: this route is reached with a signed response token and no session at all, so there is no owner to detect. Do not add one.

- [ ] **Step 5: Write the failing route test**

Add to `test/routes/respond-get.test.ts`:

```ts
it("hides other players when the game says so", async () => {
  const { token } = await seedRespondableFixture({ squadVisibleToPlayers: false });

  const html = await (await app.fetch(new Request(`${ORIGIN}/r/${token}`))).text();

  expect(html).not.toContain("Player 1");
  expect(html).toContain("in so far");
});

it("shows other players when the game says so", async () => {
  const { token } = await seedRespondableFixture({ squadVisibleToPlayers: true });

  const html = await (await app.fetch(new Request(`${ORIGIN}/r/${token}`))).text();

  expect(html).toContain("Player 1");
});
```

Extend that file's existing seeding helper to take the flag; do not build a parallel one.

- [ ] **Step 6: Run everything**

Run: `npx vitest run test/views/fixture.test.ts test/routes/respond-get.test.ts`
then: `npm test && npm run lint && npm run typecheck`
Expected: clean. `test/security/csp.test.ts` hashes styles from source, so if you add CSS it is picked up automatically; a CSP failure means the source and the hash disagree, and the fix is never to suppress the test.

- [ ] **Step 7: Commit**

```bash
git add src/views/fixture.ts src/routes/respond.ts src/views/styles.ts test/views/fixture.test.ts test/routes/respond-get.test.ts
git commit -m "feat(respond): keep the squad private when the organiser asks"
```

---

### Task 4: The player's game view

**Spec:** §4, §4.1, §4.2.

**Files:**
- Create: `src/views/player-game.ts`, `test/routes/player-game.test.ts`
- Modify: `src/db/queries.ts`, `src/routes/games.ts`, `src/views/styles.ts`, `test/browser/catalogue.ts`

**Interfaces:**
- Consumes: `squadForViewer` (Task 2).
- Produces:
  - `findGameForMember(db, gameId, playerId)` → `typeof games.$inferSelect | null`
  - `renderPlayerGamePage(params: PlayerGameParams): string` where
    ```ts
    interface PlayerGameParams {
      gameName: string;
      venueName: string;
      venueAddress: string | null;
      timezone: string;
      /** The open fixture, or null when none is open. */
      openFixture: { kicksOffAtLocal: string; view: FixtureView; inCount: number;
                     squad: readonly SquadMember[] | null } | null;
      upcoming: readonly { kicksOffAt: Date; lifecycle: string }[];
      viewerPlayerId: string;
    }
    ```

- [ ] **Step 1: Write the failing route tests**

Create `test/routes/player-game.test.ts`, copying the session helpers from `test/routes/owner-fixture.test.ts` exactly — this harness supports one real signed-in identity and varies the membership row, not the session.

```ts
describe("GET /g/:id as a member", () => {
  it("shows the open fixture's squad to a member", async () => {
    const { gameId } = await seedGameWithOpenFixture({ viewerRole: "player", squadVisibleToPlayers: true });

    const response = await appFetch(`/g/${gameId}`);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Player 0");
  });

  it("hides other players when the organiser has turned it off", async () => {
    const { gameId } = await seedGameWithOpenFixture({ viewerRole: "player", squadVisibleToPlayers: false });

    const html = await (await appFetch(`/g/${gameId}`)).text();

    expect(html).not.toContain("Player 0");
    expect(html).toContain("in so far");
  });

  it("still gives an owner the owner's page", async () => {
    const { gameId } = await seedGameWithOpenFixture({ viewerRole: "owner", squadVisibleToPlayers: false });

    const html = await (await appFetch(`/g/${gameId}`)).text();

    // The invite link is the owner page's tell, and it must never appear on
    // the player's — it is a capability, not a decoration.
    expect(html).toContain("Invite people");
  });

  it("never shows a member the invite link", async () => {
    const { gameId } = await seedGameWithOpenFixture({ viewerRole: "player", squadVisibleToPlayers: true });

    const html = await (await appFetch(`/g/${gameId}`)).text();

    expect(html).not.toContain("Invite people");
    expect(html).not.toContain("/j/");
  });

  it("404s a removed member", async () => {
    const { gameId } = await seedGameWithOpenFixture({ viewerRole: "removed", squadVisibleToPlayers: true });

    expect((await appFetch(`/g/${gameId}`)).status).toBe(404);
  });

  it("404s a non-member", async () => {
    const { gameId } = await seedGameWithOpenFixture({ viewerRole: "none", squadVisibleToPlayers: true });

    expect((await appFetch(`/g/${gameId}`)).status).toBe(404);
  });

  it("says so when no fixture is open, and names nobody", async () => {
    const { gameId } = await seedGameWithNoOpenFixture({ viewerRole: "player" });

    const html = await (await appFetch(`/g/${gameId}`)).text();

    expect(html).toContain("Nothing open yet");
    expect(html).not.toContain("Player 0");
  });
});
```

Write `seedGameWithOpenFixture` and `seedGameWithNoOpenFixture` from `test/support/factories.ts` and `openFixture`. `viewerRole: "removed"` means an inactive membership row; `"none"` means no membership row at all.

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run test/routes/player-game.test.ts`
Expected: FAIL — every member case 404s, because only owners reach `/g/:id`.

- [ ] **Step 3: Add the member entitlement query**

In `src/db/queries.ts`, beside `findGameForOwner`:

```ts
/**
 * The game, if and only if this player is an **active member** of it, whatever
 * their role (TR-18).
 *
 * The role-agnostic sibling of `findGameForOwner`. Returns `null` for "no such
 * game", "not a member", "a member who was removed" and "a deactivated game"
 * alike — the caller answers 404 for all four, so a game id cannot be probed
 * and a removed member learns nothing from the difference.
 */
export async function findGameForMember(
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
        eq(memberships.active, true),
      ),
    )
    .limit(1);
  return row?.game ?? null;
}
```

- [ ] **Step 4: Write the player view**

Create `src/views/player-game.ts`. Model its structure on `src/views/owner-fixture.ts`, and import `renderStatusLine` from `src/views/fixture.ts` and the shared row helpers from `src/views/squad-row.ts` rather than restating any wording.

Requirements:
- `<h1>` the game name; venue and address below it.
- When `openFixture` is present: its kickoff, `renderStatusLine(view)`, then either the squad list or `Who's playing isn't shown for this game. N in so far.` — reuse Task 3's wording by importing whatever Task 3 exported, or if Task 3 kept it private, export it there now rather than writing the sentence twice.
- When `openFixture` is null: `<p>Nothing open yet — you'll get an email the day before the next game.</p>`
- Then `<h2>Coming up</h2>` and the upcoming dates as a plain list.
- **No invite link, no QR code, no controls, no edit link, no squad-management anything.**
- No `<script>`. `pageStyles: [FORM_CSS, SQUAD_STYLES_CSS]`.

Do not import from `src/views/game-overview.ts`.

- [ ] **Step 5: Branch the route**

In `src/routes/games.ts`, in the existing `GET /g/:id` handler, after the owner lookup fails:

```ts
  const game = await findGameForOwner(db, c.req.param("id"), player.id);
  if (game === null) {
    // Not an owner. A member gets their own page; everyone else gets the same
    // 404 an owner-entitlement failure gets, so the two are indistinguishable.
    const asMember = await findGameForMember(db, c.req.param("id"), player.id);
    if (asMember === null) return c.text("Not found", 404);
    return renderPlayerGame(c, asMember, player.id, now);
  }
```

Write `renderPlayerGame` as a local helper that finds the game's open fixture (`listOpenFixtureIds` returns them kickoff-ordered — take the first), loads it with `getFixtureWithSquad`, builds `PlayerGameParams` — passing `squadForViewer(game, squad, { isOwner: false })` — and returns `c.html(...)`.

- [ ] **Step 6: Run and watch them pass**

Run: `npx vitest run test/routes/player-game.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 7: Add the catalogue entry**

In `test/browser/catalogue.ts`:

```ts
  {
    id: "player-game",
    title: "Game (player)",
    path: (world) => `/g/${world.gameId}`,
    persona: "player",
    note: "A member's view of a game: who's playing this week, and what's coming up.",
  },
```

Check the `Persona` type in that file. If it has no `"player"` value, add one and teach the capture how to sign in as `TEST_PLAYER` — `test/browser/sign-in.ts` already exports it. If wiring a new persona turns out to be more than a few lines, use the existing signed-in persona and seed that identity as a plain member instead; say which you did in your report.

This repo also pins every route to a named page in `test/routes/signin.test.ts` and `test/browser/catalogue.spec.ts`; `GET /g/:id` is already pinned, so those may need no change — check.

- [ ] **Step 8: Full gate**

Run: `npm test && npm run lint && npm run typecheck`
then: `npx playwright test`
Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add src/db/queries.ts src/views/player-game.ts src/routes/games.ts src/views/styles.ts test/routes/player-game.test.ts test/browser/catalogue.ts
git commit -m "feat(games): give a player their own view of a game"
```

---

### Task 5: The browser journey

**Spec:** §8.

**Files:**
- Modify: `test/browser/journeys.spec.ts`

This tier exists because server tests stop at the Worker boundary — see the `connect-src` post-mortem in `docs/known-issues.md`, where both passkey buttons were broken in every browser for days while the whole server suite stayed green.

- [ ] **Step 1: Write the journey**

Add to `test/browser/journeys.spec.ts`, following its existing structure exactly (`observe(page)`, `seedWorld(page, browser)`, and its JS-off variants). **Note `seedWorld` leaves the page signed in as the owner — do not call `signIn` again after it, which hangs rather than failing, because `/sign-in` redirects an authenticated visitor away from the form.**

The journey:
1. As the organiser, open `/g/{gameId}` and confirm the owner page renders (the invite section is present).
2. Turn the setting off through the edit form — untick "Let players see who else is playing" and save.
3. Reload the player-facing fixture page for a squad member (`/r/{responseToken}`) and assert another member's name is **absent** while the count line is present.
4. Turn it back on, reload, and assert the name is **present** again.

Assert `seen.violations()` and `seen.errors()` are empty, as the file's other journeys do.

Step 3's negative assertion is the one carrying weight: it is what distinguishes a real setting from a checkbox that saves and changes nothing.

- [ ] **Step 2: Run the browser suite**

Run: `npx playwright test` (foreground, 900000ms timeout)
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add test/browser/journeys.spec.ts
git commit -m "test(browser): drive the squad-visibility setting end to end"
```

---

### Task 6: The guide and the spec amendments

**Spec:** §3.2, §8, and the milestone note in the header.

**Files:**
- Modify: `docs/superpowers/specs/2026-08-10-make-the-team-design.md`, `docs/guide/03-answering-a-reminder.md`, `docs/guide/05-running-your-squad.md`, `test/browser/guide-shots.ts`, `test/browser/guide-world.ts`
- Regenerate: `docs/guide/images/`, `docs/guide/manifest.json`

- [ ] **Step 1: Amend the business rules**

In `docs/superpowers/specs/2026-08-10-make-the-team-design.md`:

- **BR-25** currently says a valid response token authorises viewing that single fixture's squad, unconditionally. Amend it to say that this is subject to the game's squad-visibility setting, naming BR-33.
- Add **BR-33** under "Access and identity":

  > **BR-33** A Game carries a squad-visibility setting, default on. When it is off, players see a fixture's counts and their own response but not other players' names or responses. Owners are unaffected.

- Add an **M8** row to §2.14's build order table: scope "Squad visibility — an owner-controlled setting, and a player's view of a game", done when "a player can see who else is playing, and an owner can turn that off".

Do not restate the rule in two voices — BR-25 should point at BR-33, not duplicate it.

- [ ] **Step 2: Add the shots**

In `test/browser/guide-shots.ts`, add two shots to the `03-answering-a-reminder` chapter — the response page with the squad shown, and the same page with it hidden — and one to `05-running-your-squad` showing the organiser's checkbox.

Drive the setting change in `test/browser/guide-world.ts` **through the edit form**, not the database, so the screenshot depicts a state the app itself produced.

**Beware the trap the previous milestone hit:** the guide world's counts and names are quoted verbatim in chapters 1, 3, 4 and 6. Changing the main world's state falsifies them silently. If showing the hidden state would disturb the main game, build a small second game for these shots exactly as J6b's `buildOverrideDemo` does, and say so in your report.

- [ ] **Step 3: Capture and look at the images**

Run: `npm run guide:capture` (foreground, 900000ms timeout)

Then **read each new PNG.** Check: not clipped, no placeholder text, legible at 390px, no name that could belong to a real person, and — for the hidden-state shot — that no other player's name is actually visible in the image. Never write prose around a bad screenshot.

- [ ] **Step 4: Write the prose**

Chapter 03 currently tells a player they can see the squad. That stops being unconditionally true: say that they see who else is playing **when their organiser allows it**, and what they see when they don't (the count, and their own answer).

Chapter 05 gains the organiser's control: what the setting does, that it is on by default, and that it changes nothing for them — they always see the whole squad.

Match the existing chapters' voice. Read two of them first.

- [ ] **Step 5: Run the reference checks and the full gate**

Run: `npx playwright test test/browser/guide-references.spec.ts`
then: `npm test && npm run lint && npm run typecheck`
then: `npx playwright test`
Expected: all clean.

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/specs/2026-08-10-make-the-team-design.md docs/guide test/browser/guide-shots.ts test/browser/guide-world.ts
git commit -m "docs: document squad visibility and amend BR-25"
```

---

## Self-review

**Spec coverage.** §2 (what's new) → Tasks 1, 3, 4. §3 (column and rule) → Task 1. §3.1 (`squadForViewer`) → Task 2. §3.2 (BR amendments) → Task 6. §4/§4.1/§4.2 (player game view, separate renderer, contents) → Task 4. §5 (fixture page) → Task 3. §6/§6.1 (the control and the checkbox trap) → Task 1, steps 7–8. §7 (out of scope) → nothing implements it, correctly; the dashboard is untouched by every task. §8 (testing) → Tasks 4, 5, 6. §9 (done) → all six.

**Type consistency.** `squadVisibleToPlayers` is spelled identically in the schema, `GameFormValues`, the form field name and `squadForViewer`'s parameter. `FixturePageOptions.squad` widens to `readonly SquadMember[] | null` in Task 3 and `PlayerGameParams.openFixture.squad` uses the same type in Task 4. `findGameForMember` returns the same `typeof games.$inferSelect | null` as `findGameForOwner`.

**Known soft spots for the implementer.** Task 4's `Persona` question is genuinely open — the browser catalogue may have no player persona, and the plan gives an explicit fallback rather than pretending to know. Task 3 and Task 4 both render the hidden-state sentence; Task 4 says to export it from Task 3's module rather than write it twice, and an implementer who writes it twice will produce two wordings that drift. Task 6's guide-world change is the one most likely to falsify existing chapters, and the plan names the specific defence.

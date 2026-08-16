# Player account — design

**Date:** 16 August 2026
**Status:** approved
**Milestone:** M11. Adds a milestone rather than filling one; the master spec's
build order (§2.14) needs a row for it, as M8 and M10 did.

## 1. What this is

Three small things, in one milestone because they are the same page seen from
two sides plus the link that leads to it:

1. **A sign-in link on the home page.** `/` currently offers Privacy and
   nothing else. There is no link anywhere on the public site to `/sign-in`.
2. **An account page for a player, seen by themselves** — `/app/account`. Their
   name (editable), their email (read-only), a link to manage how they sign in,
   and their last 20 fixtures across every game they belong to.
3. **The same player, seen by an organiser of one of their games** —
   `/g/:id/squad/:playerId`. Name, email, role and joined date, all read-only,
   and **no fixture history at all**.

Anybody else signed in gets a 404.

## 2. Why two pages and not one

The obvious shape is one URL — `/app/players/:playerId` — branching on the
viewer's relationship to the subject. It was rejected.

Two pages means **the entitlement question is answered by the URL's shape
rather than by a branch inside a handler**. `/app/account` names no player at
all, so its subject is `c.get("player")` and there is nothing in it to probe or
to get wrong. `/g/:id/squad/:playerId` is scoped to a game, so it is entitled
exactly the way `memberRolePath`, `memberRemovePath` and `ownerFixturePath`
already are — by `loadSquadTarget`, which exists.

It also means the fixture history is **absent from the organiser's renderer**,
not conditionally suppressed inside a shared one. A single view with a
`mode: "self" | "owner"` prop would put the read-only/editable distinction and
the history/no-history distinction in two `if`s inside one template, and a
later edit that reorders or refactors that template is how a squad list ends up
on a page it should never have reached.

The third option — no page for the organiser at all, just more inside the
existing per-member `<details>` on the game overview — was rejected because it
would put every squad member's email address on one page.

## 3. What already exists

Nearly all of the organiser half.

| | State today |
|---|---|
| `loadSquadTarget` (`src/routes/games.ts`) | **Exists.** Owner-of-this-game + player-is-in-this-squad, `null` on either failure. Five routes already use it. |
| `findMembershipInGame` (`src/db/queries.ts`) | **Exists**, and already selects `name`, `email`, `role`, `active`, `joinedAt`. No query change needed. |
| `PASSKEYS_PATH` → `/app/passkeys` | **Exists.** The "manage how you sign in" link is a link to a page that already works. |
| A fixture history query | **Does not exist.** `listDashboardFixtures` deliberately excludes terminal lifecycles. |
| `/app/account` | **Does not exist.** `src/routes/account.ts` today holds only the erasure flow. |
| A sign-in link on `/` | **Does not exist.** |

**No migration.** Nothing here adds a column.

## 4. The home page link

`/` gains a `Sign in` link beside the existing Privacy link. It is
**unconditional** — it does not say "Your dashboard" to somebody already signed
in.

`/` sits outside every mount of `sessionMiddleware`, for the blast-radius
reason set out in that middleware's own doc comment: a defect in session
resolution must not be able to take down the one page every stranger reaches.
Personalising this link would require either a fourth mount or a call to
`resolveSessionPlayer`, and would put a cookie parse and an HMAC verification
on every hit to the holding page — including every prefetch and every crawl —
to change one word. A signed-in visitor following "Sign in" is bounced straight
to the dashboard by the existing `/sign-in` handler, so the unconditional link
is not even wrong for them.

## 5. `/app/account` — the player's own page

New constant in `src/auth/paths.ts`:

```ts
export const ACCOUNT_PATH = `${DASHBOARD_PATH}/account`;
```

Under `DASHBOARD_PATH` so it inherits the session mount and the
`private, no-store` header `AUTHENTICATED_PREFIX` carries — this page renders
an email address and a fixture history, and neither belongs in a shared cache.

Both handlers join `src/routes/account.ts`, which is already the module for
"things a player does to their own account", and both run behind
`requirePlayer`. **There is no player id anywhere in either URL**, so as with
the dashboard the guard establishing *who* is also the whole of the entitlement
question (TR-18): there is no id for a handler to forget to check.

### 5.1 What the page shows

- **Name**, in a text input inside a form that posts back to this same path.
- **Email**, as plain text, read-only, under a line saying it cannot be changed
  here. See §5.3.
- **How you sign in** — a link to `PASSKEYS_PATH`.
- **Your fixtures** — the last 20, §6.
- **Delete my data** — a link to `DELETE_ACCOUNT_PATH`. It is the other thing
  that belongs on an account page, and today it is reachable only from the
  dashboard footer.

If an erasure is pending, the page says so and links to `/app/delete`, rather
than offering a rename as though nothing were happening. `player.erasesAt` is
already on `c.get("player")` — `sessionMiddleware` selects the whole row — so
this costs no query.

### 5.2 `POST /app/account` — the rename

Origin-checked exactly as `POST /app` and `POST /app/delete` are, and for the
stated reason: this is a same-origin form post on our own page, a browser
always sends `Origin` on a cross-site one, and a missing header is a non-browser
client acting on its own behalf.

Validation, in a domain module `src/domain/player-name.ts` so the rule has one
home and the route carries no policy:

- Trimmed.
- Empty after trimming is refused. A squad list of blanks is worse than a
  refusal.
- Capped at 200 characters, matching `MAX_NAME_LENGTH` in
  `src/domain/game-form.ts`, which is what game and venue names use.

A refusal re-renders the page itself at 422 with the reason on it — the pattern
`renderDashboard` and `renderDeleteAccount` both use, which is why the page gets
one `renderAccount(c, problem?)` function reached by both handlers rather than a
second copy of the page assembled after the write. Success writes
`players.name`, records an audit row, and redirects 303 to `ACCOUNT_PATH`.

**It does not touch Better Auth's `user.name`.** Nothing in this product renders
that column; the domain `players` row is the name every page, email and squad
list reads. Writing both would create two names that can disagree, with no rule
about which wins.

New audit action, added to `AUDIT_ACTIONS` in `src/domain/audit.ts`:

```
"player.renamed"
```

Subject and actor are always the same player, as with the four erasure actions
— this route acts on the session's own player id and takes no parameter naming
a player. `before_json`/`after_json` carry `{ name }`, because the point of the
row is what the name used to be.

### 5.3 Email is read-only, deliberately

`players.email` is not just a column: it is the identity Better Auth signs
people in with (`user.email`), and the address every notification goes to.
Making it editable means either

- writing both rows immediately, so that one typo silently ends the account —
  sign-in stops working *and* the magic link that would fix it goes to a
  stranger's inbox; or
- a verified change: a pending-address column, a token flow, a confirmation
  page, and a decision about what happens to squad email in between.

The second is correct and is its own milestone. Until then the page says the
address is fixed rather than pretending otherwise. Somebody who must change it
can register again under the new address, which is the honest current answer.

## 6. The fixture history

New query in `src/db/dashboard-queries.ts`, beside the two that already share
`selectEntitledFixtures`:

```ts
export async function listPlayerFixtureHistory(
  db: Db,
  playerId: string,
  limit: number,
): Promise<DashboardFixture[]>
```

It reuses `selectEntitledFixtures`'s joins and its `eq(responses.playerId, …)`
root — so it still, structurally, cannot reach another player's response row —
with **two deliberate differences** from `listDashboardFixtures`:

1. **Terminal lifecycles are included.** `played` and `cancelled` fixtures are
   the history; excluding them, as the dashboard does, would leave this list
   showing exactly what the dashboard already shows.
2. **Ordered `kicksOffAt` desc, limited to 20.** Most recent first.

This means the predicate can no longer be `entitledTo` unchanged.
`entitledTo` will take the lifecycle condition as a parameter rather than
hard-coding it, so the security half — the viewer's own response rows, an
active membership, not `withdrawn` — stays in one place and is shared by all
three callers. The lifecycle filter is a *scope* choice, not a security one;
splitting them is what lets this query relax one without touching the other.

`memberships.active` stays. A player who left a game keeps their history in the
sense that the rows survive, but they lose their standing in that game, and this
page is not an exception to that. The consequence is worth stating: **leaving a
game removes its fixtures from this list.** That is the same rule the dashboard
applies, and a page that showed them would be showing a squad's fixtures to
somebody no longer in the squad.

"Last 20" means the 20 most recent by kickoff, so an upcoming fixture sorts
above a played one. The list is therefore not purely historical, and the page
says so in a word: each row shows the fixture's state.

### 6.1 One row

Game name, venue, kickoff in the *game's* timezone via `formatLocalDateTime`
(TR-5 — every conversion in this codebase goes through that module), the
fixture's state, and the player's own status. Each row links to the game.
No other player's name, no squad, no waitlist rank — for the reason
`DashboardFixture`'s own doc comment gives.

## 7. `/g/:id/squad/:playerId` — the organiser's view

A `GET` handler in `src/routes/games.ts`, alongside its five siblings, behind
`requirePlayer` and `loadSquadTarget`:

```ts
gamesRoutes.get("/g/:id/squad/:playerId", requirePlayer, async (c) => {
  const target = await loadSquadTarget(c, c.req.param("id"), c.req.param("playerId"));
  if (target === null) return c.text("Not found", 404);
  …
});
```

New path helper `memberDetailPath(gameId, playerId)` in `paths.ts`, next to
`memberRolePath` and `memberRemovePath`, and for the same reason: the view names
the link and the route names its own registration without either importing the
other.

### 7.1 What it shows, and what it must not

Name, email, role, joined date. All read-only — there is no form on this page.
The two things an organiser may actually *do* to a member, role and removal,
stay where they are on the game overview, so this page has no state-changing
surface at all and needs no origin check.

**No fixture history, and no fixtures from any other game.** An organiser is
entitled to their own squad, not to a person. What that player does in a
different game is not this organiser's business, and there is no way to render
"only fixtures from this game" that does not immediately raise the question of
why not the rest.

A guest (`players.is_guest`) has no email; the page says so rather than
rendering an empty line. An erased player cannot reach this page at all —
erasure deactivates every membership, and `loadSquadTarget` refuses an inactive
one — but the name still goes through `displayName(name, erasedAt)`, as every
other renderer of a player's name does, because that guarantee lives in
`erasePlayer` rather than here.

### 7.2 Where it is reached from

A `View details` link, first inside the existing per-member `<details
class="member-actions">` disclosure on the game overview (M10 §3.8). Inside the
disclosure rather than on the summary row, because the squad list is mostly read
rather than managed and M10 put the controls behind a disclosure for exactly
that reason.

## 8. Access denied is a 404

A signed-in person who organises nothing, or who organises a *different* game,
gets `c.text("Not found", 404)` — not a 403 and not an "access denied" page.

This follows `loadSquadTarget`'s existing rule, stated in its own doc comment:
these paths carry two ids, either of which could otherwise be probed, and a 403
confirms that a resource exists. A stranger who guesses a real game id and a
real player id must not be able to tell that apart from a stranger who guesses
two fabricated ones.

`/app/account` has no denial state, because it has no id. An anonymous visitor
is redirected to `/sign-in` and a session with no linked Player gets
`requirePlayer`'s 403 page with its exits — both the same as the dashboard's,
and neither reads an address, so neither says whether any particular address has
a player here.

## 9. Testing

**`test/routes/account.test.ts`** — a new file. The erasure flow's tests live in
`test/routes/delete-account.test.ts` and stay there; one file per page, as the
rest of `test/routes/` is organised. It covers:

- `GET /app/account` renders the viewer's name and email, the passkeys link and
  the delete link.
- It lists at most 20 fixtures, most recent first, and includes a `played` one —
  the assertion that separates this list from the dashboard's.
- It does **not** list a fixture from a game the viewer has left.
- `POST` renames, writes a `player.renamed` audit row, and redirects 303.
- `POST` with an empty or whitespace-only name refuses at 422 with the page
  itself, and the name is unchanged.
- `POST` from another origin is 403.
- Anonymous `GET` redirects to `/sign-in`.

**The organiser's view**, in `test/routes/squad.test.ts`, beside the role and
removal tests that already exercise `loadSquadTarget`:

- The organiser sees name, email, role and joined date.
- The organiser sees **no fixture list** — asserted directly, since it is the
  property most likely to be broken by a later refactor.
- An ordinary member of the same game gets 404.
- An organiser of a *different* game gets 404.
- A real game id with a player id who is not in that squad gets 404.

**Registration chores this repo enforces**, both of which caught the M7c
privacy page late:

- `test/browser/catalogue.ts` gains an `account` entry (persona `owner`, which
  is the seeded persona with fixtures) and a `squad-member` entry.
- `test/browser/catalogue.spec.ts` gains `ACCOUNT_PATH` to `CONSTANTS` and both
  routes to `ROUTE_TO_ID`.
- `test/routes/signin.test.ts` gains `GET /app/account` and
  `GET /g/:id/squad/:playerId` to `ROUTE_TO_PAGE`, and `POST /app/account` to
  whichever of `ROUTE_TO_PAGE`/`EXCLUDED_ROUTES` matches how the sibling POSTs
  are handled there.

Browser smoke and capture runs regenerate the phone screenshots for both new
pages.

## 10. Out of scope, named

- **Changing an email address.** §5.3. Its own milestone.
- **An activity feed.** "Activity" on this page means the fixture list and
  nothing else — no `audit_log`-derived timeline. The audit vocabulary is
  internal (`membership.role_changed`, `fixture.response_overridden`) and
  surfacing it to players would mean writing a second, player-facing wording for
  every action in the list.
- **Pagination past 20.** A twentieth-most-recent fixture is roughly five months
  back for a weekly game.
- **An organiser editing a member's name.** They can already remove and re-add,
  and a rename by somebody else is a change to who a person says they are.

/**
 * Every path the authenticated part of the site is reached at, in one place.
 *
 * Its own module, rather than living beside the middleware that redirects to
 * them, so that the views can name a form's `action` and the routes can name
 * their own registration without either importing the other. A constants file
 * has no imports and no behaviour, so nothing here can participate in an
 * import cycle.
 *
 * Re-exported from `src/auth/session.ts`, which is where callers looking for
 * "where does the guard send me" naturally read first.
 */

/**
 * Where the guards send someone who needs to sign in. One constant so the
 * guards and the page cannot disagree about the path — `src/routes/signin.ts`
 * registers itself from this value rather than restating it.
 */
export const SIGN_IN_PATH = "/sign-in";

/**
 * Everything the sign-in flow serves, as a mount prefix.
 *
 * `sessionMiddleware` is mounted here as well as on `AUTHENTICATED_PREFIX` —
 * the second mount that `sessionMiddleware`'s own doc comment anticipates.
 * `/sign-in` must bounce an already-signed-in visitor to the dashboard, and
 * `/sign-in/complete` runs behind `requireSession`, so both need a resolved
 * session while sitting outside `/app/*`. Hono's `/x/*` matches bare `/x`
 * too, so this one prefix covers the page and its children.
 */
export const SIGN_IN_PREFIX = `${SIGN_IN_PATH}/*`;

/**
 * Where Better Auth's magic-link verification is told to land (its
 * `callbackURL`). Signing in mints the session; *this* page is where the
 * session gets connected to a domain Player, and where the refusals that
 * connection can produce are explained.
 */
export const SIGN_IN_COMPLETE_PATH = `${SIGN_IN_PATH}/complete`;

/**
 * Where the sign-out form posts. `POST` only, and never a `GET` alias: a `GET`
 * sign-out is triggerable by any `<img>` tag or link prefetcher on any page in
 * the world.
 */
export const SIGN_OUT_PATH = "/sign-out";

/**
 * Where a signed-in person with a Player belongs. Nothing serves it yet — the
 * dashboard is the next task — but every success path in the sign-in flow
 * already points here, so it is one constant rather than a literal in four
 * places.
 */
export const DASHBOARD_PATH = "/app";

/**
 * Where every route that needs a signed-in person lives (the dashboard and
 * everything under it). `sessionMiddleware` is mounted on exactly this prefix
 * in `src/app.ts` — see the note on the middleware for why it is scoped rather
 * than global — so a route added outside it gets no session at all.
 */
export const AUTHENTICATED_PREFIX = `${DASHBOARD_PATH}/*`;

/**
 * Where a signed-in player manages their passkeys (M5 Task 8).
 *
 * Under `DASHBOARD_PATH` on purpose, and not a page of its own outside it:
 * adding a passkey is only ever done by someone already signed in, so it must
 * sit behind the session mount and the `private, no-store` cache header that
 * `AUTHENTICATED_PREFIX` carries. There is deliberately no passkey page
 * reachable while signed out — a passkey-first registration path would turn a
 * lost authenticator into a lost account.
 */
export const PASSKEYS_PATH = `${DASHBOARD_PATH}/passkeys`;

/**
 * Where a signed-in player erases themselves (BR-34, M7b).
 *
 * Under `DASHBOARD_PATH` so it sits behind the session mount and the
 * `private, no-store` header `AUTHENTICATED_PREFIX` carries. There is
 * deliberately no token-reached equivalent: leaving one game works from an
 * emailed link (M7a), but erasure is global and irreversible, and BR-25 draws
 * the line at cross-game actions needing a session.
 */
export const DELETE_ACCOUNT_PATH = `${DASHBOARD_PATH}/delete`;
export const DELETE_ACCOUNT_CANCEL_PATH = `${DELETE_ACCOUNT_PATH}/cancel`;

/**
 * Better Auth's own mount point: every endpoint it owns (`/sign-in/magic-link`,
 * `/magic-link/verify`, `/sign-out`, …) hangs off this. It is the framework's
 * default `basePath`, restated here because this project's own code builds
 * internal requests against it.
 */
export const AUTH_API_PREFIX = "/api/auth";

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

/**
 * Where the team picker's Save posts (BR-35 §4).
 *
 * One path for the whole pick rather than one per player: the picker is a
 * single form whose rows are radio groups, so an organiser working with
 * JavaScript off saves every side in one submission. A per-player endpoint
 * would need a button per row and would let a half-applied pick exist between
 * two requests — exactly the state the save/publish instants on `fixtures` are
 * meant to make unambiguous.
 */
export function ownerTeamsPath(gameId: string, fixtureId: string): string {
  return `/g/${gameId}/f/${fixtureId}/teams`;
}

/**
 * Where the team picker's Publish posts (BR-35 §4).
 *
 * A sibling of `ownerTeamsPath` rather than a flag on it, because the two are
 * different acts with different consequences: saving is private and reversible,
 * publishing sets `teams_published_at` and emails the whole squad. A shared
 * endpoint distinguished by a submit button's value would make an accidental
 * announcement one stray `name="intent"` away, and would give the two no way
 * to differ in what they refuse — a partial pick saves happily and must never
 * publish.
 */
export function ownerTeamsPublishPath(gameId: string, fixtureId: string): string {
  return `/g/${gameId}/f/${fixtureId}/teams/publish`;
}

/** Where an owner's mark-in/mark-out for one player posts (J6b §4). */
export function ownerResponsePath(gameId: string, fixtureId: string, playerId: string): string {
  return `/g/${gameId}/f/${fixtureId}/response/${playerId}`;
}

/** Where the add-a-guest form posts (J6b §5). */
export function ownerGuestPath(gameId: string, fixtureId: string): string {
  return `/g/${gameId}/f/${fixtureId}/guest`;
}

/**
 * Where a signed-in player leaves a game from their own account, as opposed
 * to from an emailed token (M7a Task 4). Under `DASHBOARD_PATH` so it sits
 * behind the session mount and its `private, no-store` header.
 */
export function leaveOtherGamePath(gameId: string): string {
  return `${DASHBOARD_PATH}/games/${gameId}/leave`;
}

/** Where removing a guest posts (J6b §5). */
export function ownerGuestRemovePath(gameId: string, fixtureId: string, playerId: string): string {
  return `/g/${gameId}/f/${fixtureId}/guest/${playerId}/remove`;
}

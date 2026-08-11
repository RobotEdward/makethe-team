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
 * Better Auth's own mount point: every endpoint it owns (`/sign-in/magic-link`,
 * `/magic-link/verify`, `/sign-out`, …) hangs off this. It is the framework's
 * default `basePath`, restated here because this project's own code builds
 * internal requests against it.
 */
export const AUTH_API_PREFIX = "/api/auth";

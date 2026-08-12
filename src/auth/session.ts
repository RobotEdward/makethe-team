import { eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import type { Db } from "../db/client.js";
import { getDb } from "../db/client.js";
import { players } from "../db/schema.js";
import type { AppEnv, Bindings } from "../env.js";
import { layout } from "../views/layout.js";
import { createAuth } from "./factory.js";
import { SIGN_IN_PATH } from "./paths.js";
import { signOutForm } from "../views/sign-out-form.js";

/**
 * Every path this flow uses lives in `./paths.ts` — a module with no imports,
 * so the views and the routes can both name a path without importing each
 * other. Re-exported here because this is where a reader looking for "where
 * does the guard send me" arrives first.
 */
export {
  AUTHENTICATED_PREFIX,
  AUTH_API_PREFIX,
  DASHBOARD_PATH,
  PASSKEYS_PATH,
  SIGN_IN_COMPLETE_PATH,
  SIGN_IN_PATH,
  SIGN_IN_PREFIX,
  SIGN_OUT_PATH,
} from "./paths.js";

/** The domain Player, as stored. */
export type Player = typeof players.$inferSelect;

/**
 * Better Auth's own view of a request's session: the `session` row and the
 * `user` it belongs to. Derived from the instance rather than restated, so a
 * Better Auth upgrade that changes the shape is a compile error here rather
 * than a lie in a hand-written interface.
 */
export type AuthSession = NonNullable<
  Awaited<ReturnType<ReturnType<typeof createAuth>["api"]["getSession"]>>
>;

/**
 * What the middleware puts on every request it runs for.
 *
 * Both slots are always set, and both may be null — `null` means "resolved,
 * and there isn't one", which is a different statement from the `undefined`
 * Hono hands back on a route the middleware never ran for. The guards below
 * treat both as "no", so an unmounted route fails closed rather than sailing
 * through on a missing value.
 *
 * `player` is resolved eagerly beside the session rather than lazily on first
 * use: it is a single indexed lookup on `players_auth_user_id_unique`, it only
 * happens for requests that already had a valid session cookie, and it keeps
 * this type honest — a lazy slot would have to be typed `Player | null |
 * undefined` and every reader would have to know which of the three it had.
 */
export interface AppVariables {
  session: AuthSession | null;
  player: Player | null;
}

/**
 * Resolves the caller's session, and their Player, onto the context.
 *
 * **Scoped to `AUTHENTICATED_PREFIX`, not `*`, on purpose.** In order of
 * weight:
 *
 * 1. **Blast radius.** Mounted globally, a defect in this file could take
 *    down `/` or `/r/:token` — the only two pages that matter commercially
 *    today. Scoped to the prefix, it structurally cannot: those routes never
 *    run this middleware at all.
 * 2. **`/r/:token` has nothing to gain.** It authenticates by signed token and
 *    must keep working identically whether or not the caller happens to be
 *    signed in, so a resolved session there could only ever be cost or a
 *    source of divergence.
 * 3. **Cost, precisely stated.** A cookie parse and an HMAC verification are
 *    paid by every request that reaches this middleware regardless of
 *    whether a cookie is present; the D1 round trip is paid only when a
 *    cookie actually is. Cookieless strangers and prefetchers — the bulk of
 *    traffic to `/` — would therefore cost 0 D1 statements even under a
 *    global mount; the saving a scoped mount buys is for *signed-in* people
 *    browsing public pages, which is real but narrower than "every anonymous
 *    request".
 *
 * The cost of the choice is that a route added outside the prefix silently
 * has no session — which is what the guards' fail-closed reading of
 * `undefined` is for, and why the prefix is one exported constant rather than
 * a string typed twice. Hono's `/app/*` matches bare `/app` too, so there is
 * no gap at the prefix root (verified in review).
 *
 * **Expect a second mount, and treat it as normal rather than a violation of
 * this scoping.** `/sign-in` (next task) must bounce an already-signed-in
 * visitor to the dashboard, and any nav/header personalisation on a public
 * page ("Sign in" vs "Your dashboard") would too — both need a session
 * outside `/app/*`. `AUTHENTICATED_PREFIX` names *the current list of
 * mounts*, not "everywhere a session is ever needed"; whoever adds that
 * second mount is fulfilling the design, not undermining it.
 *
 * **Never fatal.** An expired, tampered, truncated or stale-deploy cookie is
 * anonymous, not an error: Better Auth answers `null` for all of those, and
 * the `catch` covers the rest (a D1 fault mid-lookup). A malformed cookie
 * arriving at a page must never turn into a 500.
 *
 * `now` comes from the one wall-clock read at this edge, and `db` is created
 * once and shared with `createAuth` — a second Drizzle wrapper around the same
 * D1 binding inside one request is the 30-second Miniflare deadlock documented
 * on `createAuth`.
 */
export const sessionMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const now = new Date(Date.now());
  const db = getDb(c.env.DB);

  const session = await resolveSession(c.env, db, now, c.req.raw.headers);
  c.set("session", session);
  c.set("player", session === null ? null : await findPlayer(db, session.user.id));

  await next();
};

async function resolveSession(
  env: Bindings,
  db: Db,
  now: Date,
  headers: Headers,
): Promise<AuthSession | null> {
  try {
    return (await createAuth(env, db, now).api.getSession({ headers })) ?? null;
  } catch (error) {
    // Anonymous, and loudly logged. Never the cookie or the token: this repo
    // is public and a session token in a log line is a live credential.
    //
    // Logging `error.stack` (which includes `error.message`) is safe *only*
    // under an assumption we do not control: that Better Auth never embeds
    // the raw cookie value or token into an error's message or stack trace.
    // Verified true empirically for the failure this file can actually
    // produce (a D1 fault mid-lookup — see `session.test.ts`), but that is
    // not a guarantee about every error Better Auth's internals might one day
    // throw. If Better Auth is ever upgraded, re-verify this assumption
    // before trusting this log line again; do not assume a passing test
    // suite today covers a different error shape tomorrow.
    console.error(
      `session lookup failed, treating request as anonymous: ${
        error instanceof Error ? (error.stack ?? error.message) : String(error)
      }`,
    );
    return null;
  }
}

/** The Player this identity owns, or null if none has been linked yet. */
async function findPlayer(db: Db, authUserId: string): Promise<Player | null> {
  const [player] = await db
    .select()
    .from(players)
    .where(eq(players.authUserId, authUserId))
    .limit(1);
  return player ?? null;
}

// ---------------------------------------------------------------------------
// Route guards.
//
// TR-18: **these establish *who* is asking, and nothing else. Neither of them
// says the caller is entitled to the Game, Fixture, Membership or Player the
// route is about.** A route that edits a Game, removes a member, cancels a
// fixture or reads another player's details must load that row and check
// ownership against `c.get("player")!.id` *in the handler*, and answer 404 (not
// 403) when the check fails, so an id cannot be probed for existence. Mounting
// `requirePlayer` on an owner route and stopping there gives every signed-in
// person in the trial write access to every other squad's data — the id in the
// URL is the only thing that would be deciding whose. There is no middleware
// that can do this check for you: entitlement depends on which row the handler
// is about, which the middleware cannot know.
// ---------------------------------------------------------------------------

/**
 * For routes that need a signed-in person and nothing more.
 *
 * Redirects rather than erroring: a session expiring is ordinary, and the
 * answer to it is the sign-in page, not a 401 body a browser will render as a
 * dead end. No `?next=` parameter yet — a redirect target taken from the
 * request is an open-redirect surface, and there is no sign-in page to honour
 * it until the next task.
 */
export const requireSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.get("session")) return c.redirect(SIGN_IN_PATH, 302);
  await next();
};

/**
 * For routes that need the domain Player behind the session.
 *
 * A session with no linked Player is **not** a corner case today: nothing
 * calls `linkPlayerOnSignIn` yet, so *every* session that currently exists is
 * in this state. It is also permanently reachable afterwards — linking has
 * refusal outcomes (`conflict`, `ambiguous-email`, `email-held-by-guest`)
 * that leave a perfectly valid session with no Player.
 *
 * So the contract is: no session at all is a redirect to sign-in, exactly as
 * `requireSession`; a session without a Player is a plain 403 page, and never
 * a 500, a crash, or a Player invented on the spot. It is deliberately *not* a
 * redirect back to sign-in — signing in again does not create the Player
 * today, and once linking is wired the refusal outcomes still would not, so
 * that redirect would be a loop.
 *
 * What it *is* instead is a page with a way out. The likeliest real cause is
 * signing in with an address the squad does not know — a work address instead
 * of a personal one — and the fix for that is to sign out and try the other
 * one, which is exactly what the page now offers (see `renderNoPlayerPage`).
 * Refusing to redirect is not the same thing as leaving someone on a dead
 * end.
 */
export const requirePlayer: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.get("session")) return c.redirect(SIGN_IN_PATH, 302);
  if (!c.get("player")) return c.html(renderNoPlayerPage(), 403);
  await next();
};

/**
 * The 403 body, with the two exits the person actually needs.
 *
 * Signing out and trying a different address is first because it is the
 * likeliest fix: the squad has them under a different email from the one they
 * just typed. The home link is the second exit, for the case where it isn't.
 * Neither is a redirect — see `requirePlayer` for why this page must not
 * bounce anyone back to sign-in on its own.
 */
function renderNoPlayerPage(): string {
  return layout({
    title: "We can't find your player — Make The Team",
    body: `
      <h1>We can't find your player</h1>
      <p>You're signed in, but this account isn't connected to a player in any squad yet.</p>
      <p>If your squad knows you by a different email address, sign out and sign in with that one.</p>
      ${signOutForm("Sign out and try a different address")}
      <p><a href="/">Back to Make The Team</a></p>
      <p>Otherwise, ask whoever organises your game to add you.</p>
    `,
  });
}

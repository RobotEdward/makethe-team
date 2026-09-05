import { Hono } from "hono";
import { GAMES_PREFIX, JOIN_CONFIRM_PREFIX, SERVICE_WORKER_PATH } from "./auth/paths.js";
import { AUTHENTICATED_PREFIX, SIGN_IN_PREFIX, sessionMiddleware } from "./auth/session.js";
import type { AppEnv } from "./env.js";
import { account } from "./routes/account.js";
import { admin } from "./routes/admin.js";
import { broadcast } from "./routes/broadcast.js";
import { cancel } from "./routes/cancel.js";
import { dashboard } from "./routes/dashboard.js";
import { gamesRoutes } from "./routes/games.js";
import { archivedGameGuard } from "./routes/archived-guard.js";
import { home } from "./routes/home.js";
import { privacy } from "./routes/privacy.js";
import { join } from "./routes/join.js";
import { passkeys } from "./routes/passkeys.js";
import { push } from "./routes/push.js";
import { pwa } from "./routes/pwa.js";
import { respond } from "./routes/respond.js";
import { resultsRoutes } from "./routes/results.js";
import { robots } from "./routes/robots.js";
import { cspHeader } from "./security/csp.js";
import { tokenRateLimit } from "./security/rate-limit.js";
import { signIn } from "./routes/signin.js";
import { renderLinkProblemPage } from "./views/link-problem.js";

export function createApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    await next();
    c.header("X-Robots-Tag", "noindex, nofollow");
    c.header("Referrer-Policy", "strict-origin-when-cross-origin");
    c.header("X-Content-Type-Options", "nosniff");
    // One year, the value the preload list treats as the minimum. Neither
    // `includeSubDomains` nor `preload`: this Worker answers for one hostname
    // and cannot vouch for anything else on the zone, and preloading is a
    // browser-list submission with its own removal lag, not a header
    // decision to make in passing. Harmless over plain HTTP (browsers ignore
    // it there), so it costs nothing on `wrangler dev`.
    c.header("Strict-Transport-Security", "max-age=31536000");
    // /sw.js is the one response that names its own policy — see
    // src/routes/pwa.ts. Checked by path, not by whether a
    // Content-Security-Policy header is already present: a presence check
    // cannot tell "this route deliberately declared a stricter policy" apart
    // from "a header arrived here some other way" (src/routes/signin.ts
    // already copies set-cookie off a Better Auth response; the day
    // something copies a whole Headers object, a presence check would defer
    // to whatever came back and fail open, silently). Naming the one path
    // that opts out means a second route that starts setting its own CSP
    // gets overwritten here and its own test fails loudly, instead of
    // silently winning against this middleware.
    // Method-scoped as well as path-scoped: pwa.ts only registers a GET
    // handler for /sw.js, so POST /sw.js matches no route and falls through
    // to app.notFound, which carries no CSP of its own. Without the method
    // check that request would skip this header too — safe in practice
    // (app.notFound serves text/plain with nosniff, not a document a script
    // could run in) but free to close: only the one response that actually
    // declares its own policy opts out.
    if (!(c.req.method === "GET" && c.req.path === SERVICE_WORKER_PATH)) {
      c.header("Content-Security-Policy", await cspHeader());
    }
  });

  // A signed-in player's own data must never be written to a shared or disk
  // cache. Scoped to `AUTHENTICATED_PREFIX` for the same blast-radius reason
  // `sessionMiddleware` is (see its own doc comment): the token routes
  // (`/r/:token`, `/leave/:token`, `/cancel/:token`) carry `private, no-store`
  // via their own mounts below, each for its own reason, while the public
  // holding page and `robots.txt` genuinely keep whatever caching behaviour
  // they already have, so this must not become a global mount.
  app.use(AUTHENTICATED_PREFIX, async (c, next) => {
    await next();
    c.header("Cache-Control", "private, no-store");
  });

  // Session resolution, deliberately scoped to the authenticated prefix rather
  // than `*` — the reasoning is on `sessionMiddleware`. Public paths (`/`,
  // `/r/:token`, `/leave/:token`, robots) pay nothing for it.
  app.use(AUTHENTICATED_PREFIX, sessionMiddleware);
  // The second mount `sessionMiddleware` anticipates: `/sign-in` bounces an
  // already-signed-in visitor, and `/sign-in/complete` runs behind
  // `requireSession`. Named prefixes, not `*` — the blast-radius argument for
  // keeping `/` and `/r/:token` off the session path is unchanged.
  app.use(SIGN_IN_PREFIX, sessionMiddleware);

  // Owner game management. A third session mount, for the same reason
  // `/sign-in` is the second: `/g/*` needs a session and sits outside
  // `AUTHENTICATED_PREFIX`. The `no-store` header applies for the same reason
  // it does there — these pages show a squad's data.
  app.use(GAMES_PREFIX, sessionMiddleware);
  app.use(GAMES_PREFIX, async (c, next) => {
    await next();
    c.header("Cache-Control", "private, no-store");
  });

  // The throttle on the unauthenticated token families (TR-37). Scoped to
  // exactly the prefixes whose callers have no session, for the same
  // blast-radius reason `sessionMiddleware` is scoped: a `*` mount would spend
  // limiter budget on `/robots.txt`, the icons and the service worker, and
  // would throttle the signed-in dashboard on an IP key whose entire
  // justification is that these callers cannot be identified any other way.
  //
  // Ahead of the `private, no-store` mounts below so that a refusal carries
  // that header too — a 429 for one player behind a shared IP must never be
  // cached and served to the next.
  //
  // Supplement, not control: `src/security/rate-limit.ts` fails open and the
  // bindings are optional, so every route below must still hold with the whole
  // thing switched off — exactly as it must with the WAF rules off.
  // Two scopes, because a personal link and a squad's invite link cannot share
  // a per-token budget: the invite link is one token for the whole squad (the
  // game page says to share it in a group chat), so a budget sized for one
  // player counts thirteen people into one bucket and refuses the sixth to tap
  // it inside a minute. See `SHARED_TOKEN_LIMITER` in `src/env.ts`.
  for (const prefix of ["/r/*", "/leave/*", "/cancel/*"]) {
    app.use(prefix, tokenRateLimit("personal"));
  }
  for (const prefix of ["/j/*", JOIN_CONFIRM_PREFIX]) {
    app.use(prefix, tokenRateLimit("shared"));
  }

  // The public invite page, and (M39) its confirmation-link sibling
  // `/join/:jtoken`. No session, so this is not the "a signed-in player's own
  // data" argument that scopes the two mounts above — it is *revocation*.
  // Rotating the invite token and deactivating the game are an owner's only
  // ways to kill a leaked link, and a shared cache holding a 200 for the old
  // URL silently defeats both for the length of its TTL. The 422 branch also
  // echoes the submitter's own address back into the form, which no shared
  // cache should ever hold.
  for (const prefix of ["/j/*", JOIN_CONFIRM_PREFIX]) {
    app.use(prefix, async (c, next) => {
      await next();
      c.header("Cache-Control", "private, no-store");
    });
  }

  // The response page. Confidentiality *and* staleness: it renders full names
  // and every player's current answer, and that state changes on every tap, so
  // a cached copy is wrong almost immediately and can still be served.
  app.use("/r/*", async (c, next) => {
    await next();
    c.header("Cache-Control", "private, no-store");
  });

  // The leave page. Reached by the same population from the same emails. It
  // names the Game, its POST takes the visitor out of the squad, and for a
  // signed-in visitor it also lists the other squads they belong to — so both
  // halves of the argument apply as strongly as they do to its neighbours:
  // confidentiality, and a state that changes the moment the button is
  // pressed. A visitor with no session has no way to tell that a page they
  // were served is stale.
  app.use("/leave/*", async (c, next) => {
    await next();
    c.header("Cache-Control", "private, no-store");
  });

  // The owner's cancellation link, and the strongest case of the three:
  // presenting it does not merely show a fixture, it calls the fixture off for
  // the entire squad. A shared cache holding a 200 for that URL is the worst
  // outcome on this list.
  app.use("/cancel/*", async (c, next) => {
    await next();
    c.header("Cache-Control", "private, no-store");
  });

  // M41. Every `POST` under a game is refused while the game is archived,
  // whichever router owns it — mounted once here, ahead of all of them, so
  // `broadcast` and `results` are covered as well as `games`. Enumerated by
  // `test/routes/archived-guard.test.ts`.
  app.use("/g/:id/*", archivedGameGuard);

  app.route("/", robots);
  // The manifest, the icons and (from Task 3) the service worker. Public and
  // unauthenticated like robots.txt, and for the same reason: the browser
  // asks for these before a visitor is anyone.
  app.route("/", pwa);
  app.route("/", home);
  // Public and ungated on purpose — see src/routes/privacy.ts.
  app.route("/", privacy);
  app.route("/", respond);
  app.route("/", cancel);
  // `/j/:token`, the public invite page. Registered here alongside `respond`
  // and `cancel`, and deliberately *not* under `AUTHENTICATED_PREFIX` or
  // `GAMES_PREFIX`: a stranger holding an invite link has no session and must
  // not need one (§1.6). It is unauthenticated and it both writes rows and
  // sends email — see `src/routes/join.ts` for what bounds that.
  app.route("/", join);
  app.route("/", signIn);
  // Behind `AUTHENTICATED_PREFIX`'s session mount above, and behind
  // `requirePlayer` on each of its own handlers.
  app.route("/", dashboard);
  // `/app/passkeys`, behind the same prefix and the same `requirePlayer`.
  app.route("/", passkeys);
  // `/app/delete` and its cancel (M7b). Same prefix, same `requirePlayer`, and
  // no middleware of its own: the session mount and `private, no-store` above
  // are exactly what a page naming a pending erasure needs.
  app.route("/", account);
  // `/app/push/subscribe` and `/app/push/unsubscribe` (M14). Same prefix, but
  // deliberately not gated on `requirePlayer`: a response token is also
  // sufficient proof here — see the doc comments on `PUSH_SUBSCRIBE_PATH` and
  // `src/routes/push.ts`. The session mount above still resolves
  // `c.get("player")` for whichever caller has one.
  app.route("/", push);
  // `/app/admin/allowlist` (M16). Behind `AUTHENTICATED_PREFIX`'s session
  // mount; whether the caller is an admin is re-asked inside every handler,
  // and a refusal is a 404 (TR-18) — see src/routes/admin.ts.
  app.route("/", admin);
  // `/g/*`, behind the game-management session mount above.
  app.route("/", gamesRoutes);
  // `/g/:id/message` and `/g/:id/f/:fixtureId/message` (M15 Task 8), under
  // the same `/g/*` prefix as `gamesRoutes` and so behind the same session
  // mount and `private, no-store` header — these pages show squad membership
  // and per-fixture responses, exactly the confidentiality argument that
  // scopes that mount.
  app.route("/", broadcast);
  // `/g/:id/f/:fixtureId/result` (M25), under the same `/g/*` prefix as
  // `gamesRoutes` and so behind the same session mount and `private,
  // no-store` header — the panel shows who voted for what, which is squad
  // membership by another name.
  app.route("/", resultsRoutes);

  // A bare string, and it stays that way. An unrouted path is reached by a
  // scanner, not by a person tapping a link — `test/routes/not-found.test.ts`
  // pins this and names the reason: an HTML page titled "Make The Team" would
  // tell a probe the product and the stack, which the routes a person actually
  // reaches can afford to and this one cannot.
  //
  // The M52 design review flagged the unstyled page as a dead end and it was
  // switched to `renderNotFoundPage()` for about an hour before that guard,
  // and the five scanner-path cases beside it, said why not.
  app.notFound((c) => c.text("Not found", 404));

  /**
   * The last line of defence on the product's critical path.
   *
   * Every *expected* failure on `/r/:token` and `/leave/:token` already has a
   * carefully written friendly page. Without this, the *unexpected* one — a
   * D1 error, or a `LocalTimeError` thrown out of date formatting for a Game
   * with a malformed timezone — fell through to Hono's bare `500 Internal
   * Server Error`, which is the one response a player is most likely to see
   * at the exact moment they are trying to reply to a reminder.
   *
   * Renders the same shared page as every other link problem, for the same
   * reason it is shared: a player gets one honest, actionable message rather
   * than a stack trace, and an attacker learns nothing from the difference
   * between a rejected token and a broken database. The page takes no inputs,
   * so the byte-identical property the route tests pin survives this handler.
   *
   * 500, not 200 — unlike the token-failure paths (see `src/routes/respond.ts`
   * for that contrast). Something genuinely broke server-side, and Cloudflare's
   * metrics, any future alerting, and this `console.error` must all agree on
   * that. The real error is logged here and only here.
   */
  app.onError((error, c) => {
    console.error(
      `unhandled error serving ${c.req.method} ${new URL(c.req.url).pathname}: ${
        error instanceof Error ? (error.stack ?? error.message) : String(error)
      }`,
    );
    return c.html(renderLinkProblemPage(), 500);
  });

  return app;
}

import { Hono } from "hono";
import { GAMES_PREFIX } from "./auth/paths.js";
import { AUTHENTICATED_PREFIX, SIGN_IN_PREFIX, sessionMiddleware } from "./auth/session.js";
import type { AppEnv } from "./env.js";
import { cancel } from "./routes/cancel.js";
import { dashboard } from "./routes/dashboard.js";
import { gamesRoutes } from "./routes/games.js";
import { home } from "./routes/home.js";
import { join } from "./routes/join.js";
import { passkeys } from "./routes/passkeys.js";
import { respond } from "./routes/respond.js";
import { robots } from "./routes/robots.js";
import { cspHeader } from "./security/csp.js";
import { signIn } from "./routes/signin.js";
import { renderLinkProblemPage } from "./views/link-problem.js";

export function createApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    await next();
    c.header("X-Robots-Tag", "noindex, nofollow");
    c.header("Referrer-Policy", "strict-origin-when-cross-origin");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Content-Security-Policy", await cspHeader());
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

  // The public invite page. No session, so this is not the "a signed-in
  // player's own data" argument that scopes the two mounts above — it is
  // *revocation*. Rotating the invite token and deactivating the game are an
  // owner's only ways to kill a leaked link, and a shared cache holding a 200
  // for the old URL silently defeats both for the length of its TTL. The 422
  // branch also echoes the submitter's own address back into the form, which
  // no shared cache should ever hold.
  app.use("/j/*", async (c, next) => {
    await next();
    c.header("Cache-Control", "private, no-store");
  });

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

  app.route("/", robots);
  app.route("/", home);
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
  // `/g/*`, behind the game-management session mount above.
  app.route("/", gamesRoutes);

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

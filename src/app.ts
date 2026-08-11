import { Hono } from "hono";
import { AUTHENTICATED_PREFIX, SIGN_IN_PREFIX, sessionMiddleware } from "./auth/session.js";
import type { AppEnv } from "./env.js";
import { home } from "./routes/home.js";
import { respond } from "./routes/respond.js";
import { robots } from "./routes/robots.js";
import { signIn } from "./routes/signin.js";
import { renderLinkProblemPage } from "./views/link-problem.js";

export function createApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    await next();
    c.header("X-Robots-Tag", "noindex, nofollow");
    c.header("Referrer-Policy", "strict-origin-when-cross-origin");
    c.header("X-Content-Type-Options", "nosniff");
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

  app.route("/", robots);
  app.route("/", home);
  app.route("/", respond);
  app.route("/", signIn);

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

import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import { PRIVACY_PATH, SIGN_IN_PATH } from "../auth/paths.js";
import { layout } from "../views/layout.js";

export const home = new Hono<AppEnv>();

/**
 * The holding page, and the only link into the signed-in half of the site.
 *
 * The sign-in link is **unconditional** — it does not become "Your dashboard"
 * for somebody already signed in. `/` sits outside every mount of
 * `sessionMiddleware` on purpose (see that middleware's own doc comment on
 * blast radius), so personalising this one word would mean either a fourth
 * mount or a `resolveSessionPlayer` call, putting a cookie parse and an HMAC
 * verification on every hit to the page strangers, prefetchers and crawlers
 * reach. `/sign-in` already bounces an existing session to the dashboard, so
 * the unconditional link is not even wrong for a signed-in visitor.
 */
home.get("/", (c) =>
  c.html(
    layout({
      title: "Make The Team",
      body: `<h1>Make The Team</h1>
             <p><a href="${SIGN_IN_PATH}">Sign in</a></p>
             <p><a href="${PRIVACY_PATH}">Privacy</a></p>`,
      centred: true,
    }),
  ),
);

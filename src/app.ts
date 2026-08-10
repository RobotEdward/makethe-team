import { Hono } from "hono";
import type { AppEnv } from "./env.js";
import { home } from "./routes/home.js";
import { respond } from "./routes/respond.js";
import { robots } from "./routes/robots.js";

export function createApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    await next();
    c.header("X-Robots-Tag", "noindex, nofollow");
    c.header("Referrer-Policy", "strict-origin-when-cross-origin");
    c.header("X-Content-Type-Options", "nosniff");
  });

  app.route("/", robots);
  app.route("/", home);
  app.route("/", respond);

  app.notFound((c) => c.text("Not found", 404));

  return app;
}

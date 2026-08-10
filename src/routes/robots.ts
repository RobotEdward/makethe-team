import { Hono } from "hono";
import type { AppEnv } from "../env.js";

export const robots = new Hono<AppEnv>();

robots.get("/robots.txt", (c) =>
  c.text("User-agent: *\nDisallow: /\n", 200, { "content-type": "text/plain; charset=utf-8" }),
);

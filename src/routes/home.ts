import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import { layout } from "../views/layout.js";

export const home = new Hono<AppEnv>();

home.get("/", (c) =>
  c.html(
    layout({
      title: "Make The Team",
      body: `<h1>Make The Team</h1>
             <p>Getting a regular game on, without the group chat.</p>`,
      centred: true,
    }),
  ),
);

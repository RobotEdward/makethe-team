import { env } from "cloudflare:test";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../src/db/client.js";
import type { AppEnv } from "../../src/env.js";
import { archivedGameGuard, ARCHIVE_ACTION_PATHS } from "../../src/routes/archived-guard.js";
import { broadcast } from "../../src/routes/broadcast.js";
import { gamesRoutes } from "../../src/routes/games.js";
import { resultsRoutes } from "../../src/routes/results.js";
import { insertGame, resetDatabase } from "../support/factories.js";

const db = getDb(env.DB);

/**
 * Every `POST` any router registers under `/g/:id/…`, read from the routers
 * themselves so a handler added tomorrow is covered without anyone
 * remembering this file exists. `/g/new` has no game to be archived and is
 * excluded by the prefix.
 */
function registeredGamePosts(): string[] {
  const all = [gamesRoutes, broadcast, resultsRoutes].flatMap((router) => router.routes);
  const paths = all
    .filter((route) => route.method === "POST" && route.path.startsWith("/g/:id/"))
    .map((route) => route.path);
  return [...new Set(paths)];
}

/** `:id` becomes the game; every other parameter gets a stand-in the guard must ignore. */
function concrete(path: string, gameId: string): string {
  return path.replace(":id", gameId).replace(/:[A-Za-z]+/g, "x");
}

/** The guard in front of a handler that reports being reached — the guard is the unit, not the handlers. */
function harness() {
  const app = new Hono<AppEnv>();
  app.use("/g/:id/*", archivedGameGuard);
  app.all("*", (c) => c.text("reached", 200));
  const call = (method: string, path: string) =>
    app.request(`https://makethe.team${path}`, { method }, env);
  return { call };
}

describe("archivedGameGuard", () => {
  beforeEach(resetDatabase);

  it("registers at least the routes this milestone knows about", () => {
    const posts = registeredGamePosts();
    expect(posts.length).toBeGreaterThan(15);
    expect(posts).toContain("/g/:id/edit");
    expect(posts).toContain("/g/:id/f/:fixtureId/result");
    expect(posts).toContain("/g/:id/message");
  });

  it("refuses every registered POST on an archived game, except archive and unarchive", async () => {
    const gameId = await insertGame(db, { archivedAt: new Date("2026-08-28T09:00:00Z") });
    const { call } = harness();
    for (const path of registeredGamePosts()) {
      const response = await call("POST", concrete(path, gameId));
      const exempt = ARCHIVE_ACTION_PATHS.some((action) => path === action);
      expect(response.status, path).toBe(exempt ? 200 : 404);
    }
  });

  it("lets every registered POST through on a live game", async () => {
    const gameId = await insertGame(db);
    const { call } = harness();
    for (const path of registeredGamePosts()) {
      const response = await call("POST", concrete(path, gameId));
      expect(response.status, path).toBe(200);
    }
  });

  it("never touches a GET, archived or not", async () => {
    const gameId = await insertGame(db, { archivedAt: new Date("2026-08-28T09:00:00Z") });
    const { call } = harness();
    expect((await call("GET", `/g/${gameId}/edit`)).status).toBe(200);
    expect((await call("GET", `/g/${gameId}/fixtures`)).status).toBe(200);
  });

  it("ignores POST /g/new, which the /g/:id/* mount also matches", async () => {
    const { call } = harness();
    expect((await call("POST", "/g/new")).status).toBe(200);
  });

  it("refuses a POST for a game that does not exist, indistinguishably from an archived one", async () => {
    const { call } = harness();
    const response = await call("POST", "/g/no-such-game/edit");
    expect(response.status).toBe(404);
  });
});

import { eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { getDb } from "../db/client.js";
import { games } from "../db/schema.js";
import type { AppEnv } from "../env.js";
import { renderNotFoundPage } from "../views/not-found.js";

/**
 * The two actions an archived game still accepts (M41). Compared against the
 * router's *registered* path, not the request URL, so a game id containing
 * "archive" cannot match, and so the enumerating test in
 * `test/routes/archived-guard.test.ts` can check the same list.
 */
export const ARCHIVE_ACTION_PATHS = ["/g/:id/archive", "/g/:id/unarchive"] as const;

/**
 * Refuse every `POST` under `/g/:id/*` while the game is archived (M41).
 *
 * One middleware rather than a check in each handler, because the failure it
 * prevents is a handler somebody adds next month that forgets the check —
 * `test/routes/archived-guard.test.ts` walks every registered route, so a new
 * one is covered the day it is written. This is not the entitlement check:
 * that stays in each handler (`findGameForOwner`, TR-18), because which row
 * to check depends on which row the handler is about. This asks a question
 * with one answer for the whole prefix.
 *
 * `GET`s pass untouched — archived history is meant to be read. A missing
 * game is refused with the same 404 as an archived one, and a live game is
 * passed to a handler that will 404 it itself if the caller is not entitled,
 * so an outsider learns nothing from this layer that the handler would not
 * already tell them.
 */
export const archivedGameGuard: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.req.method !== "POST") return next();
  const segments = c.req.path.split("/").filter(Boolean);
  // Hono's `/g/:id/*` also matches `/g/new` — the wildcard is happy with
  // nothing after the id — and `new` is not a game. Only a path with
  // something after the id is an action on an existing game.
  if (segments.length < 3) return next();
  if (ARCHIVE_ACTION_PATHS.some((action) => matchesAction(segments, action))) return next();
  const db = getDb(c.env.DB);
  const [row] = await db
    .select({ archivedAt: games.archivedAt })
    .from(games)
    .where(eq(games.id, c.req.param("id") ?? ""))
    .limit(1);
  if (row === undefined || row.archivedAt !== null) return c.html(renderNotFoundPage(), 404);
  return next();
};

/**
 * `c.req.routePath` is the *middleware's* registered path (`/g/:id/*`), not
 * the handler's, so the exemption is decided on the concrete path: exactly
 * one segment after the id, and it must be the action word.
 */
function matchesAction(segments: readonly string[], action: string): boolean {
  const word = action.split("/").pop();
  return segments.length === 3 && segments[0] === "g" && segments[2] === word;
}

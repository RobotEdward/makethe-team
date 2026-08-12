import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { NEW_GAME_PATH, gamePath } from "../auth/paths.js";
import { requirePlayer } from "../auth/session.js";
import { buildAuditInsert } from "../db/audit.js";
import { getDb } from "../db/client.js";
import { findGameForOwner, listSquad, listUpcomingFixtures } from "../db/queries.js";
import { games } from "../db/schema.js";
import { createGame } from "../domain/create-game.js";
import { parseGameForm } from "../domain/game-form.js";
import type { AppEnv, Bindings } from "../env.js";
import { renderGameFormPage } from "../views/game-form.js";
import { renderGameOverviewPage } from "../views/game-overview.js";

/**
 * Owner-facing game management, mounted at `/g/*` (see `GAMES_PREFIX` in
 * `src/auth/paths.ts`).
 *
 * **Registration order matters.** `NEW_GAME_PATH` (`/g/new`) is registered
 * here, on its own, with nothing else under `/g/*` yet. The next task in this
 * milestone adds a `/g/:id` route (and friends) for reading/editing a
 * specific game — that route MUST be registered *after* `NEW_GAME_PATH`.
 * Hono matches routes in registration order, and `:id` matches the literal
 * string `"new"` just as readily as a real id, so a `/g/:id` registered
 * first would swallow `GET /g/new` and treat "new" as a game id — a 404 (or
 * worse, some other game's page) where a form should be.
 */
export const gamesRoutes = new Hono<AppEnv>();

/** This deployment's own origin, as the state-changing handlers compare it. */
function originOf(env: Bindings): string {
  return new URL(env.BETTER_AUTH_URL).origin;
}

/**
 * Rejects a cross-site form post. Mirrors `POST /dashboard` and `POST
 * /sign-out`: a browser always sends `Origin` on a cross-site form
 * submission, and a missing header is a non-browser client acting on its own
 * behalf, which is allowed.
 */
function wrongOrigin(c: { req: { header: (name: string) => string | undefined }; env: Bindings }): boolean {
  const origin = c.req.header("origin");
  return origin !== undefined && origin !== originOf(c.env);
}

/** Every string field of the submitted body, for redisplaying a rejected form. */
function submittedValues(form: Record<string, unknown>): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(form)) {
    if (typeof value === "string") values[key] = value;
  }
  return values;
}

gamesRoutes.get(NEW_GAME_PATH, requirePlayer, (c) =>
  c.html(
    renderGameFormPage({
      action: NEW_GAME_PATH,
      heading: "Set up a game",
      submitLabel: "Create the game",
      // Sensible starting values, not an empty form — the point is to get an
      // organiser to a shareable link in as few decisions as possible.
      values: { kickoffTime: "19:00", durationMinutes: "60", minPlayers: "10", maxPlayers: "14", weekday: "TH", interval: "1" },
      errors: [],
      warnings: [],
      showAdvanced: false,
    }),
  ),
);

gamesRoutes.post(NEW_GAME_PATH, requirePlayer, async (c) => {
  if (wrongOrigin(c)) return c.text("Forbidden", 403);

  const now = new Date(Date.now());
  const player = c.get("player")!;
  const form = await c.req.parseBody();
  const parsed = parseGameForm(form);

  if (!parsed.ok) {
    // 422, and the page comes back with everything still typed in it. A bare
    // 400 would throw away a form somebody just filled in on a phone.
    return c.html(
      renderGameFormPage({
        action: NEW_GAME_PATH,
        heading: "Set up a game",
        submitLabel: "Create the game",
        values: submittedValues(form),
        errors: parsed.errors,
        warnings: [],
        showAdvanced: false,
      }),
      422,
    );
  }

  const created = await createGame({ db: getDb(c.env.DB), values: parsed.values, ownerPlayerId: player.id, now });

  // 303 so a refresh does not re-post and create a second game.
  return c.redirect(gamePath(created.gameId), 303);
});

// `/g/:id` and friends are registered here, after `NEW_GAME_PATH` above — see
// this file's module comment for why the order is load-bearing.

gamesRoutes.get("/g/:id", requirePlayer, async (c) => {
  const now = new Date(Date.now());
  const db = getDb(c.env.DB);
  const player = c.get("player")!;

  // The entitlement re-check (TR-18). `requirePlayer` established who; this
  // establishes whether. 404 rather than 403 for every failure mode, so a
  // game id cannot be probed.
  const game = await findGameForOwner(db, c.req.param("id"), player.id);
  if (game === null) return c.text("Not found", 404);

  const [squad, upcoming] = await Promise.all([
    listSquad(db, game.id),
    listUpcomingFixtures(db, game.id, now),
  ]);

  return c.html(
    renderGameOverviewPage({
      gameId: game.id,
      gameName: game.name,
      venueName: game.venueName,
      timezone: game.timezone,
      inviteToken: game.inviteToken,
      squad,
      upcoming,
    }),
  );
});

gamesRoutes.post("/g/:id/invite/rotate", requirePlayer, async (c) => {
  if (wrongOrigin(c)) return c.text("Forbidden", 403);

  const now = new Date(Date.now());
  const db = getDb(c.env.DB);
  const player = c.get("player")!;

  const game = await findGameForOwner(db, c.req.param("id"), player.id);
  if (game === null) return c.text("Not found", 404);

  const inviteToken = crypto.randomUUID();
  await db.batch([
    db.update(games).set({ inviteToken }).where(eq(games.id, game.id)),
    buildAuditInsert(db, {
      actorPlayerId: player.id,
      entityType: "game",
      entityId: game.id,
      action: "game.invite_rotated",
      // Never the old token itself: audit_log is read by people and a live
      // credential should not sit in it. The fact of the change is the point.
      before: { rotated: true },
      now,
    }),
  ]);

  return c.redirect(gamePath(game.id), 303);
});

import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Context } from "hono";
import { DASHBOARD_PATH, NEW_GAME_PATH, gameEditPath, gamePath, ownerFixturePath } from "../auth/paths.js";
import { requirePlayer } from "../auth/session.js";
import { buildAuditInsert, recordAudit } from "../db/audit.js";
import { getDb } from "../db/client.js";
import {
  countCommitments,
  findGameForOwner,
  findMembershipInGame,
  getFixtureWithSquad,
  listSquad,
  listUpcomingFixtures,
  type FixtureWithSquad,
} from "../db/queries.js";
import { fixtures, games } from "../db/schema.js";
import { changeMemberRole, parseRole } from "../domain/change-role.js";
import { createGame } from "../domain/create-game.js";
import { fixtureView } from "../domain/fixture-view.js";
import { parseGameForm } from "../domain/game-form.js";
import { parseGuestName } from "../domain/guest-name.js";
import { parseRecurrenceRule } from "../domain/recurrence/parse.js";
import { removeMember } from "../domain/remove-member.js";
import { formatLocalDateTime } from "../domain/time/zone.js";
import { countFixturesByPropagation, updateGame } from "../domain/update-game.js";
import type { AppEnv, Bindings } from "../env.js";
import { createNotifier } from "../notify/factory.js";
import { sendRemovedEmail } from "../notify/send-removed.js";
import { renderGameFormPage } from "../views/game-form.js";
import { renderGameOverviewPage } from "../views/game-overview.js";
import { renderOwnerFixturePage, type OwnerFixtureParams } from "../views/owner-fixture.js";
import { renderRemoveMemberPage } from "../views/remove-member.js";
import { notifyPromotedPlayer } from "./respond.js";

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
        warnings: parsed.warnings,
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
      venueAddress: game.venueAddress,
      timezone: game.timezone,
      maxPlayers: game.maxPlayers,
      prefersEvenNumbers: game.prefersEvenNumbers,
      inviteToken: game.inviteToken,
      squad,
      upcoming,
      viewerPlayerId: player.id,
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

gamesRoutes.get("/g/:id/edit", requirePlayer, async (c) => {
  const now = new Date(Date.now());
  const db = getDb(c.env.DB);
  const game = await findGameForOwner(db, c.req.param("id"), c.get("player")!.id);
  if (game === null) return c.text("Not found", 404);

  const counts = await countFixturesByPropagation(db, game.id, now);
  const rule = parseRecurrenceRule(game.recurrenceRule);

  return c.html(
    renderGameFormPage({
      action: gameEditPath(game.id),
      heading: `Edit ${game.name}`,
      submitLabel: "Save changes",
      values: {
        name: game.name,
        venueName: game.venueName,
        venueAddress: game.venueAddress ?? "",
        venueUrl: game.venueUrl ?? "",
        timezone: game.timezone,
        weekday: rule.byday,
        interval: String(rule.interval),
        kickoffTime: game.kickoffTime,
        durationMinutes: String(game.durationMinutes),
        minPlayers: String(game.minPlayers),
        maxPlayers: String(game.maxPlayers),
        prefersEvenNumbers: game.prefersEvenNumbers ? "on" : "",
        reminderDaysBefore: String(game.reminderDaysBefore),
        reminderLocalTime: game.reminderLocalTime,
        shortWarningOffsetHours: String(game.shortWarningOffsetHours),
      },
      errors: [],
      warnings: [],
      showAdvanced: true,
      affectedNotice: propagationNotice(counts),
    }),
  );
});

/** "This will update 4 scheduled fixtures. 1 open fixture is unchanged." */
function propagationNotice(counts: { scheduled: number; untouched: number }): string | undefined {
  if (counts.scheduled === 0 && counts.untouched === 0) return undefined;
  const scheduled = `This will update ${counts.scheduled} scheduled ${counts.scheduled === 1 ? "fixture" : "fixtures"}.`;
  if (counts.untouched === 0) return scheduled;
  return `${scheduled} ${counts.untouched} ${counts.untouched === 1 ? "fixture people have already been emailed about stays" : "fixtures people have already been emailed about stay"} unchanged.`;
}

gamesRoutes.post("/g/:id/edit", requirePlayer, async (c) => {
  if (wrongOrigin(c)) return c.text("Forbidden", 403);

  const now = new Date(Date.now());
  const db = getDb(c.env.DB);
  const game = await findGameForOwner(db, c.req.param("id"), c.get("player")!.id);
  if (game === null) return c.text("Not found", 404);

  const form = await c.req.parseBody();
  const parsed = parseGameForm(form);

  if (!parsed.ok) {
    // The propagation notice is recomputed rather than omitted: it warns about
    // the destructive half of this operation ("this will update 4 scheduled
    // fixtures"), and a redisplay is exactly when the owner is re-reading the
    // form and deciding whether to submit it again. Dropping it here would
    // make the warning appear only on the attempts that did not need it.
    const counts = await countFixturesByPropagation(db, game.id, now);

    return c.html(
      renderGameFormPage({
        action: gameEditPath(game.id),
        heading: `Edit ${game.name}`,
        submitLabel: "Save changes",
        values: submittedValues(form),
        errors: parsed.errors,
        warnings: parsed.warnings,
        showAdvanced: true,
        affectedNotice: propagationNotice(counts),
      }),
      422,
    );
  }

  await updateGame({ db, game, values: parsed.values, actorPlayerId: c.get("player")!.id, now });

  return c.redirect(gamePath(game.id), 303);
});

/**
 * The squad-management routes (J6a).
 *
 * Each one answers TR-18 twice: `findGameForOwner` establishes that the signed-in
 * player owns this game, and `findMembershipInGame` establishes that
 * `:playerId` is in *that* game's squad. Both failures are 404, never 403 — a
 * 403 confirms a resource exists, and these paths carry two ids either of
 * which could otherwise be probed.
 */
async function loadSquadTarget(
  c: Context<AppEnv>,
  gameId: string,
  playerId: string,
  /**
   * Let an *inactive* membership through. Only `POST …/remove` sets this, so
   * that a removal which failed partway through its per-fixture loop can be
   * finished by re-submitting the same form — see `removeMember`'s `resumed`
   * outcome. Everything else keeps the stricter rule: there is nothing to
   * confirm on the GET, and nothing to promote or demote on a membership that
   * is over. The entitlement half is unchanged either way, so this widens what
   * an owner may act on inside their own squad, never who may act.
   */
  options: { allowInactive?: boolean } = {},
) {
  const db = getDb(c.env.DB);
  const game = await findGameForOwner(db, gameId, c.get("player")!.id);
  if (game === null) return null;
  const member = await findMembershipInGame(db, game.id, playerId);
  if (member === null) return null;
  if (!member.active && options.allowInactive !== true) return null;
  return { db, game, member };
}

gamesRoutes.get("/g/:id/squad/:playerId/remove", requirePlayer, async (c) => {
  const target = await loadSquadTarget(c, c.req.param("id"), c.req.param("playerId"));
  if (target === null) return c.text("Not found", 404);

  const commitments = await countCommitments(target.db, target.game.id, target.member.playerId);
  return c.html(
    renderRemoveMemberPage({
      gameId: target.game.id,
      playerId: target.member.playerId,
      gameName: target.game.name,
      memberName: target.member.name,
      isOwner: target.member.role === "owner",
      commitments,
    }),
  );
});

gamesRoutes.post("/g/:id/squad/:playerId/remove", requirePlayer, async (c) => {
  if (wrongOrigin(c)) return c.text("Forbidden", 403);

  // `allowInactive`: re-submitting this POST is the documented recovery path
  // for a removal that failed partway through its per-fixture loop (§3.3), and
  // a 404 here would refuse the retry the design promises.
  const target = await loadSquadTarget(c, c.req.param("id"), c.req.param("playerId"), { allowInactive: true });
  if (target === null) return c.text("Not found", 404);

  const now = new Date(Date.now());
  const actor = c.get("player")!;
  const result = await removeMember({
    db: target.db,
    gameId: target.game.id,
    playerId: target.member.playerId,
    actorPlayerId: actor.id,
    now,
    // The binding is supplied here and nowhere deeper: `removeMember` stays a
    // domain module with no Workers dependency (TR-12 still holds — this is
    // the object, addressed by fixture id).
    withdraw: (fixtureId) =>
      c.env.FIXTURE_CAPACITY.getByName(fixtureId).withdrawMember({
        playerId: target.member.playerId,
        actorPlayerId: actor.id,
        now: now.getTime(),
      }),
  });

  if (result.kind === "not-a-member") return c.text("Not found", 404);
  if (result.kind === "refused") return renderSquadRefusal(c, target.game.id, now);

  // `removed` and `resumed` are handled identically and deliberately so: a
  // resume means the membership was already deactivated and the fixture loop
  // has just been re-run, which is the same end state a first attempt reaches.
  // The N-7 below is safe to re-attempt for the same reason — `resumed`
  // carries the original `leftAt`, so the dedupe key is byte-identical and the
  // second attempt returns `already-logged` without sending anything. The N-2s
  // are whatever *this* pass promoted, so on a resume that finished nothing
  // there are none.
  //
  // Handed to `waitUntil` for the reason `POST /r/:token` and `POST /j/:token`
  // do the same: everything the owner is waiting for is already committed, and
  // what is left is HTTP calls to a mail provider on other people's behalf.
  // Every outcome is durable in `notification_log` and every non-success is
  // logged, so a failure here is diagnosable rather than invisible.
  for (const { fixtureId, promoted } of result.promotions) {
    c.executionCtx.waitUntil(notifyPromotedPlayer(c.env, fixtureId, promoted, now));
  }
  c.executionCtx.waitUntil(
    notifyRemovedPlayer(c.env, target.game.id, target.member.playerId, result.membershipId, result.leftAt, now),
  );

  // An owner who removed themselves can no longer pass `/g/:id`'s entitlement
  // check, so sending them there would 404 them with their own successful
  // action. Everyone else goes back to the squad they just changed.
  const removedSelf = target.member.playerId === actor.id;
  return c.redirect(removedSelf ? DASHBOARD_PATH : gamePath(target.game.id), 303);
});

gamesRoutes.post("/g/:id/squad/:playerId/role", requirePlayer, async (c) => {
  if (wrongOrigin(c)) return c.text("Forbidden", 403);

  const target = await loadSquadTarget(c, c.req.param("id"), c.req.param("playerId"));
  if (target === null) return c.text("Not found", 404);

  const form = await c.req.parseBody();
  const role = parseRole(form["role"]);
  // The value comes from a `<select>` this application rendered, so anything
  // else is a hand-built request and gets a 400 rather than a guess.
  if (role === null) return c.text('Bad Request: "role" must be exactly "owner" or "player"', 400);

  const now = new Date(Date.now());
  const result = await changeMemberRole({
    db: target.db,
    gameId: target.game.id,
    playerId: target.member.playerId,
    actorPlayerId: c.get("player")!.id,
    role,
    now,
  });

  if (result.kind === "not-a-member") return c.text("Not found", 404);
  if (result.kind === "refused") return renderSquadRefusal(c, target.game.id, now);

  return c.redirect(gamePath(target.game.id), 303);
});

/**
 * The game and fixture behind a `/g/:id/f/:fixtureId` path, or `null`.
 *
 * Scoped by game id as well as fixture id, which is the whole point: without
 * it a fixture id in the path would be a global identifier and one owner could
 * read another squad's fixture. `null` for every refusal — no such game, not an
 * owner, no such fixture, a fixture of a different game — and the caller
 * answers 404 for all of them (TR-18).
 */
async function loadFixtureTarget(c: Context<AppEnv>, gameId: string, fixtureId: string) {
  const db = getDb(c.env.DB);
  const game = await findGameForOwner(db, gameId, c.get("player")!.id);
  if (game === null) return null;
  const [fixture] = await db.select().from(fixtures).where(eq(fixtures.id, fixtureId));
  if (!fixture || fixture.gameId !== game.id) return null;
  return { db, game, fixture };
}

/**
 * Build `OwnerFixtureParams` from a loaded `FixtureWithSquad`.
 *
 * One place for the three render paths this page has (a plain GET here, plus
 * Tasks 5 and 6's re-renders after a refusal) to agree on the derived `view`
 * and the formatted kickoff, so a change to either cannot drift between them.
 */
function ownerFixtureParams(
  withSquad: FixtureWithSquad,
  viewerPlayerId: string,
  now: Date,
  extras: { confirm?: OwnerFixtureParams["confirm"]; problem?: string } = {},
): OwnerFixtureParams {
  const { fixture, game, squad } = withSquad;
  return {
    gameId: game.id,
    gameName: game.name,
    fixtureId: fixture.id,
    kicksOffAtLocal: formatLocalDateTime(fixture.kicksOffAt, game.timezone),
    venueName: game.venueName,
    inCount: fixture.inCount,
    maxPlayers: fixture.maxPlayers,
    view: fixtureView(
      {
        lifecycle: fixture.lifecycle,
        kicksOffAt: fixture.kicksOffAt,
        inCount: fixture.inCount,
        minPlayers: fixture.minPlayers,
        maxPlayers: fixture.maxPlayers,
        prefersEvenNumbers: fixture.prefersEvenNumbers,
        shortWarningOffsetHours: fixture.shortWarningOffsetHours,
      },
      now,
    ),
    squad,
    viewerPlayerId,
    ...extras,
  };
}

/**
 * Render `/g/:id/f/:fixtureId` for a loaded target — the plain `GET` above
 * and both of `POST …/response/:playerId`'s refusal paths, so the three
 * cannot drift (see `ownerFixtureParams`'s own comment for why that builder
 * exists).
 */
async function renderOwnerFixture(
  c: Context<AppEnv>,
  target: NonNullable<Awaited<ReturnType<typeof loadFixtureTarget>>>,
  now: Date,
  extras: { confirm?: OwnerFixtureParams["confirm"]; problem?: string } = {},
  status: 200 | 422 = 200,
) {
  const withSquad = await getFixtureWithSquad(target.db, target.fixture.id);
  if (withSquad === null) return c.text("Not found", 404);
  return c.html(
    renderOwnerFixturePage(ownerFixtureParams(withSquad, c.get("player")!.id, now, extras)),
    status,
  );
}

gamesRoutes.get("/g/:id/f/:fixtureId", requirePlayer, async (c) => {
  const target = await loadFixtureTarget(c, c.req.param("id"), c.req.param("fixtureId"));
  if (target === null) return c.text("Not found", 404);

  const now = new Date(Date.now());
  return renderOwnerFixture(c, target, now);
});

/**
 * An owner marking a player in or out on their behalf (BR-27, §4), including
 * BR-8's deliberate over-capacity confirmation.
 *
 * `whenFull` maps `intent` to the Durable Object's three policies: `out`
 * frees a slot and is never refused, so it always waitlists (a no-op, since
 * nothing is taken); a plain mark-in `refuse`s rather than silently
 * waitlisting, so that going over capacity is a second, explicit act; and
 * `override` — the confirmation banner's own resubmission — is that second
 * act, `exceed`.
 */
gamesRoutes.post("/g/:id/f/:fixtureId/response/:playerId", requirePlayer, async (c) => {
  if (wrongOrigin(c)) return c.text("Forbidden", 403);

  const target = await loadFixtureTarget(c, c.req.param("id"), c.req.param("fixtureId"));
  if (target === null) return c.text("Not found", 404);

  const playerId = c.req.param("playerId");
  const form = await c.req.parseBody();
  const rawIntent = form["intent"];
  const intent = rawIntent === "in" || rawIntent === "out" ? rawIntent : null;
  // The value comes from a button this application rendered, so anything else
  // is a hand-built request and gets a 400 rather than a guess.
  if (intent === null) return c.text('Bad Request: "intent" must be exactly "in" or "out"', 400);

  const now = new Date(Date.now());
  const actor = c.get("player")!;
  const override = form["override"] === "1";

  // Read the previous status for the audit row *before* the write. BR-27 asks
  // for the previous value, and after the Durable Object returns it is gone.
  const before = await getFixtureWithSquad(target.db, target.fixture.id);
  const previous = before?.squad.find((m) => m.playerId === playerId);

  const outcome = await c.env.FIXTURE_CAPACITY.getByName(target.fixture.id).setResponse({
    playerId,
    intent,
    actorPlayerId: actor.id,
    source: "owner",
    whenFull: intent === "out" ? "waitlist" : override ? "exceed" : "refuse",
    now: now.getTime(),
  });

  if (outcome.kind === "rejected") {
    if (outcome.reason === "would-exceed-capacity") {
      // Not an error: the owner is one click from the thing they asked for.
      // 422, and the same page again with the question on it (§4.2).
      return renderOwnerFixture(
        c,
        target,
        now,
        { confirm: { playerId, name: previous?.name ?? "this player", intent: "in" } },
        422,
      );
    }
    if (outcome.reason === "not-eligible") return c.text("Not found", 404);
    return renderOwnerFixture(c, target, now, { problem: "That fixture isn't taking answers any more." }, 422);
  }

  await recordAudit(target.db, {
    actorPlayerId: actor.id,
    entityType: "fixture",
    entityId: target.fixture.id,
    action: "fixture.response_overridden",
    before: { playerId, status: previous?.status ?? "pending" },
    after: {
      playerId,
      status: outcome.kind === "waitlisted" ? "waitlisted" : outcome.status,
      overCapacity: override,
    },
    now,
  });

  // The same N-2 path a self-response takes, in the background, for the
  // reasons `notifyPromotedPlayer` documents. An override that frees a slot
  // promotes exactly as any other dropout does (BR-7).
  if (outcome.kind === "recorded" && outcome.promoted) {
    c.executionCtx.waitUntil(notifyPromotedPlayer(c.env, target.fixture.id, outcome.promoted, now));
  }

  return c.redirect(ownerFixturePath(target.game.id, target.fixture.id), 303);
});

/**
 * An owner adding a one-off guest to a fixture (§5). A guest never
 * waitlists — `whenFull` is `"refuse"` or `"exceed"` only — because a slot
 * held "maybe" for someone with no login and no address helps nobody.
 */
gamesRoutes.post("/g/:id/f/:fixtureId/guest", requirePlayer, async (c) => {
  if (wrongOrigin(c)) return c.text("Forbidden", 403);

  const target = await loadFixtureTarget(c, c.req.param("id"), c.req.param("fixtureId"));
  if (target === null) return c.text("Not found", 404);

  const now = new Date(Date.now());
  const form = await c.req.parseBody();
  const parsed = parseGuestName(form["name"]);
  if (!parsed.ok) return renderOwnerFixture(c, target, now, { problem: parsed.problem }, 422);

  const override = form["override"] === "1";
  const outcome = await c.env.FIXTURE_CAPACITY.getByName(target.fixture.id).addGuest({
    name: parsed.name,
    actorPlayerId: c.get("player")!.id,
    whenFull: override ? "exceed" : "refuse",
    now: now.getTime(),
  });

  if (outcome.kind === "rejected") {
    if (outcome.reason === "would-exceed-capacity") {
      // `playerId: null` is what tells the banner to repost to the guest
      // endpoint with the name it is holding, rather than to a player.
      return renderOwnerFixture(
        c,
        target,
        now,
        { confirm: { playerId: null, name: parsed.name, intent: "in" } },
        422,
      );
    }
    return renderOwnerFixture(c, target, now, { problem: "That fixture isn't taking answers any more." }, 422);
  }

  await recordAudit(target.db, {
    actorPlayerId: c.get("player")!.id,
    entityType: "fixture",
    entityId: target.fixture.id,
    action: "fixture.guest_added",
    after: { playerId: outcome.playerId, name: parsed.name, overCapacity: override },
    now,
  });

  return c.redirect(ownerFixturePath(target.game.id, target.fixture.id), 303);
});

/**
 * An owner removing a one-off guest (§5), reusing `withdrawMember` — the same
 * capacity-freeing, promotion-triggering path any other dropout takes.
 *
 * Guests only, and only when seated on *this* fixture. `players.isGuest` is a
 * global flag — a guest's attachment to a fixture lives only in `responses`
 * — so checking it alone would let a POST naming a guest seated on a
 * *different* fixture (including one on a game this owner does not own) pass
 * the entitlement check. `withdrawMember` would then find no response row
 * here, no-op, and this handler would fall through to the same 303 a real
 * removal produces — "that guest isn't here" answering as success. Requiring
 * the guest to appear in *this* fixture's own squad (`getFixtureWithSquad`,
 * fetched here rather than only for the audit row) closes that, and is the
 * same TR-18 scoping every other refusal on `/g/*` uses. Squad members leave
 * through `/g/:id/squad/:playerId/remove`, which has its own confirmation
 * page; without both checks, this route would be a second, unconfirmed way to
 * take a real person out of a squad.
 */
gamesRoutes.post("/g/:id/f/:fixtureId/guest/:playerId/remove", requirePlayer, async (c) => {
  if (wrongOrigin(c)) return c.text("Forbidden", 403);

  const target = await loadFixtureTarget(c, c.req.param("id"), c.req.param("fixtureId"));
  if (target === null) return c.text("Not found", 404);

  const playerId = c.req.param("playerId");
  const before = await getFixtureWithSquad(target.db, target.fixture.id);
  const previous = before?.squad.find((m) => m.playerId === playerId);
  if (!previous || !previous.isGuest) return c.text("Not found", 404);

  const now = new Date(Date.now());

  const outcome = await c.env.FIXTURE_CAPACITY.getByName(target.fixture.id).withdrawMember({
    playerId,
    actorPlayerId: c.get("player")!.id,
    now: now.getTime(),
  });

  // A refusal must never answer as success. The guest was on this fixture's
  // squad a moment ago, so the one no-op reachable here is a fixture that has
  // stopped taking changes since the page was rendered — say so, on the page
  // itself, rather than redirecting back to a squad that still lists them.
  if (outcome.kind === "no-op") {
    if (outcome.reason === "fixture-not-open") {
      return renderOwnerFixture(c, target, now, { problem: "That fixture isn't taking changes any more." }, 422);
    }
    return c.text("Not found", 404);
  }

  await recordAudit(target.db, {
    actorPlayerId: c.get("player")!.id,
    entityType: "fixture",
    entityId: target.fixture.id,
    action: "fixture.guest_removed",
    before: { playerId, name: previous.name, status: previous.status },
    now,
  });

  // Removing a guest frees a slot, so it can promote (BR-7) — the same N-2
  // path every other dropout takes.
  if (outcome.promoted) {
    c.executionCtx.waitUntil(notifyPromotedPlayer(c.env, target.fixture.id, outcome.promoted, now));
  }

  return c.redirect(ownerFixturePath(target.game.id, target.fixture.id), 303);
});

/**
 * The one refusal J6a's invariant produces, rendered as the game page again at
 * 422 with the reason on it — never a bare error and never a dead end. The
 * owner is one click from the fix (make someone else an organiser), and that
 * is the page the fix lives on.
 */
async function renderSquadRefusal(
  c: Context<AppEnv>,
  gameId: string,
  now: Date,
) {
  const db = getDb(c.env.DB);
  const game = await findGameForOwner(db, gameId, c.get("player")!.id);
  if (game === null) return c.text("Not found", 404);
  const [squad, upcoming] = await Promise.all([listSquad(db, game.id), listUpcomingFixtures(db, game.id, now)]);
  return c.html(
    renderGameOverviewPage({
      gameId: game.id,
      gameName: game.name,
      venueName: game.venueName,
      venueAddress: game.venueAddress,
      timezone: game.timezone,
      maxPlayers: game.maxPlayers,
      prefersEvenNumbers: game.prefersEvenNumbers,
      inviteToken: game.inviteToken,
      squad,
      upcoming,
      viewerPlayerId: c.get("player")!.id,
      problem: "A game needs at least one organiser. Make someone else an organiser first.",
    }),
    422,
  );
}

/**
 * Send N-7 in the background, logging every non-success on one greppable line.
 *
 * The `catch` is not decoration: a rejected promise inside a `waitUntil`
 * resolves into nothing, and a thrown D1 error here would otherwise vanish
 * entirely — this codebase has been bitten by exactly that before. The
 * notifier is built here rather than passed in because it must be the
 * quota-wrapped one from `createNotifier` (TR-31).
 */
export async function notifyRemovedPlayer(
  env: AppEnv["Bindings"],
  gameId: string,
  playerId: string,
  membershipId: string,
  leftAt: Date,
  now: Date,
): Promise<void> {
  const who = `game ${gameId}, player ${playerId}`;
  try {
    const db = getDb(env.DB);
    const result = await sendRemovedEmail({
      db,
      notifier: createNotifier(env, db, now),
      gameId,
      playerId,
      membershipId,
      leftAt,
      now,
    });
    if (result.kind === "failed") console.error(`n7 removal email failed for ${who}: ${result.reason}`);
    if (result.kind === "deferred") console.error(`n7 removal email deferred by the daily ceiling for ${who}`);
    // `console.log`, matching `POST /j/:token` and `POST /r/:token`: expected
    // and permanent (BR-32), not a fault — a guest has no address, so every
    // guest removal would otherwise file an error line for working correctly.
    if (result.kind === "skipped-no-recipient") console.log(`n7 removal email skipped, no address, for ${who}`);
  } catch (error) {
    console.error(
      `n7 removal email threw for ${who}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
  }
}

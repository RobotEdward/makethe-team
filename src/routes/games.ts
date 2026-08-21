import { and, eq, ne } from "drizzle-orm";
import { Hono } from "hono";
import type { PageNav } from "../views/layout.js";
import type { Context } from "hono";
import { wrongOrigin } from "../auth/origin.js";
import {
  DASHBOARD_PATH,
  NEW_GAME_PATH,
  gameEditPath,
  gamePath,
  fixturePath,
  resultClearPath,
  resultPath,
} from "../auth/paths.js";
import { requirePlayer, pageNav } from "../auth/session.js";
import { buildAuditInsert, recordAudit } from "../db/audit.js";
import { getDb, type Db } from "../db/client.js";
import {
  countCommitments,
  findGameForMember,
  findGameForOwner,
  findMembershipInGame,
  getFixtureWithSquad,
  listOpenFixtureIds,
  listSquad,
  listTeamAssignments,
  listUpcomingFixtures,
  type FixtureWithSquad,
  type SquadMember,
} from "../db/queries.js";
import { listResultClaims, resultElectorate } from "../db/result-queries.js";
import { fixtures, games, responses } from "../db/schema.js";
import { changeMemberRole, parseRole } from "../domain/change-role.js";
import { createGame } from "../domain/create-game.js";
import { displayName } from "../domain/display-name.js";
import { fixtureView, takingChanges } from "../domain/fixture-view.js";
import { parseGameForm } from "../domain/game-form.js";
import { parseGuestName } from "../domain/guest-name.js";
import { parseRecurrenceRule } from "../domain/recurrence/parse.js";
import { removeMember } from "../domain/remove-member.js";
import { deriveResult, tally } from "../domain/result.js";
import { isResultLocked, resultDeadline, resultWritable } from "../domain/result-lock.js";
import {
  announcementOutstanding,
  isTeamId,
  publishedTeamsFor,
  teamNames,
  teamsNeedAnotherLook,
  unassignedIn,
  type TeamAssignment,
  type TeamId,
} from "../domain/teams.js";
import { formatLocalDateTime } from "../domain/time/zone.js";
import { squadForViewer } from "../domain/squad-visibility.js";
import { countFixturesByPropagation, updateGame } from "../domain/update-game.js";
import type { AppEnv } from "../env.js";
import { recordCeilingDeferral } from "../notify/ceiling-audit.js";
import { createNotifier } from "../notify/factory.js";
import { sendRemovedEmail } from "../notify/send-removed.js";
import { sendTeamsEmails } from "../notify/send-teams.js";
import { renderGameFormPage } from "../views/game-form.js";
import { renderGameOverviewPage } from "../views/game-overview.js";
import { renderOwnerFixturePage, type OwnerFixtureParams } from "../views/owner-fixture.js";
import { renderPlayerFixturePage } from "../views/player-fixture.js";
import { renderPlayerGamePage } from "../views/player-game.js";
import { renderRemoveMemberPage } from "../views/remove-member.js";
import { outcomeNames, type ResultPanelParams } from "../views/result.js";
import { renderSquadMemberPage } from "../views/squad-member.js";
import { rowName } from "../views/team-picker.js";
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
      nav: pageNav(c, "games"),
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
      nav: pageNav(c, "games"),
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
  if (game === null) {
    // Not an owner. A member gets their own page; everyone else gets the same
    // 404 an owner-entitlement failure gets, so the two are indistinguishable.
    const asMember = await findGameForMember(db, c.req.param("id"), player.id);
    if (asMember === null) return c.text("Not found", 404);
    return renderPlayerGame(c, asMember, player.id, now);
  }

  const [squad, upcoming] = await Promise.all([
    listSquad(db, game.id),
    listUpcomingFixtures(db, game.id, now),
  ]);

  return c.html(
    renderGameOverviewPage({
      nav: pageNav(c, "games"),
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
      broadcastNotice: broadcastNoticeFrom(c),
    }),
  );
});

/**
 * The broadcast receipt (M20 B4), from the send handler's redirect flag.
 * Enum-and-integer only: an unrecognised channel or a count that is not a
 * sane positive integer renders nothing rather than something surprising —
 * the query string is caller-controlled, the notice text is not.
 *
 * The channel-word lookup is a `Map`, not an object literal: an object
 * literal's `[key]` lookup falls through to `Object.prototype`, so
 * `via=constructor`, `toString`, `valueOf`, `hasOwnProperty` or `__proto__`
 * would resolve to an inherited function rather than miss, and the
 * `=== undefined` guard below would wave it through into the rendered
 * notice. A `Map` has no prototype chain to fall through to — `get` returns
 * only what was `set`.
 */
const CHANNEL_WORDING = new Map([
  ["email", "by email"],
  ["push", "by push"],
  ["both", "by email and push"],
]);

function broadcastNoticeFrom(c: Context<AppEnv>): string | undefined {
  const sent = Number(c.req.query("sent"));
  if (!Number.isInteger(sent) || sent < 1 || sent > 10_000) return undefined;
  const channel = CHANNEL_WORDING.get(c.req.query("via") ?? "");
  if (channel === undefined) return undefined;
  return `Sent to ${sent} player${sent === 1 ? "" : "s"} ${channel}.`;
}

/**
 * Render `/g/:id` for a member who is not this game's owner — the game's
 * open fixture, if it has one, filtered through `squadForViewer` so a member
 * sees the squad only when the organiser allows it, and what's coming up.
 *
 * Never given the invite token, and never imports `renderGameOverviewPage`
 * or anything from `src/views/game-overview.ts`: the invite link is a
 * capability, and this is the page every member — not just the organiser —
 * can reach.
 */
async function renderPlayerGame(c: Context<AppEnv>, game: typeof games.$inferSelect, viewerPlayerId: string, now: Date) {
  const db = getDb(c.env.DB);

  // `listOpenFixtureIds` returns them kickoff-ordered; a game has at most one
  // open fixture at a time in practice, but the first is the right answer
  // either way.
  const [openFixtureIds, upcoming] = await Promise.all([
    listOpenFixtureIds(db, game.id),
    listUpcomingFixtures(db, game.id, now),
  ]);

  let openFixture: NonNullable<Parameters<typeof renderPlayerGamePage>[0]["openFixture"]> | null = null;
  if (openFixtureIds[0] !== undefined) {
    const withSquad = await getFixtureWithSquad(db, openFixtureIds[0]);
    if (withSquad !== null) {
      openFixture = {
        kicksOffAtLocal: formatLocalDateTime(withSquad.fixture.kicksOffAt, game.timezone),
        view: fixtureView(
          {
            lifecycle: withSquad.fixture.lifecycle,
            kicksOffAt: withSquad.fixture.kicksOffAt,
            inCount: withSquad.fixture.inCount,
            minPlayers: withSquad.fixture.minPlayers,
            maxPlayers: withSquad.fixture.maxPlayers,
            prefersEvenNumbers: withSquad.fixture.prefersEvenNumbers,
            shortWarningOffsetHours: withSquad.fixture.shortWarningOffsetHours,
          },
          now,
        ),
        inCount: withSquad.fixture.inCount,
        // The stored column, not a count of the squad: `squadForViewer` below
        // returns `null` when the organiser hides the list, and the headcount
        // line is rendered either way.
        waitlistCount: withSquad.fixture.waitlistCount,
        squad: squadForViewer(game, withSquad.squad, { isOwner: false }),
        // Read off the viewer's own squad row, taken from the *unfiltered*
        // list — `squadForViewer` above may have returned `null`, and a
        // player's own side survives that (BR-35 §5, `publishedTeamsFor`).
        // `undefined` when they have no response row for this fixture, which
        // is what a member who joined after it opened looks like.
        teams: publishedTeamsFor(
          withSquad.fixture,
          game,
          withSquad.squad.find((member) => member.playerId === viewerPlayerId),
        ),
      };
    }
  }

  return c.html(
    renderPlayerGamePage({
      nav: pageNav(c, "games"),
      gameId: game.id,
      gameName: game.name,
      venueName: game.venueName,
      venueAddress: game.venueAddress,
      timezone: game.timezone,
      openFixture,
      upcoming,
      viewerPlayerId,
    }),
  );
}

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
      nav: pageNav(c, "games"),
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
        squadVisibleToPlayers: game.squadVisibleToPlayers ? "on" : "",
        teamAName: game.teamAName,
        teamBName: game.teamBName,
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
      nav: pageNav(c, "games"),
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

/**
 * One squad member, as their organiser sees them (M11).
 *
 * Entitled entirely by `loadSquadTarget`: owner of *this* game, and
 * `:playerId` genuinely in *this* squad. `null` is 404 and never 403, because
 * this path carries two ids either of which could otherwise be probed for
 * existence (TR-18) — which is also the answer a signed-in stranger gets, by
 * construction rather than by a separate branch.
 *
 * Read-only. There is no `POST` counterpart to this route: renaming a member
 * is the member's own business (`/app/account`), and the role and removal
 * controls belong to the two routes below.
 */
gamesRoutes.get("/g/:id/squad/:playerId", requirePlayer, async (c) => {
  const target = await loadSquadTarget(c, c.req.param("id"), c.req.param("playerId"));
  if (target === null) return c.text("Not found", 404);

  return c.html(
    renderSquadMemberPage({
      nav: pageNav(c, "games"),
      gameId: target.game.id,
      gameName: target.game.name,
      // Never the raw column, and never a literal `null` for the second
      // argument: this page is genuinely unreachable for an erased member
      // (erasure deactivates every membership, and `loadSquadTarget` refuses
      // an inactive one), but that guarantee lives in `erasePlayer` and
      // `loadSquadTarget`, not here — a renderer that claims to route a name
      // through `displayName` should actually pass the column it depends on,
      // not a value that makes the call a no-op regardless of what the
      // database says.
      memberName: displayName(target.member.name, target.member.erasedAt),
      email: target.member.email,
      isGuest: target.member.isGuest,
      role: target.member.role,
      joinedAtLocal: formatLocalDateTime(target.member.joinedAt, target.game.timezone),
    }),
  );
});

gamesRoutes.get("/g/:id/squad/:playerId/remove", requirePlayer, async (c) => {
  const target = await loadSquadTarget(c, c.req.param("id"), c.req.param("playerId"));
  if (target === null) return c.text("Not found", 404);

  const commitments = await countCommitments(target.db, target.game.id, target.member.playerId);
  return c.html(
    renderRemoveMemberPage({
      nav: pageNav(c, "games"),
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
 * The parts of the owner fixture page a *refusal* gets to set: the
 * over-capacity confirmation, a one-line problem, and the publish guard's
 * list of players with no side yet. Everything else about the page is derived
 * from the database, so a refusal can only ever add an explanation to it.
 */
type FixtureRenderExtras = Partial<Pick<OwnerFixtureParams, "confirm" | "problem" | "unassignedProblem">>;

/**
 * The result panel's params for the organiser's own fixture page (M25 Task
 * 10) — the same shape `renderPlayerFixture` below builds for a member, so
 * the tally an organiser sees can never drift from the one a player sees.
 *
 * Callers only reach for this on a `played` fixture; an open one has nothing
 * to have a result about, and `POST …/result` (`src/routes/results.ts`) 404s
 * a write to any fixture that is not `played`, so a panel offering forms on
 * one would invite a submit the route refuses.
 */
async function ownerResultParams(
  db: Db,
  game: typeof games.$inferSelect,
  fixture: typeof fixtures.$inferSelect,
  viewerPlayerId: string,
  now: Date,
): Promise<ResultPanelParams> {
  const [claims, electorate] = await Promise.all([
    listResultClaims(db, fixture.id),
    resultElectorate(db, game.id, fixture.id),
  ]);
  const deadline = resultDeadline(fixture.kicksOffAt);
  return {
    names: outcomeNames(game),
    candidates: tally(claims),
    derived: deriveResult(claims, electorate.organiserIds),
    locked: isResultLocked(fixture.kicksOffAt, claims.length, now),
    writable: resultWritable(fixture.lifecycle, fixture.kicksOffAt, claims.length, now),
    eligible: electorate.eligibleIds.has(viewerPlayerId),
    rostered: fixture.teamsPublishedAt !== null,
    yourPlayerId: viewerPlayerId,
    deadlineLocal: formatLocalDateTime(deadline, game.timezone),
    actionPath: resultPath(game.id, fixture.id),
    clearPath: resultClearPath(game.id, fixture.id),
  };
}

/**
 * Build `OwnerFixtureParams` from a loaded `FixtureWithSquad`.
 *
 * One place for the three render paths this page has (a plain GET here, plus
 * Tasks 5 and 6's re-renders after a refusal) to agree on the derived `view`
 * and the formatted kickoff, so a change to either cannot drift between them.
 */
async function ownerFixtureParams(
  db: Db,
  nav: PageNav,
  withSquad: FixtureWithSquad,
  assignments: readonly TeamAssignment[],
  viewerPlayerId: string,
  now: Date,
  extras: FixtureRenderExtras = {},
): Promise<OwnerFixtureParams> {
  const { fixture, game, squad } = withSquad;
  // Only a `played` fixture has anything to have a result about — see
  // `ownerResultParams`'s own comment for why an open one gets no panel.
  const result =
    fixture.lifecycle === "played"
      ? await ownerResultParams(db, game, fixture, viewerPlayerId, now)
      : undefined;
  return {
    nav,
    gameId: game.id,
    teamNames: teamNames(game),
    prefersEvenNumbers: fixture.prefersEvenNumbers,
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
    // Durable: set by the first publish and never cleared, so this stays true
    // through every later save and the button never falls back to the
    // "Publish teams" label a never-published fixture shows.
    teamsPublished: fixture.teamsPublishedAt !== null,
    // Both derived from the *unfiltered* rows: `withSquad.squad` has
    // `withdrawn` filtered out, and a withdrawn player still carrying a side
    // is precisely one of the two staleness conditions
    // (`src/domain/teams.ts`), so deriving these from the squad above would
    // answer "no" to half the question.
    teamsNeedAnotherLook: teamsNeedAnotherLook(assignments),
    announcementOutstanding: announcementOutstanding(fixture, assignments),
    cancellationReason: fixture.cancellationReason,
    result,
    ...extras,
  };
}

/**
 * Render `/g/:id/f/:fixtureId` for a loaded target — the plain `GET` above,
 * this file's own POST refusal paths, and (M25 review fix) the owner branch
 * of each of `src/routes/results.ts`'s three 422 refusals, exported for that
 * reason. See `ownerFixtureParams`'s own comment for why that builder
 * exists.
 */
export async function renderOwnerFixture(
  c: Context<AppEnv>,
  target: NonNullable<Awaited<ReturnType<typeof loadFixtureTarget>>>,
  now: Date,
  extras: FixtureRenderExtras = {},
  status: 200 | 422 = 200,
) {
  const [withSquad, assignments] = await Promise.all([
    getFixtureWithSquad(target.db, target.fixture.id),
    // The unfiltered rows, `withdrawn` included — see `ownerFixtureParams`.
    listTeamAssignments(target.db, target.fixture.id),
  ]);
  if (withSquad === null) return c.text("Not found", 404);
  const params = await ownerFixtureParams(
    target.db,
    pageNav(c, "games"),
    withSquad,
    assignments,
    c.get("player")!.id,
    now,
    extras,
  );
  // Only the plain GET (`status === 200`, no `extras`-carrying refusal) gets
  // the receipt — a 422 re-render is never the destination of a redirect.
  return c.html(
    renderOwnerFixturePage(status === 200 ? { ...params, broadcastNotice: broadcastNoticeFrom(c) } : params),
    status,
  );
}

gamesRoutes.get("/g/:id/f/:fixtureId", requirePlayer, async (c) => {
  const now = new Date(Date.now());
  const player = c.get("player")!;
  const target = await loadFixtureTarget(c, c.req.param("id"), c.req.param("fixtureId"));
  if (target !== null) return renderOwnerFixture(c, target, now);

  // Not an owner. A member gets their own page; everyone else gets the same
  // 404 an owner-entitlement failure gets, so the two are indistinguishable
  // and a fixture id cannot be probed (TR-18).
  const game = await findGameForMember(getDb(c.env.DB), c.req.param("id"), player.id);
  if (game === null) return c.text("Not found", 404);
  return renderPlayerFixture(c, game, c.req.param("fixtureId"), player.id, now);
});

/**
 * Render `/g/:id/f/:fixtureId` for a member who is not this game's owner —
 * the plain `GET` below, and (Task 9) `src/routes/results.ts`'s member-role
 * 422 refusals (the filing route's not-writable and bad-claim branches, and
 * the clear route's not-writable branch — an owner tripping any of the three
 * gets `renderOwnerFixture` instead, per the M25 review fix that added the
 * role branch), so none of the four can drift.
 *
 * `game` came from `findGameForMember`, which scopes by the path's own game
 * id — but the fixture id is a second, independent path segment, so the
 * fixture is loaded and checked against `game.id` before anything else. A
 * fixture id from another game must not render (TR-18): without this check a
 * member of one game could read a fixture belonging to a different one just
 * by pasting its id into a URL they already have.
 */
export async function renderPlayerFixture(
  c: Context<AppEnv>,
  game: typeof games.$inferSelect,
  fixtureId: string,
  viewerPlayerId: string,
  now: Date,
  extras: { problem?: string } = {},
  status: 200 | 422 = 200,
) {
  const db = getDb(c.env.DB);
  const [fixture] = await db.select().from(fixtures).where(eq(fixtures.id, fixtureId));
  if (!fixture || fixture.gameId !== game.id) return c.text("Not found", 404);

  const withSquad = await getFixtureWithSquad(db, fixtureId);
  if (withSquad === null) return c.text("Not found", 404);

  const [claims, electorate] = await Promise.all([
    listResultClaims(db, fixtureId),
    resultElectorate(db, game.id, fixtureId),
  ]);
  const deadline = resultDeadline(fixture.kicksOffAt);

  return c.html(
    renderPlayerFixturePage({
      nav: pageNav(c, "games"),
      gameName: game.name,
      venueName: game.venueName,
      venueAddress: game.venueAddress,
      kicksOffAtLocal: formatLocalDateTime(fixture.kicksOffAt, game.timezone),
      lifecycle: fixture.lifecycle,
      teams: publishedTeamsFor(
        fixture,
        game,
        withSquad.squad.find((member) => member.playerId === viewerPlayerId),
      ),
      squad: squadForViewer(game, withSquad.squad, { isOwner: false }),
      inCount: fixture.inCount,
      viewerPlayerId,
      problem: extras.problem,
      result: {
        names: outcomeNames(game),
        candidates: tally(claims),
        derived: deriveResult(claims, electorate.organiserIds),
        locked: isResultLocked(fixture.kicksOffAt, claims.length, now),
        writable: resultWritable(fixture.lifecycle, fixture.kicksOffAt, claims.length, now),
        eligible: electorate.eligibleIds.has(viewerPlayerId),
        rostered: fixture.teamsPublishedAt !== null,
        yourPlayerId: viewerPlayerId,
        deadlineLocal: formatLocalDateTime(deadline, game.timezone),
        actionPath: resultPath(game.id, fixtureId),
        clearPath: resultClearPath(game.id, fixtureId),
      },
      fixturePath: fixturePath(game.id, fixtureId),
    }),
    status,
  );
}

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

  return c.redirect(fixturePath(target.game.id, target.fixture.id), 303);
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

  return c.redirect(fixturePath(target.game.id, target.fixture.id), 303);
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

  return c.redirect(fixturePath(target.game.id, target.fixture.id), 303);
});

/**
 * An organiser saving a team pick (BR-35 §4).
 *
 * Saving, not publishing: nothing here emails anybody, and a saved pick stays
 * invisible to players until the fixture is first published; after that,
 * every save is live on players' pages straight away, while the email they
 * already hold is unchanged. That is why the
 * write stamps `teams_saved_at` — once the sides have moved, what was
 * announced is no longer what is picked, and `teams_saved_at >
 * teams_published_at` says so outright rather than leaving it to be inferred.
 * `teams_published_at` itself is deliberately left alone: it is the durable
 * record that an announcement went out, and clearing it here (as an earlier
 * version did) made a re-saved pick indistinguishable from one nobody had
 * ever published — same absent prompt, same "Publish teams" button.
 *
 * **This is also the only thing that clears a departed player's side.** Every
 * row that is not currently `in` has its `team` nulled in the same batch. See
 * `src/domain/teams.ts` for why that clearing belongs here and nowhere else:
 * the orphaned value is the staleness signal, and a save is the organiser
 * deliberately acknowledging the churn it signalled.
 *
 * This is the only owner control on a fixture that writes straight to D1
 * rather than through the FixtureCapacity Durable Object, and deliberately
 * so: a team assignment changes nobody's `status` and takes nobody's slot, so
 * routing it through the capacity actor would put a write in the critical
 * section that cannot affect the thing that section protects. It also means
 * nothing else would refuse a pick on a closed fixture, which is why
 * `takingChanges` is checked here explicitly.
 *
 * **A partial pick is allowed.** An organiser interrupted halfway keeps what
 * they have done; refusing to *publish* an incomplete pick is the publish
 * guard's job, not this one's.
 */
gamesRoutes.post("/g/:id/f/:fixtureId/teams", requirePlayer, async (c) => {
  if (wrongOrigin(c)) return c.text("Forbidden", 403);

  const target = await loadFixtureTarget(c, c.req.param("id"), c.req.param("fixtureId"));
  if (target === null) return c.text("Not found", 404);

  const now = new Date(Date.now());
  const withSquad = await getFixtureWithSquad(target.db, target.fixture.id);
  if (withSquad === null) return c.text("Not found", 404);

  // The same predicate the picker renders behind, so a form that was on
  // screen when the fixture closed cannot save through the back of it.
  if (!takingChanges(fixtureView(target.fixture, now))) {
    return renderOwnerFixture(c, target, now, { problem: "That fixture isn't taking changes any more." }, 422);
  }

  const submitted = await c.req.parseBody();
  const assignments = readAssignments(submitted, withSquad.squad);

  const before = teamsOf(withSquad.squad);
  // Seeded from `before`, then overlaid with what was actually submitted, so
  // the row records the pick as it now stands rather than only the keys this
  // request happened to carry. A form rendered before a waitlist promotion —
  // or any hand-built POST — otherwise filed `after: {}` against a populated
  // `before`, and the trail read as "the organiser stripped everyone's side"
  // for an act that changed nothing. §7 makes that accuracy the reason the
  // row exists.
  const after = { ...before, ...Object.fromEntries(assignments.map((a) => [a.playerId, a.team])) };

  await target.db.batch([
    // Stamped unconditionally, including when the assignments turn out to be
    // identical to what was published: this handler cannot tell a re-save
    // from a real change without comparing every row, and a pick wrongly
    // believed to be still-announced is the failure that matters — it would
    // leave the page claiming everyone has been told when they may not have.
    target.db.update(fixtures).set({ teamsSavedAt: now }).where(eq(fixtures.id, target.fixture.id)),
    // The one place an orphaned side is cleared (see this route's doc comment
    // and `src/domain/teams.ts`). It cannot be expressed as one of the
    // per-player statements below: those are restricted to currently-`in`
    // members, and a departed player is by definition not among them — which
    // is exactly why nothing could clear their side before this statement
    // existed.
    target.db
      .update(responses)
      .set({ team: null })
      .where(and(eq(responses.fixtureId, target.fixture.id), ne(responses.status, "in"))),
    buildAuditInsert(target.db, {
      actorPlayerId: c.get("player")!.id,
      entityType: "fixture",
      entityId: target.fixture.id,
      action: "fixture.teams_saved",
      // BR-27's previous value: the whole pick before and after, because a
      // side is only meaningful against the rest of the pick it belongs to.
      before: { teams: before },
      after: { teams: after },
      now,
    }),
    // One statement per player rather than a CASE expression: a squad is
    // tens of rows, D1's per-statement parameter ceiling is nowhere near in
    // play, and a batch is atomic either way.
    ...assignments.map((assignment) =>
      target.db
        .update(responses)
        .set({ team: assignment.team })
        .where(and(eq(responses.fixtureId, target.fixture.id), eq(responses.playerId, assignment.playerId))),
    ),
  ]);

  return c.redirect(fixturePath(target.game.id, target.fixture.id), 303);
});

/**
 * An organiser publishing a team pick (BR-35 §4) — the act that tells the
 * squad, and the only one in this milestone that emails anybody.
 *
 * **The order of the three checks is load-bearing, in this order:**
 *
 *  1. *Entitlement* (`loadFixtureTarget`), because everything below it reads
 *     the fixture's own rows. Answering "you haven't picked everyone yet" to
 *     somebody who does not own this game would confirm the fixture exists and
 *     leak how many players are on it (TR-18).
 *  2. *The fixture is open.* Announcing teams for a cancelled or played
 *     fixture would send a squad to a game that is not happening.
 *  3. *Completeness.* Only then is it worth reading the assignments.
 *
 * **A partial pick is refused, and this is the only place that refuses it.**
 * Saving one is deliberately allowed (see the save route above) — an organiser
 * interrupted halfway keeps their work — but an announcement that silently
 * omits whoever has no side yet is worse than no announcement: the omitted
 * player is the one person who most needs to be told. The refusal comes back
 * as the fixture page itself at 422 with the names on it, the same shape
 * `renderDashboard(c, problem)` uses, because the fix is on that page.
 *
 * A fixture with *nobody* `in` is refused by the same check, because
 * `unassignedIn` is empty when there is nobody to be unassigned and zero
 * players satisfy "everyone who is in has a side" only trivially. Publishing
 * it would stamp `teams_published_at`, email nobody, and leave the page
 * claiming the squad had been told. Unreachable from the UI — the picker
 * offers no Publish button there — but a stale form is not, which is the whole
 * reason this route re-asks every question the page already asked.
 *
 * `unassignedIn` reads `listTeamAssignments`, which deliberately includes
 * `withdrawn` rows — they cannot be `in`, so they cannot block a publish, but
 * asking the same query the staleness predicate asks keeps one source of truth
 * for what "the teams" are.
 */
gamesRoutes.post("/g/:id/f/:fixtureId/teams/publish", requirePlayer, async (c) => {
  if (wrongOrigin(c)) return c.text("Forbidden", 403);

  // Check 1: entitlement, before anything reads or reveals a fixture.
  const target = await loadFixtureTarget(c, c.req.param("id"), c.req.param("fixtureId"));
  if (target === null) return c.text("Not found", 404);

  const now = new Date(Date.now());

  // Check 2: still open. The same predicate the picker and the save route use.
  if (!takingChanges(fixtureView(target.fixture, now))) {
    return renderOwnerFixture(c, target, now, { problem: "That fixture isn't taking changes any more." }, 422);
  }

  // Check 3: everyone who is in has a side, and there is somebody to tell.
  const assignments = await listTeamAssignments(target.db, target.fixture.id);
  const unassigned = unassignedIn(assignments);
  const playing = assignments.filter((row) => row.status === "in");
  if (unassigned.length > 0 || playing.length === 0) {
    const withSquad = await getFixtureWithSquad(target.db, target.fixture.id);
    // The same name a picker row carries, `(guest)` suffix included, so the
    // refusal and the row it points at read identically — "Still to pick: Gus
    // Guest." above a row labelled "Gus Guest (guest)" is one more thing for
    // an organiser to reconcile at exactly the wrong moment.
    const nameOf = new Map(withSquad?.squad.map((m) => [m.playerId, rowName(m)]) ?? []);
    return renderOwnerFixture(
      c,
      target,
      now,
      // The names, not the count: "3 players still need a side" sends an
      // organiser back to count fourteen radio groups by hand. An empty squad
      // has no names to give, and gets the sentence the picker already renders
      // in that case instead.
      { unassignedProblem: unassigned.map((row) => nameOf.get(row.playerId) ?? "someone who has since left") },
      422,
    );
  }

  await target.db.batch([
    // `now` is the published instant, and it is what `teamsKey` builds every
    // recipient's dedupe key from — so the row and the emails describe the
    // same publish, and a second publish (which must genuinely re-send) gets
    // a genuinely different key.
    target.db.update(fixtures).set({ teamsPublishedAt: now }).where(eq(fixtures.id, target.fixture.id)),
    buildAuditInsert(target.db, {
      actorPlayerId: c.get("player")!.id,
      entityType: "fixture",
      entityId: target.fixture.id,
      action: "fixture.teams_published",
      // The pick as announced. No `before`: publishing changes no side, only
      // whether the sides are public, and the save that produced them already
      // filed its own row.
      after: { teams: Object.fromEntries(assignments.filter((a) => a.status === "in").map((a) => [a.playerId, a.team])) },
      now,
    }),
  ]);

  // `waitUntil`, matching the dashboard's promotion send: everything the
  // organiser is waiting for is already committed, no correctness property
  // depends on delivery, and a slow provider must not hold up their redirect.
  // Failures are not silent — every outcome is a durable `notification_log`
  // row and `publishTeams` logs the rest.
  c.executionCtx.waitUntil(publishTeams(c.env, target.fixture.id, now));

  return c.redirect(fixturePath(target.game.id, target.fixture.id), 303);
});

/**
 * Send N-9 in the background, logging every non-success on one greppable line.
 *
 * The `catch` is the same one `notifyRemovedPlayer` carries and for the same
 * reason: a rejected promise inside a `waitUntil` resolves into nothing, and a
 * thrown D1 error here would otherwise vanish entirely. The notifier is built
 * here rather than passed in because it must be the quota-wrapped one from
 * `createNotifier` (TR-31), and this is a per-request send path fanning out to
 * a whole squad — exactly where a runaway would show up.
 *
 * `publishedAt` and `now` are the same instant on this path, and are still
 * passed separately: `sendTeamsEmails` uses the first for the dedupe key of
 * the publish being announced and the second for `sent_at` and the leave
 * token's expiry, and collapsing them here would tie a future re-send of an
 * *older* publish to whenever it happened to be retried.
 */
async function publishTeams(env: AppEnv["Bindings"], fixtureId: string, publishedAt: Date): Promise<void> {
  const who = `fixture ${fixtureId}`;
  try {
    const db = getDb(env.DB);
    const result = await sendTeamsEmails({
      db,
      notifier: createNotifier(env, db, publishedAt),
      fixtureId,
      publishedAt,
      now: publishedAt,
      responseTokenSecret: env.RESPONSE_TOKEN_SECRET,
    });
    if (result.failed > 0) console.error(`teams email (N-9) failed for ${result.failed} player(s) on ${who}`);
    if (result.deferred > 0) {
      // The same durable record N-2 and N-3 write, and this milestone's review
      // was right to insist on it. A first version of this branch logged and
      // moved on, reasoning that a publish is retryable — the organiser can
      // publish again, and `teamsKey`'s publish instant mints a fresh dedupe
      // key. But *nothing retries it*: no sweep re-evaluates a publish, and no
      // later message corrects the silence. Worse, the ceiling refusal
      // *deletes* the `notification_log` row (`applySendResult`), the
      // organiser has already been redirected to a 303, and the page they land
      // on reads "Publish again" — the UI positively asserting the squad was
      // told. That leaves a player turning up not knowing which side they are
      // on, with nothing anywhere naming them once the log line ages out.
      // No `collapseWindowMs`: publishing is an act of a person, so the row
      // count is bounded by user action already (as with N-2 and N-3, unlike
      // the sweep-driven N-1 and N-4).
      await recordCeilingDeferral(db, {
        action: "fixture.teams_email_deferred",
        notificationType: "n9",
        entityType: "fixture",
        entityId: fixtureId,
        playerIds: result.deferredPlayerIds,
        now: publishedAt,
      });
      console.error(
        `teams email (N-9) refused by the daily send ceiling for ${result.deferred} player(s) and NOTHING WILL RETRY IT (audit_log row written): ${who}`,
      );
    }
    // `console.log`, not `error`: a guest has no address, and BR-32 says so —
    // an error line per guest would file a fault for working correctly.
    if (result.guestsSkipped > 0) console.log(`teams email (N-9) skipped ${result.guestsSkipped} guest(s) on ${who}`);
  } catch (error) {
    console.error(
      `teams email (N-9) threw for ${who}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
  }
}

/** The current pick, keyed by player id, for the audit row's `before`. */
function teamsOf(squad: readonly SquadMember[]): Record<string, TeamId | null> {
  return Object.fromEntries(squad.filter((m) => m.status === "in").map((m) => [m.playerId, m.team]));
}

/**
 * The assignments a submitted picker form actually asks for.
 *
 * Deliberately forgiving, and that is a robustness requirement rather than a
 * nicety: the squad can change under a picker that is already on screen — a
 * player drops out, a guest is removed, a waitlisted player is promoted — and
 * the stale form that organiser then submits must save what still makes sense
 * instead of failing. So a key that is not a currently-`in` member of *this*
 * fixture is ignored, and so is a value that is not `a`, `b` or empty.
 * Neither is an error; there is no attacker-supplied case here that a 400
 * would serve better than simply not doing it.
 *
 * Restricting to `in` members is also what stops the picker being a second
 * way to touch a waitlisted player's row: they are not offered a side (BR-35
 * §4), and a hand-built body naming one gets nowhere.
 */
function readAssignments(
  submitted: Record<string, unknown>,
  squad: readonly SquadMember[],
): readonly { playerId: string; team: TeamId | null }[] {
  const playing = new Set(squad.filter((m) => m.status === "in").map((m) => m.playerId));
  const assignments: { playerId: string; team: TeamId | null }[] = [];

  for (const [playerId, value] of Object.entries(submitted)) {
    if (!playing.has(playerId)) continue;
    if (value === "") assignments.push({ playerId, team: null });
    else if (isTeamId(value)) assignments.push({ playerId, team: value });
  }

  return assignments;
}

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
      nav: pageNav(c, "games"),
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

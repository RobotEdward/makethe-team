import { and, desc, eq, inArray, ne, notInArray } from "drizzle-orm";
import { Hono } from "hono";
import type { PageNav } from "../views/layout.js";
import type { Context } from "hono";
import { wrongOrigin } from "../auth/origin.js";
import { parseIntent, recordWebAnswer } from "./web-answer.js";
import {
  DASHBOARD_PATH,
  NEW_GAME_PATH,
  gameEditPath,
  gameMutePath,
  gamePath,
  gameUnmutePath,
  fixturePath,
  pickerPagePath,
  resultClearPath,
  resultPath,
} from "../auth/paths.js";
import { requirePlayer, pageNav } from "../auth/session.js";
import { buildAuditInsert, recordAudit } from "../db/audit.js";
import { buildTimeline } from "../domain/timeline.js";
import { renderTimelinePage, toRenderable } from "../views/timeline.js";
import { openFixture } from "../domain/open-fixture.js";
import { getDb, type Db } from "../db/client.js";
import {
  countCommitments,
  findGameForMember,
  findGameForOwner,
  findLastPlayedFixture,
  findMembershipInGame,
  getFixtureWithSquad,
  listOpenFixtureIds,
  listSquad,
  listPastFixturesForGame,
  listTeamAssignments,
  listUpcomingFixtures,
  muteStateFor,
  type FixtureWithSquad,
  type ViewerMuteState,
  type SquadMember,
} from "../db/queries.js";
import { listPlayerPastFixturesInGame } from "../db/dashboard-queries.js";
import { getSquadPresence } from "../db/presence-queries.js";
import { listResultClaims, resultElectorate } from "../db/result-queries.js";
import { resultWordsForLockedRows } from "../db/result-summary.js";
import { auditLog, fixtures, games, notificationLog, players, responses } from "../db/schema.js";
import { changeMemberRole, parseRole } from "../domain/change-role.js";
import { createGame } from "../domain/create-game.js";
import { displayName } from "../domain/display-name.js";
import { fixtureView, takingChanges } from "../domain/fixture-view.js";
import { GATED_FALLBACK_NEVER, parseGameForm, parseNotificationCells } from "../domain/game-form.js";
import { inviteGateApplies, loadInviteOrder } from "../db/invite-queries.js";
import { inviteTiers, memberships } from "../db/schema.js";
import { inviteOrderPath } from "../auth/paths.js";
import { renderInviteOrderPage } from "../views/invite-order.js";
import type { InviteProgressParams } from "../views/invite-order.js";
import { parseGuestName } from "../domain/guest-name.js";
import { parseRecurrenceRule } from "../domain/recurrence/parse.js";
import { removeMember } from "../domain/remove-member.js";
import { archiveGame, unarchiveGame } from "../domain/archive-game.js";
import { cancellationRecipients } from "../domain/cancel-fixture.js";
import { TERMINAL_LIFECYCLES } from "../domain/lifecycle.js";
import { sendCancellationEmails } from "../notify/send-cancellation.js";
import { renderArchiveGamePage } from "../views/archive-game.js";
import { isMuted, parseMuteDuration } from "../domain/mute.js";
import { squadSignals } from "../domain/presence.js";
import { effectiveMode, isPickerMode, mayPick, mayPublish } from "../domain/picker.js";
import { clearMute, setMute } from "../domain/set-mute.js";
import { deriveResult, tally } from "../domain/result.js";
import { isResultLocked, resultDeadline, resultWritable } from "../domain/result-lock.js";
import {
  announcementOutstanding,
  isTeamId,
  publishedTeamsFor,
  sideCounts,
  teamNames,
  teamsNeedAnotherLook,
  unassignedIn,
  type TeamAssignment,
  type TeamId,
} from "../domain/teams.js";
import { formatLocalDate, formatLocalDateTime, formatLocalShortDate, formatLocalTime } from "../domain/time/zone.js";
import { squadForViewer, standingsForViewer } from "../domain/squad-visibility.js";
import { countFixturesByPropagation, updateGame } from "../domain/update-game.js";
import type { AppEnv } from "../env.js";
import { recordCeilingDeferral } from "../notify/ceiling-audit.js";
import { createNotifier } from "../notify/factory.js";
import { sendLateInvitations } from "../notify/send-late-invitations.js";
import { loadNotificationSettings, saveOwnerNotificationSettings } from "../notify/notification-settings.js";
import { sendPickerHandover } from "../notify/send-picker-handover.js";
import { sendRemovedEmail } from "../notify/send-removed.js";
import { sendTeamsEmails } from "../notify/send-teams.js";
import { ownerNotificationRows, renderGameFormPage } from "../views/game-form.js";
import { renderAddGuestPage } from "../views/add-guest.js";
import { renderRotateInvitePage } from "../views/rotate-invite.js";
import { renderNotFoundPage } from "../views/not-found.js";
import { buildLeagueTable } from "../domain/league-table.js";
import { squadLeagueTally } from "../db/record-queries.js";
import { renderGameOverviewPage } from "../views/game-overview.js";
import { renderOwnerFixturePage, type OwnerFixtureParams } from "../views/owner-fixture.js";
import { renderPickerPage } from "../views/picker-page.js";
import { renderPlayerFixturePage } from "../views/player-fixture.js";
import type { MuteControlsOptions } from "../views/mute-controls.js";
import { renderPastFixturesPage, type PastFixtureRow } from "../views/past-fixtures.js";
import { renderPlayerGamePage } from "../views/player-game.js";
import { renderRemoveMemberPage } from "../views/remove-member.js";
import { derivedResultWords, outcomeNames, type ResultPanelParams } from "../views/result.js";
import { renderSquadMemberPage } from "../views/squad-member.js";
import { rowName } from "../views/team-picker.js";
import { notifyPromotedPlayer, notifyReleasedSubs } from "./respond.js";

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

/**
 * The "last result" line both game pages show (M25 Task 13, BR-37): the
 * words for the game's most recently played fixture, and its own id to link
 * to — or `null` for "nothing to show", which covers two different states
 * identically: no fixture has ever been played, and one has but nobody has
 * filed a claim on it yet.
 *
 * A read-only summary, never the panel (`renderResultPanel`) — that carries
 * live forms, and `POST …/result` 404s a submission to anything but the
 * fixture page's own played fixture (Task 9), so a form here would invite a
 * submit this page cannot honour. The words themselves come from
 * `derivedResultWords`, the same function `renderLocked` uses inside the
 * panel, so this line and that one can never disagree about what a result
 * was called.
 *
 * **Gated on `isResultLocked`, the same predicate the account page's
 * `resultWordsForLockedRows` uses and says why (M25 review fix).** Without
 * it, one person's claim filed minutes after full time put a bare, settled-
 * looking line on both game pages while the claim was still openly
 * arguable — contradicting `screens.md`'s "absent until a fixture has
 * locked" and the result panel right below it, which shows the same claims
 * *with* their backer counts precisely so a contested tally does not read as
 * fact.
 */
async function lastResultFor(
  db: Db,
  game: { id: string; teamAName: string; teamBName: string },
  now: Date,
): Promise<{ fixtureId: string; words: string } | null> {
  const last = await findLastPlayedFixture(db, game.id);
  if (last === null) return null;

  const claims = await listResultClaims(db, last.id);
  if (claims.length === 0) return null;
  if (!isResultLocked(last.kicksOffAt, claims.length, now)) return null;

  const { organiserIds } = await resultElectorate(db, game.id, last.id);
  const derived = deriveResult(claims, organiserIds);
  // `claims` is non-empty here, so `deriveResult` cannot return null — see
  // `src/sweep/result-cache.ts`'s own comment on the identical guarantee.
  if (derived === null) return null;

  const words = derivedResultWords(outcomeNames(game), derived);
  if (words === null) return null;
  return { fixtureId: last.id, words };
}

/**
 * The squad as the organiser's overview shows it: the members, their mute
 * state, and M33's reachability markers.
 *
 * Both callers go through here rather than each mapping their own, so the
 * refusal render cannot end up showing a squad shaped differently from the
 * ordinary one.
 *
 * `isMuted` and `squadSignals` are applied here rather than in the view for
 * the same reason: both are relative to *now*, and the page must not hold a
 * clock (M28).
 */
async function squadForOverview(db: Db, gameId: string, now: Date) {
  const [squad, presence] = await Promise.all([
    listSquad(db, gameId),
    getSquadPresence(db, gameId, now),
  ]);
  const byPlayer = new Map(presence.map((row) => [row.playerId, row]));
  return squad.map((member) => {
    // A member with no presence row cannot happen — both reads take the same
    // active memberships — but the two are separate statements, and a
    // membership ending between them would otherwise throw on a page an
    // organiser is only reading.
    const presenceRow = byPlayer.get(member.playerId);
    return {
      ...member,
      muted: isMuted(member, now),
      // A guest has no address to confirm, so a guest is never marked even
      // when `emailVerifiedAt` happens to be null (M39, BR-52).
      unconfirmed: !member.isGuest && member.emailVerifiedAt === null,
      signals: squadSignals(
        {
          isGuest: member.isGuest,
          lastSeenAt: presenceRow?.lastSeenAt ?? null,
          lastAnsweredAt: presenceRow?.lastAnsweredAt ?? null,
          lastStandaloneAt: presenceRow?.lastStandaloneAt ?? null,
          pushDevices: presenceRow?.pushDevices ?? 0,
          deliveryFailing: presenceRow?.deliveryFailing ?? false,
        },
        now,
      ),
    };
  });
}

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
    if (asMember === null) return c.html(renderNotFoundPage(), 404);
    return renderPlayerGame(c, asMember, player.id, now);
  }



  const [squad, upcoming, lastResult, tally] = await Promise.all([
    squadForOverview(db, game.id, now),
    listUpcomingFixtures(db, game.id, now),
    lastResultFor(db, game, now),
    squadLeagueTally(db, game.id),
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
      archivedOn: archivedOn(game),
      squad,
      upcoming,
      viewerPlayerId: player.id,
      lastResult,
      // Through `standingsForViewer` even here, where an organiser always
      // passes it: the gate belongs to that module (M49), and a page that
      // handed the table straight through would be a second place deciding.
      standings: standingsForViewer(game, buildLeagueTable(tally), { isOwner: true }),
      broadcastNotice: broadcastNoticeFrom(c),
    }),
  );
});

/**
 * How many past fixtures either role's list shows (M27, TR-38).
 *
 * A bound, not a page size: a game running weekly for years has an unbounded
 * history, and each row's result is derived through a batched claims read
 * that D1 refuses past 100 bound parameters. Fifty is a year of a weekly
 * game. There is no "older" link yet, and the page does not pretend there is
 * — see docs/known-issues.md.
 */
const PAST_FIXTURES_LIMIT = 50;

/**
 * `GET /g/:id/fixtures` (M27): the fixtures that have been and gone.
 *
 * Registered after `NEW_GAME_PATH` like every other `/g/:…` route (see this
 * module's own comment on why the order is load-bearing).
 *
 * Dispatches by role exactly as `/g/:id` above does, and for the same reason
 * one path serves both: two paths would be two entitlement checks to keep in
 * step. What differs is only the *scope* of the list, never who may reach it
 * — an organiser sees every fixture before now, cancelled ones included; a
 * member sees the played ones they have a response row for. Both refusals are
 * a 404 rather than a 403, so a game id cannot be probed (TR-18).
 */
gamesRoutes.get("/g/:id/fixtures", requirePlayer, async (c) => {
  const now = new Date(Date.now());
  const db = getDb(c.env.DB);
  const player = c.get("player")!;
  const gameId = c.req.param("id");

  const asOwner = await findGameForOwner(db, gameId, player.id);
  const game = asOwner ?? (await findGameForMember(db, gameId, player.id));
  if (game === null) return c.html(renderNotFoundPage(), 404);

  // Two shapes into one: the organiser's rows come from the game's own
  // fixtures, the member's from the entitled join that starts at their own
  // response row. Normalised here rather than in the view, which has no
  // business knowing there are two queries behind it.
  const listed =
    asOwner === null
      ? (await listPlayerPastFixturesInGame(db, player.id, game.id, PAST_FIXTURES_LIMIT)).map(
          (row) => ({
            fixtureId: row.fixtureId,
            gameId: row.gameId,
            kicksOffAt: row.kicksOffAt,
            lifecycle: row.lifecycle,
            inCount: row.inCount,
          }),
        )
      : (await listPastFixturesForGame(db, game.id, now, PAST_FIXTURES_LIMIT)).map((row) => ({
          fixtureId: row.id,
          gameId: game.id,
          kicksOffAt: row.kicksOffAt,
          lifecycle: row.lifecycle,
          inCount: row.inCount,
        }));

  // The same derivation the account history and the dashboard use, so no two
  // surfaces can name one result differently — and gated on the same lock, so
  // a tally still inside its 48 hours shows no line at all rather than a
  // settled-looking one.
  const words = await resultWordsForLockedRows(db, listed, now);

  const rows: PastFixtureRow[] = listed.map((row) => ({
    fixtureId: row.fixtureId,
    kicksOffAtLocal: formatLocalDateTime(row.kicksOffAt, game.timezone),
    lifecycle: row.lifecycle,
    inCount: row.inCount,
    resultWords: words.get(row.fixtureId),
  }));

  return c.html(
    renderPastFixturesPage({
      nav: pageNav(c, "games"),
      gameId: game.id,
      gameName: game.name,
      rows,
      owner: asOwner !== null,
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
  const [openFixtureIds, upcoming, lastResult, mute, tally] = await Promise.all([
    listOpenFixtureIds(db, game.id),
    listUpcomingFixtures(db, game.id, now),
    lastResultFor(db, game, now),
    muteStateFor(db, game.id, viewerPlayerId, now),
    squadLeagueTally(db, game.id),
  ]);

  let openFixture: NonNullable<Parameters<typeof renderPlayerGamePage>[0]["openFixture"]> | null = null;
  if (openFixtureIds[0] !== undefined) {
    const withSquad = await getFixtureWithSquad(db, openFixtureIds[0]);
    if (withSquad !== null) {
      // The viewer's own row from the *unfiltered* squad, for the same reason
      // `teams` below reads it there: `squadForViewer` returns null on a game
      // that hides its list, and a player's own answer survives that.
      const mine = withSquad.squad.find((member) => member.playerId === viewerPlayerId);
      openFixture = {
        fixtureId: withSquad.fixture.id,
        // A member with no response row has not been asked yet, which is what
        // `pending` means — the state a joiner is in before the backfill, and
        // the one the answer block offers both buttons for.
        myStatus: mine?.status ?? "pending",
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
      archivedOn: archivedOn(game),
      openFixture,
      upcoming,
      lastResult,
      viewerPlayerId,
      mute: muteControlsFor(game, mute),
      // The league table names every squad member, so it is gated exactly as
      // the squad list above is (M49, BR-33) — same module, same question.
      standings: standingsForViewer(game, buildLeagueTable(tally), { isOwner: false }),
    }),
  );
}

/**
 * The auto-decline panel's props for one viewer (M28), shared by the game page
 * and the fixture page so the two cannot offer different durations or post to
 * different places.
 *
 * A `null` state — the viewer has no active membership — renders as switched
 * off rather than not at all. It is unreachable from either caller, both of
 * which have already established membership to get this far, and rendering the
 * off state is the harmless branch: the routes behind the form re-ask the same
 * question and answer 404.
 */
function muteControlsFor(
  game: typeof games.$inferSelect,
  state: ViewerMuteState | null,
): MuteControlsOptions {
  return {
    muteAction: gameMutePath(game.id),
    unmuteAction: gameUnmutePath(game.id),
    state:
      state?.muted === true
        ? {
            muted: true,
            // The date alone: the expiry's time of day is four weeks after
            // whichever minute the player tapped, and naming it invites a
            // reader to think that minute was chosen.
            untilLocal: state.mutedUntil === null ? null : formatLocalDate(state.mutedUntil, game.timezone),
          }
        : { muted: false },
    otherGamesCount: state?.otherGamesCount ?? 0,
  };
}

/**
 * The player's own auto-decline switch (M28).
 *
 * Entitlement is any **active membership**, owner or not, re-asked here rather
 * than inherited from the page that rendered the form (TR-18) — and a refusal
 * is a 404, so a game id cannot be probed through it. `setMute` re-reads the
 * membership itself and answers `not-a-member` for the same case; the check
 * here exists so the refusal is decided in one place with the other routes'.
 *
 * A duration the catalogue does not contain is a 400, never a default: a
 * hand-crafted body must not be able to mute somebody for a length nobody
 * offered. `all-games` is an ordinary checkbox, so its absence is the "just
 * this squad" answer and needs no hidden companion field — unlike the game
 * form's `prefersEvenNumbers`, there is no stored value being edited whose
 * unticking has to survive a validation round-trip.
 */
/**
 * A signed-in member answering one fixture from the game page (M52).
 *
 * The write is `recordWebAnswer`, shared with `POST /app` rather than copied:
 * the entitlement re-check, the capacity object that alone decides `in` versus
 * `waitlisted`, the promotion email and the race handling must be identical on
 * both, and a second copy would have been the fourth place in this codebase
 * deciding who gets a place.
 *
 * The only real difference is where the player lands afterwards. The dashboard
 * route redirects to the dashboard, which would have bounced a player out of
 * the game they were reading; this comes back to the same page, so the answer
 * appears where it was given.
 *
 * The fixture id is in the path rather than a hidden field, and the game id
 * beside it is passed through to be checked against the fixture's own — a
 * member of one game must not be able to answer a fixture in another the same
 * owner runs (TR-18). A refusal is a 404, never a 403.
 */
gamesRoutes.post("/g/:id/f/:fixtureId/answer", requirePlayer, async (c) => {
  if (wrongOrigin(c)) return c.text("Forbidden", 403);

  const form = await c.req.parseBody();
  const intent = parseIntent(form["intent"]);
  if (intent === null) {
    return c.text('Bad Request: "intent" must be exactly "in" or "out"', 400);
  }

  const gameId = c.req.param("id");
  const recorded = await recordWebAnswer(
    c,
    c.get("player")!.id,
    c.req.param("fixtureId"),
    intent,
    new Date(Date.now()),
    gameId,
  );
  if (recorded === "not-found") return c.text("Not found", 404);

  return c.redirect(gamePath(gameId), 303);
});

gamesRoutes.post("/g/:id/mute", requirePlayer, async (c) => {
  if (wrongOrigin(c)) return c.text("Forbidden", 403);

  const now = new Date(Date.now());
  const db = getDb(c.env.DB);
  const player = c.get("player")!;
  const gameId = c.req.param("id");

  const form = await c.req.parseBody();
  const duration = parseMuteDuration(form["duration"]);
  if (duration === null) {
    return c.text('Bad Request: "duration" must be one of 2w, 4w, 8w, forever', 400);
  }

  // The fixture ids the mute declined on the player's behalf. `SetMuteResult`
  // carries only a count, and the callback below is the one place each id is
  // visible — collecting them here avoids widening that interface for one
  // caller.
  const autoDeclined: string[] = [];
  const result = await setMute({
    db,
    playerId: player.id,
    gameId,
    duration,
    applyToAll: form["all-games"] !== undefined,
    now,
    decline: (fixtureId, playerId) => {
      autoDeclined.push(fixtureId);
      return c.env.FIXTURE_CAPACITY.getByName(fixtureId).setResponse({
        playerId,
        intent: "out",
        // The player is acting on themselves, so there is no override to
        // record: `setByPlayerId` stays null, exactly as it does when they
        // press "Can't play" (BR-27).
        actorPlayerId: null,
        source: "web",
        now: now.getTime(),
        whenFull: "waitlist",
      });
    },
  });
  if (result.kind === "not-a-member") return c.text("Not found", 404);

  // A mute is a decline the player made in advance (M28), so each fixture it
  // answered owes a tier just as a live decline does.
  for (const fixtureId of autoDeclined) {
    c.executionCtx.waitUntil(notifyReleasedSubs(c.env, fixtureId, now));
  }

  return c.redirect(gamePath(gameId), 303);
});

/** Turning it back off. See `POST /g/:id/mute` for the entitlement reasoning. */
gamesRoutes.post("/g/:id/unmute", requirePlayer, async (c) => {
  if (wrongOrigin(c)) return c.text("Forbidden", 403);

  const db = getDb(c.env.DB);
  const player = c.get("player")!;
  const gameId = c.req.param("id");

  const form = await c.req.parseBody();
  const result = await clearMute({
    db,
    playerId: player.id,
    gameId,
    applyToAll: form["all-games"] !== undefined,
    now: new Date(Date.now()),
  });
  if (result.kind === "not-a-member") return c.text("Not found", 404);

  return c.redirect(gamePath(gameId), 303);
});

/**
 * The confirmation page for replacing a game's invite link (M52).
 *
 * A `GET` that only ever renders, and a separate `POST` that acts — the same
 * shape as `/g/:id/archive` and for the same reason: a mail client prefetch or
 * a mis-tap must not be able to kill a link that is already in a group chat.
 */
gamesRoutes.get("/g/:id/invite/rotate", requirePlayer, async (c) => {
  const db = getDb(c.env.DB);
  const game = await findGameForOwner(db, c.req.param("id"), c.get("player")!.id);
  if (game === null) return c.html(renderNotFoundPage(), 404);

  const squad = await listSquad(db, game.id);

  return c.html(
    renderRotateInvitePage({
      nav: pageNav(c, "games"),
      gameId: game.id,
      gameName: game.name,
      squadSize: squad.length,
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

/**
 * The owner's invite-order editor (M34, BR-38).
 *
 * Entitled by `findGameForOwner` and a 404 on refusal, like every other route
 * in this file: a 403 would confirm the Game exists to somebody who has no
 * business knowing (TR-18).
 */
gamesRoutes.get("/g/:id/invites", requirePlayer, async (c) => {
  const db = getDb(c.env.DB);
  const game = await findGameForOwner(db, c.req.param("id"), c.get("player")!.id);
  if (game === null) return c.text("Not found", 404);

  const tiers = await loadInviteOrder(db, game.id);
  return c.html(
    renderInviteOrderPage({
      nav: pageNav(c, "games"),
      gameId: game.id,
      gameName: game.name,
      squadSize: tiers.reduce((total, tier) => total + tier.members.length, 0),
      tiers: tiers.map((tier) => ({
        tierId: tier.tierId,
        name: tier.name,
        position: tier.position,
        members: tier.members.map((member) => ({ playerId: member.playerId, name: member.name })),
      })),
    }),
  );
});

/**
 * Re-run every open fixture's invite order after the order itself changed.
 *
 * Moving a member into a released tier releases them, and BR-40a means that is
 * no longer only a question of who gets mailed: since M43 an unreleased member
 * who volunteered is sitting on the waitlist, and releasing them is what puts
 * them in a free slot. `notifyReleasedSubs` already does the whole job —
 * claim, stamp, N-1 to the newly invited, N-2 to whoever the claim promoted —
 * so this is the same call a decline makes, over a different trigger.
 *
 * **The hourly sweep already did this, up to an hour later.** That is precisely
 * the problem: an owner who fixes somebody's group sees nothing happen, and an
 * organiser sorting out tomorrow's game does not have an hour. This closes the
 * gap; it does not replace the sweep, which remains the guarantee if the
 * background task here is dropped.
 *
 * `waitUntil` rather than `await`: the redirect owes nothing to the outcome,
 * and an owner reordering their squad must not wait on a mail provider.
 */
async function reconcileInviteOrder(
  c: Context<AppEnv>,
  db: Db,
  gameId: string,
  now: Date,
): Promise<void> {
  const open = await db
    .select({ id: fixtures.id })
    .from(fixtures)
    .where(and(eq(fixtures.gameId, gameId), eq(fixtures.lifecycle, "open")));

  for (const fixture of open) {
    c.executionCtx.waitUntil(notifyReleasedSubs(c.env, fixture.id, now));
  }
}

/**
 * Save the whole order and every member's tier in one submission.
 *
 * **Every tier id in the form is checked against this Game's own tiers**, and
 * anything else is written as null rather than rejected. That check is the
 * only thing standing behind `memberships.invite_tier_id`: SQLite cannot
 * express "the referenced tier belongs to this Game", so a hand-built request
 * naming another squad's tier would otherwise be stored, and the invite order
 * of two unrelated Games would be quietly entangled.
 */
gamesRoutes.post("/g/:id/invites", requirePlayer, async (c) => {
  if (wrongOrigin(c)) return c.text("Forbidden", 403);

  const db = getDb(c.env.DB);
  const game = await findGameForOwner(db, c.req.param("id"), c.get("player")!.id);
  if (game === null) return c.text("Not found", 404);

  const form = await c.req.parseBody();
  const tiers = await loadInviteOrder(db, game.id);
  const ownTierIds = new Set(
    tiers.map((tier) => tier.tierId).filter((tierId): tierId is string => tierId !== null),
  );

  const statements = [];

  for (const tier of tiers) {
    for (const member of tier.members) {
      const raw = form[`tier-${member.playerId}`];
      if (typeof raw !== "string") continue;
      const target = ownTierIds.has(raw) ? raw : null;
      if (target === tier.tierId) continue;
      statements.push(
        db
          .update(memberships)
          .set({ inviteTierId: target })
          .where(and(eq(memberships.gameId, game.id), eq(memberships.playerId, member.playerId))),
      );
    }
  }

  for (const tierId of ownTierIds) {
    const raw = form[`position-${tierId}`];
    if (typeof raw !== "string") continue;
    const position = Number.parseInt(raw, 10);
    // A blank or junk box leaves the tier where it is rather than sending it
    // to the front: `Number.parseInt("")` is NaN, and writing that would make
    // every ordering comparison false.
    if (!Number.isInteger(position) || position < 1) continue;
    statements.push(
      db
        .update(inviteTiers)
        .set({ position })
        .where(and(eq(inviteTiers.gameId, game.id), eq(inviteTiers.id, tierId))),
    );
  }

  // Same cast `updateGame` uses: D1's batch signature wants a non-empty
  // tuple, and the length check above is what actually guarantees it.
  if (statements.length > 0) {
    await db.batch(statements as [typeof statements[number], ...typeof statements]);
    // Only when something actually moved. A save that changed nothing owes no
    // reconcile, and firing one anyway would put a background task and its
    // reads behind every idle press of the button.
    await reconcileInviteOrder(c, db, game.id, new Date(Date.now()));
  }

  return c.redirect(inviteOrderPath(game.id), 303);
});

/** Add one named group to the end of the order (M34). */
gamesRoutes.post("/g/:id/invites/tier", requirePlayer, async (c) => {
  if (wrongOrigin(c)) return c.text("Forbidden", 403);

  const db = getDb(c.env.DB);
  const game = await findGameForOwner(db, c.req.param("id"), c.get("player")!.id);
  if (game === null) return c.text("Not found", 404);

  const form = await c.req.parseBody();
  const name = typeof form["name"] === "string" ? form["name"].trim() : "";
  if (name === "") {
    const tiers = await loadInviteOrder(db, game.id);
    return c.html(
      renderInviteOrderPage({
        nav: pageNav(c, "games"),
        gameId: game.id,
        gameName: game.name,
        squadSize: tiers.reduce((total, tier) => total + tier.members.length, 0),
        tiers: tiers.map((tier) => ({
          tierId: tier.tierId,
          name: tier.name,
          position: tier.position,
          members: tier.members.map((member) => ({ playerId: member.playerId, name: member.name })),
        })),
        problem: "Give the group a name.",
      }),
      422,
    );
  }

  const existing = await loadInviteOrder(db, game.id);
  // One past the highest stored position, so a new group lands last — which is
  // where an owner adding a fallback group almost always wants it, and is the
  // only placement that cannot displace an order they already set.
  const position =
    existing.reduce((highest, tier) => Math.max(highest, tier.position), 0) + 1;

  await db.insert(inviteTiers).values({
    id: crypto.randomUUID(),
    gameId: game.id,
    name: name.slice(0, 60),
    position,
  });

  return c.redirect(inviteOrderPath(game.id), 303);
});

/**
 * Delete one group, dropping its members to the implicit final tier.
 *
 * The membership update runs *before* the delete, in one batch: the column
 * holds a foreign key, so deleting first would leave rows pointing at a tier
 * that no longer exists.
 */
gamesRoutes.post("/g/:id/invites/tier/:tierId/delete", requirePlayer, async (c) => {
  if (wrongOrigin(c)) return c.text("Forbidden", 403);

  const db = getDb(c.env.DB);
  const game = await findGameForOwner(db, c.req.param("id"), c.get("player")!.id);
  if (game === null) return c.text("Not found", 404);

  const tierId = c.req.param("tierId");
  // Scoped by game id as well as tier id, so a tier belonging to another squad
  // can neither be probed nor deleted through this route (TR-18).
  const [tier] = await db
    .select({ id: inviteTiers.id })
    .from(inviteTiers)
    .where(and(eq(inviteTiers.gameId, game.id), eq(inviteTiers.id, tierId)));
  if (!tier) return c.text("Not found", 404);

  await db.batch([
    db
      .update(memberships)
      .set({ inviteTierId: null })
      .where(and(eq(memberships.gameId, game.id), eq(memberships.inviteTierId, tier.id))),
    db.delete(inviteTiers).where(eq(inviteTiers.id, tier.id)),
  ]);

  // Deleting a group drops its members into the implicit final tier, which on
  // a fixture whose order has fully run is already released — so this can
  // release people, and must reconcile for the same reason the save above
  // does. Adding a group cannot: a new tier is created empty at the end,
  // carries no stamps, and `releaseNext` steps over an empty tier, so there is
  // deliberately no such call on that route.
  await reconcileInviteOrder(c, db, game.id, new Date(Date.now()));

  return c.redirect(inviteOrderPath(game.id), 303);
});

/** "28 Aug 2026", in the game's own zone, or null for a live game (M41). */
function archivedOn(game: { archivedAt: Date | null; timezone: string }): string | null {
  return game.archivedAt === null ? null : formatLocalShortDate(game.archivedAt, game.timezone);
}

/**
 * `GET /g/:id/archive` (M41): the confirmation. Counts what archiving will
 * call off and who will be told, so the owner is agreeing to a specific
 * consequence rather than a verb. Owner-only and a 404 otherwise (TR-18).
 * An already-archived game 404s too: there is nothing left to confirm.
 */
gamesRoutes.get("/g/:id/archive", requirePlayer, async (c) => {
  const db = getDb(c.env.DB);
  const game = await findGameForOwner(db, c.req.param("id"), c.get("player")!.id);
  if (game === null || game.archivedAt !== null) return c.html(renderNotFoundPage(), 404);

  const pending = await db
    .select({ id: fixtures.id })
    .from(fixtures)
    .where(and(eq(fixtures.gameId, game.id), notInArray(fixtures.lifecycle, [...TERMINAL_LIFECYCLES])));
  const players = new Set<string>();
  for (const fixture of pending) {
    for (const recipient of await cancellationRecipients(db, fixture.id)) players.add(recipient.playerId);
  }

  return c.html(
    renderArchiveGamePage({
      nav: pageNav(c, "games"),
      gameId: game.id,
      gameName: game.name,
      upcomingCount: pending.length,
      playerCount: players.size,
    }),
  );
});

/**
 * `POST /g/:id/archive` (M41). The domain call does the cancelling and the
 * stamp; this sends N-3 for each fixture it called off, the same way
 * `/cancel` does for one — after the archive is durable, and wrapped, so a
 * mail failure cannot turn a completed archive into a 500. The N-3 dedupe
 * key is per (fixture, player), so a retry cannot double-mail.
 */
gamesRoutes.post("/g/:id/archive", requirePlayer, async (c) => {
  if (wrongOrigin(c)) return c.text("Forbidden", 403);
  const now = new Date(Date.now());
  const db = getDb(c.env.DB);
  const player = c.get("player")!;

  const game = await findGameForOwner(db, c.req.param("id"), player.id);
  if (game === null) return c.html(renderNotFoundPage(), 404);

  const result = await archiveGame(db, { gameId: game.id, actorPlayerId: player.id, now });
  if (!result.archived) return c.html(renderNotFoundPage(), 404);

  for (const { fixture, recipients } of result.cancelled) {
    if (recipients.length === 0) continue;
    try {
      await sendCancellationEmails({
        db,
        notifier: createNotifier(c.env, db, now),
        fixture,
        game,
        recipients,
        reason: "",
        now,
        responseTokenSecret: c.env.RESPONSE_TOKEN_SECRET,
      });
    } catch (error) {
      console.error(`archive ${game.id}: N-3 for fixture ${fixture.id} failed`, error);
    }
  }

  return c.redirect(gamePath(game.id), 303);
});

/** `POST /g/:id/unarchive` (M41). Exempt from the archived-game guard by name. */
gamesRoutes.post("/g/:id/unarchive", requirePlayer, async (c) => {
  if (wrongOrigin(c)) return c.text("Forbidden", 403);
  const now = new Date(Date.now());
  const db = getDb(c.env.DB);
  const player = c.get("player")!;

  const result = await unarchiveGame(db, { gameId: c.req.param("id"), actorPlayerId: player.id, now });
  if (!result.unarchived) return c.html(renderNotFoundPage(), 404);
  return c.redirect(gamePath(c.req.param("id")), 303);
});

gamesRoutes.get("/g/:id/edit", requirePlayer, async (c) => {
  const now = new Date(Date.now());
  const db = getDb(c.env.DB);
  const game = await findGameForOwner(db, c.req.param("id"), c.get("player")!.id);
  // An archived game has nothing to edit (M41); its POST is refused by the
  // guard in `src/app.ts`, and a form whose submit will 404 is worse than
  // the 404 itself.
  if (game === null || game.archivedAt !== null) return c.text("Not found", 404);

  const counts = await countFixturesByPropagation(db, game.id, now);
  const rule = parseRecurrenceRule(game.recurrenceRule);
  const settings = await loadNotificationSettings(db, [game.id]);

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
        resultPromptOffsetHours: String(game.resultPromptOffsetHours),
        gatedInvitesEnabled: game.gatedInvitesEnabled ? "on" : "",
        gatedFallbackHoursBefore:
          game.gatedFallbackHoursBefore === null
            ? GATED_FALLBACK_NEVER
            : String(game.gatedFallbackHoursBefore),
      },
      errors: [],
      warnings: [],
      showAdvanced: true,
      // Without this the "Edit the invite order" link has no game to point at
      // and the whole gating section renders as if the feature did not exist.
      gameId: game.id,
      affectedNotice: propagationNotice(counts),
      notifications: ownerNotificationRows(game.id, settings),
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
    const settings = await loadNotificationSettings(db, [game.id]);

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
        // Same reason as the GET: without it the redisplayed form loses its
        // gating section, so an unrelated validation error would look like the
        // feature had been switched off.
        gameId: game.id,
        affectedNotice: propagationNotice(counts),
        // Built from the stored settings, exactly as the GET is — a validation
        // failure elsewhere on the form does not touch the notifications
        // matrix, whose own submission is applied separately below.
        notifications: ownerNotificationRows(game.id, settings),
      }),
      422,
    );
  }

  await updateGame({ db, game, values: parsed.values, actorPlayerId: c.get("player")!.id, now });
  await saveOwnerNotificationSettings(db, game.id, parseNotificationCells(form));

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

  // The same game-scoped presence query the overview runs, and the one row out
  // of it that matters here (M52). Reused rather than given a per-player
  // variant: it is one round trip either way, and two queries answering the
  // same question are how the row and the page it links to come to disagree —
  // which is what the M52 review found, in the other direction.
  const now = new Date(Date.now());
  const presence = (await getSquadPresence(getDb(c.env.DB), target.game.id, now)).find(
    (row) => row.playerId === target.member.playerId,
  );

  return c.html(
    renderSquadMemberPage({
      nav: pageNav(c, "games"),
      gameId: target.game.id,
      gameName: target.game.name,
      signals:
        presence === undefined
          ? undefined
          : squadSignals(
              {
                isGuest: target.member.isGuest,
                lastSeenAt: presence.lastSeenAt,
                lastAnsweredAt: presence.lastAnsweredAt,
                lastStandaloneAt: presence.lastStandaloneAt,
                pushDevices: presence.pushDevices,
                deliveryFailing: presence.deliveryFailing,
              },
              now,
            ),
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
  const notificationSettings = await loadNotificationSettings(db, [game.id]);
  return {
    nav,
    gameId: game.id,
    inviteToken: game.inviteToken,
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
    // M26. The picker says publishing emails the squad, and for a game with
    // that switch off it does not — an organiser reading the unqualified
    // sentence would believe the squad had been told.
    teamsEmailEnabled: notificationSettings.isEnabled(game.id, "n9", "email"),
    // M29. Absent once the fixture has stopped taking changes: there is
    // nothing to hand over on a game that has been played or called off, so
    // the control would be an act with no effect.
    picker: takingChanges(
      fixtureView(
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
    )
      ? {
          mode: effectiveMode(fixture),
          delegatePlayerId: fixture.teamPickerPlayerId,
          handedOverOnLocal:
            fixture.teamPickerSetAt === null
              ? undefined
              : formatLocalDate(fixture.teamPickerSetAt, game.timezone),
          // The squad minus guests (who cannot sign in) and minus the
          // organiser themselves, whose "Just me" is already the first
          // radio — offering their own name under "hand it to" would be two
          // controls for one state.
          candidates: (await listSquad(db, game.id))
            .filter((member) => !member.isGuest && member.playerId !== viewerPlayerId)
            .map((member) => ({ playerId: member.playerId, name: member.name })),
        }
      : undefined,
    cancellationReason: fixture.cancellationReason,
    result,
    // M34. Only a gated Game, and only while the fixture is still taking
    // answers: a played or cancelled fixture releases nothing, so a panel
    // offering to invite the next group would be a control with no effect.
    gatedInvites: game.gatedInvitesEnabled,
    inviteProgress:
      game.gatedInvitesEnabled && fixture.lifecycle === "open"
        ? await inviteProgressParams(db, game, fixture)
        : undefined,
    // `inviteProgressParams` returns undefined of its own accord when no
    // order is running on this fixture — see its comment.
    ...extras,
  };
}

/**
 * The owner's invite-progress panel for one open, gated fixture (M34).
 *
 * A tier counts as asked when **any** of its members carries a stamp, and the
 * time shown is the earliest of them. Reading the earliest rather than the
 * latest is what keeps the line stable: a member backfilled into an
 * already-released tier days later (BR-2′) is stamped when they join, and
 * showing the latest would make the tier look as though it had been asked
 * again.
 */
async function inviteProgressParams(
  db: Db,
  game: typeof games.$inferSelect,
  fixture: typeof fixtures.$inferSelect,
): Promise<InviteProgressParams | undefined> {
  const tiers = await loadInviteOrder(db, game.id, fixture.id);

  // Nothing stamped means the invite order is not running on this fixture —
  // either it opened and was mailed before gating was switched on (the Durable
  // Object then refuses to release, `already-invited`), or it has not reached
  // its reminder instant yet. Either way a panel would report every tier as
  // "held" and offer a button that releases nothing, which is worse than no
  // panel: it describes a gate that is not there.
  if (!tiers.some((tier) => tier.members.some((member) => member.invitedAt !== null))) {
    return undefined;
  }

  const rendered = tiers.map((tier) => {
    const stamps = tier.members
      .map((member) => member.invitedAt)
      .filter((invitedAt): invitedAt is Date => invitedAt !== null);
    const askedAt =
      stamps.length === 0
        ? null
        : stamps.reduce((earliest, stamp) => (stamp < earliest ? stamp : earliest));
    return {
      name: tier.name,
      askedAtLocal: askedAt === null ? null : formatLocalDateTime(askedAt, game.timezone),
      inCount: tier.members.filter((member) => member.status === "in").length,
      outCount: tier.members.filter((member) => member.status === "out").length,
      waitingCount: tier.members.filter((member) => member.status === "waitlisted").length,
      memberCount: tier.members.length,
    };
  });

  const nextIndex = rendered.findIndex((tier) => tier.askedAtLocal === null);

  return {
    gameId: game.id,
    fixtureId: fixture.id,
    tiers: rendered,
    // The sentence the panel exists for. Null when the owner has switched the
    // fallback off, in which case the held tiers really do wait for a decline
    // and saying otherwise would be a promise the sweep never keeps.
    fallbackNote:
      game.gatedFallbackHoursBefore === null
        ? null
        : `asked automatically at ${game.gatedFallbackHoursBefore}h before, if still short`,
    canReleaseNext: nextIndex !== -1,
    nextTierName: nextIndex === -1 ? null : (rendered[nextIndex]?.name ?? null),
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
  if (game === null) return c.html(renderNotFoundPage(), 404);
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

  // Only a `played` fixture has anything to have a result about — the same
  // gate `ownerResultParams` uses on the organiser's page, and spec §15
  // excludes `open`, `scheduled` and `cancelled` fixtures from results
  // entirely (M25 review fix, I1). Before this fix the panel was built
  // unconditionally and an upcoming or cancelled fixture rendered "No result
  // recorded yet" about a game that had not happened, or never would.
  const result =
    fixture.lifecycle === "played"
      ? await (async () => {
          const [claims, electorate] = await Promise.all([
            listResultClaims(db, fixtureId),
            resultElectorate(db, game.id, fixtureId),
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
            actionPath: resultPath(game.id, fixtureId),
            clearPath: resultClearPath(game.id, fixtureId),
          };
        })()
      : undefined;

  // Not on a fixture that is over or off, matching `/r/:token`: those pages
  // are a record of one evening, and the switch belongs where a reader is
  // still deciding something.
  const mute =
    fixture.lifecycle === "played" || fixture.lifecycle === "cancelled"
      ? null
      : await muteStateFor(db, game.id, viewerPlayerId, now);

  // Two questions in one read: is an invite order running on this fixture at
  // all, and has this viewer been reached by it.
  //
  // Both are needed. A fixture mailed before gating was switched on carries no
  // stamps at all (BR-46), so testing the viewer's own row alone would tell the
  // whole squad they had not been asked while every one of them held the
  // invitation. `invited_at` is written only by the reconciler and never
  // cleared, so one stamp anywhere is proof the order has taken hold here.
  //
  // Read here rather than widened onto `SquadMember`, which is threaded through
  // the owner page, the dashboard and the picker: none of those ask this.
  const inviteRows = game.gatedInvitesEnabled
    ? await db
        .select({ playerId: responses.playerId, invitedAt: responses.invitedAt })
        .from(responses)
        .where(eq(responses.fixtureId, fixtureId))
    : [];
  // `inviteGateApplies` rather than a bare "is anything stamped": since M43
  // the order governs who may take a slot, and it does so from the moment the
  // fixture opens — including the window before the first tier is released,
  // when nothing is stamped yet and a player would otherwise be waitlisted
  // with no explanation on the page.
  const orderIsRunning = await inviteGateApplies(db, {
    fixtureId,
    gatedInvitesEnabled: game.gatedInvitesEnabled,
    anyStamped: inviteRows.some((row) => row.invitedAt !== null),
  });
  const viewerInvited =
    inviteRows.find((row) => row.playerId === viewerPlayerId)?.invitedAt != null;

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
      result,
      fixturePath: fixturePath(game.id, fixtureId),
      // M29. Only while the fixture is still taking changes: a link to a
      // picker that can no longer save anything is a dead end. `mayPick` is
      // asked here rather than the mode being read directly, so this link and
      // `loadPickerTarget` cannot disagree about who may follow it.
      picker:
        takingChanges(fixtureView(fixture, now)) && mayPick(fixture, viewerPlayerId)
          ? {
              // Narrowed from `PickerMode`: `organiser` cannot reach here,
              // because `mayPick` is false for everyone in that mode and this
              // render is only ever for a non-owner.
              mode: effectiveMode(fixture) === "delegate" ? "delegate" : "open",
              path: pickerPagePath(game.id, fixtureId),
            }
          : undefined,
      mute: mute === null ? undefined : muteControlsFor(game, mute),
      // M34, BR-40. Copy only — the viewer may still answer, and nothing on
      // this page is disabled on the strength of it.
      notYetInvited: orderIsRunning && !viewerInvited,
      // BR-40a: they answered, and the order is what they are waiting on.
      // Read off the squad row the page is already rendering rather than
      // queried again, so the paragraph and the roster beside it cannot
      // disagree about what this reader answered.
      heldByInviteOrder:
        orderIsRunning &&
        !viewerInvited &&
        withSquad.squad.find((member) => member.playerId === viewerPlayerId)?.status === "waitlisted",
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
      // M46. A promotion by hand jumps BR-6's strict arrival order, and
      // nothing else on this row would say so: an owner marking a pending
      // player in and an owner moving somebody past four people who have been
      // waiting longer produce the same `status: "in"`, and `before.status`
      // alone does not carry the rank that was skipped. Read from the
      // pre-write squad, because after the Durable Object returns the rank is
      // gone with the row.
      fromWaitlist: previous?.status === "waitlisted",
      waitlistRank: previous?.status === "waitlisted" ? (previous.waitlistRank ?? null) : null,
    },
    now,
  });

  // The same N-2 path a self-response takes, in the background, for the
  // reasons `notifyPromotedPlayer` documents. An override that frees a slot
  // promotes exactly as any other dropout does (BR-7).
  if (outcome.kind === "recorded" && outcome.promoted) {
    c.executionCtx.waitUntil(notifyPromotedPlayer(c.env, target.fixture.id, outcome.promoted, now));
  }

  // An owner marking somebody out owes a tier exactly as the player's own
  // decline does (BR-41) — the fixture does not care who pressed the button.
  if (intent === "out") {
    c.executionCtx.waitUntil(notifyReleasedSubs(c.env, target.fixture.id, now));
  }

  return c.redirect(fixturePath(target.game.id, target.fixture.id), 303);
});

/**
 * An owner adding a one-off guest to a fixture (§5). A guest never
 * waitlists — `whenFull` is `"refuse"` or `"exceed"` only — because a slot
 * held "maybe" for someone with no login and no address helps nobody.
 */
/**
 * One fixture's history, for its organiser (M46).
 *
 * Read-only, and built from `audit_log` and `notification_log` alone — the two
 * records that already exist and already decide nothing about this page. A
 * timeline with writes of its own would be a third record of the same events,
 * free to drift from the two that matter.
 *
 * Owner-only, and a refusal is a 404 (TR-18): the trail names who answered
 * what and when, which is more than a squad member is entitled to read about
 * everybody else.
 */
gamesRoutes.get("/g/:id/f/:fixtureId/timeline", requirePlayer, async (c) => {
  const target = await loadFixtureTarget(c, c.req.param("id"), c.req.param("fixtureId"));
  if (target === null) return c.text("Not found", 404);

  const { db, game, fixture } = target;

  const auditRows = await db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.entityType, "fixture"), eq(auditLog.entityId, fixture.id)))
    .orderBy(desc(auditLog.createdAt));

  const notificationRows = await db
    .select()
    .from(notificationLog)
    .where(eq(notificationLog.fixtureId, fixture.id));

  // One lookup for every id either record mentions, rather than a join on each
  // — an actor is not always in this fixture's squad (an organiser who never
  // answered, a player since removed), so the squad query cannot serve as the
  // name source.
  const ids = [
    ...new Set([
      ...auditRows.flatMap((row) => (row.actorPlayerId === null ? [] : [row.actorPlayerId])),
      ...auditRows.flatMap((row) => {
        const after = row.afterJson === null ? null : (JSON.parse(row.afterJson) as { playerId?: unknown });
        return typeof after?.playerId === "string" ? [after.playerId] : [];
      }),
      ...notificationRows.map((row) => row.playerId),
    ]),
  ];
  const nameRows =
    ids.length === 0
      ? []
      : await db
          .select({ id: players.id, name: players.name, erasedAt: players.erasedAt })
          .from(players)
          .where(inArray(players.id, ids));
  const byId = new Map(nameRows.map((row) => [row.id, displayName(row.name, row.erasedAt)]));

  const entries = buildTimeline({
    audit: auditRows.map((row) => ({
      action: row.action,
      actorPlayerId: row.actorPlayerId,
      before: row.beforeJson === null ? null : JSON.parse(row.beforeJson),
      after: row.afterJson === null ? null : JSON.parse(row.afterJson),
      createdAt: row.createdAt,
    })),
    notifications: notificationRows.map((row) => ({
      notificationType: row.notificationType,
      playerId: row.playerId,
      channel: row.channel,
      status: row.status,
      sentAt: row.sentAt,
      createdAt: row.createdAt,
    })),
    names: (playerId) => byId.get(playerId) ?? null,
  });

  return c.html(
    renderTimelinePage({
      nav: pageNav(c, "games"),
      gameId: game.id,
      fixtureId: fixture.id,
      gameName: game.name,
      kicksOffAtLocal: formatLocalDateTime(fixture.kicksOffAt, game.timezone),
      entries: entries.map((entry) =>
        // Day and time apart (M52): the page groups by day and prints the
        // date once over each group, so a run of entries sharing an instant no
        // longer stacks the same date three times above the events.
        toRenderable(
          entry,
          formatLocalDate(entry.at, game.timezone),
          formatLocalTime(entry.at, game.timezone),
        ),
      ),
    }),
  );
});

/**
 * The owner's "open it now" button on a scheduled fixture (M46, BR-11).
 *
 * Opening fixes the eligible set at this instant (BR-1), so pressing this a
 * week early asks the squad as it stands a week early — that is the point of
 * the button, and `openFixture` is the one place that rule lives.
 *
 * **It does not send the day-before reminder, and must not start.** N-1 is
 * capped at one per player per fixture (BR-18) and step 2 of the sweep keys
 * off the reminder instant rather than off `opened_at`; a route that sent it
 * here would spend that one message days early and leave the fixture silent
 * from now until kickoff (see `openAndRemind`). What it does do is run the
 * gated release path, which for a gated Game invites the first tier at once —
 * an existing message on an existing dedupe key, not a second N-1 — and for an
 * ungated Game claims nothing and sends nobody anything.
 *
 * The lifecycle guard is `openFixture`'s own: a second press, or a press on a
 * cancelled fixture, returns `opened: false` and this handler writes neither
 * an audit row nor a send. So the redirect is unconditional and the button's
 * absence on an already-open page is presentation, not enforcement.
 */
gamesRoutes.post("/g/:id/f/:fixtureId/open", requirePlayer, async (c) => {
  if (wrongOrigin(c)) return c.text("Forbidden", 403);

  const target = await loadFixtureTarget(c, c.req.param("id"), c.req.param("fixtureId"));
  if (target === null) return c.text("Not found", 404);

  const now = new Date(Date.now());
  // `openFixture` writes the `fixture.opened` audit row itself, taking the
  // actor — so an early open and the sweep's are distinguishable without this
  // handler having to remember.
  const result = await openFixture(target.db, target.fixture.id, now, c.get("player")!.id);

  if (result.opened) c.executionCtx.waitUntil(notifyReleasedSubs(c.env, target.fixture.id, now));

  return c.redirect(fixturePath(target.game.id, target.fixture.id), 303);
});

/**
 * The owner's "invite the next group now" button (M34).
 *
 * `force: true`, so BR-43's veto does not apply: the owner is looking at the
 * numbers and has decided anyway, and a button that silently did nothing when
 * the fixture happened to be full would be worse than no button.
 *
 * The send goes through the same `notifyReleasedSubs` a decline uses, in a
 * `waitUntil` for the same reason — and with the same guarantee behind it, so
 * a failed send here is picked up by the next sweep tick rather than lost.
 */
gamesRoutes.post("/g/:id/f/:fixtureId/invite/next", requirePlayer, async (c) => {
  if (wrongOrigin(c)) return c.text("Forbidden", 403);

  const target = await loadFixtureTarget(c, c.req.param("id"), c.req.param("fixtureId"));
  if (target === null) return c.text("Not found", 404);

  const now = new Date(Date.now());
  c.executionCtx.waitUntil(
    notifyReleasedSubs(c.env, target.fixture.id, now, {
      force: true,
      actorPlayerId: c.get("player")!.id,
    }),
  );

  return c.redirect(fixturePath(target.game.id, target.fixture.id), 303);
});

/**
 * The owner's "invite now" button on one player's row (M46).
 *
 * The single-player counterpart to `invite/next`, and deliberately not built
 * on it: releasing a tier to reach one sub asks everybody else in that tier
 * too, and the case this exists for is the organiser who wants one specific
 * person and not the four behind them.
 *
 * Registered **before** `/invite/next` cannot matter — the paths differ past
 * the third segment — but the two must stay distinguishable to a reader, so
 * the player id sits under `/invite/player/` rather than directly under
 * `/invite/`.
 *
 * The send mirrors the release path: an `n1` on the same dedupe key through
 * `sendLateInvitations`, so the sweep's own reminder later skips this player
 * rather than mailing them twice (BR-18). A player the stamp *promoted* off
 * the gate waitlist gets the N-2 instead — they answered this question days
 * ago and an N-1 would contradict the answer.
 */
gamesRoutes.post("/g/:id/f/:fixtureId/invite/player/:playerId", requirePlayer, async (c) => {
  if (wrongOrigin(c)) return c.text("Forbidden", 403);

  const target = await loadFixtureTarget(c, c.req.param("id"), c.req.param("fixtureId"));
  if (target === null) return c.text("Not found", 404);

  const playerId = c.req.param("playerId");
  const now = new Date(Date.now());

  const outcome = await c.env.FIXTURE_CAPACITY.getByName(target.fixture.id).inviteIndividually({
    playerId,
    now: now.getTime(),
  });

  if (outcome.kind === "invited" && outcome.stamped) {
    await recordAudit(target.db, {
      actorPlayerId: c.get("player")!.id,
      entityType: "fixture",
      entityId: target.fixture.id,
      action: "fixture.invited_individually",
      after: { playerId },
      now,
    });
  }

  if (outcome.kind === "invited") {
    const env = c.env;
    const promoted = outcome.promoted;
    const owed = outcome.owedInvitation;
    c.executionCtx.waitUntil(
      (async () => {
        // Sequential, not concurrent: every send passes through the same daily
        // ceiling (TR-31), and firing them together is how a batch races
        // itself past it.
        for (const promotion of promoted) {
          await notifyPromotedPlayer(env, target.fixture.id, promotion, now);
        }
        if (!owed) return;
        const db = getDb(env.DB);
        await sendLateInvitations({
          db,
          notifier: createNotifier(env, db, now),
          playerId,
          fixtureIds: [target.fixture.id],
          responseTokenSecret: env.RESPONSE_TOKEN_SECRET,
          now,
        });
      })(),
    );
  }

  return c.redirect(fixturePath(target.game.id, target.fixture.id), 303);
});

/**
 * The add-a-guest page (M52). A GET that renders and writes nothing; the POST
 * below is unchanged and is still what adds the guest.
 *
 * It carries the places-left figure because this is the last screen before the
 * write, and going over the limit is allowed rather than refused (BR-8) — so
 * the page says what will happen instead of standing in the way.
 */
gamesRoutes.get("/g/:id/f/:fixtureId/guest/add", requirePlayer, async (c) => {
  const target = await loadFixtureTarget(c, c.req.param("id"), c.req.param("fixtureId"));
  if (target === null) return c.html(renderNotFoundPage(), 404);

  const left = target.fixture.maxPlayers - target.fixture.inCount;

  return c.html(
    renderAddGuestPage({
      nav: pageNav(c, "games"),
      gameId: target.game.id,
      fixtureId: target.fixture.id,
      gameName: target.game.name,
      kicksOffAtLocal: formatLocalDateTime(target.fixture.kicksOffAt, target.game.timezone),
      spotsLeft: left > 0 ? left : null,
    }),
  );
});

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
 * The game and fixture behind a `/g/:id/f/:fixtureId` path for somebody who
 * may **pick the teams** on it (M29) — the owner, or a member the fixture's
 * mode allows.
 *
 * The deliberately wider sibling of `loadFixtureTarget`, and the only wider
 * one in the application. Exactly three routes use it: the picker page, the
 * save and the publish. Every other route under `/g/:id` keeps
 * `loadFixtureTarget` and its owner-only check, and
 * `test/routes/picker-entitlement.test.ts` walks Hono's own route table to
 * hold that line — a fourth route reaching for this loader fails that test
 * until somebody says in writing that it should.
 *
 * The two halves are asked separately and in this order: *are you an active
 * member of this game* (`findGameForOwner`, else `findGameForMember`), then
 * *does this fixture's mode let you pick*. Keeping membership as the outer
 * question is what makes a delegate who leaves the squad stop passing the
 * instant they are removed, with no sweep over their future fixtures to clear
 * the pointer they left behind.
 *
 * `null` for every refusal — no such game, not a member, no such fixture, a
 * fixture of another game, a mode that does not name you — and the caller
 * answers 404 to all of them (TR-18).
 */
async function loadPickerTarget(c: Context<AppEnv>, gameId: string, fixtureId: string) {
  const db = getDb(c.env.DB);
  const playerId = c.get("player")!.id;

  const asOwner = await findGameForOwner(db, gameId, playerId);
  const game = asOwner ?? (await findGameForMember(db, gameId, playerId));
  if (game === null) return null;

  const [fixture] = await db.select().from(fixtures).where(eq(fixtures.id, fixtureId));
  if (!fixture || fixture.gameId !== game.id) return null;

  if (asOwner === null && !mayPick(fixture, playerId)) return null;
  return { db, game, fixture, isOwner: asOwner !== null };
}

type PickerTarget = NonNullable<Awaited<ReturnType<typeof loadPickerTarget>>>;

/**
 * Render the standalone picker page for a loaded target.
 *
 * Every derived value comes from the same helpers the organiser's fixture
 * page uses — `fixtureView`, `sideCounts`, `teamsNeedAnotherLook`,
 * `announcementOutstanding` — so the two surfaces cannot disagree about
 * whether a pick has gone stale. `listTeamAssignments` rather than the
 * squad's rows for the two staleness predicates, because `getFixtureWithSquad`
 * filters `withdrawn` out and half the staleness question is about exactly
 * those rows (`src/domain/teams.ts`).
 */
async function renderPicker(
  c: Context<AppEnv>,
  target: PickerTarget,
  now: Date,
  extras: { problem?: string; unassignedProblem?: readonly string[] } = {},
  status: 200 | 422 = 200,
) {
  const [withSquad, assignments] = await Promise.all([
    getFixtureWithSquad(target.db, target.fixture.id),
    listTeamAssignments(target.db, target.fixture.id),
  ]);
  if (withSquad === null) return c.text("Not found", 404);

  const { fixture, game, squad } = withSquad;
  const playing = squad.filter((member) => member.status === "in");
  const counts = sideCounts(squad);
  const notificationSettings = await loadNotificationSettings(target.db, [game.id]);

  return c.html(
    renderPickerPage({
      nav: pageNav(c, "games"),
      gameId: game.id,
      fixtureId: fixture.id,
      gameName: game.name,
      venueName: game.venueName,
      kicksOffAtLocal: formatLocalDateTime(fixture.kicksOffAt, game.timezone),
      view: fixtureView(fixture, now),
      waitlistCount: fixture.waitlistCount,
      teamNames: teamNames(game),
      members: playing,
      counts,
      uneven: fixture.prefersEvenNumbers && counts.a !== counts.b,
      published: fixture.teamsPublishedAt !== null,
      needsAnotherLook: teamsNeedAnotherLook(assignments),
      announcementOutstanding: announcementOutstanding(fixture, assignments),
      teamsEmailEnabled: notificationSettings.isEnabled(game.id, "n9", "email"),
      // The owner is never barred from publishing, whatever the mode; the
      // restriction `mayPublish` carries is about members in `open` mode.
      canPublish:
        target.isOwner ||
        mayPublish(fixture, c.get("player")!.id, fixture.teamsPublishedAt),
      mode: effectiveMode(fixture),
      ...extras,
    }),
    status,
  );
}

/**
 * A refusal from one of the two picking POSTs, rendered on whichever page the
 * person who submitted it came from.
 *
 * The owner submitted from their fixture page, where the picker is a fragment
 * among the squad list and the guest form; everybody else submitted from the
 * standalone picker page. Sending either of them to the other's page would
 * answer a refusal with a screen they have not seen before, and in the
 * owner's case would drop the rest of the fixture out from under them.
 */
function renderPickingRefusal(
  c: Context<AppEnv>,
  target: PickerTarget,
  now: Date,
  extras: { problem?: string; unassignedProblem?: readonly string[] } = {},
) {
  if (target.isOwner) return renderOwnerFixture(c, target, now, extras, 422);
  return renderPicker(c, target, now, extras, 422);
}

/**
 * `GET /g/:id/f/:fixtureId/teams` (M29): the picker on a page of its own.
 *
 * The same path as the save `POST` below, one method up — see `pickerPagePath`
 * (`src/auth/paths.ts`) for why the page and the pick share a URL.
 *
 * Open to the owner as well as to a delegate, though the owner has no link to
 * it: one page fewer to keep in step than a version that 404s the person who
 * granted the capability, and an organiser who follows a delegate's link
 * should see what the delegate sees.
 */
gamesRoutes.get("/g/:id/f/:fixtureId/teams", requirePlayer, async (c) => {
  const target = await loadPickerTarget(c, c.req.param("id"), c.req.param("fixtureId"));
  if (target === null) return c.text("Not found", 404);
  return renderPicker(c, target, new Date(Date.now()));
});

/**
 * `POST /g/:id/f/:fixtureId/picker` (M29): the organiser choosing who picks
 * the teams on this fixture.
 *
 * Owner-only, through `loadFixtureTarget` like every other control on their
 * fixture page — a delegate may pick the teams, never hand the job on. That
 * boundary is enumerated in `test/routes/picker-entitlement.test.ts` rather
 * than asserted only here.
 *
 * The mode and the delegate are written in one statement so the pair cannot
 * be left disagreeing, and `team_picker_set_at` moves **only when the holder
 * actually changes**. Re-submitting the form unchanged therefore reuses the
 * same N-13 dedupe key and sends nothing, while a genuine re-delegation to
 * the same person after a spell in another mode gets a fresh key and does
 * send (see `pickerHandoverKey`).
 */
gamesRoutes.post("/g/:id/f/:fixtureId/picker", requirePlayer, async (c) => {
  if (wrongOrigin(c)) return c.text("Forbidden", 403);

  const target = await loadFixtureTarget(c, c.req.param("id"), c.req.param("fixtureId"));
  if (target === null) return c.text("Not found", 404);

  const now = new Date(Date.now());
  // The same gate the control renders behind: there is nothing to hand over
  // on a fixture that has been played or called off.
  if (!takingChanges(fixtureView(target.fixture, now))) {
    return renderOwnerFixture(c, target, now, { problem: "That fixture isn't taking changes any more." }, 422);
  }

  const form = await c.req.parseBody();
  const mode = form["mode"];
  // The value comes from a radio this application rendered, so anything else
  // is a hand-built request and gets a 400 rather than a guess — the same
  // treatment `POST /g/:id/squad/:playerId/role` gives an unknown role.
  if (!isPickerMode(mode)) {
    return c.text('Bad Request: "mode" must be one of organiser, delegate, open', 400);
  }

  let delegatePlayerId: string | null = null;
  if (mode === "delegate") {
    const chosen = typeof form["delegate"] === "string" ? form["delegate"] : "";
    // Re-asked against the database rather than trusted from the form (TR-18):
    // the select was rendered from the squad as it stood when the page loaded,
    // and a member can leave between then and now. A guest is refused for a
    // reason a stale form cannot produce but a hand-built request can — they
    // have no way to sign in, so the delegation would name somebody who could
    // never reach the picker.
    const member = await findMembershipInGame(target.db, target.game.id, chosen);
    if (member === null || !member.active || member.isGuest) {
      return renderOwnerFixture(
        c,
        target,
        now,
        { problem: "Pick somebody who is currently in the squad and can sign in." },
        422,
      );
    }
    delegatePlayerId = member.playerId;
  }

  const before = {
    mode: effectiveMode(target.fixture),
    delegate: target.fixture.teamPickerPlayerId,
  };
  const handedToSomebodyNew = delegatePlayerId !== null && delegatePlayerId !== before.delegate;
  // Kept at its old value when the holder has not changed, so a re-submitted
  // form does not mint a new dedupe key and re-send N-13. Cleared outright in
  // the two modes that have no holder, so a later delegation cannot inherit a
  // stale instant.
  const setAt = mode === "delegate" ? (handedToSomebodyNew ? now : target.fixture.teamPickerSetAt) : null;

  await target.db.batch([
    target.db
      .update(fixtures)
      .set({ pickerMode: mode, teamPickerPlayerId: delegatePlayerId, teamPickerSetAt: setAt })
      .where(eq(fixtures.id, target.fixture.id)),
    buildAuditInsert(target.db, {
      actorPlayerId: c.get("player")!.id,
      entityType: "fixture",
      entityId: target.fixture.id,
      action: "fixture.picker_changed",
      // BR-27's previous value. Both halves, because a mode without its
      // holder does not say who could pick.
      before,
      after: { mode, delegate: delegatePlayerId },
      now,
    }),
  ]);

  // Only a genuinely new holder is told, and only on whichever channels this
  // game and the administrator both leave switched on (M37). `setAt` is
  // non-null on this branch by construction — `handedToSomebodyNew` implies
  // `mode === "delegate"` — and is passed rather than re-read so the key
  // matches the row that was just written.
  if (handedToSomebodyNew && setAt !== null) {
    const settings = await loadNotificationSettings(target.db, [target.game.id]);
    const channels = {
      email: settings.isEnabled(target.game.id, "n13", "email"),
      push: settings.isEnabled(target.game.id, "n13", "push"),
    };
    // M37. The hand-over itself still happened — the delegate can already
    // pick — but with both channels off none is sent and no
    // `notification_log` row is written.
    if (channels.email || channels.push) {
      c.executionCtx.waitUntil(notifyPicker(c.env, target.fixture.id, delegatePlayerId!, setAt, now, channels));
    }
  }

  return c.redirect(fixturePath(target.game.id, target.fixture.id), 303);
});

/**
 * Send N-13 in the background, logging every non-success on one greppable
 * line.
 *
 * The `catch` is the one `notifyRemovedPlayer` carries and for the same
 * reason: a rejected promise inside a `waitUntil` resolves into nothing, and
 * a thrown D1 error here would otherwise vanish entirely.
 */
async function notifyPicker(
  env: AppEnv["Bindings"],
  fixtureId: string,
  playerId: string,
  setAt: Date,
  now: Date,
  channels: { email: boolean; push: boolean },
): Promise<void> {
  const who = `fixture ${fixtureId}, player ${playerId}`;
  try {
    const db = getDb(env.DB);
    const result = await sendPickerHandover({
      db,
      notifier: createNotifier(env, db, now),
      fixtureId,
      playerId,
      setAt,
      now,
      responseTokenSecret: env.RESPONSE_TOKEN_SECRET,
      channels,
    });
    if (result.kind === "failed") console.error(`n13 picker hand-over failed for ${who}: ${result.reason}`);
    if (result.kind === "deferred") {
      console.error(`n13 picker hand-over deferred by the daily ceiling for ${who}`);
    }
    // `console.log` rather than `error`: expected and permanent (BR-32)
    // rather than a fault. The route refuses a guest, so this is reachable
    // only through a member with no address on file.
    if (result.kind === "skipped-no-recipient") {
      console.log(`n13 picker hand-over skipped, no address, for ${who}`);
    }
  } catch (error) {
    console.error(
      `n13 picker hand-over threw for ${who}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
  }
}

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

  const target = await loadPickerTarget(c, c.req.param("id"), c.req.param("fixtureId"));
  if (target === null) return c.text("Not found", 404);

  const now = new Date(Date.now());
  const withSquad = await getFixtureWithSquad(target.db, target.fixture.id);
  if (withSquad === null) return c.text("Not found", 404);

  // The same predicate the picker renders behind, so a form that was on
  // screen when the fixture closed cannot save through the back of it.
  if (!takingChanges(fixtureView(target.fixture, now))) {
    return renderPickingRefusal(c, target, now, { problem: "That fixture isn't taking changes any more." });
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

  // Back to whichever page the form was on: the owner's fixture page carries
  // the picker as a fragment, so a redirect to the standalone page would move
  // them somewhere they never were.
  return c.redirect(
    target.isOwner
      ? fixturePath(target.game.id, target.fixture.id)
      : pickerPagePath(target.game.id, target.fixture.id),
    303,
  );
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
  const target = await loadPickerTarget(c, c.req.param("id"), c.req.param("fixtureId"));
  if (target === null) return c.text("Not found", 404);

  const now = new Date(Date.now());

  // Check 2: still open. The same predicate the picker and the save route use.
  if (!takingChanges(fixtureView(target.fixture, now))) {
    return renderPickingRefusal(c, target, now, { problem: "That fixture isn't taking changes any more." });
  }

  // Check 2a (M29): may *this* picker announce, as opposed to merely save?
  // Only ever false for a member picking in `open` mode on a fixture whose
  // teams have already gone out — `mayPublish` (src/domain/picker.ts) holds
  // the reasoning. Their page renders no Publish button in that state, so
  // reaching here means a form that was on screen before somebody else
  // published; a 422 on the page they are looking at explains that, where a
  // 404 would read as the fixture having vanished.
  if (!target.isOwner && !mayPublish(target.fixture, c.get("player")!.id, target.fixture.teamsPublishedAt)) {
    return renderPickingRefusal(c, target, now, {
      problem: "These teams have already been sent out. The organiser sends the squad any changes from here on.",
    });
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
    return renderPickingRefusal(
      c,
      target,
      now,
      // The names, not the count: "3 players still need a side" sends an
      // organiser back to count fourteen radio groups by hand. An empty squad
      // has no names to give, and gets the sentence the picker already renders
      // in that case instead.
      { unassignedProblem: unassigned.map((row) => nameOf.get(row.playerId) ?? "someone who has since left") },
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
  const settings = await loadNotificationSettings(target.db, [target.game.id]);
  const channels = {
    email: settings.isEnabled(target.game.id, "n9", "email"),
    push: settings.isEnabled(target.game.id, "n9", "push"),
  };
  // M37. The publish itself still happened — `teams_published_at` is set
  // above and players can see their side — but with both channels off none
  // is sent and no `notification_log` row is written.
  if (channels.email || channels.push) {
    c.executionCtx.waitUntil(publishTeams(c.env, target.fixture.id, now, channels));
  }

  // Back to the page the form was on, as the save route does and for the same
  // reason.
  return c.redirect(
    target.isOwner
      ? fixturePath(target.game.id, target.fixture.id)
      : pickerPagePath(target.game.id, target.fixture.id),
    303,
  );
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
async function publishTeams(
  env: AppEnv["Bindings"],
  fixtureId: string,
  publishedAt: Date,
  channels: { email: boolean; push: boolean },
): Promise<void> {
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
      channels,
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
  const [squad, upcoming, lastResult, tally] = await Promise.all([
    squadForOverview(db, game.id, now),
    listUpcomingFixtures(db, game.id, now),
    lastResultFor(db, game, now),
    squadLeagueTally(db, game.id),
  ]);
  return c.html(
    renderGameOverviewPage({
      // A refusal must show the page a normal load would, standings included
      // — an owner who hit J6a's invariant should not also lose their table.
      standings: standingsForViewer(game, buildLeagueTable(tally), { isOwner: true }),
      nav: pageNav(c, "games"),
      gameId: game.id,
      gameName: game.name,
      venueName: game.venueName,
      venueAddress: game.venueAddress,
      timezone: game.timezone,
      maxPlayers: game.maxPlayers,
      prefersEvenNumbers: game.prefersEvenNumbers,
      inviteToken: game.inviteToken,
      archivedOn: archivedOn(game),
      squad,
      upcoming,
      lastResult,
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
    // Expected and permanent (M37), not a fault: the administrator has
    // turned N-7 off on every channel.
    if (result.kind === "switched-off") console.log(`n7 removal email switched off by the administrator for ${who}`);
  } catch (error) {
    console.error(
      `n7 removal email threw for ${who}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
  }
}

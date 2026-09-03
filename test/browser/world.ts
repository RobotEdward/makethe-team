import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import type { Browser, Page } from "@playwright/test";
import {
  joinTokenExpiry,
  leaveTokenExpiry,
  signCancelToken,
  signJoinToken,
  signLeaveToken,
  signResponseToken,
} from "../../src/domain/token.js";
import { toLocalParts } from "../../src/domain/time/zone.js";
import { BASE_URL } from "../../playwright.config.js";
import { signIn, TEST_OWNER, TEST_PLAYER } from "./sign-in.js";

const run = promisify(execFile);

/**
 * The secret `playwright.config.ts` starts `wrangler dev` with. The harness
 * knows it, so it can mint the same response links the reminder emails carry
 * — `ConsoleNotifier` never logs a URL, and there is no other way to reach
 * `/r/:token` from outside an inbox.
 */
const RESPONSE_SECRET = "local-browser-tests-only-not-a-real-secret";

/**
 * Matches `test/browser/browser.env` CANCEL_TOKEN_SECRET. Must be distinct from
 * RESPONSE_SECRET: src/env.ts deliberately keeps the two apart as a security
 * boundary, so a leaked response key cannot forge fixture cancellations. This
 * suite exercises that separation only through the kind discriminator baked
 * into signed payloads; the different secrets make it a true boundary.
 */
const CANCEL_SECRET = "local-browser-tests-only-not-a-real-cancel-secret";

const WEEKDAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;

/**
 * The zone every game in this suite is in. `/g/new` has no timezone field and
 * `src/domain/game-form.ts` defaults to Europe/London, so a weekday or an hour
 * read from the machine's clock is the wrong weekday or hour for a contributor
 * outside that zone: at 14:00 in New York the form would be told 16:00, which
 * London has already passed, and no fixture would ever open.
 */
const GAME_ZONE = "Europe/London";

/**
 * The weekday code for the day `days` after the London date `now` falls on.
 *
 * The calendar day is incremented rather than 24 hours added: across a
 * spring-forward, `now + 24h` is the day after tomorrow's local reading in the
 * hour that goes missing.
 */
function londonWeekdayCode(now: Date, days: number): string {
  const parts = toLocalParts(now, GAME_ZONE);
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return WEEKDAY_CODES[shifted.getUTCDay()]!;
}

/**
 * A weekday and kickoff time chosen so the first materialised fixture is
 * always open by the time the sweep runs, whatever the hour.
 *
 * A fixture opens when its reminder instant — 09:00 the day before kickoff —
 * has passed and it has not yet ended. A fixed weekday and a fixed 19:00 (the
 * form's default) therefore only work in the ~35 hours between Wednesday
 * 09:00 and Thursday 20:00; outside that window the first fixture is up to a
 * week away and stays `scheduled` forever, and every test that needs an open
 * fixture fails. The suite passed for days on the luck of when it was run.
 *
 * Before 21:00 in the game's zone, kick off two hours from now on that zone's
 * weekday: the reminder instant was 09:00 yesterday, and the fixture has not
 * ended. After 21:00, two hours from now would cross midnight and land in the
 * past, so use tomorrow at noon, whose reminder instant was 09:00 today.
 *
 * Every reading is taken in `GAME_ZONE`, never in machine local time — see the
 * note there.
 */
export function imminentSlot(now: Date): { weekday: string; kickoffTime: string } {
  const hour = toLocalParts(now, GAME_ZONE).hour;
  if (hour < 21) {
    return {
      weekday: londonWeekdayCode(now, 0),
      kickoffTime: `${String(hour + 2).padStart(2, "0")}:00`,
    };
  }
  return { weekday: londonWeekdayCode(now, 1), kickoffTime: "12:00" };
}

/** The joined member's display name, asserted on by the journeys. */
export const JOINER_NAME = "Alex Morgan";

export interface World {
  gameId: string;
  fixtureId: string;
  inviteToken: string;
  /**
   * M39 (BR-48/BR-50): a confirmation-link token for an address that has
   * never joined anything, minted directly rather than mailed — there is no
   * inbox to read it from — and never consumed by this harness. The
   * "join-confirm" catalogue entry is a `GET`, which BR-50 requires to write
   * nothing, so capturing it must not exercise the `POST` that would seat
   * this address and leave nothing for a real click to do.
   */
  freshJoinToken: string;
  /** The joined member — the one the squad-management pages act on. */
  memberPlayerId: string;
  responseToken: string;
  /** For the joined member, in the seeded game — see the "leave" catalogue entry. */
  leaveToken: string;
  ownerPlayerId: string;
  cancelToken: string;
  /**
   * A second game of the same owner's, whose open fixture is full and has
   * people waiting and a guest on it (M52). `owner-fixture` and `team-picker`
   * are captured here rather than on the thin fixture above, which showed
   * neither density nor any of the controls that only appear with it.
   */
  busyGameId: string;
  busyFixtureId: string;
}

/**
 * D1 access via the supported path (see `sign-in.ts` for why this shells out
 * rather than opening the database directly), used for both reads and
 * direct writes (a legacy row `seedWorld` cannot produce through the app,
 * `result.spec.ts` and `push.spec.ts`'s own fixture rows). Every value
 * interpolated into a `sql` string here is a locally generated UUID or a
 * hard-coded literal, never attacker- or user-supplied text — this is test
 * setup, not a request handler, so there is nothing here for injection to
 * exploit; `wrangler d1 execute --command` also has no bound-parameter form
 * to use instead.
 */
async function query<T>(sql: string): Promise<T[]> {
  // Retried on SQLITE_BUSY, and only on that. This runs as a separate process
  // against the same local SQLite file the worker is using, so a read issued
  // just after a cron sweep is triggered can land while that sweep is still
  // writing — `database is locked`, from the CLI rather than from anything the
  // app did. Seen once the M52 world started verifying its own seed
  // immediately after the hourly cron. Any other failure is raised at once:
  // a syntax error retried three times is just a slower syntax error.
  for (let attempt = 0; ; attempt++) {
    try {
      const { stdout } = await run(
        "npx",
        ["wrangler", "d1", "execute", "makethe-team", "--local", "--json", "--command", sql],
        { cwd: process.cwd(), maxBuffer: 4 * 1024 * 1024 },
      );
      const start = stdout.indexOf("[");
      if (start === -1) throw new Error(`unexpected wrangler output:\n${stdout}`);
      return (JSON.parse(stdout.slice(start)) as { results?: T[] }[])[0]?.results ?? [];
    } catch (error) {
      const busy = /database is locked|SQLITE_BUSY/.test(
        error instanceof Error ? error.message : String(error),
      );
      if (!busy || attempt >= 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
}

/**
 * Give a game a season behind it: played fixtures with sides picked and a
 * result everybody agreed (M52).
 *
 * Without this the two newest features in the product photograph as nothing.
 * `Your record` and `Standings` both read `fixture_results` joined to a
 * `responses` row that has a `team` on it, so a world with no settled,
 * *sided* history renders them as empty strings — which is exactly how they
 * reached production unlooked-at, and how three separate design reviewers came
 * to judge a page with the feature missing from it. Five findings in that
 * review turned out to be artefacts of a world too thin to show the thing
 * being reviewed.
 *
 * Written as rows rather than driven through the app, unlike the rest of this
 * harness, and the reason is the clock. A fixture becomes `played` only by
 * being retired after its kickoff, and its result only materialises once a
 * 48-hour window has closed — so producing this through the UI would mean
 * three weeks of wall time. Backdating is the one thing the app has no surface
 * for, which is the same exemption `seedWorld` already takes for the legacy
 * membership below.
 *
 * The rows are still consistent with what the app would have written: every
 * result has claims behind it, and the hourly cron is what turns those into
 * the cache row, so nothing here asserts an outcome the sweep would not derive.
 */
async function seedMatchHistory(
  page: Page,
  gameId: string,
  /** Everyone who played, in the order their sides alternate. */
  squad: readonly string[],
): Promise<void> {
  // Four weeks, oldest first, with the sides written out per fixture rather
  // than fixed per player. Three players alternating fixed sides finish level
  // on points however the results fall, and a league table where everyone is
  // level does not illustrate a league table — the same objection that got two
  // screenshots of all-nought tables thrown out of the guide in M51. These
  // sides give a clear leader, a clear bottom, and one draw.
  //
  // `sides` is index-aligned to `squad`.
  const HISTORY = [
    { daysAgo: 28, outcome: "a", scoreA: 3, scoreB: 1, sides: ["a", "b", "b"] },
    { daysAgo: 21, outcome: "b", scoreA: 0, scoreB: 2, sides: ["a", "b", "a"] },
    { daysAgo: 14, outcome: "draw", scoreA: 2, scoreB: 2, sides: ["a", "a", "b"] },
    { daysAgo: 7, outcome: "a", scoreA: 4, scoreB: 2, sides: ["a", "b", "a"] },
  ] as const;

  const DAY = 24 * 60 * 60 * 1000;
  const now = Date.now();

  // Past fixtures are inserted, not repurposed from the schedule. The first
  // version of this took the furthest-out `scheduled` rows and then ran the
  // materialisation cron again to top the schedule back up — which cost two
  // extra cron sweeps per `seedWorld` call, and each sweep walks every game
  // the run has created so far. Measured across the browser suite: 12 minutes
  // became 40, then 17.7 once the row writes were batched, and 13 again once
  // these two sweeps went away. Inserting is also the honest shape: these are
  // finished fixtures, and nothing about a finished one needs the capacity
  // object that materialisation exists to create.
  const [shape] = await query<{
    minPlayers: number;
    maxPlayers: number;
    prefersEvenNumbers: number;
    shortWarningOffsetHours: number;
    durationMinutes: number;
  }>(
    `SELECT min_players AS minPlayers, max_players AS maxPlayers,
            prefers_even_numbers AS prefersEvenNumbers,
            short_warning_offset_hours AS shortWarningOffsetHours,
            duration_minutes AS durationMinutes
       FROM fixtures WHERE game_id = '${gameId}' LIMIT 1`,
  );
  if (!shape) {
    throw new Error(
      `seedMatchHistory: game ${gameId} has no fixture to copy its shape from. ` +
        `Materialisation is what creates them, so this ran before that cron.`,
    );
  }

  // Two statements for the whole history, not one per row. Every `query` here
  // shells out to `wrangler d1 execute`, which costs about a second, and
  // `seedWorld` runs once per spec file across dozens of specs.
  const fixtureRows: string[] = [];
  const responseRows: string[] = [];
  const claimRows: string[] = [];

  for (const past of HISTORY) {
    const fixtureId = randomUUID();
    const kickoff = now - past.daysAgo * DAY;

    // `played` outright, with the teams already published. The hourly sweep
    // below is what turns the claims into the cache row the two tables read;
    // retirement is not needed for a fixture that was never open.
    fixtureRows.push(
      `('${fixtureId}', '${gameId}', ${kickoff}, 'played', ${shape.minPlayers}, ` +
        `${shape.maxPlayers}, ${shape.prefersEvenNumbers}, ${shape.shortWarningOffsetHours}, ` +
        `${shape.durationMinutes}, ${squad.length}, 0, ${kickoff - 7 * DAY}, ` +
        `${kickoff}, ${kickoff})`,
    );

    for (const [position, playerId] of squad.entries()) {
      const side = past.sides[position];
      if (side === undefined) {
        throw new Error(
          `seedMatchHistory: no side for squad position ${position}. ` +
            `HISTORY.sides is index-aligned to squad and must be the same length.`,
        );
      }
      responseRows.push(
        `('${randomUUID()}', '${fixtureId}', '${playerId}', 'in', '${side}', ${kickoff - DAY}, 'web')`,
      );
    }

    // Two claims that agree, which is what makes a result settle rather than
    // stand as one person's word. Filed after kickoff, as a real one is.
    for (const playerId of squad.slice(0, 2)) {
      claimRows.push(
        `('${randomUUID()}', '${fixtureId}', '${playerId}', '${past.outcome}', ` +
          `${past.scoreA}, ${past.scoreB}, ${kickoff + 3600000}, ${kickoff + 3600000})`,
      );
    }
  }

  await query(
    `INSERT INTO fixtures (id, game_id, kicks_off_at, lifecycle, min_players, max_players,
       prefers_even_numbers, short_warning_offset_hours, duration_minutes, in_count,
       waitlist_count, opened_at, teams_published_at, teams_saved_at)
     VALUES ${fixtureRows.join(", ")};
     INSERT INTO responses (id, fixture_id, player_id, status, team, responded_at, source)
     VALUES ${responseRows.join(", ")};
     INSERT INTO fixture_result_claims
       (id, fixture_id, player_id, outcome, score_a, score_b, filed_at, created_at)
     VALUES ${claimRows.join(", ")}`,
  );

  // The one sweep this needs: the hourly handler materialises the result of
  // every played fixture whose 48-hour window has closed, which is the row
  // both tables actually read. Nothing here asserts an outcome the sweep would
  // not derive — the claims above are what it derives it from.
  await page.request.get(`${BASE_URL}/cdn-cgi/handler/scheduled?cron=0+*+*+*+*`);

  const settled = await query<{ n: number }>(
    `SELECT count(*) AS n FROM fixture_results r
       JOIN fixtures f ON f.id = r.fixture_id WHERE f.game_id = '${gameId}'`,
  );
  if ((settled[0]?.n ?? 0) < HISTORY.length) {
    throw new Error(
      `seedMatchHistory: ${settled[0]?.n ?? 0} of ${HISTORY.length} fixtures ` +
        `settled. Standings and Your record both read fixture_results, so a ` +
        `short count here is the two of them rendering as nothing.`,
    );
  }
}

/** One seeded member of the busy game. */
interface BusyMember {
  id: string;
  name: string;
}

/**
 * A second game, created before the crons so the same two sweeps that
 * materialise and open the first game's fixtures do this one's too (M52).
 *
 * `owner-fixture` is the densest page in the product — a per-member In/Out
 * control, waitlist labels, guest rows with their own Remove, the team picker,
 * the guest form, the WhatsApp card and two footer actions. It was captured
 * with none of that: nought in, no guests, no waitlist, an empty picker. The
 * M52 design review was asked whether that page had become unmanageable and
 * could only answer "the capture is not evidence either way" — a verdict about
 * the harness rather than about the page.
 *
 * **A second game, not more people in the first.** Filling the fixture every
 * other capture already points at would change what four of them mean: the
 * `respond-in`, `respond-out`, `respond-waitlisted` and `respond-pending`
 * entries all act on it through `World.responseToken`, and on a full fixture
 * "I'm in" waitlists rather than seats. An organiser running two games is also
 * simply true.
 */
async function createBusyGame(page: Page): Promise<{ gameId: string; members: BusyMember[] }> {
  // Eight places and ten players, so the fixture fills and two wait. Small on
  // purpose: every extra player is an HTTP round trip, in a harness that runs
  // once per spec file across dozens of specs.
  const SQUAD = [
    "Priya Raman", "Tom Okonjo", "Sarah Vance", "Diego Marin", "Ken Adeyemi",
    "Lucy Brandt", "Omar Haddad", "Nina Kowalski", "Rob Ellery", "Mika Toivonen",
  ] as const;

  await page.goto("/g/new");
  await page.fill('input[name="name"]', "Sunday 5-a-side");
  await page.fill('input[name="venueName"]', "Burgess Park Cages");
  const slot = imminentSlot(new Date(Date.now()));
  await page.selectOption('select[name="weekday"]', slot.weekday);
  await page.fill('input[name="kickoffTime"]', slot.kickoffTime);
  await page.fill('input[name="minPlayers"]', "4");
  await page.fill('input[name="maxPlayers"]', "8");
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/g\/[^/]+$/);

  const gameId = new URL(page.url()).pathname.split("/")[2]!;

  // One statement for the whole squad: each `query` shells out to a separate
  // wrangler process, which is the expensive thing in this harness.
  const members: BusyMember[] = SQUAD.map((name) => ({ id: randomUUID(), name }));
  const address = (m: BusyMember) =>
    `${m.name.toLowerCase().replace(/[^a-z]/g, "")}+${m.id.slice(0, 8)}@example.test`;
  await query(
    `INSERT INTO players (id, name, email) VALUES ${members
      .map((m) => `('${m.id}', '${m.name}', '${address(m)}')`)
      .join(", ")};
     INSERT INTO memberships (id, game_id, player_id, role, joined_at) VALUES ${members
       .map((m) => `('${randomUUID()}', '${gameId}', '${m.id}', 'player', ${Date.now()})`)
       .join(", ")}`,
  );

  return { gameId, members };
}

/**
 * Fill that game's open fixture: everyone answers, the last two are waitlisted
 * by the capacity object, and the owner adds a guest.
 *
 * Answers go through `POST /r/:token`, never by writing `responses` rows. The
 * capacity object is the only thing allowed to decide `in` versus `waitlisted`
 * (TR-10), and it is what keeps `in_count` and `waitlist_count` agreeing with
 * the rows — a hand-written seat leaves the headcount line disagreeing with
 * the squad listed directly beneath it, which is the one error an organiser
 * cannot be asked to reconcile.
 */
async function fillBusyFixture(
  page: Page,
  gameId: string,
  members: readonly BusyMember[],
): Promise<string> {
  const [fixture] = await query<{ id: string }>(
    `SELECT id FROM fixtures WHERE game_id = '${gameId}' AND lifecycle = 'open'
       ORDER BY kicks_off_at LIMIT 1`,
  );
  if (!fixture) {
    throw new Error(
      `fillBusyFixture: game ${gameId} has no open fixture. Both crons run ` +
        `after this game is created, so this ran in the wrong order.`,
    );
  }

  // The guest first, while there is still room. Added after the fixture fills,
  // the request is refused and the page renders without the guest row this
  // capture exists to show — which is what happened on the first attempt, and
  // left a comment here claiming a guest the screenshot did not have.
  await page.request.post(`${BASE_URL}/g/${gameId}/f/${fixture.id}/guest`, {
    form: { name: "Sam (Rob's mate)" },
    headers: { origin: BASE_URL },
  });

  for (const member of members) {
    const token = await signResponseToken(
      { playerId: member.id, fixtureId: fixture.id, expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000 },
      RESPONSE_SECRET,
    );
    await page.request.post(`${BASE_URL}/r/${token}`, {
      form: { intent: "in" },
      headers: { origin: BASE_URL },
    });
  }

  const [counts] = await query<{ inCount: number; waitlistCount: number }>(
    `SELECT in_count AS inCount, waitlist_count AS waitlistCount FROM fixtures WHERE id = '${fixture.id}'`,
  );
  // The point of the whole helper: a page captured at nought in tells a
  // reviewer nothing about a page whose job is density. Each element is
  // asserted, because each one silently absent is a capture that looks fine
  // and shows less than it claims.
  const [guest] = await query<{ n: number }>(
    `SELECT count(*) AS n FROM responses r JOIN players p ON p.id = r.player_id
       WHERE r.fixture_id = '${fixture.id}' AND p.is_guest = 1`,
  );
  if ((counts?.waitlistCount ?? 0) < 1 || (guest?.n ?? 0) < 1) {
    throw new Error(
      `fillBusyFixture: ${counts?.inCount ?? 0} in, ${counts?.waitlistCount ?? 0} waiting, ` +
        `${guest?.n ?? 0} guests. The fixture is meant to be full, with people ` +
        `queued behind it and a guest among them — check max_players against ` +
        `the squad size above, and that the guest is added before it fills.`,
    );
  }

  return fixture.id;
}

/**
 * Build the state every catalogue page points at, by driving the app's own
 * surface rather than inserting rows.
 *
 * A hand-built world can be internally inconsistent in ways a real one cannot
 * — a membership with no audit row, a fixture with no capacity object — and
 * this world is what the console gate then loads. Only the fixture
 * materialisation is triggered directly, because it is a cron and there is no
 * user-facing way to ask for it.
 */
export async function seedWorld(
  page: Page,
  browser: Browser,
  // The joiner gets its own context, which does not inherit the calling
  // test's `javaScriptEnabled`. Passing it explicitly keeps the JS-off run
  // genuinely JS-off on both sides of the invite.
  options: {
    javaScriptEnabled?: boolean;
    /**
     * Also build the busy second game (M52) — a full fixture with a waitlist
     * and a guest, which `owner-fixture` and `team-picker` are captured on.
     *
     * Off by default, and the default is a measurement rather than a taste.
     * A second game per spec file means every later cron sweep walks one more
     * game, and a sweep runs twice per `seedWorld`: always-on took the browser
     * suite from 15.6 minutes to 20.9. Only the specs that read the catalogue
     * need it, so only they ask. Everything else gets `busyGameId` pointing at
     * the ordinary game, so a path built from it is still a real page.
     */
    busy?: boolean;
  } = {},
): Promise<World> {
  await signIn(page, TEST_OWNER);

  // --- the game -----------------------------------------------------------
  await page.goto("/g/new");
  await page.fill('input[name="name"]', "Thursday 7-a-side");
  await page.fill('input[name="venueName"]', "Peckham Rye Astro");
  // The one wall-clock read in this harness, spelled the way the repository
  // spells a deliberate clock read at an edge (see `src/routes/dashboard.ts`):
  // `imminentSlot` itself takes `now` as a parameter.
  const slot = imminentSlot(new Date(Date.now()));
  await page.selectOption('select[name="weekday"]', slot.weekday);
  await page.fill('input[name="kickoffTime"]', slot.kickoffTime);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/g\/[^/]+$/);

  const gameId = new URL(page.url()).pathname.split("/")[2]!;
  const inviteUrl = await page.inputValue("#invite-url");
  const inviteToken = inviteUrl.split("/j/")[1]!;

  // M39: a confirmation-link token for the "join-confirm" catalogue entry, for
  // an address that is not (and will not become) a member — minted the way
  // `sendJoinConfirmation` would have, not by submitting the join form, since
  // this harness has no inbox to read it from.
  const freshJoinToken = await signJoinToken(
    {
      gameId,
      inviteToken,
      email: "unconfirmed-catalogue@example.test",
      name: "Robin Catalogue",
      expiresAt: joinTokenExpiry(new Date(Date.now())).getTime(),
    },
    RESPONSE_SECRET,
  );

  // --- a second identity joins --------------------------------------------
  // Its own context, so the two identities never share a cookie jar: a joiner
  // carrying the owner's session would exercise a path no real visitor takes.
  const joiner = await browser.newContext({
    javaScriptEnabled: options.javaScriptEnabled ?? true,
  });
  const joinerPage = await joiner.newPage();
  await joinerPage.goto(`/j/${inviteToken}`);
  await joinerPage.fill('input[name="name"]', JOINER_NAME);
  await joinerPage.fill('input[name="email"]', TEST_PLAYER);
  await joinerPage.click('button[type="submit"]');
  await joinerPage.waitForLoadState("networkidle");

  // M39 (BR-48): a never-before-seen address no longer joins on that click —
  // the submit above sent N-14 and landed on "Check your inbox" instead of a
  // squad. The confirmation link is what actually creates the membership and
  // stamps `emailVerifiedAt`; this harness has no inbox to read it from, so
  // it mints the same token `sendJoinConfirmation` would have mailed (same
  // secret, same payload shape) and follows it, exactly as a real click
  // would.
  const jtoken = await signJoinToken(
    { gameId, inviteToken, email: TEST_PLAYER, name: JOINER_NAME, expiresAt: joinTokenExpiry(new Date(Date.now())).getTime() },
    RESPONSE_SECRET,
  );
  await joinerPage.goto(`/join/${jtoken}`);
  await joinerPage.click('button[type="submit"]');
  await joinerPage.waitForLoadState("networkidle");
  await joiner.close();

  // Verify the postcondition rather than trusting the click. A silently
  // failed join still returns a plausible-looking World — one whose response
  // token points at a player who is not in the squad — and the failure then
  // surfaces several assertions later, in a test that has nothing to do with
  // joining. Fail here, where the cause is.
  await page.goto(`/g/${gameId}`);
  const joined = page.locator("ul.squad li").filter({ hasText: JOINER_NAME });
  if ((await joined.count()) !== 1) {
    throw new Error(
      `seedWorld: ${JOINER_NAME} did not join game ${gameId}. The squad list ` +
        `shows: ${JSON.stringify(await page.locator("ul.squad li .member").allTextContents())}`,
    );
  }

  // --- a legacy, never-confirmed member ------------------------------------
  // BR-52's whole premise is a row `confirm-to-join` never touched: nobody
  // joining through the app today can end up with a null `email_verified_at`
  // any more (both paths above stamp it), so the only way to put one in front
  // of the "Unconfirmed" badge is to insert it directly, the way the real
  // rows it describes actually got there — seated before M39 shipped.
  // `email_verified_at` is left off entirely rather than passed as NULL, so
  // there is no doubt this is the column's true default and not this
  // harness's choice.
  //
  // The email is per-call, not a fixed literal: `players_email_unique` is a
  // partial unique index on a non-null email, this D1 is reset once for the
  // whole Playwright run (`workers: 1` in playwright.config.ts), and
  // `seedWorld` is called once per spec file across dozens of specs — a
  // fixed address collided on the second call and failed every spec after
  // the first. Suffixed the same way `result.spec.ts`'s "Backer
  // ${playerId.slice(0, 8)}" is.
  const legacyMemberId = randomUUID();
  const legacyEmail = `lauren-legacy+${legacyMemberId.slice(0, 8)}@example.test`;
  await query(`INSERT INTO players (id, name, email) VALUES ('${legacyMemberId}', 'Lauren Legacy', '${legacyEmail}')`);
  await query(
    `INSERT INTO memberships (id, game_id, player_id, role, joined_at) VALUES ('${randomUUID()}', '${gameId}', '${legacyMemberId}', 'player', ${Date.now()})`,
  );

  // Before the crons below, deliberately: the same two sweeps then materialise
  // and open this game's fixtures as well as the first game's, so a second
  // game costs no extra sweep (and a sweep walks every game the run has made).
  const busy = options.busy === true ? await createBusyGame(page) : null;

  // --- fixtures -----------------------------------------------------------
  // Two crons, and both are needed. `15 3 * * *` materialises fixtures from
  // the game's recurrence; `0 * * * *` is the hourly sweep that *opens* the
  // ones which have reached their open-at time. Without the second, every
  // fixture stays `scheduled`, and `/r/:token` renders its read-only notice
  // with no answer buttons at all — which presents as a click that hangs
  // until the test times out, rather than as anything resembling its cause.
  await page.request.get(`${BASE_URL}/cdn-cgi/handler/scheduled?cron=15+3+*+*+*`);
  await page.request.get(`${BASE_URL}/cdn-cgi/handler/scheduled?cron=0+*+*+*+*`);

  const [fixture] = await query<{ id: string; lifecycle: string }>(
    `SELECT id, lifecycle FROM fixtures WHERE game_id = '${gameId}'
       AND lifecycle = 'open' ORDER BY kicks_off_at LIMIT 1`,
  );
  if (!fixture) {
    const all = await query<{ lifecycle: string }>(
      `SELECT lifecycle FROM fixtures WHERE game_id = '${gameId}'`,
    );
    throw new Error(
      `seedWorld: game ${gameId} has no open fixture after both crons ran. ` +
        `Lifecycles present: ${JSON.stringify(all.map((f) => f.lifecycle))}.`,
    );
  }

  const [member] = await query<{ id: string }>(
    `SELECT p.id AS id FROM players p WHERE p.email = '${TEST_PLAYER}' LIMIT 1`,
  );
  if (!member) throw new Error(`the joined player ${TEST_PLAYER} has no row`);

  const [owner] = await query<{ id: string }>(
    `SELECT id FROM players WHERE email = '${TEST_OWNER}' LIMIT 1`,
  );
  if (!owner) throw new Error(`the owner ${TEST_OWNER} has no player row`);

  // A season behind the game, so `Your record` and `Standings` have something
  // to report on every page that carries them (M52). After the member and the
  // owner are resolved, and before the tokens: it runs a cron, and the open
  // fixture above is already fixed by id so a second sweep cannot move it.
  await seedMatchHistory(page, gameId, [owner.id, member.id, legacyMemberId]);

  const busyFixtureId =
    busy === null ? fixture.id : await fillBusyFixture(page, busy.gameId, busy.members);

  const responseToken = await signResponseToken(
    {
      playerId: member.id,
      fixtureId: fixture.id,
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
    },
    RESPONSE_SECRET,
  );

  const leaveToken = await signLeaveToken(
    {
      gameId,
      playerId: member.id,
      // Through `leaveTokenExpiry`, exactly as every mailed leave link is
      // minted: `/leave/:token` derives when a token was signed from its
      // expiry and refuses one older than the player's current spell in the
      // squad, so an invented expiry would describe a token from months ago.
      expiresAt: leaveTokenExpiry(new Date(Date.now())).getTime(),
    },
    RESPONSE_SECRET,
  );

  // `/cancel/:token` is an owner's one-tap link out of the "this fixture needs
  // attention" email. It is signed with a *different* secret from the response
  // token on purpose (see CANCEL_TOKEN_SECRET in src/env.ts): the two are kept
  // apart so a leaked response key cannot forge a cancellation.
  const cancelToken = await signCancelToken(
    {
      ownerPlayerId: owner.id,
      fixtureId: fixture.id,
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
    },
    CANCEL_SECRET,
  );

  return {
    gameId,
    fixtureId: fixture.id,
    inviteToken,
    freshJoinToken,
    memberPlayerId: member.id,
    responseToken,
    leaveToken,
    ownerPlayerId: owner.id,
    cancelToken,
    // Falls back to the ordinary game when the busy one was not asked for, so
    // every catalogue path still resolves to a page that exists.
    busyGameId: busy?.gameId ?? gameId,
    busyFixtureId,
  };
}

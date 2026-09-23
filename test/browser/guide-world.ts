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
import { toLocalParts, toUtc } from "../../src/domain/time/zone.js";
import { BASE_URL } from "../../playwright.config.js";
import { signIn } from "./sign-in.js";

const run = promisify(execFile);
// Both must match `test/browser/browser.env` exactly, and they are
// deliberately different from each other: `src/env.ts` keeps the response and
// cancel keys apart as a security boundary, and a suite that shared one value
// could not tell the two apart.
const RESPONSE_SECRET = "local-browser-tests-only-not-a-real-secret";
const CANCEL_SECRET = "local-browser-tests-only-not-a-real-cancel-secret";

/**
 * The zone the guide's game is in: `/g/new` has no timezone field and
 * `src/domain/game-form.ts` defaults to Europe/London.
 */
const GAME_ZONE = "Europe/London";

/**
 * The organiser. Every address here is `@example.test` and every name is
 * invented: these screenshots are committed to a public repository and are
 * permanent, so nothing may resemble a real person.
 */
export const GUIDE_ORGANISER = "jamie@example.test";

/** The organiser's display name, as the squad sees it. */
export const GUIDE_ORGANISER_NAME = "Jamie Hollis";

/**
 * The game's name. Asserted on at capture time (see `guide-capture.spec.ts`)
 * as well as typed into the form, so a shot that is not scoped to this world
 * cannot be photographed silently.
 */
export const GUIDE_GAME_NAME = "Meadow Park Kickabout";

/**
 * The thirteen who join, in the order they answer. The first nine take the
 * remaining places (the organiser has the tenth), the next two are
 * waitlisted, and the twelfth cannot make it — which is how one world comes
 * to show a full fixture, a waitlist and a dropout at once.
 *
 * The thirteenth, Ade Sowande, never answers at all. Every other member has a
 * response POSTed for them before capture, so without this one there is no
 * player left in the state a reader is actually in when the reminder arrives:
 * no headline, both buttons untapped. Chapter 03 opens on that screen, so the
 * world has to contain it.
 */
const SQUAD = [
  { name: "Priya Raman", email: "priya@example.test" },
  { name: "Tom Okonjo", email: "tom@example.test" },
  { name: "Sarah Vance", email: "sarah@example.test" },
  { name: "Diego Marín", email: "diego@example.test" },
  { name: "Ken Adeyemi", email: "ken@example.test" },
  { name: "Lucy Brandt", email: "lucy@example.test" },
  { name: "Omar Haddad", email: "omar@example.test" },
  { name: "Nina Kowalski", email: "nina@example.test" },
  { name: "Rob Ellery", email: "rob@example.test" },
  { name: "Mika Toivonen", email: "mika@example.test" },
  { name: "Grace Abara", email: "grace@example.test" },
  { name: "Sam Whitlock", email: "sam@example.test" },
  { name: "Ade Sowande", email: "ade@example.test" },
] as const;

/**
 * A plausible evening kickoff for the guide's screenshots — always 19:00,
 * never "two hours from now", which is right for the test suite and reads
 * absurdly in a document (a 22:00 kickoff looks like a typo, not a squad).
 *
 * A fixture opens once its reminder instant — 09:00 the day before — has
 * passed, and closes when it ends. Before 10:00, today's 19:00 satisfies both
 * (its reminder was 09:00 yesterday, and it has not kicked off). From 10:00
 * on, today's reminder instant has passed, so tomorrow's 19:00 is open too.
 *
 * Both readings — the hour that decides today-or-tomorrow, and the weekday
 * itself — are taken in `GAME_ZONE`. `/g/new` has no timezone field and
 * `src/domain/game-form.ts` defaults every game to Europe/London, so a
 * weekday read from the machine's clock names the wrong day for any
 * contributor whose own date has already turned over (or has not yet).
 */
function guideSlot(now: Date): { weekday: string; kickoffTime: string } {
  const WEEKDAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;
  const parts = toLocalParts(now, GAME_ZONE);
  // The calendar day is incremented rather than 24 hours added: across a
  // spring-forward, `now + 24h` reads as the day after tomorrow in the hour
  // that goes missing.
  const shifted = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day + (parts.hour < 10 ? 0 : 1)),
  );
  return { weekday: WEEKDAY_CODES[shifted.getUTCDay()]!, kickoffTime: "19:00" };
}

/** Read-only D1 access, via the supported path. See `sign-in.ts` for why. */
async function query<T>(sql: string): Promise<T[]> {
  const { stdout } = await run(
    "npx",
    ["wrangler", "d1", "execute", "makethe-team", "--local", "--json", "--command", sql],
    { cwd: process.cwd(), maxBuffer: 4 * 1024 * 1024 },
  );
  const start = stdout.indexOf("[");
  if (start === -1) throw new Error(`unexpected wrangler output:\n${stdout}`);
  return (JSON.parse(stdout.slice(start)) as { results?: T[] }[])[0]?.results ?? [];
}

/**
 * Write access to local D1, via the same supported path `query` reads
 * through. Reserved for the one thing no product route can do — backdating a
 * kickoff so a fixture retires to `played` inside a capture run that itself
 * takes only seconds (see `buildResultDemo`, and `test/browser/result.spec.ts`'s
 * `playFixture`, whose pattern this matches exactly).
 */
async function execSql(sql: string): Promise<void> {
  await run("npx", ["wrangler", "d1", "execute", "makethe-team", "--local", "--command", sql], {
    cwd: process.cwd(),
    maxBuffer: 4 * 1024 * 1024,
  });
}

export interface GuideWorld {
  gameId: string;
  fixtureId: string;
  inviteToken: string;
  /**
   * M39: a confirmation-link token (BR-48) for an address that has never
   * joined anything, minted the way `sendJoinConfirmation` would have — not
   * consumed by anything in this world, since `GET /join/:jtoken` (the
   * "join-confirm" shot) writes nothing (BR-50) and there is nothing here to
   * exercise the `POST`.
   */
  freshJoinToken: string;
  cancelToken: string;
  /** A response token for a player who is `in`. */
  inToken: string;
  /** A response token for a player who is waitlisted. */
  waitlistedToken: string;
  /** A response token for the player who answered "can't make it". */
  outToken: string;
  /**
   * A response token for the one member who has not answered at all — the
   * state a player is actually in when they open the reminder.
   */
  pendingToken: string;
  /**
   * A leave token (M7a) for a squad member — never the organiser, who is the
   * sole owner of this world's game and would land on the "you're the only
   * organiser" page instead of the confirmation this shot is about. Reuses
   * the player who answered "can't make it" (`outToken`'s player), the same
   * one `removablePlayerId` names, rather than minting a fresh member: this
   * is a `GET`, which `respond.ts` guarantees performs no write, so it
   * cannot disturb the counts chapters 1, 3, 4 and 6 already quote verbatim.
   */
  leaveToken: string;
  /**
   * The member the removal confirmation page is shown for. Deliberately the
   * player who already answered "can't make it", so the page is not about
   * someone holding a place — removing them would trigger a promotion and
   * the screenshot would describe a different situation from the one the
   * chapter is explaining.
   */
  removablePlayerId: string;
  /**
   * A second, small game — not the Meadow Park Kickabout — built purely to
   * demonstrate an owner's mark-in and guest-add (Task 8's three new shots).
   * It cannot reuse the main fixture: every other chapter has already
   * committed exact numbers to that fixture (chapter 1's "ten people in",
   * chapter 3's "10 of 10 in · 2 waiting" and Ade Sowande shown as not yet
   * responded,
   * chapter 6's headcount on the cancellation page), and the member who
   * never answers there is *the* Ade Sowande those chapters name. Marking
   * him in here would quietly falsify all of them on the next capture. A
   * second game keeps this section's own screenshots honest without
   * touching a number any other chapter depends on. Its kickoff is
   * deliberately later in the day than the main game's (see
   * `buildOverrideDemo`), so it never displaces the Meadow Park fixture from
   * the front of the dashboard.
   */
  demoGameId: string;
  demoFixtureId: string;
  /**
   * A response token for a player in a third, small game whose organiser has
   * turned off "Let players see who else is playing" — see
   * `buildVisibilityDemo` for why this needs its own game rather than
   * toggling the Meadow Park Kickabout's own setting.
   */
  hiddenSquadToken: string;
  /**
   * A fourth, small game solely for chapter 7's "recording a result"
   * screenshot (M25) — see `buildResultDemo` for why this needs its own game
   * rather than the Meadow Park Kickabout's own (still-future) fixture.
   */
  resultDemoGameId: string;
  resultDemoFixtureId: string;
  /**
   * The squad member — never the organiser, who already filed the claim
   * this shot's candidate row belongs to — the capture run signs in as to
   * take the screenshot: the writable panel with someone else's claim
   * already on it and an Agree button of their own.
   */
  resultDemoPlayerEmail: string;
  /**
   * The squad member the Standings, Your record and past-fixtures shots are
   * taken as: mid-table in `SEASON`, so the highlighted row is not simply the
   * top one, and in the week nobody filed a result, so Your record shows NR.
   */
  seasonPlayerEmail: string;
}

/**
 * A stable, unique 198.51.100.x address per joiner — TEST-NET-2, reserved for
 * documentation, so it can never collide with anything real. Derived from the
 * address rather than a counter so a rerun gives the same person the same
 * bucket, and two people never share one.
 */
function joinerAddress(email: string): string {
  let hash = 0;
  for (const char of email) hash = (hash * 31 + char.charCodeAt(0)) % 254;
  return `198.51.100.${hash + 1}`;
}

/**
 * Seat one person in a squad through the real two-step join, in their own
 * browser context.
 *
 * Both steps are needed and neither is optional. The form submission is what a
 * person actually does with an invite link, and since M39 (BR-47/BR-48) it
 * seats nobody for an address the app has never seen: it sends N-14 and shows
 * "Check your inbox". The membership is created by the confirmation link, which
 * also stamps `email_verified_at`. This harness has no inbox, so it mints the
 * token `sendJoinConfirmation` would have mailed — same secret, same payload
 * shape — and follows it, exactly as `test/browser/world.ts` does.
 *
 * Every guide world had its own copy of the one-step loop, so M39 broke all
 * four at once and each would have had to be found separately. One helper is
 * the guard: the next change to the join flow lands here, once.
 *
 * The context is per person because a joiner carrying the organiser's session
 * would exercise a path no real visitor takes.
 *
 * It also carries its own `CF-Connecting-IP`, for the same reason: thirteen
 * people join from thirteen phones. Without it the whole squad shares one
 * bucket in `TOKEN_IP_LIMITER`, whose budget is 60 a minute — and at four
 * requests a join this harness spends that inside two worlds, so a later
 * joiner is refused for a crowding that exists only here. `wrangler dev`
 * honours the header (measured 2 September 2026: 60 requests then 429s on one
 * value, while 40 distinct values all passed against the same exhausted
 * bucket); Cloudflare overwrites it at the edge, so this is a local-harness
 * detail and not a header any real client controls.
 */
async function joinSquadMember(
  browser: Browser,
  gameId: string,
  inviteToken: string,
  person: { readonly name: string; readonly email: string },
): Promise<void> {
  const context = await browser.newContext({
    extraHTTPHeaders: { "CF-Connecting-IP": joinerAddress(person.email) },
  });
  const joinerPage = await context.newPage();

  await joinerPage.goto(`/j/${inviteToken}`);
  await joinerPage.fill('input[name="name"]', person.name);
  await joinerPage.fill('input[name="email"]', person.email);
  await joinerPage.click('button[type="submit"]');
  await joinerPage.waitForLoadState("networkidle");

  const jtoken = await signJoinToken(
    {
      gameId,
      inviteToken,
      email: person.email,
      name: person.name,
      expiresAt: joinTokenExpiry(new Date(Date.now())).getTime(),
    },
    RESPONSE_SECRET,
  );
  await joinerPage.goto(`/join/${jtoken}`);
  await joinerPage.click('button[type="submit"]');
  await joinerPage.waitForLoadState("networkidle");

  await context.close();
}


export async function buildGuideWorld(page: Page, browser: Browser): Promise<GuideWorld> {
  await signIn(page, GUIDE_ORGANISER);

  // A first sign-in names the player after their address, and an organiser
  // eight weeks into a season has long since fixed that: without this, the
  // Standings shot lists thirteen full names and one bare "jamie".
  await page.goto("/app/account");
  await page.fill("#name", GUIDE_ORGANISER_NAME);
  await page.locator("form", { has: page.locator("#name") }).getByRole("button", { name: "Save" }).click();
  await page.waitForLoadState("networkidle");

  await page.goto("/g/new");
  // Deliberately no weekday in the name. `guideSlot` picks the day from the
  // clock, so a game called "Thursday Night Football" ends up playing every
  // Friday whenever the capture runs late on a Thursday — a contradiction
  // baked into every screenshot, since the name heads most of these pages and
  // the fixture dates sit directly beneath it. Naming the game after the venue
  // it already plays at cannot disagree with the day it lands on.
  await page.fill('input[name="name"]', GUIDE_GAME_NAME);
  await page.fill('input[name="venueName"]', "Meadow Park 3G");
  await page.fill('input[name="venueAddress"]', "14 Meadow Lane");
  // Named sides, as a squad with a season behind it has: every past fixture
  // and the picker otherwise read "Team A won", which no real squad says.
  await page.fill('input[name="teamAName"]', "Bibs");
  await page.fill('input[name="teamBName"]', "Skins");

  // The weekday must be chosen from the clock, not fixed. A fixture only opens
  // once its reminder instant — 09:00 the day before kickoff — has passed and
  // it has not yet ended, so a hardcoded weekday leaves the first fixture up to
  // a week away and permanently `scheduled`.
  //
  // `guideSlot`, not `world.js`'s `imminentSlot`: the browser suite wants a
  // kickoff two hours from now, which is correct for a test and produces a
  // 22:00 kickoff in every screenshot when the capture runs in the evening.
  // The guide needs a time a reader recognises as five-a-side.
  // The one wall-clock read in this harness, spelled the way the repository
  // spells a deliberate clock read at an edge (see `src/routes/dashboard.ts`):
  // `guideSlot` itself takes `now` as a parameter.
  const slot = guideSlot(new Date(Date.now()));
  await page.selectOption('select[name="weekday"]', slot.weekday);
  await page.fill('input[name="kickoffTime"]', slot.kickoffTime);

  await page.fill('input[name="minPlayers"]', "8");
  // Max 10 rather than the default 14: with a squad of fourteen answering, a
  // waitlist is only reachable if the cap is below the squad size, and a
  // waitlist is one of the three things this single world has to illustrate.
  await page.fill('input[name="maxPlayers"]', "10");
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/g\/[^/]+$/);

  const gameId = new URL(page.url()).pathname.split("/")[2]!;
  const inviteToken = (await page.inputValue("#invite-url")).split("/j/")[1]!;

  // M39's confirm-to-join shot needs a token for an address that has never
  // joined anything — minted directly, the way the email would carry it,
  // rather than by driving the form: this address is never submitted to
  // `/j/:token` by this harness, so there is no inbox to read it from.
  const freshJoinToken = await signJoinToken(
    {
      gameId,
      inviteToken,
      email: "unconfirmed-demo@example.test",
      name: "Alex Doyle",
      expiresAt: joinTokenExpiry(new Date(Date.now())).getTime(),
    },
    RESPONSE_SECRET,
  );

  for (const person of SQUAD) {
    await joinSquadMember(browser, gameId, inviteToken, person);
  }

  await page.goto(`/g/${gameId}`);
  const squadSize = await page.locator("ul.squad li:has(.member)").count();
  if (squadSize !== SQUAD.length + 1) {
    throw new Error(
      `buildGuideWorld: expected a squad of ${SQUAD.length + 1} — the organiser ` +
        `plus ${SQUAD.length} joiners — and found ${squadSize}. The chapters ` +
        `state that number and every screenshot shows it.`,
    );
  }

  await page.request.get(`${BASE_URL}/cdn-cgi/handler/scheduled?cron=15+3+*+*+*`);
  await page.request.get(`${BASE_URL}/cdn-cgi/handler/scheduled?cron=0+*+*+*+*`);

  const [fixture] = await query<{ id: string }>(
    `SELECT id FROM fixtures WHERE game_id = '${gameId}'
       AND lifecycle = 'open' ORDER BY kicks_off_at LIMIT 1`,
  );
  if (!fixture) throw new Error(`buildGuideWorld: game ${gameId} has no open fixture`);

  const players = await query<{ id: string; email: string }>(
    `SELECT id, email FROM players WHERE email LIKE '%@example.test'`,
  );
  const idFor = (email: string): string => {
    const found = players.find((p) => p.email === email);
    if (!found) throw new Error(`buildGuideWorld: no player row for ${email}`);
    return found.id;
  };

  const tokenFor = async (email: string): Promise<string> =>
    signResponseToken(
      { playerId: idFor(email), fixtureId: fixture.id, expiresAt: Date.now() + 7 * 864e5 },
      RESPONSE_SECRET,
    );

  // The organiser takes a place first, then the next nine fill the cap of ten.
  // Sequential and awaited: waitlist position is arrival order, and the guide
  // names who ended up on it.
  const answering = [GUIDE_ORGANISER, ...SQUAD.slice(0, 11).map((p) => p.email)];
  for (const email of answering) {
    const token = await tokenFor(email);
    await page.request.post(`${BASE_URL}/r/${token}`, {
      form: { intent: "in" },
      headers: { origin: BASE_URL },
    });
  }

  // And one who cannot make it.
  const outEmail = SQUAD[11]!.email;
  const outToken = await tokenFor(outEmail);
  await page.request.post(`${BASE_URL}/r/${outToken}`, {
    form: { intent: "out" },
    headers: { origin: BASE_URL },
  });

  // The last member is deliberately left alone: no POST, no response. That is
  // what chapter 03's opening screenshot needs.
  const pendingEmail = SQUAD[12]!.email;

  const counts = await query<{ status: string; n: number }>(
    `SELECT status, COUNT(*) AS n FROM responses
       WHERE fixture_id = '${fixture.id}' GROUP BY status`,
  );
  const count = (status: string): number =>
    counts.find((row) => row.status === status)?.n ?? 0;

  if (count("in") !== 10 || count("waitlisted") !== 2 || count("out") !== 1) {
    throw new Error(
      `buildGuideWorld: expected 10 in / 2 waitlisted / 1 out, got ` +
        `${JSON.stringify(counts)}. The guide's prose states these numbers.`,
    );
  }

  await seedSeason(page, gameId, fixture.id, idFor);

  const demo = await buildOverrideDemo(page, browser, slot);
  const hiddenSquadToken = await buildVisibilityDemo(page, browser, slot);
  const resultDemo = await buildResultDemo(page, browser, slot);

  return {
    gameId,
    fixtureId: fixture.id,
    inviteToken,
    freshJoinToken,
    inToken: await tokenFor(GUIDE_ORGANISER),
    waitlistedToken: await tokenFor(SQUAD[10]!.email),
    outToken,
    pendingToken: await tokenFor(pendingEmail),
    leaveToken: await signLeaveToken(
      { gameId, playerId: idFor(outEmail), expiresAt: leaveTokenExpiry(new Date(Date.now())).getTime() },
      RESPONSE_SECRET,
    ),
    removablePlayerId: idFor(outEmail),
    demoGameId: demo.gameId,
    demoFixtureId: demo.fixtureId,
    hiddenSquadToken,
    resultDemoGameId: resultDemo.gameId,
    resultDemoFixtureId: resultDemo.fixtureId,
    resultDemoPlayerEmail: resultDemo.agreeingPlayerEmail,
    seasonPlayerEmail: "nina@example.test",
    cancelToken: await signCancelToken(
      {
        ownerPlayerId: idFor(GUIDE_ORGANISER),
        fixtureId: fixture.id,
        expiresAt: Date.now() + 7 * 864e5,
      },
      CANCEL_SECRET,
    ),
  };
}

/**
 * A second, small game solely for Task 8's owner-override screenshots — see
 * `GuideWorld.demoGameId`'s comment for why the main fixture can't carry
 * this.
 *
 * Filling the squad to capacity beforehand uses the same signed-token POSTs
 * `buildGuideWorld` uses for the main squad: those are ordinary self-answers,
 * not the organiser action being demonstrated. From the point the squad is
 * full onward, every write goes through the owner fixture page's own forms —
 * not the API — so the three screenshots depict a state the app itself
 * produced.
 */
async function buildOverrideDemo(
  page: Page,
  browser: Browser,
  slot: { weekday: string; kickoffTime: string },
): Promise<{ gameId: string; fixtureId: string }> {
  const DEMO_SQUAD = [
    { name: "Callum Reyes", email: "callum@example.test" },
    { name: "Freya Lindqvist", email: "freya@example.test" },
    { name: "Theo Marchetti", email: "theo@example.test" },
    // Never answers, on purpose: the mark-in below targets her precisely
    // because she genuinely never responded, the same reason `buildGuideWorld`
    // leaves Ade Sowande alone for chapter 3.
    { name: "Nadia Okafor", email: "nadia@example.test" },
  ] as const;
  const neverAnswers = DEMO_SQUAD[3];

  await page.goto("/g/new");
  await page.fill('input[name="name"]', "Riverside Turf");
  await page.fill('input[name="venueName"]', "Riverside Astro");
  await page.fill('input[name="venueAddress"]', "9 Mill Lane");
  await page.selectOption('select[name="weekday"]', slot.weekday);
  // An hour after the main game's kickoff, same weekday: both fixtures share
  // the same reminder instant — 09:00 the day before, independent of the
  // kickoff hour (see `guideSlot`) — so the same cron sweep opens both, and
  // this fixture always sorts after the Meadow Park one on the dashboard
  // (`nth=0` there depends on that ordering).
  await page.fill('input[name="kickoffTime"]', "20:00");
  await page.fill('input[name="minPlayers"]', "2");
  await page.fill('input[name="maxPlayers"]', "4");
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/g\/[^/]+$/);

  const gameId = new URL(page.url()).pathname.split("/")[2]!;
  const inviteToken = (await page.inputValue("#invite-url")).split("/j/")[1]!;

  for (const person of DEMO_SQUAD) {
    await joinSquadMember(browser, gameId, inviteToken, person);
  }

  // The same two sweeps `buildGuideWorld` already ran for the main game:
  // materialisation and opening both walk every game, so running them again
  // is what gets this one its first fixture too.
  await page.request.get(`${BASE_URL}/cdn-cgi/handler/scheduled?cron=15+3+*+*+*`);
  await page.request.get(`${BASE_URL}/cdn-cgi/handler/scheduled?cron=0+*+*+*+*`);

  const [fixture] = await query<{ id: string }>(
    `SELECT id FROM fixtures WHERE game_id = '${gameId}'
       AND lifecycle = 'open' ORDER BY kicks_off_at LIMIT 1`,
  );
  if (!fixture) throw new Error(`buildOverrideDemo: game ${gameId} has no open fixture`);

  const players = await query<{ id: string; email: string }>(
    `SELECT id, email FROM players WHERE email LIKE '%@example.test'`,
  );
  const idFor = (email: string): string => {
    const found = players.find((p) => p.email === email);
    if (!found) throw new Error(`buildOverrideDemo: no player row for ${email}`);
    return found.id;
  };

  // The organiser plus the first three answer "in", filling the cap of four
  // exactly. `neverAnswers` gets no POST at all.
  const answering = [GUIDE_ORGANISER, ...DEMO_SQUAD.slice(0, 3).map((p) => p.email)];
  for (const email of answering) {
    const token = await signResponseToken(
      { playerId: idFor(email), fixtureId: fixture.id, expiresAt: Date.now() + 7 * 864e5 },
      RESPONSE_SECRET,
    );
    await page.request.post(`${BASE_URL}/r/${token}`, {
      form: { intent: "in" },
      headers: { origin: BASE_URL },
    });
  }

  const counts = await query<{ status: string; n: number }>(
    `SELECT status, COUNT(*) AS n FROM responses WHERE fixture_id = '${fixture.id}' GROUP BY status`,
  );
  const inCount = counts.find((row) => row.status === "in")?.n ?? 0;
  if (inCount !== 4) {
    throw new Error(
      `buildOverrideDemo: expected 4 in before the override, got ${inCount}. The ` +
        `mark-in below depends on the squad already being full.`,
    );
  }

  await page.goto(`/g/${gameId}/f/${fixture.id}`);

  // The mark-in, through the owner's own row controls. The squad is already
  // full, so this refuses with BR-8's over-capacity confirmation (§4.2)
  // rather than silently waitlisting.
  const neverAnswersRow = page.locator("ul.squad li", { hasText: neverAnswers.name });
  await neverAnswersRow.getByRole("button", { name: "In" }).click();
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Add them anyway" }).click();
  await page.waitForLoadState("networkidle");

  // The guest add, through the same page's own form. Now five in against a
  // cap of four, so it needs the same confirmation. The form has had its own
  // page since M52; the confirmation still comes back on the fixture page.
  await page.getByRole("link", { name: "Add a guest" }).click();
  await page.fill("#guest-name", "Jono Fielding");
  await page.getByRole("button", { name: "Add guest" }).click();
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Add them anyway" }).click();
  await page.waitForLoadState("networkidle");

  return { gameId, fixtureId: fixture.id };
}

/**
 * A third, small game solely for chapter 3's "squad hidden" screenshot.
 *
 * The Meadow Park Kickabout keeps its default — the setting on — because
 * chapters 1, 3, 4 and 6 already quote its exact squad and its names
 * verbatim ("ten people in", Ade Sowande as the one who never answers).
 * Turning that game's setting off would silently falsify every one of those
 * sentences on the next capture. This game exists only to show the other
 * state, and nothing else in the guide depends on its numbers.
 *
 * The setting is turned off through the edit form itself — not written to
 * the database directly — so the screenshot depicts a state the app itself
 * produced, exactly as BR-33 and its checkbox are meant to be used.
 */
async function buildVisibilityDemo(
  page: Page,
  browser: Browser,
  slot: { weekday: string; kickoffTime: string },
): Promise<string> {
  const HIDDEN_SQUAD = [
    { name: "Isla Ferreira", email: "isla@example.test" },
    { name: "Noah Kessler", email: "noah@example.test" },
  ] as const;

  await page.goto("/g/new");
  await page.fill('input[name="name"]', "Oakfield Six-a-side");
  await page.fill('input[name="venueName"]', "Oakfield Astro");
  await page.fill('input[name="venueAddress"]', "2 Oak Lane");
  await page.selectOption('select[name="weekday"]', slot.weekday);
  // Later again than both the Meadow Park and Riverside Turf kickoffs, same
  // weekday and reminder instant, so this fixture always sorts after both of
  // theirs and never disturbs `dashboard`'s `nth=0` card.
  await page.fill('input[name="kickoffTime"]', "21:00");
  await page.fill('input[name="minPlayers"]', "1");
  await page.fill('input[name="maxPlayers"]', "4");
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/g\/[^/]+$/);

  const gameId = new URL(page.url()).pathname.split("/")[2]!;
  const inviteToken = (await page.inputValue("#invite-url")).split("/j/")[1]!;

  for (const person of HIDDEN_SQUAD) {
    await joinSquadMember(browser, gameId, inviteToken, person);
  }

  await page.request.get(`${BASE_URL}/cdn-cgi/handler/scheduled?cron=15+3+*+*+*`);
  await page.request.get(`${BASE_URL}/cdn-cgi/handler/scheduled?cron=0+*+*+*+*`);

  const [fixture] = await query<{ id: string }>(
    `SELECT id FROM fixtures WHERE game_id = '${gameId}'
       AND lifecycle = 'open' ORDER BY kicks_off_at LIMIT 1`,
  );
  if (!fixture) throw new Error(`buildVisibilityDemo: game ${gameId} has no open fixture`);

  const players = await query<{ id: string; email: string }>(
    `SELECT id, email FROM players WHERE email LIKE '%@example.test'`,
  );
  const idFor = (email: string): string => {
    const found = players.find((p) => p.email === email);
    if (!found) throw new Error(`buildVisibilityDemo: no player row for ${email}`);
    return found.id;
  };

  // The organiser plus both joiners answer in — three in, so the hidden
  // count reads "3 in so far." rather than the less legible "1".
  const answering = [GUIDE_ORGANISER, ...HIDDEN_SQUAD.map((p) => p.email)];
  let hiddenSquadToken = "";
  for (const email of answering) {
    const token = await signResponseToken(
      { playerId: idFor(email), fixtureId: fixture.id, expiresAt: Date.now() + 7 * 864e5 },
      RESPONSE_SECRET,
    );
    await page.request.post(`${BASE_URL}/r/${token}`, {
      form: { intent: "in" },
      headers: { origin: BASE_URL },
    });
    if (email === HIDDEN_SQUAD[0]!.email) hiddenSquadToken = token;
  }

  // Turn the setting off through the edit form — the same route and the same
  // checkbox an organiser uses — not a direct write.
  await page.goto(`/g/${gameId}/edit`);
  await page.uncheck("#squadVisibleToPlayers");
  await page.click('button[type="submit"]');
  await page.waitForURL(new RegExp(`/g/${gameId}$`));

  return hiddenSquadToken;
}

/**
 * A fourth, small game solely for chapter 7's "recording a result"
 * screenshot (M25, BR-37). It cannot reuse the Meadow Park Kickabout's own
 * fixture: that one kicks off later today or tomorrow (`guideSlot`), and a
 * result can only be recorded once a fixture has actually been played — so
 * this game's own fixture is backdated directly, the same way
 * `test/browser/result.spec.ts`'s `playFixture` does it, since there is no
 * product route that edits a kickoff once a fixture exists.
 *
 * The state this leaves for the shot: the organiser has filed "3–1", through
 * the app's own form, so the panel a second squad member opens shows a real
 * candidate with a real backer count and their own Agree button — not an
 * empty panel, which chapter 7's prose has more to say about than a picture
 * of nothing could show.
 */
async function buildResultDemo(
  page: Page,
  browser: Browser,
  slot: { weekday: string; kickoffTime: string },
): Promise<{ gameId: string; fixtureId: string; agreeingPlayerEmail: string }> {
  const RESULT_SQUAD = [
    { name: "Ella Whitmore", email: "ella@example.test" },
    { name: "Marcus Aidoo", email: "marcus@example.test" },
  ] as const;
  const agreeingPlayer = RESULT_SQUAD[1];

  await page.goto("/g/new");
  await page.fill('input[name="name"]', "Bellview Five-a-side");
  await page.fill('input[name="venueName"]', "Bellview Astro");
  await page.fill('input[name="venueAddress"]', "3 Bell Row");
  await page.selectOption('select[name="weekday"]', slot.weekday);
  // Later again than every other demo game's kickoff, same weekday and
  // reminder instant, so it never displaces the Meadow Park fixture from
  // `dashboard`'s `nth=0` card while it is still `scheduled`/`open` — and,
  // once backdated below, it is `played` and off the dashboard's upcoming
  // list entirely.
  await page.fill('input[name="kickoffTime"]', "22:00");
  await page.fill('input[name="minPlayers"]', "1");
  await page.fill('input[name="maxPlayers"]', "3");
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/g\/[^/]+$/);

  const gameId = new URL(page.url()).pathname.split("/")[2]!;
  const inviteToken = (await page.inputValue("#invite-url")).split("/j/")[1]!;

  for (const person of RESULT_SQUAD) {
    await joinSquadMember(browser, gameId, inviteToken, person);
  }

  await page.request.get(`${BASE_URL}/cdn-cgi/handler/scheduled?cron=15+3+*+*+*`);
  await page.request.get(`${BASE_URL}/cdn-cgi/handler/scheduled?cron=0+*+*+*+*`);

  const [fixture] = await query<{ id: string }>(
    `SELECT id FROM fixtures WHERE game_id = '${gameId}'
       AND lifecycle = 'open' ORDER BY kicks_off_at LIMIT 1`,
  );
  if (!fixture) throw new Error(`buildResultDemo: game ${gameId} has no open fixture`);

  const players = await query<{ id: string; email: string }>(
    `SELECT id, email FROM players WHERE email LIKE '%@example.test'`,
  );
  const idFor = (email: string): string => {
    const found = players.find((p) => p.email === email);
    if (!found) throw new Error(`buildResultDemo: no player row for ${email}`);
    return found.id;
  };

  // Everyone answers in, including the agreeing player: BR-37 §6's
  // electorate needs a `responses.status = 'in'` row for this fixture, and
  // without one there is nothing for `resultElectorate` to admit them by.
  const answering = [GUIDE_ORGANISER, ...RESULT_SQUAD.map((p) => p.email)];
  for (const email of answering) {
    const token = await signResponseToken(
      { playerId: idFor(email), fixtureId: fixture.id, expiresAt: Date.now() + 7 * 864e5 },
      RESPONSE_SECRET,
    );
    await page.request.post(`${BASE_URL}/r/${token}`, {
      form: { intent: "in" },
      headers: { origin: BASE_URL },
    });
  }

  // Backdate the kickoff and ask the sweep to retire it — the only way a
  // fixture becomes `played` (see this function's own doc comment).
  //
  // To the most recent 19:00 that has already reached full time, not "three
  // hours ago": a morning capture otherwise photographs a 07:30 kickoff. Its
  // result window runs a day past full time, so it is always still open.
  const now = Date.now();
  const today = toLocalParts(new Date(now), GAME_ZONE);
  const eveningOf = (daysBack: number): number => {
    const day = new Date(Date.UTC(today.year, today.month - 1, today.day - daysBack));
    return toUtc(
      {
        year: day.getUTCFullYear(),
        month: day.getUTCMonth() + 1,
        day: day.getUTCDate(),
        hour: 19,
        minute: 0,
        second: 0,
      },
      GAME_ZONE,
    ).getTime();
  };
  const [{ durationMinutes } = { durationMinutes: 60 }] = await query<{ durationMinutes: number }>(
    `SELECT duration_minutes AS durationMinutes FROM fixtures WHERE id = '${fixture.id}'`,
  );
  const fullTimePassed = (kickoff: number): boolean => kickoff + durationMinutes * 60_000 < now;
  const kickoff = fullTimePassed(eveningOf(0)) ? eveningOf(0) : eveningOf(1);
  await execSql(`UPDATE fixtures SET kicks_off_at = ${kickoff} WHERE id = '${fixture.id}'`);
  await page.request.get(`${BASE_URL}/cdn-cgi/handler/scheduled?cron=0+*+*+*+*`);

  const [retired] = await query<{ lifecycle: string }>(
    `SELECT lifecycle FROM fixtures WHERE id = '${fixture.id}'`,
  );
  if (retired?.lifecycle !== "played") {
    throw new Error(
      `buildResultDemo: ${fixture.id} did not retire to 'played' (lifecycle now ${retired?.lifecycle})`,
    );
  }

  // File the claim through the app's own form, as the organiser — signed in
  // already, and the page this call leaves `page` on is what the next demo
  // (or the capture run itself) navigates away from next.
  await page.goto(`/g/${gameId}/f/${fixture.id}`);
  await page.fill('input[name="scoreA"]', "3");
  await page.fill('input[name="scoreB"]', "1");
  await page.click('button:has-text("Record it")');
  await page.waitForLoadState("networkidle");

  return { gameId, fixtureId: fixture.id, agreeingPlayerEmail: agreeingPlayer.email };
}

/**
 * The Meadow Park Kickabout's last eight weeks, oldest first, by email handle.
 *
 * Without these the guide photographed a game on its first night: no
 * Standings, no Your record, and a past-fixtures list borrowed from a
 * three-person demo game. Chapter 7 describes all three at length, so the
 * pictures have to come from a squad that has actually played.
 *
 * `a` is side A; everyone else playing that week was side B. Ade Sowande is in
 * none of them — he is the member who never answers, and a season behind him
 * would contradict chapter 3.
 *
 * Six settle, one was called off, and one was played with nothing ever filed.
 * The last is what puts an NR column in Your record, which chapter 7 explains
 * and a clean history would never show.
 */
const SEASON: readonly (
  | {
      weeksAgo: number;
      sitOut: readonly string[];
      a: readonly string[];
      result: { outcome: "a" | "b" | "draw"; scoreA: number; scoreB: number } | null;
    }
  | { weeksAgo: number; cancelled: string }
)[] = [
  {
    weeksAgo: 8,
    sitOut: ["mika", "grace", "sam"],
    a: ["jamie", "priya", "tom", "diego", "lucy"],
    result: { outcome: "a", scoreA: 5, scoreB: 3 },
  },
  {
    weeksAgo: 7,
    sitOut: ["omar", "rob", "sam"],
    a: ["jamie", "sarah", "ken", "nina", "mika"],
    result: { outcome: "b", scoreA: 2, scoreB: 4 },
  },
  { weeksAgo: 6, cancelled: "Pitch closed, waterlogged." },
  {
    weeksAgo: 5,
    sitOut: ["tom", "nina", "grace"],
    a: ["priya", "diego", "omar", "rob", "sam"],
    result: { outcome: "draw", scoreA: 3, scoreB: 3 },
  },
  {
    weeksAgo: 4,
    sitOut: ["ken", "mika", "sam"],
    a: ["priya", "tom", "lucy", "nina", "grace"],
    result: { outcome: "a", scoreA: 6, scoreB: 2 },
  },
  {
    weeksAgo: 3,
    sitOut: ["priya", "lucy", "rob"],
    a: ["jamie", "tom", "ken", "nina", "sam"],
    result: null,
  },
  {
    weeksAgo: 2,
    sitOut: ["diego", "omar", "grace"],
    a: ["jamie", "priya", "sarah", "rob", "sam"],
    result: { outcome: "b", scoreA: 1, scoreB: 2 },
  },
  {
    weeksAgo: 1,
    sitOut: ["sarah", "nina", "sam"],
    a: ["priya", "diego", "lucy", "mika", "grace"],
    result: { outcome: "a", scoreA: 4, scoreB: 3 },
  },
];

/**
 * Write `SEASON` behind the Meadow Park Kickabout, as rows.
 *
 * Rows rather than the app's own forms for the reason `test/browser/world.ts`'s
 * `seedMatchHistory` gives: a fixture becomes `played` only after its kickoff
 * and a result settles only once its 48-hour window closes, so driving this
 * through the UI would take two months of wall time. The settled results are
 * still derived by the app's own hourly sweep from the claims below.
 *
 * Each kickoff is the open fixture's local wall-clock time a whole number of
 * weeks earlier, counted in calendar days in `GAME_ZONE`: subtracting 7 × 24
 * hours across a clock change would print every older fixture an hour off.
 */
async function seedSeason(
  page: Page,
  gameId: string,
  openFixtureId: string,
  idFor: (email: string) => string,
): Promise<void> {
  const [open] = await query<{
    kicksOffAt: number;
    minPlayers: number;
    maxPlayers: number;
    prefersEvenNumbers: number;
    shortWarningOffsetHours: number;
    durationMinutes: number;
  }>(
    `SELECT kicks_off_at AS kicksOffAt, min_players AS minPlayers, max_players AS maxPlayers,
            prefers_even_numbers AS prefersEvenNumbers,
            short_warning_offset_hours AS shortWarningOffsetHours,
            duration_minutes AS durationMinutes
       FROM fixtures WHERE id = '${openFixtureId}'`,
  );
  if (!open) throw new Error(`seedSeason: open fixture ${openFixtureId} has no row`);

  const HOUR = 60 * 60 * 1000;
  const openLocal = toLocalParts(new Date(open.kicksOffAt), GAME_ZONE);
  const weeksBefore = (weeks: number): number => {
    const day = new Date(Date.UTC(openLocal.year, openLocal.month - 1, openLocal.day - 7 * weeks));
    return toUtc(
      {
        ...openLocal,
        year: day.getUTCFullYear(),
        month: day.getUTCMonth() + 1,
        day: day.getUTCDate(),
      },
      GAME_ZONE,
    ).getTime();
  };

  const pool = [GUIDE_ORGANISER, ...SQUAD.slice(0, 12).map((p) => p.email)];
  const byHandle = (handle: string): string => {
    const email = `${handle}@example.test`;
    if (!pool.includes(email)) throw new Error(`seedSeason: ${handle} is not in the pool`);
    return email;
  };

  const fixtureRows: string[] = [];
  const responseRows: string[] = [];
  const claimRows: string[] = [];
  let expectedSettled = 0;

  for (const week of SEASON) {
    const fixtureId = randomUUID();
    const kickoff = weeksBefore(week.weeksAgo);
    const shape =
      `${open.minPlayers}, ${open.maxPlayers}, ${open.prefersEvenNumbers}, ` +
      `${open.shortWarningOffsetHours}, ${open.durationMinutes}`;

    if ("cancelled" in week) {
      fixtureRows.push(
        `('${fixtureId}', '${gameId}', ${kickoff}, 'cancelled', ${shape}, 0, 0, ` +
          `${kickoff - 34 * HOUR}, NULL, NULL, ${kickoff - 6 * HOUR}, ` +
          `'${week.cancelled.replace(/'/g, "''")}')`,
      );
      continue;
    }

    const sitOut = week.sitOut.map(byHandle);
    const sideA = new Set(week.a.map(byHandle));
    const playing = pool.filter((email) => !sitOut.includes(email));
    if (playing.length !== open.maxPlayers || sideA.size * 2 !== playing.length) {
      throw new Error(
        `seedSeason: week ${week.weeksAgo} has ${playing.length} playing and ` +
          `${sideA.size} on side A. Each week must be a full, even ${open.maxPlayers}.`,
      );
    }

    fixtureRows.push(
      `('${fixtureId}', '${gameId}', ${kickoff}, 'played', ${shape}, ${playing.length}, 0, ` +
        `${kickoff - 34 * HOUR}, ${kickoff - 3 * HOUR}, ${kickoff - 3 * HOUR}, NULL, NULL)`,
    );
    for (const email of playing) {
      const side = sideA.has(email) ? "a" : "b";
      responseRows.push(
        `('${randomUUID()}', '${fixtureId}', '${idFor(email)}', 'in', '${side}', ${kickoff - 30 * HOUR}, 'web')`,
      );
    }
    for (const email of sitOut) {
      responseRows.push(
        `('${randomUUID()}', '${fixtureId}', '${idFor(email)}', 'out', NULL, ${kickoff - 30 * HOUR}, 'web')`,
      );
    }

    if (week.result) {
      expectedSettled += 1;
      // Two agreeing claims from people who played: one person's word does
      // not settle a result.
      for (const email of playing.slice(0, 2)) {
        claimRows.push(
          `('${randomUUID()}', '${fixtureId}', '${idFor(email)}', '${week.result.outcome}', ` +
            `${week.result.scoreA}, ${week.result.scoreB}, ${kickoff + 2 * HOUR}, ${kickoff + 2 * HOUR})`,
        );
      }
    }
  }

  await execSql(
    `INSERT INTO fixtures (id, game_id, kicks_off_at, lifecycle, min_players, max_players,
       prefers_even_numbers, short_warning_offset_hours, duration_minutes, in_count,
       waitlist_count, opened_at, teams_published_at, teams_saved_at, cancelled_at,
       cancellation_reason)
     VALUES ${fixtureRows.join(", ")};
     INSERT INTO responses (id, fixture_id, player_id, status, team, responded_at, source)
     VALUES ${responseRows.join(", ")};
     INSERT INTO fixture_result_claims
       (id, fixture_id, player_id, outcome, score_a, score_b, filed_at, created_at)
     VALUES ${claimRows.join(", ")}`,
  );

  // Everyone who played the season joined before it began, or the member page
  // says "Player, since" today beside eight weeks of results. The organiser
  // first, the rest over the following days; Ade stays today's joiner.
  const firstKickoff = weeksBefore(Math.max(...SEASON.map((week) => week.weeksAgo)));
  const joinedRows = pool.map(
    (email, position) =>
      `WHEN '${idFor(email)}' THEN ${firstKickoff - 14 * 24 * HOUR + position * 9 * HOUR}`,
  );
  await execSql(
    `UPDATE memberships SET joined_at = CASE player_id ${joinedRows.join(" ")} ELSE joined_at END
       WHERE game_id = '${gameId}'`,
  );

  // The hourly sweep is what turns claims into the `fixture_results` rows
  // Standings and Your record read.
  await page.request.get(`${BASE_URL}/cdn-cgi/handler/scheduled?cron=0+*+*+*+*`);

  const [settled] = await query<{ n: number }>(
    `SELECT count(*) AS n FROM fixture_results r
       JOIN fixtures f ON f.id = r.fixture_id WHERE f.game_id = '${gameId}'`,
  );
  if ((settled?.n ?? 0) !== expectedSettled) {
    throw new Error(
      `seedSeason: ${settled?.n ?? 0} of ${expectedSettled} results settled. ` +
        `Standings and Your record read fixture_results, so a short count ` +
        `photographs as an empty table.`,
    );
  }
}

/** The squad, for the guide's prose and its tests. */
export const GUIDE_SQUAD = SQUAD;

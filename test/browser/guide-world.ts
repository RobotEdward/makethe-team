import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Browser, Page } from "@playwright/test";
import { leaveTokenExpiry, signCancelToken, signLeaveToken, signResponseToken } from "../../src/domain/token.js";
import { toLocalParts } from "../../src/domain/time/zone.js";
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

export interface GuideWorld {
  gameId: string;
  fixtureId: string;
  inviteToken: string;
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
   * chapter 3's "0 spots left" and Ade Sowande shown as not yet responded,
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
}

export async function buildGuideWorld(page: Page, browser: Browser): Promise<GuideWorld> {
  await signIn(page, GUIDE_ORGANISER);

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

  // Each joiner in its own context: a joiner carrying the organiser's session
  // would exercise a path no real visitor takes.
  for (const person of SQUAD) {
    const context = await browser.newContext();
    const joinerPage = await context.newPage();
    await joinerPage.goto(`/j/${inviteToken}`);
    await joinerPage.fill('input[name="name"]', person.name);
    await joinerPage.fill('input[name="email"]', person.email);
    await joinerPage.click('button[type="submit"]');
    await joinerPage.waitForLoadState("networkidle");
    await context.close();
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

  const demo = await buildOverrideDemo(page, browser, slot);
  const hiddenSquadToken = await buildVisibilityDemo(page, browser, slot);

  return {
    gameId,
    fixtureId: fixture.id,
    inviteToken,
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
    const context = await browser.newContext();
    const joinerPage = await context.newPage();
    await joinerPage.goto(`/j/${inviteToken}`);
    await joinerPage.fill('input[name="name"]', person.name);
    await joinerPage.fill('input[name="email"]', person.email);
    await joinerPage.click('button[type="submit"]');
    await joinerPage.waitForLoadState("networkidle");
    await context.close();
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
  await neverAnswersRow.getByRole("button", { name: "Mark in" }).click();
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Add them anyway" }).click();
  await page.waitForLoadState("networkidle");

  // The guest add, through the same page's own form. Now five in against a
  // cap of four, so it needs the same confirmation.
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
    const context = await browser.newContext();
    const joinerPage = await context.newPage();
    await joinerPage.goto(`/j/${inviteToken}`);
    await joinerPage.fill('input[name="name"]', person.name);
    await joinerPage.fill('input[name="email"]', person.email);
    await joinerPage.click('button[type="submit"]');
    await joinerPage.waitForLoadState("networkidle");
    await context.close();
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

/** The squad, for the guide's prose and its tests. */
export const GUIDE_SQUAD = SQUAD;

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Browser, Page } from "@playwright/test";
import { signCancelToken, signResponseToken } from "../../src/domain/token.js";
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

/** Matches `test/browser/browser.env`. Separate from the response secret. */
const CANCEL_SECRET = "local-browser-tests-only-not-a-real-secret";

const WEEKDAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;

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
 * Before 21:00 local, kick off two hours from now on today's weekday: the
 * reminder instant was 09:00 yesterday, and the fixture has not ended. After
 * 21:00, two hours from now would cross midnight and land in the past, so use
 * tomorrow at noon, whose reminder instant was 09:00 today.
 */
function imminentSlot(now: Date): { weekday: string; kickoffTime: string } {
  const hour = now.getHours();
  if (hour < 21) {
    return {
      weekday: WEEKDAY_CODES[now.getDay()]!,
      kickoffTime: `${String(hour + 2).padStart(2, "0")}:00`,
    };
  }
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  return { weekday: WEEKDAY_CODES[tomorrow.getDay()]!, kickoffTime: "12:00" };
}

/** The joined member's display name, asserted on by the journeys. */
export const JOINER_NAME = "Alex Morgan";

export interface World {
  gameId: string;
  fixtureId: string;
  inviteToken: string;
  /** The joined member — the one the squad-management pages act on. */
  memberPlayerId: string;
  responseToken: string;
  ownerPlayerId: string;
  cancelToken: string;
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
  options: { javaScriptEnabled?: boolean } = {},
): Promise<World> {
  await signIn(page, TEST_OWNER);

  // --- the game -----------------------------------------------------------
  await page.goto("/g/new");
  await page.fill('input[name="name"]', "Thursday 7-a-side");
  await page.fill('input[name="venueName"]', "Peckham Rye Astro");
  const slot = imminentSlot(new Date());
  await page.selectOption('select[name="weekday"]', slot.weekday);
  await page.fill('input[name="kickoffTime"]', slot.kickoffTime);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/g\/[^/]+$/);

  const gameId = new URL(page.url()).pathname.split("/")[2]!;
  const inviteUrl = await page.inputValue("#invite-url");
  const inviteToken = inviteUrl.split("/j/")[1]!;

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

  const responseToken = await signResponseToken(
    {
      playerId: member.id,
      fixtureId: fixture.id,
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
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
    memberPlayerId: member.id,
    responseToken,
    ownerPlayerId: owner.id,
    cancelToken,
  };
}

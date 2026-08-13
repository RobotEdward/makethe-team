import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Browser, Page } from "@playwright/test";
import { signResponseToken } from "../../src/domain/token.js";
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

export interface World {
  gameId: string;
  fixtureId: string;
  inviteToken: string;
  /** The joined member — the one the squad-management pages act on. */
  memberPlayerId: string;
  responseToken: string;
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
export async function seedWorld(page: Page, browser: Browser): Promise<World> {
  await signIn(page, TEST_OWNER);

  // --- the game -----------------------------------------------------------
  await page.goto("/g/new");
  await page.fill('input[name="name"]', "Thursday 7-a-side");
  await page.fill('input[name="venueName"]', "Peckham Rye Astro");
  await page.selectOption('select[name="weekday"]', { index: 4 });
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/g\/[^/]+$/);

  const gameId = new URL(page.url()).pathname.split("/")[2]!;
  const inviteUrl = await page.inputValue("#invite-url");
  const inviteToken = inviteUrl.split("/j/")[1]!;

  // --- a second identity joins --------------------------------------------
  // Its own context, so the two identities never share a cookie jar: a joiner
  // carrying the owner's session would exercise a path no real visitor takes.
  const joiner = await browser.newContext();
  const joinerPage = await joiner.newPage();
  await joinerPage.goto(`/j/${inviteToken}`);
  await joinerPage.fill('input[name="name"]', "Alex Morgan");
  await joinerPage.fill('input[name="email"]', TEST_PLAYER);
  await joinerPage.click('button[type="submit"]');
  await joiner.close();

  // --- fixtures -----------------------------------------------------------
  // Materialisation is the daily cron (`15 3 * * *` in wrangler.jsonc), and
  // wrangler dev exposes it directly. Without this the game has no fixture and
  // /r/:token has nothing to point at.
  await page.request.get(`${BASE_URL}/cdn-cgi/handler/scheduled?cron=15+3+*+*+*`);

  const [fixture] = await query<{ id: string }>(
    `SELECT id FROM fixtures WHERE game_id = '${gameId}' ORDER BY kicks_off_at LIMIT 1`,
  );
  if (!fixture) throw new Error(`no fixture materialised for game ${gameId}`);

  const [member] = await query<{ id: string }>(
    `SELECT p.id AS id FROM players p WHERE p.email = '${TEST_PLAYER}' LIMIT 1`,
  );
  if (!member) throw new Error(`the joined player ${TEST_PLAYER} has no row`);

  const responseToken = await signResponseToken(
    {
      playerId: member.id,
      fixtureId: fixture.id,
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
    },
    RESPONSE_SECRET,
  );

  return {
    gameId,
    fixtureId: fixture.id,
    inviteToken,
    memberPlayerId: member.id,
    responseToken,
  };
}

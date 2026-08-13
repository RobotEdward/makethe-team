import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Browser, Page } from "@playwright/test";
import { signCancelToken, signResponseToken } from "../../src/domain/token.js";
import { BASE_URL } from "../../playwright.config.js";
import { signIn } from "./sign-in.js";
import { imminentSlot } from "./world.js";

const run = promisify(execFile);
// Both must match `test/browser/browser.env` exactly, and they are
// deliberately different from each other: `src/env.ts` keeps the response and
// cancel keys apart as a security boundary, and a suite that shared one value
// could not tell the two apart.
const RESPONSE_SECRET = "local-browser-tests-only-not-a-real-secret";
const CANCEL_SECRET = "local-browser-tests-only-not-a-real-cancel-secret";

/**
 * The organiser. Every address here is `@example.test` and every name is
 * invented: these screenshots are committed to a public repository and are
 * permanent, so nothing may resemble a real person.
 */
export const GUIDE_ORGANISER = "jamie@example.test";

/**
 * The twelve who join, in the order they answer. The first nine take the
 * remaining places (the organiser has the tenth), the next two are
 * waitlisted, and the last one cannot make it — which is how one world comes
 * to show a full fixture, a waitlist and a dropout at once.
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
] as const;

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
   * The member the removal confirmation page is shown for. Deliberately the
   * player who already answered "can't make it", so the page is not about
   * someone holding a place — removing them would trigger a promotion and
   * the screenshot would describe a different situation from the one the
   * chapter is explaining.
   */
  removablePlayerId: string;
}

export async function buildGuideWorld(page: Page, browser: Browser): Promise<GuideWorld> {
  await signIn(page, GUIDE_ORGANISER);

  await page.goto("/g/new");
  await page.fill('input[name="name"]', "Thursday Night Football");
  await page.fill('input[name="venueName"]', "Meadow Park 3G");
  await page.fill('input[name="venueAddress"]', "14 Meadow Lane");

  // The weekday and kickoff time must be chosen from the clock, not fixed.
  // A fixture only opens once its reminder instant — 09:00 the day before
  // kickoff — has passed and it has not yet ended, so a hardcoded weekday
  // leaves the first fixture up to a week away and permanently `scheduled`.
  // `imminentSlot` is exported from `./world.js`, where Task 1 added it after
  // exactly this bug made the browser suite pass only on the luck of the hour
  // it was run. Do not reimplement it here.
  const slot = imminentSlot(new Date());
  await page.selectOption('select[name="weekday"]', slot.weekday);
  await page.fill('input[name="kickoffTime"]', slot.kickoffTime);

  await page.fill('input[name="minPlayers"]', "8");
  // Max 10 rather than the default 14: with thirteen members answering, a
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
      `buildGuideWorld: expected ${SQUAD.length + 1} members, found ${squadSize}. ` +
        `Every screenshot depends on this world being what it claims.`,
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

  return {
    gameId,
    fixtureId: fixture.id,
    inviteToken,
    inToken: await tokenFor(GUIDE_ORGANISER),
    waitlistedToken: await tokenFor(SQUAD[10]!.email),
    outToken,
    removablePlayerId: idFor(outEmail),
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

/** The squad, for the guide's prose and its tests. */
export const GUIDE_SQUAD = SQUAD;

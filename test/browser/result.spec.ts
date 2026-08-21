import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { fixturePath } from "../../src/auth/paths.js";
import type { ResultOutcome } from "../../src/domain/result.js";
import { BASE_URL } from "../../playwright.config.js";
import { signIn, TEST_OWNER, TEST_PLAYER } from "./sign-in.js";
import { seedWorld, type World } from "./world.js";

const run = promisify(execFile);

/**
 * The result panel (M25, BR-37): the browser tier for the one page string
 * assertions cannot finish checking — CLAUDE.md's third milestone rule. Tasks
 * 1-13 covered the domain, the queries and the write routes at the fetch
 * level; what is left is what only a real browser can see: an unstyled
 * input, an illegible radio label, a control that only *looks* aligned in the
 * markup, and whether any of it still works with JavaScript off.
 */

/** Matches `test/browser/world.ts`'s own private helper — see its comment. */
async function execSql(sql: string): Promise<void> {
  await run("npx", ["wrangler", "d1", "execute", "makethe-team", "--local", "--command", sql], {
    cwd: process.cwd(),
    maxBuffer: 4 * 1024 * 1024,
  });
}

async function querySql<T>(sql: string): Promise<T[]> {
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
 * Move a fixture from `open` to `played`, the way only the hourly sweep
 * (`retirePastFixtures`) can — there is no product route that edits a
 * kickoff once a fixture exists, so the kickoff is backdated directly and
 * the sweep is asked to run, exactly as `seedWorld` already asks the sweep to
 * *open* a fixture rather than inserting a row that says it is open.
 *
 * Three hours ago clears every fixture's duration (`seedWorld` never sets
 * one above the form's 60-minute default) and stays nowhere near the
 * 48-hour result-lock window (BR-37), so the fixture just retired is still
 * writable.
 */
async function playFixture(page: Page, fixtureId: string): Promise<void> {
  const kicksOffAt = Date.now() - 3 * 60 * 60 * 1000;
  await execSql(`UPDATE fixtures SET kicks_off_at = ${kicksOffAt} WHERE id = '${fixtureId}'`);
  await page.request.get(`${BASE_URL}/cdn-cgi/handler/scheduled?cron=0+*+*+*+*`);

  const [fixture] = await querySql<{ lifecycle: string }>(
    `SELECT lifecycle FROM fixtures WHERE id = '${fixtureId}'`,
  );
  if (fixture?.lifecycle !== "played") {
    throw new Error(`playFixture: ${fixtureId} did not retire to 'played' (lifecycle now ${fixture?.lifecycle})`);
  }
}

/**
 * Mark the joined member `in` for the fixture, via the same public,
 * token-only page a reminder email links to — never a session, so this
 * works identically whether or not the caller's own context has JavaScript.
 * Without this the joiner has no `responses` row and `resultElectorate`
 * (`src/db/result-queries.ts`) leaves them out of the electorate entirely, so
 * the Agree and file forms this suite depends on would simply not render.
 */
async function markJoinerIn(browser: Browser, world: World, javaScriptEnabled: boolean): Promise<void> {
  const context = await browser.newContext({ javaScriptEnabled });
  const page = await context.newPage();
  await page.goto(`/r/${world.responseToken}`);
  await page.click('button[name="intent"][value="in"]');
  await context.close();
}

/**
 * Seed a `fixture_result_claims` row directly, bypassing both the app and a
 * signed-in identity. Reserved for the row-shape test below, which needs
 * five distinct backers and cares only about how their rows lay out, never
 * about the filing route itself — that is exercised end to end, through the
 * real form, by the two flow tests above it. A player row is inserted first
 * because the claim has a `NOT NULL` foreign key to one, and `listResultClaims`
 * inner-joins `players` for a display name.
 */
async function seedClaim(
  fixtureId: string,
  claim: { outcome: ResultOutcome; scoreA: number | null; scoreB: number | null },
): Promise<void> {
  const playerId = randomUUID();
  const now = Date.now();
  await execSql(`INSERT INTO players (id, name) VALUES ('${playerId}', 'Backer ${playerId.slice(0, 8)}')`);
  const scoreA = claim.scoreA === null ? "NULL" : String(claim.scoreA);
  const scoreB = claim.scoreB === null ? "NULL" : String(claim.scoreB);
  await execSql(
    `INSERT INTO fixture_result_claims (id, fixture_id, player_id, outcome, score_a, score_b, filed_at) ` +
      `VALUES ('${randomUUID()}', '${fixtureId}', '${playerId}', '${claim.outcome}', ${scoreA}, ${scoreB}, ${now})`,
  );
}

/**
 * The whole life of one result: filed by the owner, agreed by the joined
 * member, then withdrawn — run once with JavaScript on and once off, so the
 * same assertions prove both that the feature works and that it needed none
 * of the client script running everywhere else on this page (the freshness
 * bar's own script ships on this route too).
 */
async function recordAgreeAndWithdraw(browser: Browser, javaScriptEnabled: boolean): Promise<void> {
  const ownerContext = await browser.newContext({ javaScriptEnabled });
  const ownerPage = await ownerContext.newPage();
  const world = await seedWorld(ownerPage, browser, { javaScriptEnabled });

  await markJoinerIn(browser, world, javaScriptEnabled);
  await playFixture(ownerPage, world.fixtureId);

  const path = fixturePath(world.gameId, world.fixtureId);
  await ownerPage.goto(path);
  await expect(ownerPage.getByText("No result recorded yet.")).toBeVisible();

  await ownerPage.fill('input[name="scoreA"]', "3");
  await ownerPage.fill('input[name="scoreB"]', "1");
  await ownerPage.click('button:has-text("Record it")');

  const ownerRow = ownerPage.locator(".result-candidate");
  await expect(ownerRow).toHaveCount(1);
  await expect(ownerRow.locator(".result-claim")).toHaveText("Team A won 3–1");
  await expect(ownerRow.locator(".result-backers")).toHaveText("1 backer");
  await expect(ownerRow.locator(".result-yours")).toBeVisible();
  await ownerContext.close();

  const joinerContext = await browser.newContext({ javaScriptEnabled });
  const joinerPage = await joinerContext.newPage();
  await signIn(joinerPage, TEST_PLAYER);
  await joinerPage.goto(path);

  const joinerRow = joinerPage.locator(".result-candidate");
  await expect(joinerRow).toHaveCount(1);
  await joinerRow.locator("form button.button").click();
  await expect(joinerRow.locator(".result-backers")).toHaveText("2 backers");
  await expect(joinerRow.locator(".result-yours")).toBeVisible();

  await joinerPage.locator("button.result-withdraw").click();
  await expect(joinerRow.locator(".result-backers")).toHaveText("1 backer");
  await expect(joinerRow.locator(".result-yours")).toHaveCount(0);

  await joinerContext.close();
}

test("a player records a result and another agrees", async ({ browser }) => {
  await recordAgreeAndWithdraw(browser, true);
});

test("the whole flow works with JavaScript disabled", async ({ browser }) => {
  await recordAgreeAndWithdraw(browser, false);
});

/**
 * The one check string assertions cannot make (CLAUDE.md's third milestone
 * rule): that every candidate row is laid out the same way, whatever the
 * claim inside it says. `test/browser/layout.spec.ts`'s squad-row test is
 * the model — read its own comment for why only a browser's cascade can
 * settle this — and how the ragged-wrap defect in `docs/known-issues.md` was
 * originally found.
 *
 * A squad row is a fixed two-column shape (`justify-content: space-between`),
 * so every row's name and control sit at the same offset regardless of the
 * name's length. `.result-candidate` is different on purpose — it wraps
 * (`flex-wrap: wrap`), and a long claim is *meant* to take more of the row
 * before its Agree button drops to its own line. So this does not pin the
 * button's absolute position; it pins the one thing wrapping must not change:
 * `margin: 0 0 0 auto` (`RESULT_CSS`) means the button's right edge should
 * always land the same distance from the row's own right edge, whichever
 * line it ends up on. The claim text's left offset is pinned the same way,
 * against the row's left edge.
 */
test("candidate rows have the same shape whatever the claim's length", async ({ page, browser }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const world = await seedWorld(page, browser);

  // A side name long enough to force real wrapping at 390px, so the test
  // means something — a short name would fit on one line regardless of any
  // bug in how the wrap is handled.
  await execSql(
    `UPDATE games SET team_a_name = 'Association Football Reserves Extraordinaire' WHERE id = '${world.gameId}'`,
  );
  await playFixture(page, world.fixtureId);

  // Five distinct claims, chosen for very different claim-text lengths: a
  // long side name with a score, a short side name with no score, a draw
  // with a score, the long name with no score, and a two-digit scoreline.
  await seedClaim(world.fixtureId, { outcome: "a", scoreA: 5, scoreB: 0 });
  await seedClaim(world.fixtureId, { outcome: "b", scoreA: null, scoreB: null });
  await seedClaim(world.fixtureId, { outcome: "draw", scoreA: 2, scoreB: 2 });
  await seedClaim(world.fixtureId, { outcome: "a", scoreA: null, scoreB: null });
  await seedClaim(world.fixtureId, { outcome: "b", scoreA: 12, scoreB: 11 });

  await page.goto(fixturePath(world.gameId, world.fixtureId));

  const rows = page.locator(".result-candidate");
  const count = await rows.count();
  expect(count, "need all five seeded candidates to mean anything").toBe(5);

  const shapes: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const row = rows.nth(index);
    const rowBox = (await row.boundingBox())!;
    const claimBox = (await row.locator(".result-claim").boundingBox())!;
    const buttonBox = (await row.locator("form button.button").boundingBox())!;

    shapes.push(
      JSON.stringify({
        claimLeftOffset: Math.round(claimBox.x - rowBox.x),
        buttonRightOffset: Math.round(rowBox.x + rowBox.width - (buttonBox.x + buttonBox.width)),
      }),
    );
  }

  expect(
    new Set(shapes).size,
    `candidate rows are laid out differently from one another: ${shapes.join(" vs ")}`,
  ).toBe(1);
});

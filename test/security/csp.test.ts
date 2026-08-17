import { SELF, env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { FONT_ORIGINS } from "../../src/security/csp.js";
import { getDb } from "../../src/db/client.js";
import { fixtures, games, memberships, players } from "../../src/db/schema.js";
import { openFixture } from "../../src/domain/open-fixture.js";
import { leaveTokenExpiry, signCancelToken, signLeaveToken, signResponseToken } from "../../src/domain/token.js";
import { insertGame, insertMembership, insertPlayer, resetDatabase, testDb } from "../support/factories.js";
import { ALLOWED, signIn } from "../support/sign-in.js";
import { kickoffIn, NOW } from "../support/clock.js";
import { SCRIPT_BLOCKS } from "../../src/views/scripts.js";

/**
 * Task 9's CSP header, asserted two ways on every page the app renders:
 *
 * 1. The header's literal directives — `default-src`, `script-src`,
 *    `form-action`, `frame-ancestors`, `base-uri` never change per request,
 *    so these are pinned exactly.
 * 2. `style-src`'s hashes are cross-checked against the *actual* bytes each
 *    response inlines between `<style>` and `</style>`, computed
 *    independently here with the same Web Crypto API a real browser uses —
 *    not by re-importing the app's own hashing function, which would only
 *    prove the implementation agrees with itself.
 *
 * `robots.txt` and the 404 page carry no `<style>` block at all, so only (1)
 * applies to them.
 */

const db = getDb(env.DB);
const RESPONSE_SECRET = env.RESPONSE_TOKEN_SECRET;
const CANCEL_SECRET = env.CANCEL_TOKEN_SECRET;
// Relative to the real clock, not pinned to a date — see `test/support/clock.ts`.
// These instants are seeded into rows, but `/cancel/:token` and `/r/:token`
// verify their tokens and judge the fixture against the wall clock — so a
// hardcoded kickoff silently stops being in the future, and from that day on
// the cancellation page refuses every request and renders the link-problem
// page instead. Both CSP assertions then describe the wrong page. That is
// exactly what happened: this file was pinned to 2026-08-13 and began failing
// on every branch once that evening passed — the first of six files to do so.
const KICKOFF = kickoffIn(9);

async function sha256Base64(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return btoa(String.fromCharCode(...new Uint8Array(digest)));
}

/** Every `<style>...</style>` block's exact inner text, in document order. */
function inlineStyleBlocks(html: string): string[] {
  return [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((match) => match[1] ?? "");
}

function inlineScriptBlocks(html: string): string[] {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1] ?? "");
}

interface Seeded {
  gameId: string;
  fixtureId: string;
  playerId: string;
}

async function seedOpenFixture(): Promise<Seeded> {
  const gameId = await insertGame(db, { name: "Thursday 7-a-side", maxPlayers: 14 });
  const fixtureId = crypto.randomUUID();
  await db.insert(fixtures).values({
    id: fixtureId,
    gameId,
    kicksOffAt: KICKOFF,
    minPlayers: 10,
    maxPlayers: 14,
    prefersEvenNumbers: true,
    shortWarningOffsetHours: 12,
    durationMinutes: 60,
  });
  const playerId = crypto.randomUUID();
  await db.insert(players).values({ id: playerId, name: "Edward Cooper", email: "edward@example.com" });
  await db.insert(memberships).values({
    id: crypto.randomUUID(),
    gameId,
    playerId,
    active: true,
    role: "owner",
    // Pinned to the suite's clock, like `insertMembership` does: the leave
    // page refuses a token minted before the membership began, and the
    // column's own default is the wall clock at insert.
    joinedAt: NOW,
  });
  await openFixture(db, fixtureId, NOW);
  return { gameId, fixtureId, playerId };
}

interface SeededGame {
  gameId: string;
  cookie: string;
  inviteToken: string;
}

/**
 * A game owned by the signed-in player, for the four `/g/*` and `/j/*` pages
 * M6a adds. Membership is inserted directly rather than driven through
 * `POST /g/new` — this suite is about the CSP header, not game creation,
 * which `test/routes/games.test.ts` already covers.
 */
async function seedOwnedGame(): Promise<SeededGame> {
  const { cookie } = await signIn();
  const [viewer] = await db.select().from(players).where(eq(players.email, ALLOWED));
  const gameId = await insertGame(db, { name: "Thursday 7-a-side" });
  await insertMembership(db, gameId, viewer!.id, { role: "owner", active: true });
  const [game] = await db.select().from(games).where(eq(games.id, gameId));
  return { gameId, cookie, inviteToken: game!.inviteToken };
}

beforeEach(async () => {
  await resetDatabase();
});

/** The CSP header as served for the holding page — any page carries the same fixed directives. */
async function cspHeader(): Promise<string> {
  const response = await SELF.fetch("https://makethe.team/");
  return response.headers.get("content-security-policy") as string;
}

/** Assert every literal (non-`style-src`) directive this task adds. */
function expectFixedDirectives(csp: string | null) {
  expect(csp).not.toBeNull();
  expect(csp).toContain("default-src 'none'");
  expect(csp).toContain("form-action 'self'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toContain("base-uri 'none'");
  expectScriptSrcStrict(csp!);
  expectFetchTargetsAllowed(csp!);
}

/**
 * Every URL the enumerated scripts `fetch()`, taken from the scripts
 * themselves rather than restated here — the same discipline `script-src`'s
 * hashes already follow, so a script that grows a new endpoint is covered
 * without anyone remembering to update a list.
 */
function scriptFetchTargets(): string[] {
  return SCRIPT_BLOCKS.flatMap((block) =>
    [...block.matchAll(/fetch\("([^"]+)"/g)].map((match) => match[1]!),
  );
}

/**
 * **`connect-src` does not fall back to `script-src` — it falls back to
 * `default-src`, which is `'none'`.** A hash in `script-src` lets a block
 * *execute*; it says nothing about what that block may then talk to. Both
 * passkey scripts do nothing but `fetch()` Better Auth's endpoints, so with
 * no `connect-src` the browser refused every one of those calls before it
 * left the device, both buttons failed with their generic catch, and the
 * server never saw a request — which is exactly how this was found in
 * production, from a `wrangler tail` that recorded the page load and no
 * subsequent API call at all.
 *
 * `'self'` and not a wildcard: every target below is a same-origin absolute
 * path, which is asserted here too, so this directive never needs to name a
 * foreign host and must not be widened to one.
 */
function expectFetchTargetsAllowed(csp: string) {
  const targets = scriptFetchTargets();
  // Guards the assertion below against passing vacuously if the scripts are
  // ever rewritten to build their URLs some other way.
  expect(targets.length).toBeGreaterThan(0);
  for (const target of targets) expect(target.startsWith("/")).toBe(true);

  const connectSrc = csp.match(/connect-src ([^;]+)/)?.[1] ?? "";
  expect(connectSrc).toBe("'self'");
}

/**
 * `script-src` was `'none'` until M5 added passkeys — WebAuthn is a browser
 * API and cannot be done server-side, so it is the one feature that earns
 * client JavaScript. The directive must still never fall back to a blanket
 * allowance: every script on the page is allowed by hash, and `'unsafe-inline'`
 * or `'unsafe-eval'` appearing here would defeat the whole directive.
 */
function expectScriptSrcStrict(csp: string) {
  const scriptSrc = csp.match(/script-src ([^;]+)/)?.[1] ?? "";
  expect(scriptSrc).not.toBe("");
  expect(scriptSrc).not.toContain("unsafe-inline");
  expect(scriptSrc).not.toContain("unsafe-eval");
  expect(scriptSrc).not.toContain("unsafe-hashes");
  expect(scriptSrc).not.toContain("*");
}

/** Assert every inline `<script>` block the page actually sent is covered by `script-src`'s hash list. */
async function expectScriptsAllowed(csp: string, html: string) {
  const allowed = (csp.match(/script-src ([^;]+)/)?.[1] ?? "")
    .split(" ")
    .filter((token) => token.startsWith("'sha256-"))
    .map((token) => token.slice("'sha256-".length, -1));

  for (const block of inlineScriptBlocks(html)) {
    expect(allowed).toContain(await sha256Base64(block));
  }
}

/** Assert every inline `<style>` block the page actually sent is covered by `style-src`'s hash list. */
async function expectStylesAllowed(csp: string, html: string) {
  const styleSrcMatch = csp.match(/style-src ([^;]+)/);
  expect(styleSrcMatch).not.toBeNull();
  const allowedHashes = (styleSrcMatch?.[1] ?? "")
    .split(" ")
    .filter((token) => token.startsWith("'sha256-"))
    .map((token) => token.slice("'sha256-".length, -1));
  expect(allowedHashes.length).toBeGreaterThan(0);

  const blocks = inlineStyleBlocks(html);
  expect(blocks.length).toBeGreaterThan(0);
  for (const block of blocks) {
    const hash = await sha256Base64(block);
    expect(allowedHashes).toContain(hash);
  }
}

describe("Content-Security-Policy", () => {
  it("allows the two font origins and nothing wider", async () => {
    const header = await cspHeader();
    const directive = (name: string) => header.split("; ").find((d) => d.startsWith(`${name} `))!;

    // Enumerated, not merely searched. An earlier version of this test asserted
    // `styleSrc).toContain("https://fonts.googleapis.com")` and checked the
    // whole header for the substring "https:;" — which proved the required host
    // was present but said nothing about a *second* host being added beside it,
    // and caught scheme-only sources (`style-src https:`) only by accident of
    // where the join happened to put a semicolon. `style-src` is the directive
    // that also carries the hash allowlist, so a stray extra origin there is
    // the likeliest way this policy ever quietly widens. Splitting into tokens
    // and insisting every one is a known shape is what actually refuses that.
    const tokens = (name: string) => directive(name).split(" ").slice(1);

    for (const token of tokens("style-src")) {
      const known = /^'sha256-[A-Za-z0-9+/]+={0,2}'$/.test(token) || token === FONT_ORIGINS[0];
      expect(known, `unexpected style-src source: ${token}`).toBe(true);
    }
    expect(tokens("style-src")).toContain(FONT_ORIGINS[0]);
    expect(tokens("font-src")).toEqual([FONT_ORIGINS[1]]);

    // Belt and braces on the two shapes that would defeat the whole directive
    // even while every token above still looked plausible.
    expect(header).not.toContain("'unsafe-inline'");
    expect(header).not.toContain("*");
  });

  it("holding page (/): fixed directives present and inline styles covered", async () => {
    const response = await SELF.fetch("https://makethe.team/");
    const csp = response.headers.get("content-security-policy");
    expectFixedDirectives(csp);
    await expectStylesAllowed(csp as string, await response.text());
  });

  it("GET /r/:token, intent=in: fixed directives present and inline styles covered", async () => {
    const { fixtureId, playerId } = await seedOpenFixture();
    const token = await signResponseToken(
      { playerId, fixtureId, expiresAt: KICKOFF.getTime() + 86_400_000 },
      RESPONSE_SECRET,
    );
    const response = await SELF.fetch(`https://makethe.team/r/${token}?intent=in`);
    const csp = response.headers.get("content-security-policy");
    expectFixedDirectives(csp);
    await expectStylesAllowed(csp as string, await response.text());
  });

  it("GET /r/:token, intent=out: fixed directives present and inline styles covered", async () => {
    const { fixtureId, playerId } = await seedOpenFixture();
    const token = await signResponseToken(
      { playerId, fixtureId, expiresAt: KICKOFF.getTime() + 86_400_000 },
      RESPONSE_SECRET,
    );
    const response = await SELF.fetch(`https://makethe.team/r/${token}?intent=out`);
    const csp = response.headers.get("content-security-policy");
    expectFixedDirectives(csp);
    await expectStylesAllowed(csp as string, await response.text());
  });

  it("shared bad-token page: fixed directives present and inline styles covered", async () => {
    const response = await SELF.fetch("https://makethe.team/r/not-a-real-token");
    const csp = response.headers.get("content-security-policy");
    expectFixedDirectives(csp);
    await expectStylesAllowed(csp as string, await response.text());
  });

  it("GET /leave/:token: fixed directives present and inline styles covered", async () => {
    const { gameId, playerId } = await seedOpenFixture();
    const token = await signLeaveToken(
      // Minted through `leaveTokenExpiry`, like every leave link the app
      // actually sends: the route derives a token's mint time from its expiry,
      // so a hand-picked expiry would describe a token minted months ago.
      { gameId, playerId, expiresAt: leaveTokenExpiry(NOW).getTime() },
      RESPONSE_SECRET,
    );
    const response = await SELF.fetch(`https://makethe.team/leave/${token}`);
    const csp = response.headers.get("content-security-policy");
    expectFixedDirectives(csp);
    await expectStylesAllowed(csp as string, await response.text());
  });

  it("cancellation confirm page (GET /cancel/:token): fixed directives present and BOTH inline style blocks covered", async () => {
    const { fixtureId, playerId } = await seedOpenFixture();
    const token = await signCancelToken(
      { ownerPlayerId: playerId, fixtureId, expiresAt: KICKOFF.getTime() },
      CANCEL_SECRET,
    );
    const response = await SELF.fetch(`https://makethe.team/cancel/${token}`);
    const csp = response.headers.get("content-security-policy");
    expectFixedDirectives(csp);
    const html = await response.text();
    // This is the one page with two distinct inline `<style>` blocks — the
    // shared layout stylesheet AND the cancel-form-specific one. Both must
    // be covered, proving the CSP was not tuned against just the common case.
    expect(inlineStyleBlocks(html).length).toBe(2);
    await expectStylesAllowed(csp as string, html);
  });

  it("sign-in page: the passkey script is allowed by hash, not by a blanket source", async () => {
    const response = await SELF.fetch("https://makethe.team/sign-in");
    const csp = response.headers.get("content-security-policy");
    expectFixedDirectives(csp);
    const html = await response.text();
    // The only page family that ships JavaScript at all (M5 task 8: WebAuthn
    // is a browser API, so passkeys are the one feature that cannot be done
    // server-side). Asserting the block is present *and* hashed is the pair
    // that matters: without the first this would pass vacuously on a page
    // that lost its script, and without the second `script-src` could have
    // been widened to `'unsafe-inline'` and nothing here would notice.
    expect(inlineScriptBlocks(html).length).toBeGreaterThan(0);
    await expectScriptsAllowed(csp as string, html);
  });

  it("game creation form (GET /g/new): fixed directives present and inline styles covered", async () => {
    const { cookie } = await signIn();
    const response = await SELF.fetch("https://makethe.team/g/new", { headers: { cookie } });
    const csp = response.headers.get("content-security-policy");
    expectFixedDirectives(csp);
    await expectStylesAllowed(csp as string, await response.text());
  });

  /**
   * The QR code is the one thing here that would have failed CSP under an
   * `<img>`-based implementation — a `data:` or remote image source needs its
   * own `img-src` allowance, which this policy does not grant. `uqr` renders
   * an inline `<svg>` instead, so nothing beyond `style-src` and
   * `script-src` (for the copy-invite button) is needed, and this test
   * verifies both.
   */
  it("game overview (GET /g/:id): fixed directives present, styles covered, QR is inline SVG, and the copy-invite script is allowed by hash", async () => {
    const { gameId, cookie } = await seedOwnedGame();
    const response = await SELF.fetch(`https://makethe.team/g/${gameId}`, { headers: { cookie } });
    const csp = response.headers.get("content-security-policy");
    expectFixedDirectives(csp);
    const html = await response.text();
    await expectStylesAllowed(csp as string, html);
    expect(html, "the QR code must be inline SVG, not an <img> a CSP img-src would have to allow").toContain(
      "<svg",
    );
    expect(inlineScriptBlocks(html).length, "the copy-invite button ships a script").toBeGreaterThan(0);
    await expectScriptsAllowed(csp as string, html);
  });

  it("game edit form (GET /g/:id/edit): fixed directives present and inline styles covered", async () => {
    const { gameId, cookie } = await seedOwnedGame();
    const response = await SELF.fetch(`https://makethe.team/g/${gameId}/edit`, { headers: { cookie } });
    const csp = response.headers.get("content-security-policy");
    expectFixedDirectives(csp);
    await expectStylesAllowed(csp as string, await response.text());
  });

  it("public invite page (GET /j/:token): fixed directives present and inline styles covered", async () => {
    const { inviteToken } = await seedOwnedGame();
    const response = await SELF.fetch(`https://makethe.team/j/${inviteToken}`);
    const csp = response.headers.get("content-security-policy");
    expectFixedDirectives(csp);
    await expectStylesAllowed(csp as string, await response.text());
  });

  it("serves the removal confirmation under the production policy", async () => {
    const { gameId, cookie } = await seedOwnedGame();
    const db = testDb();
    const memberId = await insertPlayer(db, { name: "Sam Okafor" });
    await insertMembership(db, gameId, memberId);

    const response = await SELF.fetch(`https://makethe.team/g/${gameId}/squad/${memberId}/remove`, {
      headers: { cookie },
    });
    expect(response.status).toBe(200);
    const csp = response.headers.get("content-security-policy");
    expectFixedDirectives(csp);
    // The half this test was missing: `expectFixedDirectives` never looks at
    // `style-src`, so without this the page's own `<style>` blocks — the one
    // thing this file exists to check — were unasserted on the newest page.
    await expectStylesAllowed(csp as string, await response.text());
  });

  it("robots.txt: fixed directives present (no inline styles to check)", async () => {
    const response = await SELF.fetch("https://makethe.team/robots.txt");
    expectFixedDirectives(response.headers.get("content-security-policy"));
  });

  it("404: fixed directives present (no inline styles to check)", async () => {
    const response = await SELF.fetch("https://makethe.team/no-such-route");
    expect(response.status).toBe(404);
    expectFixedDirectives(response.headers.get("content-security-policy"));
  });
});

/**
 * The guard the suite lacked when the cancellation confirm page shipped an
 * inline `style="…"` heading: `style-src`'s hashes cover `<style>` *blocks*
 * only (`STYLES`, `CANCEL_STYLES_CSS`), never a `style=""` *attribute* — that
 * additionally needs `'unsafe-hashes'`, which this policy deliberately omits
 * (see `src/security/csp.ts`). A header-string assertion can never catch
 * that gap, because the header does not change when a page grows an inline
 * attribute; only inspecting what each page actually renders can.
 *
 * Every page this branch serves is captured here, driven through the real
 * app (not the bare view functions, so a future page that bypasses `layout`
 * is still covered), each with a phrase distinctive to *that* page so a 404
 * or an empty body can never masquerade as coverage of the page it stands
 * in for — the same shape as the sibling M5 branch's
 * "no password field anywhere" enumeration in `test/routes/signin.test.ts`.
 */
describe("the directives the installable app needs (M13)", () => {
  it("allows the manifest, the service worker and same-origin images", async () => {
    // Each of these falls back to default-src — which is 'none' — when it is
    // not named. The failure mode is the one that reached production with
    // connect-src in M5: the browser refuses before the request leaves the
    // device, so the Worker logs nothing and every server-side test passes.
    const header = (await SELF.fetch("https://makethe.team/")).headers.get("content-security-policy");

    expect(header).toContain("manifest-src 'self'");
    expect(header).toContain("worker-src 'self'");
    expect(header).toContain("img-src 'self'");
  });

  it("does not widen anything else to get there", async () => {
    // The point of a strict policy is that it stays strict. 'self' for
    // scripts would defeat the hashing entirely, and a wildcard img-src is
    // the usual way a policy quietly becomes decorative.
    const header = (await SELF.fetch("https://makethe.team/")).headers.get("content-security-policy") ?? "";

    expect(header).toContain("default-src 'none'");
    expect(header).not.toContain("'unsafe-inline'");
    expect(header).not.toContain("img-src *");
    expect(header).not.toMatch(/script-src[^;]*'self'/);
  });

  it("serves the service worker under its own policy, not a page's", async () => {
    // /sw.js is a document, not a page. It inherits nothing, so it says for
    // itself what it may do — which is run, and reach same-origin URLs.
    const response = await SELF.fetch("https://makethe.team/sw.js");
    const header = response.headers.get("content-security-policy") ?? "";

    expect(header).toContain("script-src 'self'");
    expect(header).toContain("connect-src 'self'");
  });
});

describe("no inline style attribute on any served page", () => {
  it("renders no style=\"…\" attribute anywhere (style-src hashes don't cover attributes)", async () => {
    type Page = { name: string; html: string; distinctive: RegExp };
    const pages: Page[] = [];

    async function capture(name: string, distinctive: RegExp, url: string, cookie?: string) {
      const html = await (await SELF.fetch(url, cookie ? { headers: { cookie } } : {})).text();
      pages.push({ name, html, distinctive });
    }

    await capture("holding page", /Make The Team/, "https://makethe.team/");

    const { gameId, fixtureId, playerId } = await seedOpenFixture();
    const respondToken = await signResponseToken(
      { playerId, fixtureId, expiresAt: KICKOFF.getTime() + 86_400_000 },
      RESPONSE_SECRET,
    );
    // `?intent=` no longer affects rendering (M10 §3.1: the button reflects
    // `viewer.status`, never the querystring) — both captures render
    // byte-identical HTML now, kept as two requests only because the URLs
    // themselves must both still resolve to the real respond page.
    await capture(
      "respond, intent=in",
      /name="intent" value="in"/,
      `https://makethe.team/r/${respondToken}?intent=in`,
    );
    await capture(
      "respond, intent=out",
      /name="intent" value="out"/,
      `https://makethe.team/r/${respondToken}?intent=out`,
    );
    await capture("bad respond token", /This link isn't working/, "https://makethe.team/r/not-a-real-token");
    const leaveToken = await signLeaveToken(
      { gameId, playerId, expiresAt: leaveTokenExpiry(NOW).getTime() },
      RESPONSE_SECRET,
    );
    await capture("leave", /Thursday 7-a-side/, `https://makethe.team/leave/${leaveToken}`);

    const cancelToken = await signCancelToken(
      { ownerPlayerId: playerId, fixtureId, expiresAt: KICKOFF.getTime() },
      CANCEL_SECRET,
    );
    await capture("cancel confirm", /won't be played/, `https://makethe.team/cancel/${cancelToken}`);

    await capture("robots.txt", /User-agent/i, "https://makethe.team/robots.txt");
    await capture("404", /Not found/, "https://makethe.team/no-such-route");

    const owned = await seedOwnedGame();
    await capture("new game form", /Set up a game/, "https://makethe.team/g/new", owned.cookie);
    await capture("game overview", /Invite people/, `https://makethe.team/g/${owned.gameId}`, owned.cookie);
    const memberId = await insertPlayer(db, { name: "Sam Okafor" });
    await insertMembership(db, owned.gameId, memberId);
    await capture(
      "remove member",
      /Remove Sam Okafor\?/,
      `https://makethe.team/g/${owned.gameId}/squad/${memberId}/remove`,
      owned.cookie,
    );
    // Not `/Thursday 7-a-side/`: the game overview page's own <h1> is the bare
    // game name, so that regex would also match the overview page's HTML —
    // exactly the false-coverage failure mode this enumeration exists to
    // catch. The invite page's <h1> is "Join {gameName}" (`src/views/join.ts`),
    // which only that page renders.
    await capture("invite page", /Join Thursday 7-a-side/, `https://makethe.team/j/${owned.inviteToken}`);

    expect(pages.map((page) => page.name).sort()).toEqual(
      [
        "holding page",
        "respond, intent=in",
        "respond, intent=out",
        "bad respond token",
        "leave",
        "cancel confirm",
        "robots.txt",
        "404",
        "new game form",
        "game overview",
        "remove member",
        "invite page",
      ].sort(),
    );

    // Matches any opening tag carrying a `style="…"` attribute. Does not
    // match the `<style>` tag itself (no attribute follows the tag name
    // there), so a legitimate `<style>` block never trips this.
    const styleAttribute = /<[a-zA-Z][a-zA-Z0-9-]*\b[^>]*\sstyle\s*=/i;

    for (const { name, html, distinctive } of pages) {
      expect(html, `${name} must actually be that page`).toMatch(distinctive);
      expect(
        html,
        `${name} must not carry an inline style="" attribute — style-src's hashes don't cover it without 'unsafe-hashes'`,
      ).not.toMatch(styleAttribute);
    }
  });
});

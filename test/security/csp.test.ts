import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../src/db/client.js";
import { fixtures, memberships, players } from "../../src/db/schema.js";
import { openFixture } from "../../src/domain/open-fixture.js";
import { signCancelToken, signResponseToken } from "../../src/domain/token.js";
import { insertGame, resetDatabase } from "../support/factories.js";
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
const NOW = new Date("2026-08-13T09:00:00Z");
const KICKOFF = new Date("2026-08-13T18:00:00Z");

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
  await db.insert(memberships).values({ id: crypto.randomUUID(), gameId, playerId, active: true, role: "owner" });
  await openFixture(db, fixtureId, NOW);
  return { gameId, fixtureId, playerId };
}

beforeEach(async () => {
  await resetDatabase();
});

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
    const { fixtureId, playerId } = await seedOpenFixture();
    const token = await signResponseToken(
      { playerId, fixtureId, expiresAt: KICKOFF.getTime() + 86_400_000 },
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
describe("no inline style attribute on any served page", () => {
  it("renders no style=\"…\" attribute anywhere (style-src hashes don't cover attributes)", async () => {
    type Page = { name: string; html: string; distinctive: RegExp };
    const pages: Page[] = [];

    async function capture(name: string, distinctive: RegExp, url: string) {
      const html = await (await SELF.fetch(url)).text();
      pages.push({ name, html, distinctive });
    }

    await capture("holding page", /Make The Team/, "https://makethe.team/");

    const { fixtureId, playerId } = await seedOpenFixture();
    const respondToken = await signResponseToken(
      { playerId, fixtureId, expiresAt: KICKOFF.getTime() + 86_400_000 },
      RESPONSE_SECRET,
    );
    await capture(
      "respond, intent=in",
      /class="button primary" name="intent" value="in"/,
      `https://makethe.team/r/${respondToken}?intent=in`,
    );
    await capture(
      "respond, intent=out",
      /class="button primary" name="intent" value="out"/,
      `https://makethe.team/r/${respondToken}?intent=out`,
    );
    await capture("bad respond token", /This link isn't working/, "https://makethe.team/r/not-a-real-token");
    await capture("leave", /Thursday 7-a-side/, `https://makethe.team/leave/${respondToken}`);

    const cancelToken = await signCancelToken(
      { ownerPlayerId: playerId, fixtureId, expiresAt: KICKOFF.getTime() },
      CANCEL_SECRET,
    );
    await capture("cancel confirm", /Cancel this game\?/, `https://makethe.team/cancel/${cancelToken}`);

    await capture("robots.txt", /User-agent/i, "https://makethe.team/robots.txt");
    await capture("404", /Not found/, "https://makethe.team/no-such-route");

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

import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../src/db/client.js";
import { fixtures, memberships, players } from "../../src/db/schema.js";
import { openFixture } from "../../src/domain/open-fixture.js";
import { signCancelToken, signResponseToken } from "../../src/domain/token.js";
import { insertGame, resetDatabase } from "../support/factories.js";

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
  expect(csp).toContain("script-src 'none'");
  expect(csp).toContain("form-action 'self'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toContain("base-uri 'none'");
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

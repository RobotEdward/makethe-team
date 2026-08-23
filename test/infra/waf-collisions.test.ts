import { describe, expect, it } from "vitest";
import {
  WAF_CUSTOM_RULES,
  matchesRule,
  type CustomRule,
} from "../../infra/cloudflare/rules/waf-custom.js";
import {
  signCancelToken,
  signLeaveToken,
  signResponseToken,
} from "../../src/domain/token.js";
import {
  ACCOUNT_PATH,
  ADMIN_ALLOWLIST_PATH,
  ADMIN_PATH,
  ADMIN_USAGE_PATH,
  APPLE_TOUCH_ICON_PATH,
  DASHBOARD_PATH,
  DELETE_ACCOUNT_PATH,
  ICON_192_PATH,
  ICON_512_PATH,
  MANIFEST_PATH,
  NEW_GAME_PATH,
  OFFLINE_PATH,
  PASSKEYS_PATH,
  PRIVACY_PATH,
  PUSH_SUBSCRIBE_PATH,
  SERVICE_WORKER_PATH,
  SIGN_IN_PATH,
  fixturePath,
  gamePath,
  joinPath,
  ownerTeamsPath,
} from "../../src/auth/paths.js";

/**
 * **A WAF false positive on `/r/` silently breaks the one journey the whole
 * product depends on**, and it would break it for one player at a time, with
 * no error anywhere this project can see — the request never reaches the
 * Worker, so nothing is logged, no test fails, and the player simply gets a
 * Cloudflare block page instead of their fixture.
 *
 * `docs/runbooks/cloudflare.md` used to assert this could not happen, in
 * prose, on the grounds that "every pattern requires a literal `/`
 * immediately before it, and HMAC tokens are base64url or hex, neither of
 * which can contain a slash". **That argument does not actually establish the
 * conclusion.** The hazard is not a token containing a slash — it is a token
 * *beginning* with one of the patterns, because the `/` before it is the
 * route's own separator. `/r/wp-anything` contains `/wp-`. `wp-` is three
 * perfectly legal base64url characters.
 *
 * What actually makes it safe is the alphabets, and this test pins that
 * rather than restating it:
 *
 *  - `/r/`, `/leave/` and `/cancel/` carry `base64url(JSON).base64url(hmac)`.
 *    The payload is JSON, so its first byte is always `{` (0x7B), whose top
 *    six bits are 0b011110 = 30 — so **every one of these tokens starts with
 *    `e`**, and can never start with `wp-`, `wordpress` or `phpmyadmin`.
 *  - `/j/` carries `crypto.randomUUID()`: hex and dashes only, so it cannot
 *    contain `w`, `p`, `.` or `/`.
 *
 * Both properties are incidental to how tokens are built, not chosen for this
 * reason, so either could be changed by someone with no idea this rule exists.
 * That is exactly why the guard runs over freshly minted tokens on every
 * `npm test` instead of living in a runbook.
 */

const SECRET = "waf-collision-test-secret";
const IN_A_WEEK = Date.now() + 7 * 24 * 60 * 60 * 1000;

/** Enough tokens that a chance prefix would show up, minted the real way. */
async function mintedTokenPaths(): Promise<string[]> {
  const paths: string[] = [];
  for (let i = 0; i < 200; i++) {
    const response = await signResponseToken(
      { playerId: crypto.randomUUID(), fixtureId: crypto.randomUUID(), expiresAt: IN_A_WEEK },
      SECRET,
    );
    const leave = await signLeaveToken(
      { gameId: crypto.randomUUID(), playerId: crypto.randomUUID(), expiresAt: IN_A_WEEK },
      SECRET,
    );
    const cancel = await signCancelToken(
      { ownerPlayerId: crypto.randomUUID(), fixtureId: crypto.randomUUID(), expiresAt: IN_A_WEEK },
      SECRET,
    );
    paths.push(
      `/r/${response}`,
      `/r/${response}/mute`,
      `/r/${response}/unmute`,
      `/leave/${leave}`,
      `/cancel/${cancel}`,
      joinPath(crypto.randomUUID()),
    );
  }
  return paths;
}

/** The app's fixed paths, plus the id-bearing ones built from real UUIDs. */
function applicationPaths(): string[] {
  const gameId = crypto.randomUUID();
  const fixtureId = crypto.randomUUID();
  return [
    "/",
    "/robots.txt",
    PRIVACY_PATH,
    SIGN_IN_PATH,
    DASHBOARD_PATH,
    ACCOUNT_PATH,
    PASSKEYS_PATH,
    DELETE_ACCOUNT_PATH,
    ADMIN_PATH,
    ADMIN_ALLOWLIST_PATH,
    ADMIN_USAGE_PATH,
    PUSH_SUBSCRIBE_PATH,
    MANIFEST_PATH,
    SERVICE_WORKER_PATH,
    OFFLINE_PATH,
    ICON_192_PATH,
    ICON_512_PATH,
    APPLE_TOUCH_ICON_PATH,
    NEW_GAME_PATH,
    gamePath(gameId),
    fixturePath(gameId, fixtureId),
    ownerTeamsPath(gameId, fixtureId),
    "/api/auth/sign-in/magic-link",
  ];
}

function blockedBy(path: string, method: string): CustomRule | undefined {
  return WAF_CUSTOM_RULES.find((rule) => matchesRule(rule, { path, method }));
}

describe("the WAF custom rules against the application's real paths", () => {
  it("blocks no freshly minted token link", async () => {
    const offenders = (await mintedTokenPaths())
      .map((path) => ({ path, rule: blockedBy(path, "GET") }))
      .filter((o) => o.rule !== undefined)
      .map((o) => `${o.path} blocked by ${o.rule!.description}`);

    expect(
      offenders,
      "A WAF rule matches a real token link. The request would never reach " +
        "the Worker, nothing would be logged, and the player would see a " +
        "Cloudflare block page instead of their fixture. Either the rule or " +
        "the token alphabet has changed — see this file's header.",
    ).toEqual([]);
  });

  it("blocks none of the application's own paths", () => {
    const offenders = applicationPaths()
      .flatMap((path) => ["GET", "POST"].map((method) => ({ path, method })))
      .map((r) => ({ ...r, rule: blockedBy(r.path, r.method) }))
      .filter((o) => o.rule !== undefined)
      .map((o) => `${o.method} ${o.path} blocked by ${o.rule!.description}`);

    expect(offenders).toEqual([]);
  });

  it("still blocks the scanner traffic the rules exist for", () => {
    // Without this, the two guards above stay green if the rules are emptied
    // or their patterns broken — "nothing is blocked" would then be trivially
    // true and the enumeration would be protecting nothing.
    for (const path of ["/wp-admin", "/wordpress/", "/.env", "/.git/config", "/phpmyadmin"]) {
      expect(blockedBy(path, "GET")?.description, path).toBe("block-scanner-paths");
    }
    expect(blockedBy("/", "PUT")?.description).toBe("block-non-standard-methods");
  });

  it("pins the token prefixes the no-collision argument rests on", async () => {
    // The guards above would keep passing if tokens changed to an alphabet
    // that merely happens not to collide today. This states the actual
    // property, so a change to token encoding fails here with the reason.
    const response = await signResponseToken(
      { playerId: crypto.randomUUID(), fixtureId: crypto.randomUUID(), expiresAt: IN_A_WEEK },
      SECRET,
    );

    expect(
      response.startsWith("e"),
      "Signed tokens are base64url of a JSON payload, so they must start with " +
        "'e' (the encoding of '{'). If this changed, a token can now begin " +
        "with an arbitrary string and `/r/wp-…` becomes reachable — re-check " +
        "block-scanner-paths before changing it.",
    ).toBe(true);
    expect(/^[0-9a-f-]+$/.test(crypto.randomUUID())).toBe(true);
  });
});

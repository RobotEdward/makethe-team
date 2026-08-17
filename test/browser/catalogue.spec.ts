import { readFileSync, readdirSync } from "node:fs";
import { expect, test } from "@playwright/test";
import {
  ACCOUNT_PATH,
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
  SERVICE_WORKER_PATH,
  SIGN_IN_COMPLETE_PATH,
  SIGN_IN_PATH,
} from "../../src/auth/paths.js";
import { CATALOGUE, NOT_CATALOGUED } from "./catalogue.js";

/**
 * Routes are registered either as a string literal or as a named constant.
 * This resolves the constants so the scan below sees the same set of routes
 * the app actually serves.
 */
const CONSTANTS: Record<string, string> = {
  SIGN_IN_PATH,
  SIGN_IN_COMPLETE_PATH,
  DASHBOARD_PATH,
  PASSKEYS_PATH,
  DELETE_ACCOUNT_PATH,
  ACCOUNT_PATH,
  NEW_GAME_PATH,
  PRIVACY_PATH,
  MANIFEST_PATH,
  ICON_192_PATH,
  ICON_512_PATH,
  APPLE_TOUCH_ICON_PATH,
  OFFLINE_PATH,
  SERVICE_WORKER_PATH,
};

/** Which catalogue entry covers which route. */
const ROUTE_TO_ID = new Map<string, string>([
  ["/", "home"],
  [PRIVACY_PATH, "privacy"],
  [SIGN_IN_PATH, "sign-in"],
  [DASHBOARD_PATH, "dashboard"],
  [PASSKEYS_PATH, "passkeys"],
  [DELETE_ACCOUNT_PATH, "delete-account"],
  [ACCOUNT_PATH, "account"],
  [NEW_GAME_PATH, "new-game"],
  [OFFLINE_PATH, "offline"],
  ["/g/:id", "game-overview"],
  ["/g/:id/edit", "edit-game"],
  ["/g/:id/f/:fixtureId", "owner-fixture"],
  ["/g/:id/squad/:playerId/remove", "remove-member"],
  ["/g/:id/squad/:playerId", "squad-member"],
  ["/j/:token", "join"],
  ["/r/:token", "respond"],
  ["/leave/:token", "leave"],
  ["/cancel/:token", "cancel"],
]);

/**
 * Every GET route registered anywhere under `src/routes`.
 *
 * The leading `/` in the literal alternative is load-bearing: Hono's context
 * getter shares the method name, so `c.get("player")`, `c.get("session")` and
 * `c.get("email")` all match a naive pattern and arrive here looking like
 * uncatalogued routes.
 */
function registeredGetRoutes(): { routes: string[]; unresolved: string[] } {
  const routes = new Set<string>();
  const unresolved = new Set<string>();
  for (const file of readdirSync("src/routes")) {
    if (!file.endsWith(".ts")) continue;
    const source = readFileSync(`src/routes/${file}`, "utf8");
    for (const match of source.matchAll(/\.get\(\s*(?:["'`](\/[^"'`]*)["'`]|([A-Z_][A-Z0-9_]*))/g)) {
      const literal = match[1];
      const constant = match[2];
      if (literal !== undefined) routes.add(literal);
      else if (constant !== undefined) {
        // Resolved, or *reported*. Silently dropping a constant this map has
        // never heard of is how M7b's `/app/delete` got past this guard: the
        // route matched the regex, missed the lookup, and vanished — so the
        // test below passed while covering nothing for it, no console gate,
        // no CSP check, no capture, and nothing anywhere complained. A guard
        // whose failure mode is silence is not a guard.
        if (CONSTANTS[constant] === undefined) unresolved.add(constant);
        else routes.add(CONSTANTS[constant]!);
      }
    }
  }
  return { routes: [...routes], unresolved: [...unresolved] };
}

test("every route constant resolves to a path this scan can see", () => {
  expect(
    registeredGetRoutes().unresolved,
    "These constants register a GET route but are absent from CONSTANTS, so " +
      "the scan below cannot see the routes they name and would pass while " +
      "covering nothing for them. Add each to CONSTANTS (and then to " +
      "ROUTE_TO_ID and CATALOGUE, or to NOT_CATALOGUED with a reason).",
  ).toEqual([]);
});

test("every GET route is catalogued or excluded with a stated reason", () => {
  const catalogued = new Set(CATALOGUE.map((page) => page.id));
  const uncovered: string[] = [];

  for (const route of registeredGetRoutes().routes) {
    if (NOT_CATALOGUED.has(route)) continue;
    const id = ROUTE_TO_ID.get(route);
    if (id === undefined || !catalogued.has(id)) uncovered.push(route);
  }

  expect(
    uncovered,
    `These GET routes are neither in the catalogue nor in NOT_CATALOGUED. ` +
      `Add a CATALOGUE entry (so the page is CSP-checked and screenshotted) ` +
      `or an explicit NOT_CATALOGUED reason. Do not leave a page uncovered: ` +
      `the hand-written enumeration this replaces had silently lost every ` +
      `/g/* page. Uncovered: ${uncovered.join(", ")}`,
  ).toEqual([]);
});

test("the scan actually finds the routes it claims to", () => {
  // Guards the regex itself. If `registeredGetRoutes` silently matched
  // nothing — a refactor to a different router API, a changed call shape —
  // the test above would pass trivially and cover nothing at all.
  const { routes } = registeredGetRoutes();
  expect(routes.length).toBeGreaterThan(8);
  expect(routes).toContain("/g/:id");
  expect(routes).toContain(SIGN_IN_PATH);
});

test("every catalogue id is unique", () => {
  const ids = CATALOGUE.map((page) => page.id);
  expect(ids).toEqual([...new Set(ids)]);
});

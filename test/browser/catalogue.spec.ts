import { readFileSync, readdirSync } from "node:fs";
import { expect, test } from "@playwright/test";
import {
  DASHBOARD_PATH,
  NEW_GAME_PATH,
  PASSKEYS_PATH,
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
  NEW_GAME_PATH,
};

/** Which catalogue entry covers which route. */
const ROUTE_TO_ID = new Map<string, string>([
  ["/", "home"],
  [SIGN_IN_PATH, "sign-in"],
  [DASHBOARD_PATH, "dashboard"],
  [PASSKEYS_PATH, "passkeys"],
  [NEW_GAME_PATH, "new-game"],
  ["/g/:id", "game-overview"],
  ["/g/:id/edit", "edit-game"],
  ["/g/:id/squad/:playerId/remove", "remove-member"],
  ["/j/:token", "join"],
  ["/r/:token", "respond"],
]);

/**
 * Every GET route registered anywhere under `src/routes`.
 *
 * The leading `/` in the literal alternative is load-bearing: Hono's context
 * getter shares the method name, so `c.get("player")`, `c.get("session")` and
 * `c.get("email")` all match a naive pattern and arrive here looking like
 * uncatalogued routes.
 */
function registeredGetRoutes(): string[] {
  const routes = new Set<string>();
  for (const file of readdirSync("src/routes")) {
    if (!file.endsWith(".ts")) continue;
    const source = readFileSync(`src/routes/${file}`, "utf8");
    for (const match of source.matchAll(/\.get\(\s*(?:["'`](\/[^"'`]*)["'`]|([A-Z_][A-Z0-9_]*))/g)) {
      const literal = match[1];
      const constant = match[2];
      if (literal !== undefined) routes.add(literal);
      else if (constant !== undefined && CONSTANTS[constant] !== undefined) {
        routes.add(CONSTANTS[constant]!);
      }
    }
  }
  return [...routes];
}

test("every GET route is catalogued or excluded with a stated reason", () => {
  const catalogued = new Set(CATALOGUE.map((page) => page.id));
  const uncovered: string[] = [];

  for (const route of registeredGetRoutes()) {
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
  const routes = registeredGetRoutes();
  expect(routes.length).toBeGreaterThan(8);
  expect(routes).toContain("/g/:id");
  expect(routes).toContain(SIGN_IN_PATH);
});

test("every catalogue id is unique", () => {
  const ids = CATALOGUE.map((page) => page.id);
  expect(ids).toEqual([...new Set(ids)]);
});

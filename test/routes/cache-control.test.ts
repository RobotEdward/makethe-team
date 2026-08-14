import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";

/**
 * Every route that takes a `:token` is reached from an email by somebody with
 * no session, and each of them must answer `private, no-store`.
 *
 * **The route list is derived from the application, never restated here.**
 * That is the whole point of this file. The gap this test closes arose exactly
 * because a hand-maintained list drifted: `/j/*` was given the header in M6a
 * and its three neighbours were not, and nothing noticed for two milestones. A
 * test carrying its own list of token routes would pass forever while a fifth
 * route shipped bare.
 *
 * An invalid token is deliberate and sufficient. The middleware runs *after*
 * the handler, so the header is applied to whatever the handler produced —
 * `/r/`, `/leave/` and `/cancel/` render a link-problem page at 200 for a bad
 * token, and `/j/` answers 404. No fixture, no player and no valid token needs
 * to exist for this to be a real check.
 */
const TOKEN_ROUTES = createApp()
  .routes.filter((route) => route.path.includes(":token"))
  .map((route) => ({ method: route.method, path: route.path }));

describe("Cache-Control on token routes", () => {
  it("finds the token routes it is supposed to be guarding", () => {
    // A guard whose subject list has silently become empty passes every other
    // assertion in this file vacuously — `it.each([])` runs nothing and the
    // suite still goes green. This is the only assertion standing between that
    // and a false sense of coverage.
    //
    // A floor, deliberately, rather than an exact set: a new token route
    // should be picked up and checked automatically, not fail a test that has
    // nothing to say about it. The `it.each` below is what covers it.
    expect(TOKEN_ROUTES.length).toBeGreaterThanOrEqual(7);
    expect(new Set(TOKEN_ROUTES.map((r) => r.path))).toContain("/r/:token");
  });

  it.each(TOKEN_ROUTES)("$method $path answers private, no-store", async ({ method, path }) => {
    const url = `https://makethe.team${path.replace(":token", "not-a-real-token")}`;
    const response = await SELF.fetch(
      new Request(url, {
        method,
        ...(method === "POST"
          ? {
              body: new URLSearchParams({ intent: "in" }),
              headers: { "content-type": "application/x-www-form-urlencoded" },
            }
          : {}),
      }),
    );

    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
});

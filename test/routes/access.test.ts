import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("holding page", () => {
  it("serves the product name and nothing operational", async () => {
    const response = await SELF.fetch("https://makethe.team/");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(body).toContain("Make The Team");
    expect(body).not.toMatch(/sign in|dashboard|fixture|squad/i);
  });

  it("is not indexable", async () => {
    const response = await SELF.fetch("https://makethe.team/");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  /**
   * `Cache-Control: private, no-store` is mounted on `AUTHENTICATED_PREFIX`
   * only (`/app` and below), for the same blast-radius reason
   * `sessionMiddleware` is scoped there — this page has no signed-in visitor
   * to protect and must keep whatever caching it already had.
   */
  it("carries no Cache-Control directive of its own", async () => {
    const response = await SELF.fetch("https://makethe.team/");
    expect(response.headers.get("cache-control")).toBeNull();
  });

  it("works with no JavaScript at all", async () => {
    const body = await (await SELF.fetch("https://makethe.team/")).text();
    expect(body).not.toContain("<script");
  });
});

describe("robots.txt", () => {
  it("disallows everything", async () => {
    const response = await SELF.fetch("https://makethe.team/robots.txt");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("User-agent: *\nDisallow: /\n");
  });
});

describe("unmatched routes", () => {
  // "/g/some-game" used to live in this list as a probe of a game-id-shaped
  // path with no route behind it. Task 7 (M6a) registered `GET /g/:id`, so
  // that path is matched now — an anonymous request to it redirects to
  // `/sign-in` (SELF.fetch follows that redirect by default, landing on the
  // sign-in page's 200, which is what turned this probe red) rather than
  // 404ing. Its own coverage — the anonymous redirect — lives in
  // test/routes/games.test.ts alongside `GET /g/new`'s identical case.
  const probes = ["/wp-admin", "/.env", "/.git/config", "/admin", "/api/v1/games"];

  it.each(probes)("returns a bare 404 for %s", async (path) => {
    const response = await SELF.fetch(`https://makethe.team${path}`);
    const body = await response.text();

    expect(response.status).toBe(404);
    expect(body).toBe("Not found");
    expect(body).not.toMatch(/makethe|hono|worker|stack|cloudflare/i);
  });

  it("does not leak a framework header", async () => {
    const response = await SELF.fetch("https://makethe.team/wp-admin");
    expect(response.headers.get("x-powered-by")).toBeNull();
  });
});

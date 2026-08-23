import { env } from "cloudflare:test";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { AppEnv, Bindings } from "../../src/env.js";
import { createApp } from "../../src/app.js";
import { tokenRateLimit } from "../../src/security/rate-limit.js";

/**
 * A stand-in for a Workers rate limiting binding.
 *
 * An ordinary object with an ordinary method, not an arrow-function stub:
 * `CLAUDE.md` records that a field holding a builtin and called as
 * `this.x(...)` throws `Illegal invocation` in production while an
 * arrow-function stub reads a method call and a free call identically. The
 * production code calls `limiter.limit(...)` as a method, so the stub must be
 * shaped the same way for the test to mean anything.
 */
function stubLimiter(verdicts: boolean[] | boolean) {
  const calls: string[] = [];
  const queue = Array.isArray(verdicts) ? [...verdicts] : null;
  return {
    calls,
    async limit(options: { key: string }): Promise<{ success: boolean }> {
      calls.push(options.key);
      const success = queue ? (queue.shift() ?? true) : (verdicts as boolean);
      return { success };
    },
  };
}

/**
 * Only the two limiter bindings, cast to the full `Bindings`. These tests
 * exercise the middleware alone, which reads nothing else off the env.
 */
function bindings(
  limiters: { tokens?: ReturnType<typeof stubLimiter>; ips?: ReturnType<typeof stubLimiter> },
): Bindings {
  return {
    TOKEN_LIMITER: limiters.tokens,
    TOKEN_IP_LIMITER: limiters.ips,
  } as unknown as Bindings;
}

/** A minimal app with the middleware mounted the way `src/app.ts` mounts it. */
function appUnderTest() {
  const app = new Hono<AppEnv>();
  app.use("/r/*", tokenRateLimit());
  app.get("/r/:token", (c) => c.text("served"));
  return app;
}

describe("tokenRateLimit", () => {
  it("serves the request when no limiter binding is configured", async () => {
    const res = await appUnderTest().request("/r/abc123", {}, {} as Bindings);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("served");
  });

  it("refuses with 429 when the per-token limiter says no", async () => {
    const tokens = stubLimiter(false);

    const res = await appUnderTest().request("/r/abc123", {}, bindings({ tokens }));

    expect(res.status).toBe(429);
    expect(await res.text()).not.toBe("served");
  });

  it("keys the per-token limiter on the path family and the token", async () => {
    const tokens = stubLimiter(true);

    await appUnderTest().request("/r/abc123", {}, bindings({ tokens }));

    expect(tokens.calls).toEqual(["r:abc123"]);
  });

  it("keys the per-IP limiter on CF-Connecting-IP", async () => {
    const ips = stubLimiter(true);

    await appUnderTest().request(
      "/r/abc123",
      { headers: { "CF-Connecting-IP": "203.0.113.7" } },
      bindings({ ips }),
    );

    expect(ips.calls).toEqual(["ip:203.0.113.7"]);
  });

  it("refuses with 429 when the per-IP limiter says no", async () => {
    const ips = stubLimiter(false);

    const res = await appUnderTest().request(
      "/r/abc123",
      { headers: { "CF-Connecting-IP": "203.0.113.7" } },
      bindings({ ips }),
    );

    expect(res.status).toBe(429);
  });

  it("skips the per-IP limiter when there is no CF-Connecting-IP header", async () => {
    const ips = stubLimiter(false);

    const res = await appUnderTest().request("/r/abc123", {}, bindings({ ips }));

    expect(res.status).toBe(200);
    expect(ips.calls).toEqual([]);
  });

  it("refuses with a wait-and-retry page, not the link-problem page", async () => {
    const tokens = stubLimiter(false);

    const res = await appUnderTest().request("/r/abc123", {}, bindings({ tokens }));
    const body = await res.text();

    expect(res.headers.get("content-type")).toContain("text/html");
    // The advice has to differ from `renderLinkProblemPage`'s. A throttled
    // player's link is fine and will work in a moment; telling them to ask
    // their organiser for a fresh one sends them down a dead end and puts the
    // support burden on the organiser.
    expect(body).toContain("Too many requests");
    expect(body).not.toContain("Ask whoever organises your game");
  });

  it("tells a refused caller how long to wait", async () => {
    const tokens = stubLimiter(false);

    const res = await appUnderTest().request("/r/abc123", {}, bindings({ tokens }));

    expect(res.headers.get("Retry-After")).toBe("60");
  });

  it("serves the request when the limiter throws", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const exploding = {
      async limit(_options: { key: string }): Promise<{ success: boolean }> {
        throw new Error("rate limiter unavailable");
      },
    };

    const res = await appUnderTest().request(
      "/r/abc123",
      {},
      { TOKEN_LIMITER: exploding } as unknown as Bindings,
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("served");
    expect(errors).toHaveBeenCalledOnce();
    errors.mockRestore();
  });
});

/**
 * Where the middleware is mounted, asserted against the real app.
 *
 * Scoped mounts, never `*` — the same blast-radius argument `src/app.ts` makes
 * for `sessionMiddleware` and for the `private, no-store` header. A `*` mount
 * would spend limiter budget on `/robots.txt`, the icons and the service
 * worker, and would put a signed-in player's dashboard behind a throttle whose
 * whole justification is that its callers have no session.
 */
describe("where tokenRateLimit is mounted in the real app", () => {
  const throttled = ["/r/abc123", "/r/abc123/mute", "/leave/abc123", "/cancel/abc123", "/j/abc123"];
  const untouched = ["/", "/robots.txt", "/privacy", "/sw.js", "/app", "/g/some-game"];

  it.each(throttled)("throttles %s", async (path) => {
    const tokens = stubLimiter(true);

    await createApp().request(path, {}, { ...env, TOKEN_LIMITER: tokens });

    expect(tokens.calls).toHaveLength(1);
  });

  it.each(untouched)("leaves %s alone", async (path) => {
    const tokens = stubLimiter(true);

    await createApp().request(path, {}, { ...env, TOKEN_LIMITER: tokens });

    expect(tokens.calls).toEqual([]);
  });
});

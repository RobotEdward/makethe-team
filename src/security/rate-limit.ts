import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv, RateLimitBinding } from "../env.js";
import { renderTooManyRequestsPage } from "../views/too-many-requests.js";

/**
 * The `period` both `ratelimits` bindings are configured with in
 * `wrangler.jsonc`. Cloudflare permits only 10 or 60 here.
 */
const LIMIT_PERIOD_SECONDS = 60;

/**
 * A throttle for the unauthenticated link endpoints — `/r/:token`,
 * `/leave/:token`, `/cancel/:token` and `/j/:token` (TR-37).
 *
 * **This is a supplement, never the control.** Everything these routes do must
 * still hold with the bindings absent, exactly as it must with the WAF rules
 * switched off: what actually bounds the cost of an unauthenticated endpoint
 * that writes a row and sends an email is the quota wrapper around the
 * notifier (`MAX_EMAILS_PER_DAY`) and the token's unguessability. Two
 * independent reasons this can never be load-bearing:
 *
 * 1. Counting is **per machine**, not per colo and not global. Measured
 *    against production on 23 August 2026: 23 sequential requests to one
 *    token over fresh connections never tripped a 10-per-60s limit, because
 *    each new TCP connection can land on a different machine in the colo and
 *    each machine counted only two or three. Pinning one connection tripped
 *    it at 11. A caller who does not reuse a connection — or an attacker
 *    spread over several — gets a large multiple of the nominal limit.
 *    Cloudflare's own wording is "cached on the same machine", with
 *    asynchronous background updates, and "permissive, eventually
 *    consistent".
 * 2. It fails open, deliberately (see `withinLimit`).
 *
 * Its real job is the one the Free-plan WAF rate limiting rule cannot do: that
 * rule allows a single rule per zone, path-matched, per-IP, over a fixed 10
 * second window — see `infra/cloudflare/`. This gives a 60 second window and a
 * key that is not an IP address.
 */
export function tokenRateLimit(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const [family, token] = c.req.path.split("/").filter(Boolean);

    // Per-token first, and short-circuiting: it is the dimension that fires on
    // ordinary hammering of one link, so spending the IP budget on a request
    // already refused would make the looser limit the tighter one in practice.
    if (token !== undefined && !(await withinLimit(c.env.TOKEN_LIMITER, `${family}:${token}`))) {
      return refuse(c);
    }

    // `CF-Connecting-IP` is set by Cloudflare on every request that reaches a
    // Worker through the edge and cannot be spoofed by the client there. It is
    // absent under `wrangler dev`, in `vitest`, and in any direct invocation —
    // all of which skip this dimension rather than inventing a key, because
    // one shared fallback key would put every such request in one bucket and
    // throttle the whole test suite against itself.
    const ip = c.req.header("CF-Connecting-IP");
    if (ip !== undefined && !(await withinLimit(c.env.TOKEN_IP_LIMITER, `ip:${ip}`))) {
      return refuse(c);
    }

    await next();
  };
}

/**
 * Ask one limiter about one key. `true` — meaning "serve it" — for an
 * unconfigured binding and for any failure.
 *
 * **Fails open on purpose.** The alternative is that a Cloudflare-side fault
 * in a supplementary control takes down `/r/:token`, which is the one journey
 * the whole product depends on. A rate limiter that can 429 every player
 * because a binding is briefly unavailable is a worse outage than the abuse it
 * exists to blunt. The throw is logged so the fault is visible rather than
 * silent.
 */
async function withinLimit(limiter: RateLimitBinding | undefined, key: string): Promise<boolean> {
  if (limiter === undefined) {
    return true;
  }
  try {
    const { success } = await limiter.limit({ key });
    return success;
  } catch (error) {
    console.error(
      `rate limiter failed for key ${key}, serving anyway: ${
        error instanceof Error ? (error.stack ?? error.message) : String(error)
      }`,
    );
    return true;
  }
}

/**
 * 429, and a page rather than a bare status: the population reaching these
 * paths is players tapping a link in an email, and the realistic refusal here
 * is a false positive — a whole office or mobile network behind one IP, which
 * `TOKEN_IP_LIMITER`'s own comment explains this design accepts. Someone who
 * did nothing wrong must get a sentence they can act on.
 *
 * `Retry-After` matches the bindings' 60 second period in `wrangler.jsonc`.
 * The two must change together; there is no way to read the configured period
 * back off a binding at runtime.
 */
function refuse(c: Context<AppEnv>): Response {
  c.header("Retry-After", String(LIMIT_PERIOD_SECONDS));
  return c.html(renderTooManyRequestsPage(), 429);
}

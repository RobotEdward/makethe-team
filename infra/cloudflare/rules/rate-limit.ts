import { renderExpression, type Predicate } from "./waf-custom.js";

/**
 * The zone's rate limiting rules (TR-37).
 *
 * **Exactly one, because the Free plan allows exactly one.** It also allows
 * matching on **path only**, counting **per-IP** over a fixed **10-second**
 * window, with a **10-second** mitigation timeout. Those are hard plan limits,
 * not choices — an earlier version of `docs/runbooks/cloudflare.md` specified
 * two rules (`respond-throttle` and `join-throttle`) and left open whether both
 * could exist. They cannot, which is why the two token families share this one.
 *
 * **This is not the throttle that matters.** `src/security/rate-limit.ts` is,
 * with a 60-second window and keys that are not IP addresses. This rule exists
 * for the one thing the Worker binding structurally cannot do: it blocks
 * **before the Worker is invoked**, so it protects the bill rather than the
 * data. A 10-second mitigation window is nearly useless as a security control
 * and is not relied on as one.
 */

const TOKEN_PATHS: Predicate[] = [
  // The two unauthenticated families that both write a row and can send email.
  // `/leave/` and `/cancel/` are deliberately not included: one rule has one
  // expression, widening it dilutes the budget across paths that are reached
  // far less often, and both are covered by the Worker-side throttle.
  { field: "path", op: "contains", value: "/r/" },
  { field: "path", op: "contains", value: "/j/" },
];

export interface RateLimitRule {
  description: string;
  action: "block";
  expression: string;
  ratelimit: {
    characteristics: string[];
    period: number;
    requests_per_period: number;
    mitigation_timeout: number;
  };
}

export const RATE_LIMIT_RULES: RateLimitRule[] = [
  {
    description: "token-endpoint-throttle",
    action: "block",
    expression: renderExpression({
      description: "token-endpoint-throttle",
      action: "block",
      any: TOKEN_PATHS,
    }),
    ratelimit: {
      // `cf.colo.id` alongside `ip.src` is Cloudflare's required shape; the
      // Free plan's documented counting characteristic is the IP.
      characteristics: ["ip.src", "cf.colo.id"],
      period: 10,
      // 20 in 10 seconds. A player answering a reminder taps two or three
      // times; this is well clear of any honest use and still blunts a loop.
      requests_per_period: 20,
      mitigation_timeout: 10,
    },
  },
];

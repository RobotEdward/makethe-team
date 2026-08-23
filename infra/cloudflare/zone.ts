/**
 * Which zone this repo manages, and how to reach the API.
 *
 * The zone id is not a credential — it appears in every dashboard URL and
 * identifies a public domain. The **token** is the secret, and it is never
 * committed: `plan`, `apply` and `verify` read it from the environment.
 */

export const ZONE_NAME = "makethe.team";
export const ZONE_ID = "328cae9eaf00c3b050d5e0c5477c590c";

export const API_BASE = "https://api.cloudflare.com/client/v4";

/** The Rulesets phase each declaration is applied to. One ruleset per phase per zone. */
export const WAF_CUSTOM_PHASE = "http_request_firewall_custom";
export const RATE_LIMIT_PHASE = "http_ratelimit";

/**
 * The environment variable holding the elevated token.
 *
 * **Deliberately not `CLOUDFLARE_API_TOKEN`**, which is the deploy token in
 * `.cf-token`. That token cannot read or write firewall rules — confirmed, it
 * answers `Authentication error` on the rulesets endpoints — and that is by
 * design: GitHub Actions holds it, and nothing in CI should be able to change
 * the zone's security posture. Keeping the names distinct is what stops the
 * two being conflated by a stray `source .cf-token`.
 *
 * Neither token verifies against `/user/tokens/verify`, which answers
 * `1000 Invalid API Token` for both despite both working. Do not use that
 * endpoint to diagnose these — probe the endpoint you actually need.
 */
export const TOKEN_ENV_VAR = "CLOUDFLARE_ADMIN_API_TOKEN";

export function requireToken(): string {
  const token = process.env[TOKEN_ENV_VAR];
  if (token === undefined || token.trim() === "") {
    throw new Error(
      `${TOKEN_ENV_VAR} is not set.\n\n` +
        `This is the elevated zone token, not the deploy token in .cf-token.\n` +
        `Create it at https://dash.cloudflare.com/profile/api-tokens with:\n` +
        `  Zone → Zone WAF        → Edit   (the Rulesets API; NOT Firewall Services)\n` +
        `  Zone → Zone Settings   → Edit\n` +
        `  Zone → Zone            → Read\n` +
        `scoped to ${ZONE_NAME} only, then:\n` +
        `  echo 'export ${TOKEN_ENV_VAR}=<token>' > .cf-admin-token && chmod 600 .cf-admin-token\n` +
        `  source .cf-admin-token\n`,
    );
  }
  return token;
}

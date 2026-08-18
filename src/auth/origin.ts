import type { Bindings } from "../env.js";

/**
 * This deployment's own origin, as every state-changing route compares it
 * against a submitted form's `Origin` header.
 *
 * Previously defined once per route file (`games.ts`, `account.ts`, and a
 * third copy this milestone was about to add to `broadcast.ts`) — three
 * places a change to how the origin is derived would have to land correctly,
 * identically, in lockstep. One definition here, imported everywhere a
 * mutating route needs it.
 */
export function originOf(env: Bindings): string {
  return new URL(env.BETTER_AUTH_URL).origin;
}

/**
 * Rejects a cross-site form post. A browser always sends `Origin` on a
 * cross-site form submission, so a *mismatched* one is refused; a *missing*
 * one is a non-browser client acting on its own behalf, which is allowed.
 *
 * Not CSRF protection in the strict sense — there is no token being ridden —
 * but a cheap filter on the obvious abuse (a third-party page silently
 * posting on behalf of its visitors' browsers), same as every route that
 * calls it.
 */
export function wrongOrigin(c: {
  req: { header: (name: string) => string | undefined };
  env: Bindings;
}): boolean {
  const origin = c.req.header("origin");
  return origin !== undefined && origin !== originOf(c.env);
}

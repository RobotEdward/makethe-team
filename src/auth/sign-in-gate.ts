import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { memberships, players, signupAllowlist } from "../db/schema.js";

/**
 * The trial sign-in gate (TR-35, widened in M16): may this address be sent a
 * magic link at all?
 *
 * Three doors, checked cheapest first, any one of which opens the gate:
 *
 * 1. the `SIGNIN_ALLOWLIST` secret — no database round trip, and the only
 *    door that survives a database wipe, which is why the secret is a union
 *    partner of the table below and not replaced by it;
 * 2. the `signup_allowlist` table, managed from the admin screen;
 * 3. an invited player: a `players` row with this email holding at least one
 *    **active** membership. Being removed from your only squad closes this
 *    door again — an invitation is standing membership, not a permanent pass.
 *
 * Guests cannot open door 3: their `players.email` is NULL and SQL equality
 * never matches NULL. Player emails are stored already folded (see
 * `normaliseEmail` in `join-squad.ts`), so the folded equality here is exact,
 * not approximate.
 */
export async function isSignInPermitted(
  db: Db,
  raw: string | undefined,
  email: string,
): Promise<boolean> {
  const wanted = foldAsciiCase(email);
  if (wanted === "") return false;

  if (isSignInAllowlisted(raw, email)) return true;

  const [listed] = await db
    .select({ email: signupAllowlist.email })
    .from(signupAllowlist)
    .where(eq(signupAllowlist.email, wanted))
    .limit(1);
  if (listed !== undefined) return true;

  const [member] = await db
    .select({ id: players.id })
    .from(players)
    .innerJoin(memberships, eq(memberships.playerId, players.id))
    .where(and(eq(players.email, wanted), eq(memberships.active, true)))
    .limit(1);
  return member !== undefined;
}


/**
 * Whether `email` appears in the comma-separated `SIGNIN_ALLOWLIST` secret.
 *
 * Fails **closed**: an unset, empty or all-blank list matches nothing, so
 * nobody can sign in. This matches the convention `parseMaxEmailsPerDay`
 * already sets for a missing `MAX_EMAILS_PER_DAY` (fail closed to a ceiling
 * of 0) and is the only safe direction for a gate — a config mistake that
 * opened a trial-only site to the whole internet would be silent, whereas one
 * that closes it is reported by the first person who tries to sign in.
 *
 * Entries are trimmed (a comma-separated secret typed by a human will have
 * spaces and possibly newlines around entries) and empty ones are dropped, so
 * a trailing comma cannot create an `""` entry that a blank address would
 * match. Comparison folds ASCII case and nothing else — the same fold as
 * `normaliseEmail` in `link-player.ts`, for the same reason: a full-Unicode
 * `toLowerCase()` collapses U+212A KELVIN SIGN onto `k`, which here would let
 * `K@example.com` walk through a gate meant for `k@example.com`.
 *
 * Exported so its degenerate cases can be pinned directly; the production
 * caller is `isSignInPermitted` above, as the secret half of the union.
 */
export function isSignInAllowlisted(raw: string | undefined, email: string): boolean {
  const wanted = foldAsciiCase(email);
  if (wanted === "") return false;
  if (raw === undefined) return false;

  return raw
    .split(",")
    .map(foldAsciiCase)
    .some((entry) => entry !== "" && entry === wanted);
}

/**
 * Trim, then lowercase `A`-`Z` and nothing else (see `isSignInAllowlisted`).
 *
 * The `trim()` here is for the **allowlist entries** — a human typing a
 * comma-separated secret into `wrangler secret put` will leave stray spaces
 * and newlines around addresses, and those must be tolerated. On the
 * **address** side (the value Better Auth hands the gate) it is currently
 * unreachable dead weight: Better Auth's Zod body schema rejects any
 * whitespace-wrapped address with a 400 before `sendMagicLink` ever runs, so
 * no attacker input reaches this function carrying whitespace to strip. Do
 * not read the address-side `trim()` as the gate normalising its own input —
 * it doesn't need to, today, only because of a validator upstream of it.
 */
export function foldAsciiCase(value: string): string {
  return value.trim().replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

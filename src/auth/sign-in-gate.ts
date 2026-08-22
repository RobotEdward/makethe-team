import { and, desc, eq, notInArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { memberships, players, signinRefusals, signupAllowlist } from "../db/schema.js";
import { isOpenSignups } from "../domain/app-settings.js";

/**
 * The trial sign-in gate (TR-35, widened in M16): may this address be sent a
 * magic link at all?
 *
 * Four doors, any one of which opens the gate:
 *
 * 0. the operator's **open sign ups** switch (M30) — when it is on the allow
 *    list is not in effect at all and any plausible address is permitted. It
 *    is checked first because it makes the other three moot, and it is stored
 *    rather than configured so the operator can close it again without a
 *    deploy;
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

  if (await isOpenSignups(db)) return true;
  if (isSignInAllowlisted(raw, email)) return true;
  if (await isOnAllowlistTable(db, wanted)) return true;
  return hasActiveMembership(db, wanted);
}

/** Door 2 on its own: the folded address is a `signup_allowlist` row. */
async function isOnAllowlistTable(db: Db, wanted: string): Promise<boolean> {
  const [listed] = await db
    .select({ email: signupAllowlist.email })
    .from(signupAllowlist)
    .where(eq(signupAllowlist.email, wanted))
    .limit(1);
  return listed !== undefined;
}

/** Door 3 on its own: a player with this email holds an active membership. */
async function hasActiveMembership(db: Db, wanted: string): Promise<boolean> {
  const [member] = await db
    .select({ id: players.id })
    .from(players)
    .innerJoin(memberships, eq(memberships.playerId, players.id))
    .where(and(eq(players.email, wanted), eq(memberships.active, true)))
    .limit(1);
  return member !== undefined;
}

/** Each gate door's own answer for one address, for the admin sign-in doctor. */
export interface SignInDoors {
  /**
   * Door 0: the operator's open-sign-ups switch (M30). True for every
   * non-blank address while it is on.
   *
   * Adding a field here is not optional bookkeeping: `admin-signin-doctor.ts`
   * recomputes "permitted" as the union of these fields, so a door the gate
   * honours and this shape omits makes the doctor contradict the gate.
   */
  open: boolean;
  /** Door 1: the `SIGNIN_ALLOWLIST` secret. */
  secret: boolean;
  /** Door 2: the `signup_allowlist` table. */
  table: boolean;
  /** Door 3: an invited player with an active membership. */
  member: boolean;
}

/**
 * All four doors, answered independently (M17; the open door added in M30).
 *
 * The admin doctor's view of the gate. Built from the same door checks
 * `isSignInPermitted` composes, so the doctor and the real gate cannot
 * disagree; the only difference is that the gate stops at the first open door
 * and this runs all three, because "which doors" is the whole diagnosis.
 */
export async function explainSignIn(
  db: Db,
  raw: string | undefined,
  email: string,
): Promise<SignInDoors> {
  const wanted = foldAsciiCase(email);
  if (wanted === "") return { open: false, secret: false, table: false, member: false };
  return {
    open: await isOpenSignups(db),
    secret: isSignInAllowlisted(raw, email),
    table: await isOnAllowlistTable(db, wanted),
    member: await hasActiveMembership(db, wanted),
  };
}

/**
 * How many refused-attempt rows `recordSignInRefusal` keeps. Anyone on the
 * internet can create these rows through the sign-in form, so the table is a
 * ring buffer, not a log: enough for the admin doctor's "who was turned away
 * recently", never an unbounded store of stranger-typed addresses.
 */
export const REFUSAL_ROWS_KEPT = 100;

/**
 * Record a refused sign-in attempt for the admin doctor (M17), then prune to
 * the newest `REFUSAL_ROWS_KEPT`.
 *
 * **Never throws.** This runs on the refused branch of `sendMagicLink`; an
 * error escaping here would 500 refused addresses while permitted ones got
 * their 200 — the enumeration oracle the gate exists to close. The same
 * swallow-and-log posture as `sendSignInLink`, for the same reason, and the
 * log line carries no address.
 */
export async function recordSignInRefusal(db: Db, email: string, now: Date): Promise<void> {
  try {
    await db
      .insert(signinRefusals)
      .values({ id: crypto.randomUUID(), email: foldAsciiCase(email), createdAt: now });
    const keep = db
      .select({ id: signinRefusals.id })
      .from(signinRefusals)
      .orderBy(desc(signinRefusals.createdAt), desc(signinRefusals.id))
      .limit(REFUSAL_ROWS_KEPT);
    await db.delete(signinRefusals).where(notInArray(signinRefusals.id, keep));
  } catch (error) {
    console.error(
      `sign-in refusal not recorded: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
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

import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { players } from "../db/schema.js";

/**
 * One sign-in, described in the terms this function needs (TR-30).
 *
 * `verifiedEmail` is *the address the authentication provider has itself
 * verified*, and null when there is none. That is deliberately not the same
 * thing as "the address the person typed": matching a `players` row on an
 * unverified address is account takeover by typing someone else's email, so
 * the unverified case is unrepresentable here rather than guarded against
 * with a boolean the caller could forget to pass. It is also a different
 * notion from `players.email_verified_at`, which is the domain's own record
 * of the same fact — see `emailVerifiedAt` handling below.
 *
 * `name` is only ever used for a Player this function *creates*. It never
 * overwrites an existing row's name: the squad's name for someone is domain
 * data, and a provider profile ("ada.l") must not silently rename them.
 *
 * `now` is passed in, never read from the clock inside, so callers and tests
 * control it.
 */
export interface SignInIdentity {
  /** The `user.id` Better Auth owns; stored in `players.auth_user_id`. */
  authUserId: string;
  /** Provider-verified address, or null if the provider verified none. */
  verifiedEmail: string | null;
  name: string;
  now: Date;
}

/**
 * What linking did. Every outcome is distinguishable because the caller has
 * to react differently to each: three of them are a usable Player, and
 * `conflict`/`ambiguous-email` are refusals that need a human, not a retry.
 */
export type LinkPlayerResult =
  /** The identity was written onto a previously unlinked matching Player. */
  | { outcome: "linked"; playerId: string }
  /** This `authUserId` was already on a Player. Nothing to do. */
  | { outcome: "already-linked"; playerId: string }
  /** No Player matched, so one was created for this person. */
  | { outcome: "created"; playerId: string }
  /**
   * The matching Player already belongs to a *different* identity. Nothing
   * was written. Reachable when the same address arrives under a second
   * provider identity (a second passkey account, a magic-link sign-up beside
   * an existing one), and indistinguishable from an attempt to take the
   * account over — so it is refused and surfaced, never resolved by guessing.
   */
  | { outcome: "conflict"; playerId: string; existingAuthUserId: string }
  /**
   * More than one non-guest Player matched the address, which the
   * case-sensitive `players_email_unique` index permits when two rows differ
   * only in case. Nothing was written; which of them is "the" Player is not
   * a decision this function can make.
   */
  | { outcome: "ambiguous-email"; playerIds: string[] }
  /**
   * The only Player holding this address is a guest. Corrupt data — BR-32
   * says guests have no contact details — and nothing was written: a guest
   * is a name an Owner typed in on someone's behalf, never an account, so it
   * is not linkable, and a new Player cannot be created either because the
   * guest row occupies the address under the unique index. Needs the guest
   * row repaired by a human.
   */
  | { outcome: "email-held-by-guest"; playerIds: string[] };

/**
 * Normalised form of an address, used for *comparison only*.
 *
 * Addresses are matched case-insensitively (trimmed, lower-cased): mail
 * providers treat the domain as case-insensitive and every provider this
 * project uses treats the local part that way too, so `Ada@Example.com` and
 * `ada@example.com` are one person, and refusing to match them would strand
 * them with a second, empty Player.
 *
 * Nothing rewrites an existing row's stored `email` to this form — that is a
 * data migration, not a side effect of someone signing in — so matching is
 * done with `lower(email) = ?` rather than by relying on the stored value.
 * A Player *created* here does store the normalised form, so new rows are
 * consistent from the start.
 */
function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Connect an authenticated identity to its domain `players` row (TR-30).
 *
 * The order of the two lookups matters. `auth_user_id` is checked first, so
 * a re-sign-in is idempotent even if the address at the provider has since
 * changed — matching on email first would find nothing for such a person and
 * create them a duplicate Player. Only then is the verified address used to
 * adopt a Player who was added to a squad by someone else and is now signing
 * in for the first time.
 *
 * Guests (`is_guest = 1`) are excluded from matching explicitly rather than
 * by relying on BR-32's "guests have no email": the column is nullable, not
 * constrained, and a guest row that somehow carried an address must still
 * never be claimable by a sign-in.
 *
 * There is no `db.batch()` here because there is nothing to make atomic: the
 * write is a single statement in every branch. The link is a guarded
 * `UPDATE ... WHERE auth_user_id IS NULL`, i.e. a compare-and-set, so two
 * concurrent sign-ins racing for the same Player cannot both win — the loser
 * sees zero rows changed, re-reads, and reports `already-linked` or
 * `conflict` on what it finds.
 */
export async function linkPlayerOnSignIn(
  db: Db,
  identity: SignInIdentity,
): Promise<LinkPlayerResult> {
  const { authUserId, name, now } = identity;

  const [existing] = await db
    .select({ id: players.id })
    .from(players)
    .where(eq(players.authUserId, authUserId));
  if (existing) return { outcome: "already-linked", playerId: existing.id };

  const email = identity.verifiedEmail === null ? null : normaliseEmail(identity.verifiedEmail);
  if (email === null || email === "") {
    // No verified address, so no Player can be claimed. They are still a real
    // person who signed in and needs somewhere to stand, so they get a Player
    // of their own with no address on it — which claims nothing and collides
    // with nothing (the unique index on `email` is partial and ignores nulls).
    return createPlayer(db, { authUserId, name, email: null, emailVerifiedAt: null, now });
  }

  // Guests are read too, then excluded here rather than in the WHERE clause:
  // the exclusion has to be visible to the *creation* branch as well, because
  // a guest row holding this address would make the insert below fail the
  // unique index. Reading them is how that turns into an answer instead of a
  // D1 constraint error surfacing at sign-in.
  const rows = await db
    .select({ id: players.id, authUserId: players.authUserId, isGuest: players.isGuest })
    .from(players)
    .where(sql`lower(${players.email}) = ${email}`);

  const matches = rows.filter((row) => !row.isGuest);

  if (matches.length > 1) {
    return { outcome: "ambiguous-email", playerIds: matches.map((row) => row.id) };
  }

  const match = matches[0];
  if (!match) {
    const guests = rows.filter((row) => row.isGuest);
    if (guests.length > 0) {
      return { outcome: "email-held-by-guest", playerIds: guests.map((row) => row.id) };
    }
    return createPlayer(db, { authUserId, name, email, emailVerifiedAt: now, now });
  }

  if (match.authUserId !== null) {
    // Not our own id — that was answered by the `auth_user_id` lookup above.
    return { outcome: "conflict", playerId: match.id, existingAuthUserId: match.authUserId };
  }

  const linked = await db
    .update(players)
    .set({
      authUserId,
      // The provider has verified this address, which is the strongest
      // evidence the domain will ever get that it reaches this person, so
      // record it — but only when the domain had none. An existing
      // `email_verified_at` is an *earlier* verification and moving it
      // forward on every sign-in would destroy the one thing the column is
      // for: when we first knew.
      emailVerifiedAt: sql`coalesce(${players.emailVerifiedAt}, ${now.getTime()})`,
    })
    .where(and(eq(players.id, match.id), isNull(players.authUserId)))
    .returning({ id: players.id });

  if (linked.length > 0) return { outcome: "linked", playerId: match.id };

  // Lost the compare-and-set: someone linked this Player between the read
  // and the write. Re-read to say which of the two it was.
  const [current] = await db
    .select({ authUserId: players.authUserId })
    .from(players)
    .where(eq(players.id, match.id));
  if (current?.authUserId === authUserId) return { outcome: "already-linked", playerId: match.id };
  return {
    outcome: "conflict",
    playerId: match.id,
    existingAuthUserId: current?.authUserId ?? "unknown",
  };
}

async function createPlayer(
  db: Db,
  row: { authUserId: string; name: string; email: string | null; emailVerifiedAt: Date | null; now: Date },
): Promise<LinkPlayerResult> {
  const playerId = crypto.randomUUID();
  await db.insert(players).values({
    id: playerId,
    name: row.name,
    email: row.email,
    isGuest: false,
    authUserId: row.authUserId,
    emailVerifiedAt: row.emailVerifiedAt,
    createdAt: row.now,
  });
  return { outcome: "created", playerId };
}

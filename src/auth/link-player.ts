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
 * to react differently to each: three of them are a usable Player, three are
 * refusals that need a human, and one (`create-raced`) is a refusal that
 * wants a retry.
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
  | { outcome: "email-held-by-guest"; playerIds: string[] }
  /**
   * Every attempt lost its race with a concurrent sign-in, and the state the
   * losses pointed at had changed again by the time it was re-read. Nothing
   * was written. Unlike the other refusals this one is *retryable* — it says
   * "the table is moving under us", not "a human must decide" — and it needs
   * `MAX_ATTEMPTS` consecutive interleavings to happen at all.
   */
  | { outcome: "create-raced" };

/**
 * How many times the whole decision is re-made when a write loses a race.
 * Each retry re-reads, so an ordinary single interleaving resolves on the
 * second attempt; the bound exists only so a pathologically busy address
 * cannot spin.
 */
const MAX_ATTEMPTS = 3;

/** "Lost a race, the state has changed, decide again from a fresh read." */
const RETRY = Symbol("retry");

/**
 * Normalised form of an address, used for *comparison only*.
 *
 * Addresses are matched case-insensitively: mail providers treat the domain
 * as case-insensitive and every provider this project uses treats the local
 * part that way too, so `Ada@Example.com` and `ada@example.com` are one
 * person, and refusing to match them would strand them with a second, empty
 * Player.
 *
 * **The fold is ASCII-only, and deliberately so.** The comparison happens in
 * two engines at once — this function folds the incoming address in
 * JavaScript, and the query folds the stored column with SQLite's `lower()`.
 * `String.prototype.toLowerCase()` does full Unicode case folding; SQLite's
 * `lower()` (D1 is built without ICU) only maps `A`-`Z`. Using the two
 * together meant the sides disagreed, and disagreement in this direction is
 * account takeover: `K@example.com` with a U+212A KELVIN SIGN folds to
 * `k@example.com` in JavaScript but not in SQL, so it matched — and claimed —
 * an existing `k@example.com` Player. (It was also lossy the other way:
 * `ÄDA@example.com` signing in as itself missed its own row and minted a
 * duplicate, because JS produced `äda@…` and SQL produced `Äda@…`.)
 *
 * So this maps `A`-`Z` and nothing else, which is *exactly* what `lower()`
 * does. Both sides now apply the identical function, and two distinct strings
 * fold together only if they differ purely by ASCII case — which is the
 * intended semantics. Every non-ASCII confusable (U+212A, U+0130 `İ`, U+017F
 * `ſ`, the `ﬀ` ligatures, full-width forms) is now left alone by both sides
 * and therefore cannot collide with an ASCII address. The price is a false
 * *miss*: two addresses differing in non-ASCII case (`Äda@` vs `äda@`) are
 * treated as two people, and the second gets a new Player. That is the safe
 * direction — a missed match costs a duplicate row a human can merge, a false
 * match costs someone their account.
 *
 * `trim()` is transport hygiene, not folding: a deliverable address has no
 * leading or trailing whitespace (a quoted local part's spaces sit inside the
 * quotes), so trimming cannot bring two real addresses together.
 *
 * Nothing rewrites an existing row's stored `email` to this form — that is a
 * data migration, not a side effect of someone signing in — so matching is
 * done with `lower(email) = ?` rather than by relying on the stored value.
 * A Player *created* here does store the normalised form, so new rows are
 * consistent from the start.
 */
function normaliseEmail(email: string): string {
  return email.trim().replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
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
 * **Concurrency.** D1 has no interactive transactions, so every branch here
 * is a read that decides and a write that could be invalidated in between.
 * Rather than hope, each write is made *conditional in SQL* — the link is a
 * compare-and-set (`UPDATE … WHERE auth_user_id IS NULL`), and both creates
 * are `INSERT … ON CONFLICT DO NOTHING RETURNING`, backed by unique indexes
 * on `email` and (migration `0005`) on `auth_user_id`. A write that changes
 * no row means someone else got there first, and the answer is not to guess
 * but to throw the decision away and make it again from a fresh read: that is
 * the loop below. The retry converges because the winner's row is visible to
 * the next attempt's lookups, which then report `already-linked` (the winner
 * was this same identity, e.g. a double-submitted magic link) or `conflict`
 * (it was a different one).
 */
export async function linkPlayerOnSignIn(
  db: Db,
  identity: SignInIdentity,
): Promise<LinkPlayerResult> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const result = await attemptLink(db, identity);
    if (result !== RETRY) return result;
  }
  return { outcome: "create-raced" };
}

/**
 * One pass of the decision. Returns `RETRY` when a conditional write matched
 * no row, i.e. the read this pass was built on is already stale.
 */
async function attemptLink(
  db: Db,
  identity: SignInIdentity,
): Promise<LinkPlayerResult | typeof RETRY> {
  const { authUserId, name, now } = identity;

  const [existing] = await db
    .select({ id: players.id })
    .from(players)
    .where(eq(players.authUserId, authUserId));
  if (existing) return { outcome: "already-linked", playerId: existing.id };

  // `?? null` rather than `=== null`, so an untyped caller's `undefined` takes
  // the no-address branch instead of throwing inside `normaliseEmail`.
  const raw = identity.verifiedEmail ?? null;
  const email = raw === null ? null : normaliseEmail(raw);
  if (email === null || email === "") {
    // No verified address, so no Player can be claimed. They are still a real
    // person who signed in and needs somewhere to stand, so they get a Player
    // of their own with no address on it — which claims nothing and collides
    // with nothing (the unique index on `email` is partial and ignores nulls).
    // The empty-string case matters: `lower(email) = ''` would happily match a
    // row whose stored address is the empty string.
    return createPlayer(db, { authUserId, name, email: null, emailVerifiedAt: null, now });
  }

  // Guests are read too, then excluded here rather than in the WHERE clause:
  // the exclusion has to be visible to the *creation* branch as well, because
  // a guest row holding this address would make the insert below fail the
  // unique index. Reading them is how that turns into an answer instead of a
  // D1 constraint error surfacing at sign-in.
  //
  // `lower(email)` cannot use `players_email_unique` (which indexes the raw
  // column), so this is a full scan of `players`. Deliberate at this scale —
  // production holds single-digit rows and this runs once per sign-in. An
  // expression index on `lower(email)` is the fix if the table ever grows;
  // it would need its own migration and buys nothing today.
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
    // The compare-and-set. Without `auth_user_id IS NULL` this UPDATE would
    // overwrite an identity written between the read above and this write —
    // a silent account transfer, and the only concurrency control the link
    // branch has.
    .where(and(eq(players.id, match.id), isNull(players.authUserId)))
    .returning({ id: players.id });

  if (linked.length === 0) return RETRY;
  return { outcome: "linked", playerId: match.id };
}

/**
 * Insert the new Player, conditionally: `on conflict do nothing` covers both
 * unique indexes this row can collide with (`players_email_unique` and
 * `players_auth_user_id_unique`), so a concurrent first sign-in loses the
 * insert instead of surfacing a raw D1 constraint error mid-sign-in.
 */
async function createPlayer(
  db: Db,
  row: { authUserId: string; name: string; email: string | null; emailVerifiedAt: Date | null; now: Date },
): Promise<LinkPlayerResult | typeof RETRY> {
  const playerId = crypto.randomUUID();
  const inserted = await db
    .insert(players)
    .values({
      id: playerId,
      name: row.name,
      email: row.email,
      isGuest: false,
      authUserId: row.authUserId,
      emailVerifiedAt: row.emailVerifiedAt,
      createdAt: row.now,
    })
    .onConflictDoNothing()
    .returning({ id: players.id });

  if (inserted.length === 0) return RETRY;
  return { outcome: "created", playerId };
}

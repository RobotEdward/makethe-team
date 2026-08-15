import { and, eq, sql } from "drizzle-orm";
import { buildAuditInsert } from "../db/audit.js";
import type { Db } from "../db/client.js";
import { listActiveMemberships } from "../db/queries.js";
import { account, notificationLog, passkey, players, session, user, verification } from "../db/schema.js";
import type { WithdrawMemberOutcome } from "../capacity/types.js";
import { isLastActiveOwner } from "./last-owner.js";
import { removeMember, type FixturePromotion } from "./remove-member.js";

/**
 * What `players.name` becomes (§4).
 *
 * Deliberately not a plausible name. Renderers branch on `erased_at` and show
 * their own label; this string is a fallback that should never reach a screen,
 * and making it conspicuous means a renderer that forgets the check produces
 * something visibly wrong the first time anyone looks, rather than a fake name
 * that survives review.
 *
 * `redactName` (`src/domain/redact-name.ts`, BR-26) is the specific hazard: it
 * reduces "Edward Cooper" to "Edward C." and returns a single-word name
 * unchanged, so a two-word placeholder would render as the redacted surname of
 * a person who does not exist. The brackets make that impossible to miss.
 */
export const ERASED_NAME = "[erased player]";

export interface ErasePlayerParams {
  db: Db;
  playerId: string;
  now: Date;
  /**
   * Applies BR-3 to one fixture, exactly as `removeMember` takes it. Injected
   * rather than reached for, so this module holds no Workers binding: the
   * sweep passes
   * `(id) => env.FIXTURE_CAPACITY.getByName(id).withdrawMember({...})`.
   */
  withdraw: (fixtureId: string) => Promise<WithdrawMemberOutcome>;
}

export type ErasePlayerResult =
  | { kind: "erased"; promotions: FixturePromotion[] }
  | {
      /**
       * At least one game would be left with no active organiser. **No
       * membership, response or session has been touched** — the check runs
       * across every game before any removal happens — but the refusal itself
       * is recorded (`players.erasure_blocked_at` and one
       * `player.erasure_blocked` audit row, written once per transition; see
       * `recordBlocked`). The erasure stays pending and is retried hourly.
       *
       * The one exception is a *late* block, returned from inside the removal
       * loop after a concurrent change: earlier memberships may already be
       * gone, and `players.erasure_started_at` is what says so.
       */
      kind: "blocked";
      gameIds: string[];
    }
  | { kind: "already-erased" }
  | { kind: "not-found" };

/**
 * Escape a value for a `LIKE` pattern, so `_` and `%` in it match themselves.
 *
 * An email containing an underscore is ordinary, and without this a pattern
 * built from `a_b@example.com` would also match `axb@example.com` — deleting a
 * different person's pending magic link. The backslash must be escaped first,
 * or it would escape the escapes added after it.
 */
function escapeLike(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/**
 * Report a blocked erasure, and record it if it is news.
 *
 * §6 asks for three things when execution is refused: the erasure stays
 * pending, an audit row is written, and the player's dashboard names the game
 * holding it up. This is the second; `players.erasure_blocked_at` — set here —
 * is also what the third reads. Only the first was implemented until the final
 * review, which meant a blocked erasure had no durable trace at all: an
 * aggregate count in one log line, and a page that went on promising a date
 * that had already passed.
 *
 * **Once per transition, not once per retry.** The sweep runs hourly and a
 * block can last for weeks — nobody is obliged to find a replacement organiser
 * — so an unconditional insert here is a row an hour, forever, into a table
 * nothing prunes. `alreadyBlocked` is the guard, and the marker it reads is
 * cleared by any run that gets past the pre-check, so a genuine re-block after
 * a handover is recorded again.
 *
 * Nothing else is written: the erasure stays exactly as pending as it was, and
 * a retry costs the same queries it always did.
 */
async function recordBlocked(
  db: Db,
  playerId: string,
  gameIds: string[],
  now: Date,
  alreadyBlocked: boolean,
): Promise<ErasePlayerResult> {
  if (!alreadyBlocked) {
    await db.batch([
      db.update(players).set({ erasureBlockedAt: now }).where(eq(players.id, playerId)),
      buildAuditInsert(db, {
        actorPlayerId: playerId,
        entityType: "player",
        entityId: playerId,
        action: "player.erasure_blocked",
        // Ids, never names: §3's rule for this table. The games are named on
        // the page, from a live join, not from a payload frozen weeks ago.
        after: { gameIds },
        now,
      }),
    ]);
  }
  return { kind: "blocked", gameIds };
}

/**
 * Erase a player: leave every squad, then anonymise the row in place (§3).
 *
 * **In place, not deleted.** `responses`, `audit_log` and `notification_log`
 * all hold foreign keys here, and those rows are what keep a past fixture
 * honest — a fixture that was ten-a-side still reads as ten-a-side. What
 * survives is keyed by a random id no longer connected to a name, an address,
 * or any means of signing in.
 *
 * **The invariant is checked across every game before any of them is left.**
 * `removeMember` refuses to remove a game's last active organiser, and
 * discovering that on the third game after leaving the first two would leave
 * the person half-erased with no way to finish and no way to undo. So the
 * whole set is checked first and the operation either runs or reports
 * `blocked`, having touched no membership, no response and no session — only
 * the marker and audit row `recordBlocked` writes, which are the record *of*
 * the refusal rather than any part of the erasure. A *concurrent* change
 * between the check and the removal loop can still produce a late `blocked`;
 * see the comment inside the loop.
 *
 * Past that pre-check, the rest of the function — the removal loop, the
 * Better Auth deletes, and the final anonymising `db.batch()` — is not one
 * atomic unit either: D1 has no interactive transaction spanning Durable
 * Object calls and multiple `db.batch()`s, so a failure partway through
 * leaves real, resumable partial progress rather than a rollback. That is
 * accepted rather than fixed here, the same way `removeMember` accepts it
 * for its own two writes.
 *
 * It sends nothing. Promotions are returned for the caller to notify, exactly
 * as `removeMember` returns them.
 */
export async function erasePlayer(params: ErasePlayerParams): Promise<ErasePlayerResult> {
  const { db, playerId, now, withdraw } = params;

  const [player] = await db
    .select({
      email: players.email,
      authUserId: players.authUserId,
      erasedAt: players.erasedAt,
      erasureStartedAt: players.erasureStartedAt,
      erasureBlockedAt: players.erasureBlockedAt,
    })
    .from(players)
    .where(eq(players.id, playerId));

  if (player === undefined) return { kind: "not-found" };
  // Already done. Re-running must not write a second audit row asserting a
  // second erasure that never happened, and must not move `erased_at`.
  if (player.erasedAt !== null) return { kind: "already-erased" };

  const memberships = await listActiveMemberships(db, playerId);

  const blocked: string[] = [];
  for (const membership of memberships) {
    if (await isLastActiveOwner(db, membership.gameId, { role: membership.role, active: true })) {
      blocked.push(membership.gameId);
    }
  }
  if (blocked.length > 0) {
    return recordBlocked(db, playerId, blocked, now, player.erasureBlockedAt !== null);
  }

  // Past the pre-check: everything below writes, and none of it can be undone.
  // Marking that here — before the first removal, not after the last write —
  // is what makes a run that stops half-way distinguishable from one that
  // never started. Without it the page goes on saying "nothing has changed,
  // you're still in your squads" to somebody whose place has already been
  // given away, and cancel strands the account out of its squads with nothing
  // left to finish the job. See the column comment in `src/db/schema.ts`.
  //
  // `?? now` rather than `now`: a resumed run keeps the instant the *first*
  // one began, which is the moment the irreversible part actually started.
  //
  // The blocked marker is cleared in the same statement. A run that gets this
  // far is no longer blocked, so a block after this point is a new transition
  // and earns its own audit row.
  await db
    .update(players)
    .set({ erasureStartedAt: player.erasureStartedAt ?? now, erasureBlockedAt: null })
    .where(eq(players.id, playerId));

  // Leave every squad. The player is their own actor, exactly as `POST
  // /leave/:token` treats a leaver, so the audit trail reads as "they left".
  const promotions: FixturePromotion[] = [];
  for (const membership of memberships) {
    const result = await removeMember({
      db,
      gameId: membership.gameId,
      playerId,
      actorPlayerId: playerId,
      now,
      withdraw,
    });
    if (result.kind === "removed" || result.kind === "resumed") {
      promotions.push(...result.promotions);
    }
    // The pre-check above and this loop are two separate reads with nothing
    // atomic between them (D1 has no interactive transaction spanning the
    // membership rows checked and the ones this loop then removes), so a
    // concurrent change to a *different* membership of the same game — the
    // other active owner being removed or demoted in that window — can make
    // `removeMember` refuse here even though the pre-check passed. Falling
    // through would anonymise a player who is still that game's sole active
    // owner: a permanently locked game, and an "erased" person still running
    // it. So this reports `blocked` instead, exactly as the pre-check would
    // have. Earlier memberships in this loop may already be gone by this
    // point, but that is a resumable state, not a corrupted one: `erased_at`
    // is still null, so nothing has claimed the player is erased, and
    // `removeMember` is idempotent on a membership already left — a retry
    // (the next sweep run, or the player trying again) finishes cleanly.
    //
    // `false` for `alreadyBlocked`: the update above cleared the marker on the
    // way past the pre-check, so this is always a fresh transition and always
    // earns its row — and that row is the only durable trace that a *started*
    // erasure has stopped part-way.
    if (result.kind === "refused") {
      return recordBlocked(db, playerId, [membership.gameId], now, false);
    }
  }

  // Better Auth's own rows. Hard-deleted, unlike everything above: nothing
  // references them, and a surviving session or passkey is a way back into an
  // account that no longer exists. Children before the parent — `session`,
  // `account` and `passkey` all carry a foreign key to `user`.
  if (player.authUserId !== null) {
    await db.delete(session).where(eq(session.userId, player.authUserId));
    await db.delete(account).where(eq(account.userId, player.authUserId));
    await db.delete(passkey).where(eq(passkey.userId, player.authUserId));
    await db.delete(user).where(eq(user.id, player.authUserId));
  }

  // Pending magic links. `verification.value` holds a JSON blob containing the
  // address, so these rows are residual personal data in their own right as
  // well as a live way in. Matched by `LIKE` because the address is embedded
  // in that blob rather than being the whole of it.
  //
  // **What this match does and does not cover.** Better Auth's magic-link
  // rows (N-5, the only way into this product for most people) store
  // `JSON.stringify({ email, name })`, so the address is in `value` and the
  // pattern finds them. An abandoned *passkey registration* challenge does
  // not: its `value` holds `userData: { id, name, displayName }`, with no
  // address in it, so it is only reached while `user.name` happens to be the
  // address — which it is for a player who signed in by magic link and never
  // set a name, and is not otherwise. Such a row is a short-lived WebAuthn
  // challenge for a user record this function has just hard-deleted, so it
  // authenticates nothing and expires on its own; it is recorded here because
  // "every verification row is gone" would be the wrong thing to believe.
  //
  // Built as a single `sql` template rather than Drizzle's `like()` helper:
  // `like()` has no way to attach an `ESCAPE` clause, and the escaping is not
  // optional — see `escapeLike`. Test coverage sends an underscore through
  // this path to prove it does not become a SQL wildcard.
  const email = player.email?.trim() ?? "";
  if (email !== "") {
    const pattern = `%${escapeLike(email)}%`;
    await db.delete(verification).where(sql`${verification.value} LIKE ${pattern} ESCAPE '\\'`);
  }

  // See the test: this column can hold the provider's response body, which
  // quotes the address it rejected.
  await db
    .update(notificationLog)
    .set({ error: null })
    .where(and(eq(notificationLog.playerId, playerId), sql`${notificationLog.error} is not null`));

  await db.batch([
    db
      .update(players)
      .set({
        name: ERASED_NAME,
        email: null,
        authUserId: null,
        emailVerifiedAt: null,
        erasedAt: now,
      })
      .where(eq(players.id, playerId)),
    buildAuditInsert(db, {
      actorPlayerId: playerId,
      entityType: "player",
      entityId: playerId,
      action: "player.erased",
      now,
    }),
  ]);

  return { kind: "erased", promotions };
}

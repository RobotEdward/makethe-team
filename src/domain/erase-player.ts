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
       * At least one game would be left with no active organiser. **Nothing
       * has been written** — the check runs across every game before any
       * removal happens.
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
 * `blocked`, having written nothing — except that a *concurrent* change
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
    .select({ email: players.email, authUserId: players.authUserId, erasedAt: players.erasedAt })
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
  if (blocked.length > 0) return { kind: "blocked", gameIds: blocked };

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
    if (result.kind === "refused") return { kind: "blocked", gameIds: [membership.gameId] };
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

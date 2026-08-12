import { and, eq } from "drizzle-orm";
import { buildAuditInsert } from "../db/audit.js";
import type { Db } from "../db/client.js";
import { fixtures, memberships, players, responses } from "../db/schema.js";
import type { Lifecycle } from "./lifecycle.js";
import { isCancellationRecipient, type ResponseStatus } from "./response-status.js";

/**
 * One player who must be told the fixture is off (N-3, BR-20).
 *
 * `email` may be null even here: only guests are excluded by BR-32, and a
 * non-guest with no address is a data anomaly rather than a category. The
 * send path already handles that case (`skipped-no-recipient` in
 * `src/notify/send-promotion.ts`), so this operation reports who *should* be
 * told and leaves "can we actually reach them" to the layer that sends.
 */
export interface CancellationRecipient {
  playerId: string;
  name: string;
  email: string | null;
  /** `in` or `waitlisted`; the email's copy is the same for both, but the caller logs which. */
  status: ResponseStatus;
}

export interface CancelFixtureInput {
  fixtureId: string;
  /** Whoever the cancellation token identified. Proving who they are is not proving they may. */
  actorPlayerId: string;
  /** Stored verbatim, including empty — see below. */
  reason: string;
  now: Date;
}

/**
 * `not-entitled` is deliberately one reason, not three. A stranger, a plain
 * member and an owner who has since been removed from the squad are all
 * refused with the same value, so nothing reaching a user distinguishes "you
 * were never an owner" from "you are no longer one".
 */
export type CancelFixtureResult =
  | { cancelled: true; recipients: CancellationRecipient[] }
  | { cancelled: false; reason: "not-found" | "not-entitled" | "already-cancelled" | "played" };

/**
 * Cancel a fixture (BR-14) and report who needs telling.
 *
 * Always manual, always by an owner, always from a non-terminal lifecycle.
 * Three things happen: the lifecycle write, an `audit_log` row (BR-27), and
 * the recipient set for N-3 handed back to the caller. **This function sends
 * nothing** — keeping the send in the route is what keeps the operation
 * testable against nothing but a database.
 *
 * Deliberately *not* routed through the capacity Durable Object. The object
 * serialises slot arithmetic; this is a lifecycle change and touches no
 * counts. Nor does it need the object to fence off late responses: once the
 * lifecycle is `cancelled`, responses on this fixture are effectively frozen,
 * because `FixtureCapacity.setResponse` already refuses any fixture whose
 * lifecycle is not `open` (`src/capacity/fixture-capacity.ts`). A response
 * racing this write is therefore either accepted before the cancellation —
 * and its player is simply not in the recipient set, which is the same
 * outcome as answering a second later — or refused after it.
 */
export async function cancelFixture(
  db: Db,
  input: CancelFixtureInput,
): Promise<CancelFixtureResult> {
  const { fixtureId, actorPlayerId, reason, now } = input;

  const [fixture] = await db
    .select({ gameId: fixtures.gameId, lifecycle: fixtures.lifecycle })
    .from(fixtures)
    .where(eq(fixtures.id, fixtureId));
  if (!fixture) return { cancelled: false, reason: "not-found" };

  // Checked before the lifecycle guards so that an unentitled actor learns
  // nothing about the fixture's state from the refusal they get.
  if (!(await mayCancelFixture(db, fixture.gameId, actorPlayerId))) {
    return { cancelled: false, reason: "not-entitled" };
  }

  const before: Lifecycle = fixture.lifecycle;
  if (before === "cancelled") return { cancelled: false, reason: "already-cancelled" };
  if (before === "played") return { cancelled: false, reason: "played" };

  const recipients = await cancellationRecipients(db, fixtureId);

  // One batch, deliberately. D1 has no interactive transactions, so this is
  // the only way the lifecycle change and its audit row cannot diverge — and
  // a lifecycle change recorded nowhere is precisely what BR-27 exists to
  // prevent. Two statements, so the 100-bound-parameter ceiling is not in
  // play; nothing here is variable-length, so no chunking either.
  //
  // The reason is stored verbatim, including when it is empty or nothing but
  // whitespace: the database records what the owner typed, and deciding that
  // a blank reason is the same as no reason is the *template's* judgement
  // (see `CancellationEmailPayload.reason`), made at render time where it can
  // be changed without rewriting history.
  await db.batch([
    db
      .update(fixtures)
      .set({ lifecycle: "cancelled", cancelledAt: now, cancellationReason: reason })
      .where(eq(fixtures.id, fixtureId)),
    // Built through `buildAuditInsert` rather than `recordAudit` itself,
    // which issues its own statement and so could not join this batch — but
    // the row shape now has exactly one definition, shared with every other
    // `audit_log` writer.
    buildAuditInsert(db, {
      actorPlayerId,
      entityType: "fixture",
      entityId: fixtureId,
      action: "fixture.cancelled",
      before: { lifecycle: before },
      after: { lifecycle: "cancelled", reason },
      now,
    }),
  ]);

  return { cancelled: true, recipients };
}

/**
 * Whether `actorPlayerId` may cancel fixtures of Game `gameId`.
 *
 * A security boundary rather than a validation nicety: a token proves *who*,
 * this proves *entitled*. An active owner membership **of this fixture's
 * Game** is required — "active" being `memberships.active`, the same flag
 * `openFixture` uses to decide who is even invited, so an owner removed from
 * the squad after the cancellation email was sent cannot still act on it.
 *
 * Exported so the confirmation page (`src/routes/cancel.ts`) applies the
 * identical rule on its read-only `GET` before it will render anything about
 * a fixture. That page must refuse exactly the actors `cancelFixture` would
 * refuse, and one definition is the only way the two cannot drift into a
 * page that previews a cancellation the `POST` then declines — or, far
 * worse, previews a Game's details to somebody entitled to none of it.
 */
export async function mayCancelFixture(db: Db, gameId: string, actorPlayerId: string): Promise<boolean> {
  const [membership] = await db
    .select({ id: memberships.id })
    .from(memberships)
    .where(
      and(
        eq(memberships.gameId, gameId),
        eq(memberships.playerId, actorPlayerId),
        eq(memberships.role, "owner"),
        eq(memberships.active, true),
      ),
    );
  return membership !== undefined;
}

/**
 * Everything the confirmation page needs to say what a cancellation will do,
 * read together so the two numbers on it cannot disagree.
 */
export interface CancellationInfo {
  /**
   * Players currently holding an `in` slot (BR-3), computed the same way
   * `FixtureCapacity` computes `fixtures.inCount` — every response whose
   * status is `in`, guest or not — but read live from `responses` rather than
   * from that denormalised counter. The confirmation page's whole purpose is
   * telling an owner what is about to happen *before* it happens, so showing
   * a number that could, in principle, have drifted from the counter that
   * happens to also say "in" is worse here than it would be anywhere else in
   * the product: use the same query {@link recipients} already ran, not a
   * second read of a second source.
   */
  inCount: number;
  recipients: CancellationRecipient[];
}

/**
 * Everyone and everything the confirmation page and the cancellation itself
 * need to know about fixture `fixtureId`'s responses, from a single read.
 *
 * BR-20's rule lives in exactly one place — the predicate
 * `isCancellationRecipient` that the N-3 template's module exports — rather
 * than being restated as a `where` clause here, so the recipients this
 * returns cannot drift from the recipients that email was written for.
 *
 * Read-only, and exported for that reason: the confirmation page counts this
 * exact set to tell an owner how many people a cancellation will email,
 * *before* anything is cancelled. A separate count query would be a second
 * definition of "who gets told", free to disagree with the real one — and the
 * same reasoning is why {@link CancellationInfo.inCount} is derived from
 * this same read rather than from `fixtures.inCount`.
 */
export async function cancellationInfo(db: Db, fixtureId: string): Promise<CancellationInfo> {
  const answered = await db
    .select({
      playerId: responses.playerId,
      status: responses.status,
      name: players.name,
      email: players.email,
      isGuest: players.isGuest,
    })
    .from(responses)
    .innerJoin(players, eq(players.id, responses.playerId))
    .where(eq(responses.fixtureId, fixtureId));

  return {
    inCount: answered.filter((row) => row.status === "in").length,
    recipients: answered
      .filter((row) => isCancellationRecipient(row.status, row.isGuest))
      .map(({ playerId, name, email, status }) => ({ playerId, name, email, status })),
  };
}

/**
 * Everyone who must be told fixture `fixtureId` is off (BR-20), whether or
 * not they can actually be reached (see {@link CancellationRecipient}).
 *
 * A thin wrapper over {@link cancellationInfo} for the one caller
 * (`cancelFixture` below) that needs only the recipient list, not the count.
 */
export async function cancellationRecipients(db: Db, fixtureId: string): Promise<CancellationRecipient[]> {
  return (await cancellationInfo(db, fixtureId)).recipients;
}

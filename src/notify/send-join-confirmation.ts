import { and, eq, lt } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { joinConfirmations } from "../db/schema.js";
import { loadAdminNotificationSwitches } from "../domain/app-settings.js";
import { joinTokenExpiry, signJoinToken } from "../domain/token.js";
import { joinConfirmPath } from "../auth/paths.js";
import { SITE_ORIGIN } from "./delivery.js";
import type { Notifier } from "./notifier.js";
import { DAILY_CEILING_REASON } from "./quota.js";
import { renderJoinConfirmationEmail } from "./templates/join-confirmation.js";

export type JoinConfirmationOutcome =
  | { kind: "sent" }
  | { kind: "already-sent-today" }
  | { kind: "switched-off" }
  | { kind: "deferred" }
  | { kind: "failed"; reason: string };

export interface SendJoinConfirmationParams {
  db: Db;
  /** Always the quota-wrapped notifier from `createNotifier` (TR-31). */
  notifier: Notifier;
  gameId: string;
  gameName: string;
  inviteToken: string;
  /** Already normalised (`normaliseEmail`). */
  email: string;
  /** Already trimmed and non-empty. */
  name: string;
  now: Date;
  responseTokenSecret: string;
}

/** The UTC calendar day, the same convention `email_quota.day` uses. */
export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function dayBefore(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return utcDay(d);
}

/**
 * Send N-14 (M39). **No `notification_log` row**: `player_id` there is NOT
 * NULL and there is no player yet. The once-per-day guard is the primary key
 * of `join_confirmations`, claimed *before* the send so two concurrent
 * submissions cannot both mail the same address — one of them hits the
 * conflict and reports `already-sent-today`.
 *
 * The day is released on a ceiling refusal (the message never left) **and on
 * a provider failure**, even though the message may have gone out in that
 * second case. Keeping the claim on a provider failure would make the
 * caller's own "please try again in a little while" retry hit
 * `already-sent-today` and show "Check your inbox" with no email ever sent —
 * a real lockout, not a hypothetical one. A possible duplicate confirmation
 * is cheaper than a day's lockout on someone's first contact with the
 * product.
 */
export async function sendJoinConfirmation(params: SendJoinConfirmationParams): Promise<JoinConfirmationOutcome> {
  const { db, notifier, gameId, gameName, inviteToken, email, name, now, responseTokenSecret } = params;

  const admin = await loadAdminNotificationSwitches(db);
  if (!admin.isOn("n14", "email")) return { kind: "switched-off" };

  const day = utcDay(now);
  // Two days, not one: a row from yesterday must survive so that a request at
  // 23:59 and its retry at 00:01 are still two different days, not a prune of
  // the row that was just written.
  await db.delete(joinConfirmations).where(lt(joinConfirmations.day, dayBefore(day)));
  const claimed = await db
    .insert(joinConfirmations)
    .values({ gameId, email, day, createdAt: now })
    .onConflictDoNothing()
    .returning({ day: joinConfirmations.day });
  if (claimed.length === 0) return { kind: "already-sent-today" };

  const releaseClaim = () =>
    db.delete(joinConfirmations).where(and(eq(joinConfirmations.gameId, gameId), eq(joinConfirmations.email, email), eq(joinConfirmations.day, day)));

  const jtoken = await signJoinToken(
    { gameId, inviteToken, email, name, expiresAt: joinTokenExpiry(now).getTime() },
    responseTokenSecret,
  );
  const rendered = renderJoinConfirmationEmail({ name, gameName, confirmUrl: `${SITE_ORIGIN}${joinConfirmPath(jtoken)}` });

  const [result] = await notifier.send([
    // A fresh UUID, as N-5 uses: each issuance is a distinct message, and
    // keying on the token would write a live credential into provider logs.
    { channel: "email", to: email, subject: rendered.subject, html: rendered.html, text: rendered.text, dedupeKey: `n14:${crypto.randomUUID()}` },
  ]);
  if (result === undefined) {
    await releaseClaim();
    return { kind: "failed", reason: "notifier-contract-violation" };
  }
  if (result.ok) return { kind: "sent" };
  if (result.error === DAILY_CEILING_REASON) {
    await releaseClaim();
    return { kind: "deferred" };
  }
  await releaseClaim();
  return { kind: "failed", reason: result.error };
}

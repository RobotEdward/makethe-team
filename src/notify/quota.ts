import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { emailQuota } from "../db/schema.js";
import type { Message, Notifier, SendResult } from "./notifier.js";

/**
 * The distinct, greppable reason a message is refused once the daily send
 * ceiling is reached (TR-31). Never used for a message that was actually
 * attempted and failed at the provider — that keeps this string a reliable
 * signal that the ceiling, specifically, is what stopped delivery.
 */
export const DAILY_CEILING_REASON = "daily-ceiling-reached";

/**
 * Wraps a `Notifier` with the project's single most important cost control
 * (TR-31, TR-32/BR-32).
 *
 * Cloudflare has no account-level spend cap, and email is the one outbound
 * cost with no ceiling above it. This decorator is that ceiling: per UTC
 * day, it never lets more than `maxPerDay` messages reach the wrapped
 * notifier, and it never silently drops a message beyond that — every
 * refusal comes back as `{ ok: false, error: DAILY_CEILING_REASON }` so a
 * sweep can log it, not misread it as a successful send.
 *
 * Guests (`Message.to` empty) are dropped before they can consume quota,
 * are not failures, and never reach the wrapped notifier (BR-32, TR-32).
 * `Message.to` is typed `string`, so a well-typed caller can never actually
 * construct one of these — every real message a strictly-typed sweep builds
 * already has an email. The check exists anyway, deliberately, because this
 * class is described as "the last thing standing between a mistake and
 * someone's inbox": it must not *trust* that every upstream caller, present
 * or future, got the filtering right. Reading `message.to` as possibly
 * empty despite its declared type is exactly the "documented type-guard
 * boundary" the project's `no any` rule carves out room for.
 *
 * Preserves the one-result-per-input-in-order contract exactly: every
 * message — sent, refused or skipped — gets exactly one `SendResult` at its
 * own index, never reordered, never dropped.
 *
 * Concurrency: the reservation (see `reserve`) is a single atomic D1 batch
 * that reads the day's counter and writes its clamped update inside one
 * transaction, so two overlapping `send` calls cannot both believe they had
 * room for the same slot — whichever batch's transaction commits first
 * reserves its slots; the other sees the updated counter. See the class's
 * test file for a concurrent-sends assertion of this property.
 */
export class QuotaNotifier implements Notifier {
  constructor(
    private readonly wrapped: Notifier,
    private readonly db: Db,
    private readonly maxPerDay: number,
    private readonly now: Date,
  ) {}

  async send(messages: readonly Message[]): Promise<SendResult[]> {
    if (messages.length === 0) return [];

    const results: SendResult[] = new Array(messages.length);
    const eligible: { index: number; message: Message }[] = [];

    messages.forEach((message, index) => {
      if (hasNoEmail(message)) {
        // BR-32/TR-32: silently skipped, not a failure, no quota consumed.
        results[index] = { ok: true, providerMessageId: null };
      } else {
        eligible.push({ index, message });
      }
    });

    if (eligible.length === 0) return results;

    const day = dayKey(this.now);
    const granted = await this.reserve(day, eligible.length);

    const toSend = eligible.slice(0, granted);
    const refused = eligible.slice(granted);

    for (const { index } of refused) {
      results[index] = { ok: false, error: DAILY_CEILING_REASON };
    }

    if (toSend.length > 0) {
      const sendResults = await this.wrapped.send(toSend.map((entry) => entry.message));
      toSend.forEach((entry, i) => {
        // `wrapped.send` is contractually required to return one result per
        // input, in order (notifier.ts) — `sendResults[i]` always exists.
        const result = sendResults[i];
        if (result !== undefined) results[entry.index] = result;
      });
    }

    return results;
  }

  /**
   * Atomically reserves up to `requested` slots against today's counter and
   * returns how many were actually granted (0..requested).
   *
   * Both statements run inside one D1 `batch`, which Cloudflare documents as
   * executing as a single implicit transaction: no other `send` call's
   * batch can write to this row between this batch's read and its write.
   * The `SELECT` reports the pre-reservation count; the upsert clamps the
   * new count to `maxPerDay` using the row's own current value, evaluated
   * by SQLite as part of the same statement — so the write is correct
   * regardless of what this batch's own `SELECT` saw. The two are combined
   * in JS only to compute `granted` for the caller; the stored counter is
   * never at risk of exceeding `maxPerDay`, even if that arithmetic were
   * wrong.
   */
  private async reserve(day: string, requested: number): Promise<number> {
    const limit = this.maxPerDay;
    if (limit <= 0 || requested <= 0) return 0;

    const [selectResult] = await this.db.batch([
      this.db.select({ sentCount: emailQuota.sentCount }).from(emailQuota).where(eq(emailQuota.day, day)),
      this.db
        .insert(emailQuota)
        .values({ day, sentCount: Math.min(requested, limit) })
        .onConflictDoUpdate({
          target: emailQuota.day,
          set: {
            sentCount: sql`${emailQuota.sentCount} + min(${requested}, max(${limit} - ${emailQuota.sentCount}, 0))`,
          },
        }),
    ]);

    const before = selectResult[0]?.sentCount ?? 0;
    return Math.min(requested, Math.max(limit - before, 0));
  }
}

/**
 * True when a message has no usable recipient address. `Message.to` is
 * typed `string` and never `null` in the interface, but this class is a
 * deliberate boundary against that guarantee being violated at runtime —
 * see the class doc comment.
 */
function hasNoEmail(message: Message): boolean {
  const to: unknown = message.to;
  return to === null || to === undefined || (typeof to === "string" && to.trim() === "");
}

/** The UTC calendar day `now` falls on, as `YYYY-MM-DD` (§2.8's quota table key). */
function dayKey(now: Date): string {
  const iso = now.toISOString();
  return iso.slice(0, 10);
}

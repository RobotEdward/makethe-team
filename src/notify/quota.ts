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
 * The distinct, greppable reason a message is refused for having no usable
 * recipient address (BR-32, TR-32). `ok: false`, not `ok: true` — a guest
 * skip must never be byte-identical to a real send, or a caller mapping
 * results onto `notification_log` rows would record a delivery that never
 * happened.
 */
export const NO_RECIPIENT_REASON = "no-recipient";

/**
 * The distinct, greppable reason recorded when a `Notifier` breaks the
 * one-result-per-input-in-order contract (`notifier.ts`) and returns a short
 * result array, leaving a message with no outcome of its own.
 *
 * Shared by every producer of the string (this class and the sweep) so the
 * two can never drift apart, exactly as its two siblings above already are.
 *
 * This means *no result was reported*, which — for every implementation in
 * the repo, all of which build their result array by mapping over their own
 * input — can only happen if nothing was attempted for that slot. It is
 * therefore treated as retryable by the sweep, unlike a genuine provider
 * error (which is ambiguous and must not be retried). It is still a bug in
 * the notifier, so it is also surfaced as a failure rather than filed
 * alongside the expected, benign daily-ceiling deferral.
 */
export const NOTIFIER_CONTRACT_VIOLATION_REASON = "notifier-contract-violation";

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
 * Guests (`Message.to` empty) are dropped before they can consume quota and
 * never reach the wrapped notifier — returned as
 * `{ ok: false, error: NO_RECIPIENT_REASON }`, a distinct reason rather than
 * a byte-identical-to-success `ok: true`, so a sweep mapping results onto
 * `notification_log` rows never records a delivery that never happened
 * (BR-32, TR-32). Filtering guests out is the *caller's* job, not this
 * class's: `Message.to` stays `string`, which makes an unsendable message a
 * compile-time impossibility rather than a runtime obligation every
 * `Notifier` implementation has to remember. This check exists anyway,
 * purely as a defensive boundary, because this class is described as "the
 * last thing standing between a mistake and someone's inbox": it must not
 * *trust* that every upstream caller, present or future, got the filtering
 * right. Reading `message.to` as possibly empty despite its declared type
 * is exactly the "documented type-guard boundary" the project's `no any`
 * rule carves out room for.
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
        // BR-32/TR-32: never sent, no quota consumed. `ok: false` with a
        // distinct, greppable reason — not `ok: true` — because a byte-
        // identical success would be indistinguishable from a real delivery
        // to a caller mapping results onto notification_log rows, and the
        // whole point of this class is that no outcome here is silent.
        results[index] = { ok: false, error: NO_RECIPIENT_REASON };
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
        // input, in order (notifier.ts). A conforming implementation always
        // has an entry here; a non-conforming one must not leave a typed
        // hole in `results` (that reads as a crash for any caller doing
        // `results[i].ok`, not a diagnosable failure) — so a short result
        // array is itself treated as a fault of the wrapped notifier, not
        // silently tolerated.
        const result = sendResults[i];
        results[entry.index] =
          result ?? { ok: false, error: NOTIFIER_CONTRACT_VIOLATION_REASON };
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

/**
 * The UTC calendar day `now` falls on, as `YYYY-MM-DD` (§2.8's quota table
 * key). Exported for the admin delivery page (M17), which must read the
 * quota row under exactly the key the quota writes, or a timezone slip would
 * show the operator "0 sent" on a day the ceiling was full.
 */
export function dayKey(now: Date): string {
  const iso = now.toISOString();
  return iso.slice(0, 10);
}

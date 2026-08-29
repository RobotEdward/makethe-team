import type { Message, Notifier, SendResult } from "./notifier.js";
import { DAILY_CEILING_REASON, NOTIFIER_CONTRACT_VIOLATION_REASON } from "./quota.js";

/**
 * Offers each message to a series of quota-wrapped notifiers, moving on to
 * the next one only for the messages the previous one refused *for capacity*
 * (M42).
 *
 * # Why the spill condition is `DAILY_CEILING_REASON` and nothing else
 *
 * The whole design of this class is that spilling over is the existing
 * "we ran out of room" path, replayed against a leg that still has room.
 * Every other outcome is final:
 *
 *  - `ok: true` — sent. Retrying on another provider would deliver twice.
 *  - `NO_RECIPIENT_REASON` — there is no address. No provider can fix that.
 *  - a provider error — **ambiguous**. Resend may well have accepted and
 *    delivered the mail before the connection failed, and `applySendResult`
 *    in `delivery.ts` already declines to retry these for that reason.
 *    Spilling one to Cloudflare would be this codebase's first mechanism
 *    that can double-send, and it would do it precisely when a player is
 *    already being told something important.
 *
 * So the condition is a single, exact string match, not "anything that
 * wasn't `ok`". A wider condition is the bug this comment exists to
 * prevent.
 *
 * # What the caller sees
 *
 * A message no leg had room for comes back as `DAILY_CEILING_REASON`,
 * exactly as it did when there was one provider. That is what keeps
 * `delivery.ts`, `ceiling-audit.ts`, the sweep's retry semantics and the
 * N-1/N-4 owner warnings working with no changes at all: they were already
 * written against "the ceiling refused this", and adding capacity behind
 * that string does not change its meaning.
 *
 * # Order matters and is not arbitrary
 *
 * `legs` is tried in order, so the first leg should be the one whose
 * allowance is use-it-or-lose-it and free. Resend's free tier is a daily
 * 100 that does not roll over; Cloudflare's is a monthly 3,000 that bills
 * at $0.35/1,000 beyond it. Filling Resend first therefore spends the
 * perishable allowance before the durable one, and reaches paid sending
 * strictly later than any other order would. Cloudflare also has no
 * idempotency key (see `CloudflareEmailNotifier`), which is a second reason
 * for it to be the leg that runs last and least.
 */
export class SpilloverNotifier implements Notifier {
  private readonly legs: readonly Notifier[];

  constructor(legs: readonly Notifier[]) {
    if (legs.length === 0) {
      // An empty leg list would make `send` return "the ceiling refused
      // this" for every message forever, which reads in the audit log
      // exactly like a genuinely exhausted quota. A misconfiguration must
      // not be able to impersonate the condition operators are watching
      // for, so it fails at construction — in `createNotifier`, at startup,
      // like every other binding fault in this module.
      throw new Error("SpilloverNotifier needs at least one leg");
    }
    this.legs = legs;
  }

  async send(messages: readonly Message[]): Promise<SendResult[]> {
    if (messages.length === 0) return [];

    const results: SendResult[] = new Array(messages.length);

    // Indices into `messages` that still need an outcome. Starts as
    // everything and shrinks as legs accept or finally refuse; carrying
    // indices (rather than re-filtering messages) is what lets each leg's
    // answers land back on their original slots, which the sweep relies on
    // when it maps results onto `notification_log` rows by index.
    let pending = messages.map((_message, index) => index);

    for (const leg of this.legs) {
      if (pending.length === 0) break;

      const legResults = await leg.send(pending.map((index) => messages[index]!));
      const stillPending: number[] = [];

      pending.forEach((index, position) => {
        const result = legResults[position];
        if (result === undefined) {
          // A short result array is the wrapped notifier breaking the
          // one-result-per-input contract. Recorded against this slot and
          // *not* spilled: nothing is known about whether it was sent, so
          // it is exactly as ambiguous as a provider error.
          results[index] = { ok: false, error: NOTIFIER_CONTRACT_VIOLATION_REASON };
          return;
        }
        if (!result.ok && result.error === DAILY_CEILING_REASON) {
          stillPending.push(index);
          // Recorded anyway, so that if this is the last leg the slot
          // already holds the right answer and no post-loop pass is needed
          // to fill it in.
          results[index] = result;
          return;
        }
        results[index] = result;
      });

      pending = stillPending;
    }

    return results;
  }
}

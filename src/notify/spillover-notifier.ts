import { PROVIDER_REFUSED_REASON } from "./cloudflare-notifier.js";
import type { Message, Notifier, SendResult } from "./notifier.js";
import { DAILY_CEILING_REASON, NOTIFIER_CONTRACT_VIOLATION_REASON } from "./quota.js";

/**
 * True when a leg's refusal means the next leg may safely try the same
 * message. Two cases, and deliberately only two:
 *
 *  - `DAILY_CEILING_REASON` — the quota refused it before the provider was
 *    ever called, so nothing was sent.
 *  - `PROVIDER_REFUSED_REASON` — the provider answered and said no (a 4xx, or
 *    a 200 carrying `success: false`), so nothing was queued.
 *
 * Both are *certainties* that the message was not delivered. Everything else
 * stays final: a success (retrying would double-send), a missing recipient
 * (no provider can fix it), and — the important one — an ambiguous provider
 * error such as a timeout or a 5xx, which may have been delivered before the
 * failure surfaced. Widening this beyond certainty is the bug the whole
 * function exists to prevent.
 */
function mayRetryOnNextLeg(result: SendResult): boolean {
  if (result.ok) return false;
  return (
    result.error === DAILY_CEILING_REASON ||
    // A prefix test, not equality: `CloudflareEmailNotifier` appends the
    // provider's own diagnostic after the reason so the log line stays
    // useful, and the verdict must survive that.
    result.error === PROVIDER_REFUSED_REASON ||
    result.error.startsWith(`${PROVIDER_REFUSED_REASON}: `)
  );
}

/**
 * Offers each message to a series of quota-wrapped notifiers, moving on to
 * the next one only for the messages the previous one is *certain* it did
 * not send (M42, widened in M54).
 *
 * # The spill condition is certainty, not failure
 *
 * See `mayRetryOnNextLeg` for the two cases and the reasoning. The rule is
 * that a message moves on only when the previous leg can prove it was not
 * delivered — the quota refused it before the provider was called, or the
 * provider answered and said no.
 *
 * Everything else is final, and the ambiguous provider error is the one that
 * matters: Resend may well have accepted and delivered the mail before the
 * connection failed, and `applySendResult` in `delivery.ts` already declines
 * to retry these for that reason. Spilling one would be this codebase's
 * first mechanism that can double-send, and it would do it precisely when a
 * player is already being told something important.
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
 * `legs` is tried in order. A leg may appear more than once: M54 puts a small
 * Cloudflare leg *first* to keep that provider warm, the Resend bulk second,
 * and the full Cloudflare spill third. The first and third share one counter
 * row, each clamping to its own limit against it, so the small leg stops at
 * the warm-up figure while the large one still allows the full daily total.
 *
 * Otherwise the first leg should be the one whose
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
        if (mayRetryOnNextLeg(result)) {
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

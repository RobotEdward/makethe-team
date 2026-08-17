import type { Message, Notifier, SendResult } from "./notifier.js";
import { NOTIFIER_CONTRACT_VIOLATION_REASON } from "./quota.js";

/**
 * Routes each `Message` to the notifier for its channel and reassembles the
 * results in the caller's order (M14, spec §10.2).
 *
 * # Why this sits *outside* the quota wrapper
 *
 * The alternative was to teach `QuotaNotifier` to skip push messages, and it
 * is the wrong trade. That class is described in its own comment as "the last
 * thing standing between a mistake and someone's inbox", and its
 * one-result-per-input-in-order property is currently trivial to see because
 * it maps over a dense array. Putting the router outside it means the email
 * leg still receives nothing but email, so the quota class needs no branch,
 * no new test, and no chance for a later edit to miscount.
 *
 * Push must not consume email quota: it costs nothing to send, and the
 * ceiling exists to cap spend.
 *
 * # The merge is the whole risk
 *
 * Each leg answers about its own messages in its own order. The sweep maps
 * results onto `notification_log` rows **by index**, so putting the two
 * answers back on the wrong original positions would tell one player that
 * another player's notification failed. Hence the explicit index bookkeeping
 * below rather than a filter-and-concatenate.
 */
export class RouterNotifier implements Notifier {
  constructor(
    private readonly email: Notifier,
    private readonly push: Notifier,
  ) {}

  async send(messages: readonly Message[]): Promise<SendResult[]> {
    const emailIndices: number[] = [];
    const pushIndices: number[] = [];
    const emailMessages: Message[] = [];
    const pushMessages: Message[] = [];

    messages.forEach((message, index) => {
      if (message.channel === "email") {
        emailIndices.push(index);
        emailMessages.push(message);
      } else {
        pushIndices.push(index);
        pushMessages.push(message);
      }
    });

    const [emailResults, pushResults] = await Promise.all([
      emailMessages.length > 0 ? this.email.send(emailMessages) : Promise.resolve([]),
      pushMessages.length > 0 ? this.push.send(pushMessages) : Promise.resolve([]),
    ]);

    const merged = new Array<SendResult>(messages.length);
    // A leg that returns a short array leaves messages with no result of
    // their own. That is a bug in the leg, reported with the same reason the
    // rest of the chain uses for it, rather than a hole in the array that
    // would land as `undefined` on a row.
    emailIndices.forEach((target, position) => {
      merged[target] = emailResults[position] ?? { ok: false, error: NOTIFIER_CONTRACT_VIOLATION_REASON };
    });
    pushIndices.forEach((target, position) => {
      merged[target] = pushResults[position] ?? { ok: false, error: NOTIFIER_CONTRACT_VIOLATION_REASON };
    });

    return merged;
  }
}

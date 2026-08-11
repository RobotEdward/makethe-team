/**
 * The one interface everything in the product sends mail through (§2.8, TR-21).
 *
 * Every caller — the reminder sweep, waitlist promotion, cancellation notice,
 * owner attention warning — builds a `Message[]` and calls `send`. That is the
 * whole contract. Swapping the provider (console today, Resend later) means
 * writing a new implementation of this interface; it never means touching a
 * caller.
 *
 * `channel` stays on `Message` even though `"email"` is the only value that
 * exists yet: a per-player channel preference already exists in the data
 * model, and a later milestone adds a channel that isn't email. Nothing here
 * may assume `channel === "email"`.
 */

/** The only channel that exists today. More are expected later (TR-21). */
export type Channel = "email";

export interface Message {
  channel: Channel;
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Passed to the provider as an idempotency key where supported. */
  dedupeKey: string;
}

export type SendResult =
  | { ok: true; providerMessageId: string | null }
  | { ok: false; error: string };

export interface Notifier {
  /**
   * Sends every message in `messages` and returns exactly one `SendResult`
   * per input, in the same order.
   *
   * The sweep maps results back onto `notification_log` rows by index, so a
   * length mismatch or a reordering would attribute one player's delivery
   * failure to a different player. Every implementation of this interface
   * must preserve both the count and the order, including for an empty
   * array.
   */
  send(messages: readonly Message[]): Promise<SendResult[]>;
}

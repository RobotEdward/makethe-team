/**
 * The one interface everything in the product sends notifications through
 * (§2.8, TR-21).
 *
 * Every caller — the reminder sweep, waitlist promotion, cancellation notice,
 * owner attention warning — builds a `Message[]` and calls `send`. That is the
 * whole contract. Swapping or adding a provider (console today, Resend for
 * mail, a Web Push provider for push) means writing a new implementation of
 * this interface; it never means touching a caller.
 *
 * `Message` is a discriminated union on `channel` (M14), not a single widened
 * shape: `EmailMessage` and `PushMessage` share almost nothing beyond an
 * address and a dedupe key, and a union forces the typechecker to point at
 * every place that narrows on one channel but not the other, rather than
 * letting a push quietly get treated as mail (or vice versa) because both
 * happened to satisfy the same loose interface.
 */

/**
 * The channels this product can deliver on.
 *
 * `"push"` arrived in M14, which is the milestone the original comment on
 * this type was written in anticipation of.
 */
export type Channel = "email" | "push";

interface BaseMessage {
  /**
   * The address for this channel: an email address for `"email"`, and a
   * **player id** for `"push"` — one push message fans out to every device
   * that player has registered, inside `PushNotifier`.
   */
  to: string;
  /** Passed to the provider as an idempotency key where supported. */
  dedupeKey: string;
}

export interface EmailMessage extends BaseMessage {
  channel: "email";
  subject: string;
  html: string;
  text: string;
}

/**
 * A push notification. Deliberately *not* built by reshaping an
 * `EmailMessage`: an email subject is a line of prose and a push title has
 * roughly forty characters before Android truncates it (spec §10.5).
 */
export interface PushMessage extends BaseMessage {
  channel: "push";
  title: string;
  body: string;
  /** Where `notificationclick` sends the player. Absolute. */
  url: string;
  /** Collapses an older notification about the same fixture. */
  tag: string;
}

/**
 * A discriminated union rather than a widened single shape, so that every
 * `Notifier` implementation is forced by the typechecker to say what it does
 * with each channel instead of quietly treating a push as mail.
 */
export type Message = EmailMessage | PushMessage;

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

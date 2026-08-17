import type { Message, Notifier, SendResult } from "./notifier.js";

/**
 * Discards every message silently and reports success for each.
 *
 * This is what tests and every non-production environment use, so that no
 * environment other than production can ever email or push-notify a real
 * person. It handles both channels (M14) identically — discarding either —
 * because it never inspects anything beyond the `Message` it is handed. It
 * still carries `dedupeKey` (and the rest of `Message`) through its input
 * type, so the shape is exercised everywhere even though nothing is done
 * with it.
 */
export class NullNotifier implements Notifier {
  send(messages: readonly Message[]): Promise<SendResult[]> {
    return Promise.resolve(messages.map((): SendResult => ({ ok: true, providerMessageId: null })));
  }
}

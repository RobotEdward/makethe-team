import type { Message, Notifier, SendResult } from "./notifier.js";

/**
 * Logs every message to the console and reports success for each.
 *
 * This is what production runs on first, deliberately, before the real
 * provider (Resend) is switched on — so its output is a real diagnostic a
 * developer can read to see exactly what would have been sent, not a stub.
 * It logs the recipient, subject and dedupe key for that reason; it never
 * makes a network call.
 */
export class ConsoleNotifier implements Notifier {
  send(messages: readonly Message[]): Promise<SendResult[]> {
    return Promise.resolve(
      messages.map((message) => {
        console.log(
          `[notify:console] to=${message.to} channel=${message.channel} subject=${JSON.stringify(message.subject)} dedupeKey=${message.dedupeKey}`,
        );
        return { ok: true, providerMessageId: null } satisfies SendResult;
      }),
    );
  }
}

import type { Message, Notifier, SendResult } from "./notifier.js";

/**
 * Logs every message to the console and reports success for each.
 *
 * This is what production runs on first, deliberately, before the real
 * provider (Resend) is switched on — so its output is a real diagnostic a
 * developer can read to see exactly what would have been sent, not a stub.
 * It handles both channels (M14): it logs the recipient, subject and dedupe
 * key for email, and the recipient, title and body for push — there is no
 * "subject" on a `PushMessage` to fall back on. It never makes a network
 * call for either.
 */
export class ConsoleNotifier implements Notifier {
  send(messages: readonly Message[]): Promise<SendResult[]> {
    return Promise.resolve(
      messages.map((message) => {
        if (message.channel === "email") {
          console.log(
            `[notify:console] to=${message.to} channel=email subject=${JSON.stringify(message.subject)} dedupeKey=${message.dedupeKey}`,
          );
        } else {
          console.log(
            `[notify:console] to=${message.to} channel=push title=${JSON.stringify(message.title)} body=${JSON.stringify(message.body)} dedupeKey=${message.dedupeKey}`,
          );
        }
        return { ok: true, providerMessageId: null } satisfies SendResult;
      }),
    );
  }
}

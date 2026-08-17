import { eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { pushSubscriptions } from "../db/schema.js";
import type { Message, Notifier, SendResult } from "./notifier.js";
import { NO_RECIPIENT_REASON } from "./quota.js";
import { encryptPayload, vapidHeaders, type VapidKeys } from "./web-push.js";

/**
 * How long a push service should hold a notification for a device that is
 * currently offline, in seconds (RFC 8030 §5.2's `TTL` header). Four weeks:
 * comfortably longer than any player is likely to leave a phone off, and
 * short enough that a notification about a fixture that has long since been
 * played is not still queued for delivery a year later.
 */
const TTL_SECONDS = 4 * 7 * 24 * 60 * 60;

/**
 * Sends one `PushMessage` to every device its player has registered (M14,
 * spec §10.4).
 *
 * `to` on a `PushMessage` is a **player id**, not an endpoint (`notifier.ts`)
 * — this class is the one place that fan-out from "player" to "devices"
 * happens.
 *
 * Success if **any** device accepted it. A player whose old tablet has been
 * wiped has not had a failed notification, and treating it as one would fill
 * the log with failures nobody can act on — the same reasoning
 * `QuotaNotifier`'s guest skip documents for a different case.
 *
 * A 404 or 410 response is the only self-healing this system has for dead
 * subscriptions: that device is gone for good, so the row is deleted
 * immediately. Every other failure status — 429, 5xx, a thrown network
 * error — is left alone, because those are the push service (or the
 * network) having a bad day, not a verdict on the subscription; deleting on
 * those would unsubscribe a working phone because of somebody else's
 * outage.
 *
 * `fetch` is injected so the tests can drive every push-service response
 * without a network — the repo blocks outbound network in tests at the
 * miniflare level (`vitest.config.ts`'s `outboundService`), so a forgotten
 * stub fails loudly instead of reaching the internet. `now` is a parameter
 * for the same reason `createNotifier` takes one.
 */
export class PushNotifier implements Notifier {
  constructor(
    private readonly db: Db,
    private readonly keys: VapidKeys,
    private readonly fetchImpl: typeof fetch,
    private readonly now: Date,
  ) {}

  async send(messages: readonly Message[]): Promise<SendResult[]> {
    // Sequential across messages, not `Promise.all` over everything: a
    // Worker has a subrequest budget, and a sweep to a whole squad would
    // spend it in one burst. Devices *within* one player's message go
    // together (see `sendOne`) — that is at most a handful.
    const results: SendResult[] = [];
    for (const message of messages) {
      results.push(await this.sendOne(message));
    }
    return results;
  }

  private async sendOne(message: Message): Promise<SendResult> {
    if (message.channel !== "push") {
      // Unreachable through `createNotifier`, which routes by channel
      // before a message ever reaches here. Present because this class is
      // constructible on its own, and a silent success for something never
      // sent is exactly the failure `notification_log` exists to prevent.
      return { ok: false, error: "push-notifier-received-non-push-message" };
    }

    const subscriptions = await this.db
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.playerId, message.to));

    if (subscriptions.length === 0) {
      // Distinct from success, exactly as QuotaNotifier's guest skip is
      // (`quota.ts`): a caller mapping results onto `notification_log` rows
      // must never record a delivery that did not happen.
      return { ok: false, error: NO_RECIPIENT_REASON };
    }

    const payload = JSON.stringify({
      title: message.title,
      body: message.body,
      url: message.url,
      tag: message.tag,
    });

    // Devices for one player go together — a handful at most — rather than
    // sequentially, since it is the *messages* loop above that exists to
    // stay inside the Worker's subrequest budget.
    const outcomes = await Promise.all(
      subscriptions.map((subscription) => this.sendToDevice(subscription, payload)),
    );

    const gone = outcomes.filter((outcome) => outcome.gone).map((outcome) => outcome.id);
    if (gone.length > 0) {
      await this.db.delete(pushSubscriptions).where(inArray(pushSubscriptions.id, gone));
    }

    const delivered = outcomes.find((outcome) => outcome.delivered);
    if (delivered) {
      return { ok: true, providerMessageId: null };
    }

    const lastOutcome = outcomes[outcomes.length - 1];
    return { ok: false, error: lastOutcome?.error ?? "push-failed" };
  }

  private async sendToDevice(
    subscription: typeof pushSubscriptions.$inferSelect,
    payload: string,
  ): Promise<{ id: string; delivered: boolean; gone: boolean; error: string }> {
    try {
      const body = await encryptPayload(subscription, payload);
      const response = await this.fetchImpl(subscription.endpoint, {
        method: "POST",
        headers: {
          ...(await vapidHeaders(subscription.endpoint, this.keys, this.now)),
          "Content-Type": "application/octet-stream",
          TTL: String(TTL_SECONDS),
        },
        body,
      });

      if (response.ok) {
        return { id: subscription.id, delivered: true, gone: false, error: "" };
      }

      // 404 and 410 are the push service telling us this endpoint is dead
      // for good (RFC 8030 §7.2). Every other status might pass on a later
      // send, so only these two mark the subscription for deletion.
      const isGone = response.status === 404 || response.status === 410;
      return { id: subscription.id, delivered: false, gone: isGone, error: `push-${response.status}` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { id: subscription.id, delivered: false, gone: false, error: `push-error: ${message}` };
    }
  }
}

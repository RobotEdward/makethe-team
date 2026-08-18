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
 * outage. A success stamps `last_success_at`; a 429/5xx/thrown failure
 * stamps `last_failure_at` (spec §10.4) — the only record an operator has
 * of when a still-registered device last actually worked.
 *
 * `fetch` is injected so the tests can drive every push-service response
 * without a network — the repo blocks outbound network in tests at the
 * miniflare level (`vitest.config.ts`'s `outboundService`), so a forgotten
 * stub fails loudly instead of reaching the internet. `now` is a parameter
 * for the same reason `createNotifier` takes one.
 *
 * `keys` accepts a bare `VapidKeys` or a `Promise<VapidKeys>` because
 * `createNotifier` (`factory.ts`) has to stay synchronous for its many
 * existing callers, while importing and verifying a VAPID keypair is
 * inherently async. Resolving that promise happens inside `sendOne`, per
 * message, inside the `try`/`catch` that already turns everything else this
 * class can fail on into an ordinary `SendResult` — not in `send` and not in
 * the constructor. That placement matters: a rejected import must become a
 * failed result for *this notifier's own messages only*. `RouterNotifier`
 * runs the email and push legs concurrently via `Promise.all`; if this class
 * let that rejection propagate out of `send`, it would reject the combined
 * `Promise.all` and take the email leg's already-computed results down with
 * it, even though those emails may have genuinely been sent — exactly the
 * "one leg's answer attributed to the other" failure this task exists to
 * prevent, arriving through the error path instead of the index path.
 */
export class PushNotifier implements Notifier {
  constructor(
    private readonly db: Db,
    private readonly keys: VapidKeys | Promise<VapidKeys>,
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

    let keys: VapidKeys;
    try {
      keys = await this.keys;
    } catch (error) {
      // A mismatched or malformed VAPID pair is a deterministic
      // configuration error — `assertVapidKeysMatch`/`importVapidKeys` will
      // reject identically for every message and every device, not just
      // this one. It is reported as an ordinary failed `SendResult` for
      // this message, same as any other push failure, rather than thrown:
      // see the class doc comment for why this must never escape `send`.
      const detail = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `vapid-key-error: ${detail}` };
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
      subscriptions.map((subscription) => this.sendToDevice(subscription, payload, keys)),
    );

    const gone = outcomes.filter((outcome) => outcome.gone).map((outcome) => outcome.id);
    if (gone.length > 0) {
      await this.db.delete(pushSubscriptions).where(inArray(pushSubscriptions.id, gone));
    }

    // Stamped per message, batched across that message's devices, rather
    // than one write per device — the same reasoning as the delete above:
    // D1 round-trips stay proportional to players, not to devices. A device
    // that was deleted for being gone is excluded from both stamps; there is
    // no row left to stamp.
    const succeededIds = outcomes.filter((outcome) => outcome.delivered).map((outcome) => outcome.id);
    if (succeededIds.length > 0) {
      await this.db
        .update(pushSubscriptions)
        .set({ lastSuccessAt: this.now })
        .where(inArray(pushSubscriptions.id, succeededIds));
    }

    const failedIds = outcomes
      .filter((outcome) => !outcome.delivered && !outcome.gone)
      .map((outcome) => outcome.id);
    if (failedIds.length > 0) {
      await this.db
        .update(pushSubscriptions)
        .set({ lastFailureAt: this.now })
        .where(inArray(pushSubscriptions.id, failedIds));
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
    keys: VapidKeys,
  ): Promise<{ id: string; delivered: boolean; gone: boolean; error: string }> {
    try {
      const body = await encryptPayload(subscription, payload);
      const response = await this.fetchImpl(subscription.endpoint, {
        method: "POST",
        headers: {
          ...(await vapidHeaders(subscription.endpoint, keys, this.now)),
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

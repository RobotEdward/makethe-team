import type { EmailMessage, Message, Notifier, SendResult } from "./notifier.js";

/**
 * How many sends are in flight at once (M42).
 *
 * Cloudflare Email Service has **no batch endpoint** — unlike Resend's
 * `POST /emails/batch`, every message is its own HTTP request. A day's
 * spill-over is therefore up to `MAX_EMAILS_PER_DAY_CLOUDFLARE` separate
 * subrequests, and firing them all at once would both risk the documented
 * (but unquantified) rate-limit error 10004 and stack the whole batch's
 * latency against the Worker's `limits.cpu_ms`.
 *
 * Eight is chosen to be obviously safe rather than tuned: at the volumes
 * this leg exists for (a spill of tens of messages, not thousands) it costs
 * a few hundred milliseconds of wall-clock against a cron invocation that
 * has minutes, and the Workers subrequest ceiling is far above anything
 * this can generate.
 */
const CONCURRENCY = 8;

/**
 * Cloudflare's send endpoint. `{account_id}` is substituted per instance;
 * the account id is a var rather than a secret (it appears in dashboard
 * URLs and is not a credential on its own).
 */
function sendUrl(accountId: string): string {
  return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/email/sending/send`;
}

interface CloudflareEmailPayload {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
}

/**
 * Sends mail through Cloudflare Email Service's REST API — the spill-over
 * leg for the daily ceiling (M42). Resend stays the primary sender; see
 * `SpilloverNotifier` for why the order is not arbitrary.
 *
 * Like `ResendNotifier`, this guarantees exactly one `SendResult` per input
 * message in input order, and it is built structurally rather than
 * asserted: `send` maps over its own `messages` array to build the result
 * array, and each slot is filled by the outcome of that slot's own request.
 * Nothing here reads a length off a provider response.
 *
 * # Three ways this differs from `ResendNotifier`, all of them load-bearing
 *
 *  1. **No batch endpoint.** One request per message, bounded to
 *     `CONCURRENCY` at a time.
 *  2. **No idempotency key.** Cloudflare documents none, so a retried send
 *     is a *new* email rather than a recognised repeat. This is why
 *     Cloudflare is the spill leg and not the primary: `notification_log`'s
 *     UNIQUE constraint remains the at-most-once guarantee (§2.8), and
 *     `applySendResult` already declines to retry an ambiguous provider
 *     error, but the second, independent layer Resend's `Idempotency-Key`
 *     provides simply does not exist here.
 *  3. **HTTP 200 is not success.** The response carries `result.delivered`,
 *     `result.queued` and `result.permanent_bounces`. An address in
 *     `permanent_bounces` was *rejected*, on a 200, with `success: true`.
 *     Reading only the status code would record a delivery to someone who
 *     will never receive it — so `interpret` below requires the recipient
 *     to appear in `delivered` or `queued`.
 */
export class CloudflareEmailNotifier implements Notifier {
  constructor(
    private readonly accountId: string,
    private readonly apiToken: string,
    private readonly from: string,
  ) {}

  async send(messages: readonly Message[]): Promise<SendResult[]> {
    if (messages.length === 0) return [];

    const results: SendResult[] = new Array(messages.length);
    let next = 0;

    // A fixed pool of workers pulling from a shared cursor, rather than
    // slicing into chunks and awaiting each chunk: a chunked loop runs at
    // the speed of its slowest member at every step, whereas this keeps
    // `CONCURRENCY` requests in flight until the work runs out. Each worker
    // writes only to the index it claimed, so the pool cannot reorder or
    // drop a slot.
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = next++;
        if (index >= messages.length) return;
        const message = messages[index]!;
        results[index] =
          message.channel === "email"
            ? await this.sendOne(message)
            : failure("cloudflare-notifier-received-non-email");
      }
    };

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, messages.length) }, worker));
    return results;
  }

  /**
   * Sends one message. Never throws and never rejects — every failure mode
   * becomes an `{ ok: false }` result, because a rejection here would take
   * down the whole pool and leave other messages' slots unfilled.
   */
  private async sendOne(message: EmailMessage): Promise<SendResult> {
    const payload: CloudflareEmailPayload = {
      from: this.from,
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
    };

    let response: Response;
    try {
      response = await fetch(sendUrl(this.accountId), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return failure(`cloudflare send request failed: ${reason}`);
    }

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "<unreadable body>");
      return failure(`cloudflare send failed: HTTP ${response.status} ${truncate(bodyText, 500)}`);
    }

    let parsedBody: unknown;
    try {
      parsedBody = await response.json();
    } catch {
      return failure("cloudflare send succeeded but response body was not valid JSON");
    }

    return interpret(parsedBody, message.to);
  }
}

/**
 * Turns a 200 response body into a result for `recipient`.
 *
 * The recipient must appear in `result.delivered` or `result.queued` to
 * count as sent. Anything else — `success: false`, a `result` that is not an
 * an object, an address sitting in `permanent_bounces`, or an address that
 * appears nowhere at all — is a failure with a distinct reason, so an
 * operator reading `notification_log` can tell a bounce from a malformed
 * response from a silent drop.
 */
function interpret(body: unknown, recipient: string): SendResult {
  if (typeof body !== "object" || body === null) {
    return failure("cloudflare send response body was not an object");
  }
  const record = body as Record<string, unknown>;

  if (record["success"] !== true) {
    return failure(`cloudflare send rejected: ${truncate(describeErrors(record["errors"]), 500)}`);
  }

  const result = record["result"];
  if (typeof result !== "object" || result === null) {
    return failure('cloudflare send response had no "result" object');
  }
  const resultRecord = result as Record<string, unknown>;

  if (addresses(resultRecord["permanent_bounces"]).includes(recipient)) {
    return failure("cloudflare send permanently bounced");
  }
  if (
    addresses(resultRecord["delivered"]).includes(recipient) ||
    addresses(resultRecord["queued"]).includes(recipient)
  ) {
    // Cloudflare's send response carries no per-message id, so there is
    // nothing honest to record here. `null` is what the `SendResult` union
    // already provides for exactly this case; inventing an id would put a
    // value in `notification_log` that no provider could ever be queried
    // with.
    return { ok: true, providerMessageId: null };
  }
  return failure("cloudflare send reported neither delivery nor bounce for this recipient");
}

/**
 * Reads a `result.*` field as a list of addresses, tolerating anything that
 * is not a string array. A malformed field must degrade to "this recipient
 * is not in here" — which `interpret` turns into a recorded failure — never
 * into a thrown exception on a response that already returned 200.
 */
function addresses(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/** Renders Cloudflare's `errors` array for a log line, however malformed. */
function describeErrors(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) return "no errors reported";
  return value
    .map((entry) => {
      if (typeof entry !== "object" || entry === null) return String(entry);
      const record = entry as Record<string, unknown>;
      return `${String(record["code"] ?? "?")}: ${String(record["message"] ?? "?")}`;
    })
    .join("; ");
}

function failure(error: string): SendResult {
  return { ok: false, error };
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}

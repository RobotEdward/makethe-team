import type { EmailMessage, Message, Notifier, SendResult } from "./notifier.js";

/** Resend's documented per-call limit for `POST /emails/batch`. */
const BATCH_SIZE = 100;

const RESEND_BATCH_URL = "https://api.resend.com/emails/batch";

/** Resend's own bound on `Idempotency-Key` length. */
const IDEMPOTENCY_KEY_MAX_LENGTH = 256;

interface ResendEmailPayload {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
}

/**
 * Sends mail through Resend's batch endpoint (`POST /emails/batch`).
 *
 * The one property this class exists to guarantee — the thing the previous
 * task's review flagged forward — is that `send` returns exactly one
 * `SendResult` per input message, in input order, no matter what the
 * network or the provider does. That guarantee is built structurally, not
 * asserted after the fact:
 *
 *  1. `messages` is sliced into contiguous, non-overlapping chunks of at
 *     most `BATCH_SIZE`, in order. Concatenating the chunks back together
 *     (in order) reconstructs `messages` exactly.
 *  2. `sendBatch` is called once per chunk. Every one of its return paths —
 *     network error, non-2xx, malformed body, mismatched or short `data`,
 *     and the success path — is built by mapping over that chunk's own
 *     input array (`batch.map(...)`), never by reading the provider's
 *     response length. So `sendBatch`'s return value always has exactly
 *     `batch.length` entries, by construction, regardless of what Resend
 *     sent back.
 *  3. The per-chunk results are concatenated (`.flat()`) in chunk order.
 *     Because each chunk's result array is the same length as that chunk's
 *     input, and the chunks themselves reconstruct `messages` in order, the
 *     concatenation reconstructs a same-length, same-order result array —
 *     no index bookkeeping required, and nothing to get wrong.
 *
 * Chunks run concurrently (`Promise.all`): one batch's HTTP failure cannot
 * stop another from being attempted, and `sendBatch` never throws or
 * rejects — every failure mode it can hit is turned into `{ ok: false }`
 * entries instead, so `Promise.all` itself never rejects either.
 */
export class ResendNotifier implements Notifier {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {}

  async send(messages: readonly Message[]): Promise<SendResult[]> {
    if (messages.length === 0) return [];

    const batches: Message[][] = [];
    for (let start = 0; start < messages.length; start += BATCH_SIZE) {
      batches.push(messages.slice(start, start + BATCH_SIZE));
    }

    const perBatchResults = await Promise.all(batches.map((batch) => this.sendBatch(batch)));
    return perBatchResults.flat();
  }

  /**
   * Sends one batch (at most `BATCH_SIZE` messages) and returns exactly
   * `batch.length` results, in `batch` order. Never throws and never
   * rejects — every failure becomes `{ ok: false, error }` entries.
   */
  private async sendBatch(batch: readonly Message[]): Promise<SendResult[]> {
    // Resend cannot deliver a push (M14). This is not reachable through
    // `createNotifier`, which routes each message to the right notifier by
    // channel before anything gets here (spec §10.2) — it is present
    // because this class is exported and constructible on its own, and a
    // silent success for a message that was never sent is exactly the
    // failure mode `notification_log` exists to prevent.
    //
    // A push is refused per-slot with a distinct, greppable reason rather
    // than dropped from the batch or allowed to derail the emails sharing
    // the batch with it: the emails are re-sent through this same method
    // (which is then guaranteed an all-email batch, so it falls straight
    // through to the real request below) and the two result sets are
    // merged back into `batch`'s original order here. This recurses at
    // most once, because the recursive call's own input is already
    // all-email.
    if (batch.some((message) => message.channel !== "email")) {
      const emailBatch = batch.filter((message): message is EmailMessage => message.channel === "email");
      const emailResults = await this.sendBatch(emailBatch);
      let nextEmailResult = 0;
      return batch.map((message) =>
        message.channel === "email" ? emailResults[nextEmailResult++]! : failure("resend-notifier-received-non-email"),
      );
    }
    const emailBatch = batch as readonly EmailMessage[];

    const idempotencyKey = await deriveIdempotencyKey(emailBatch);
    const payload: ResendEmailPayload[] = emailBatch.map((message) => ({
      from: this.from,
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
    }));

    let response: Response;
    try {
      response = await fetch(RESEND_BATCH_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return batch.map(() => failure(`resend batch request failed: ${reason}`));
    }

    if (!response.ok) {
      // Drain the body for diagnostics, but never let a body-read failure
      // (e.g. a truncated stream) turn an already-known failure into a
      // thrown exception.
      const bodyText = await response.text().catch(() => "<unreadable body>");
      return batch.map(() =>
        failure(`resend batch failed: HTTP ${response.status} ${truncate(bodyText, 500)}`),
      );
    }

    let parsedBody: unknown;
    try {
      parsedBody = await response.json();
    } catch {
      return batch.map(() => failure("resend batch succeeded but response body was not valid JSON"));
    }

    const data = extractDataArray(parsedBody);
    if (data === null) {
      return batch.map(() => failure("resend batch succeeded but response body had no \"data\" array"));
    }

    // Built by mapping over `batch` itself, so this always has exactly
    // `batch.length` entries — a `data` array that is shorter, longer,
    // reordered, or contains nulls is handled per-slot below, never by
    // trusting `data.length`.
    return batch.map((_message, index) => {
      const entry = data[index];
      if (entry === undefined) {
        return failure(`resend response "data" array had no entry at index ${index}`);
      }
      if (typeof entry !== "object" || entry === null) {
        return failure(`resend response "data" entry at index ${index} was not an object`);
      }
      const id = (entry as Record<string, unknown>)["id"];
      if (typeof id !== "string") {
        return failure(`resend response "data" entry at index ${index} had no string "id"`);
      }
      return { ok: true, providerMessageId: id };
    });
  }
}

function failure(error: string): SendResult {
  return { ok: false, error };
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}

/**
 * `data` must be a JSON array to be usable at all; anything else (missing,
 * an object, a string, `null`) is treated as a malformed response rather
 * than crashing the caller.
 */
function extractDataArray(body: unknown): unknown[] | null {
  if (typeof body !== "object" || body === null) return null;
  const data = (body as Record<string, unknown>)["data"];
  return Array.isArray(data) ? data : null;
}

/**
 * A stable `Idempotency-Key` for one batch, derived from that batch's own
 * `dedupeKey`s (§2.8) — the same batch (same messages, same order) always
 * produces the same key, so a retried request is recognised as a retry by
 * Resend rather than resent as new mail. This sits beneath the
 * `notification_log` UNIQUE constraint as a second, independent layer; it
 * costs nothing because it is derived, never stored.
 *
 * SHA-256 hex digest is 64 characters, comfortably under Resend's 256-
 * character limit, but the result is still truncated defensively — nothing
 * here should ever be able to violate that bound.
 */
async function deriveIdempotencyKey(batch: readonly Message[]): Promise<string> {
  const joined = batch.map((message) => message.dedupeKey).join("\n");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(joined));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return hex.slice(0, IDEMPOTENCY_KEY_MAX_LENGTH);
}

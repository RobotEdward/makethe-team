import type { FixtureCapacity } from "./capacity/fixture-capacity.js";

export interface Bindings {
  DB: D1Database;
  FIXTURE_CAPACITY: DurableObjectNamespace<FixtureCapacity>;
  NOTIFIER: string;
  MAX_EMAILS_PER_DAY: string;
  /** HMAC key for response tokens (TR-13). Set with `wrangler secret put`. */
  RESPONSE_TOKEN_SECRET: string;
  /**
   * HMAC key for owner cancellation tokens (`/cancel/:token`), deliberately
   * **separate** from `RESPONSE_TOKEN_SECRET` rather than shared with it.
   *
   * The two token kinds are already kept apart by the `kind` discriminator
   * baked into the signed bytes (`src/domain/token.ts`), and that check is
   * pinned by tests — but it is a *correctness* boundary, not a *compromise*
   * boundary. Two things separate keys buy that the discriminator cannot:
   *
   *  1. **Blast radius.** A response token is minted for every player in
   *     every reminder and promotion email, on the hot path of every incoming
   *     link; a cancel token is minted rarely, for owners only, and destroys a
   *     Game. If the response key ever leaks, the attacker can forge a
   *     player's own answer — bad, recoverable. With one shared key they could
   *     also forge a cancellation of any fixture whose id they could obtain.
   *  2. **Independent rotation.** Rotating `RESPONSE_TOKEN_SECRET` breaks
   *     every outstanding response link in every inbox, so in practice an
   *     operator hesitates to do it. Sharing the key would extend that
   *     hesitation to the higher-value one. Separately, either can be rotated
   *     on its own cadence, and rotating this one invalidates only cancel
   *     links, which are few and short-lived (they expire at kickoff).
   *
   * Set with `wrangler secret put CANCEL_TOKEN_SECRET`. There is deliberately
   * **no fallback** to `RESPONSE_TOKEN_SECRET` if it is unset: a fallback
   * would silently restore exactly the shared-key property this binding
   * exists to remove. Unset fails closed and loudly instead — signing throws
   * by name (`signToken`), and verification returns `malformed`, so every
   * cancel link renders the ordinary "this link isn't working" page.
   */
  CANCEL_TOKEN_SECRET: string;
  /**
   * Resend API key for `ResendNotifier`. Set with `wrangler secret put`.
   * Required only when `NOTIFIER` is `"resend"`; `createNotifier` throws by
   * name if it is missing or blank at that point (an unset secret arrives as
   * `undefined` at runtime regardless of this non-optional type).
   */
  RESEND_API_KEY: string;
  /**
   * The `from` address `ResendNotifier` sends as, set in `wrangler.jsonc`'s
   * `vars`. Same requirement and same by-name failure as `RESEND_API_KEY`.
   */
  EMAIL_FROM: string;
}

export type AppEnv = { Bindings: Bindings };

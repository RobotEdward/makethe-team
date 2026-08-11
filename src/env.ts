import type { FixtureCapacity } from "./capacity/fixture-capacity.js";

export interface Bindings {
  DB: D1Database;
  FIXTURE_CAPACITY: DurableObjectNamespace<FixtureCapacity>;
  NOTIFIER: string;
  MAX_EMAILS_PER_DAY: string;
  /** HMAC key for response tokens (TR-13). Set with `wrangler secret put`. */
  RESPONSE_TOKEN_SECRET: string;
  /**
   * Resend API key for `ResendNotifier`. Set with `wrangler secret put`.
   * Unset in every environment as of this task — `NOTIFIER` stays
   * `"console"` until a later task wires `ResendNotifier` into the factory.
   */
  RESEND_API_KEY: string;
  /** The `from` address `ResendNotifier` sends as. */
  EMAIL_FROM: string;
}

export type AppEnv = { Bindings: Bindings };

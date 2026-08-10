export interface Bindings {
  DB: D1Database;
  NOTIFIER: string;
  MAX_EMAILS_PER_DAY: string;
  /** HMAC key for response tokens (TR-13). Set with `wrangler secret put`. */
  RESPONSE_TOKEN_SECRET: string;
}

export type AppEnv = { Bindings: Bindings };

export interface Bindings {
  DB: D1Database;
  NOTIFIER: string;
  MAX_EMAILS_PER_DAY: string;
}

export type AppEnv = { Bindings: Bindings };

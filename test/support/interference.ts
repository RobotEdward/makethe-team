// ---------------------------------------------------------------------------
// Deterministic interleaving for D1.
//
// workerd's test harness runs one request at a time and will never produce a
// genuine race between two callers by itself, so an interleaving is
// constructed instead: the D1 binding is wrapped, and a hook fires around the
// statement whose result some decision is built on, writing a competing row
// with the *unwrapped* handle. Everything else is the real code against the
// real database.
//
// Shared between `test/auth/link-player.test.ts` (which drives
// `linkPlayerOnSignIn` directly) and `test/routes/signin.test.ts` (which
// drives the same race through the real `/sign-in/complete` route), so the
// mechanism cannot drift between the two call sites.
// ---------------------------------------------------------------------------

export interface Interference {
  /** Fires only for statements whose SQL matches. */
  match: RegExp;
  /** Runs immediately before the matched statement executes. */
  before?: () => Promise<void>;
  /** Runs immediately after it returns, before the caller sees the rows. */
  after?: () => Promise<void>;
}

/** Wrap a callback so it fires at most once, however often it is invoked. */
export function once(fn: () => Promise<void>): () => Promise<void> {
  let fired = false;
  return async () => {
    if (fired) return;
    fired = true;
    await fn();
  };
}

function interferingStatement(
  stmt: D1PreparedStatement,
  query: string,
  hooks: Interference,
): D1PreparedStatement {
  const matched = hooks.match.test(query);
  return new Proxy(stmt, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (typeof value !== "function") return value;
      const method = value as (...args: unknown[]) => unknown;
      if (prop === "bind") {
        return (...args: unknown[]) =>
          interferingStatement(method.apply(target, args) as D1PreparedStatement, query, hooks);
      }
      if (prop === "all" || prop === "run" || prop === "raw" || prop === "first") {
        return async (...args: unknown[]) => {
          if (matched) await hooks.before?.();
          const result = await (method.apply(target, args) as Promise<unknown>);
          if (matched) await hooks.after?.();
          return result;
        };
      }
      return method.bind(target);
    },
  });
}

/** A D1 binding that runs `hooks` around the statements it matches. */
export function interferingBinding(binding: D1Database, hooks: Interference): D1Database {
  return new Proxy(binding, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (prop === "prepare") {
        return (query: string) => interferingStatement(target.prepare(query), query, hooks);
      }
      if (typeof value !== "function") return value;
      return (value as (...args: unknown[]) => unknown).bind(target);
    },
  });
}

/** The statement whose result the email-match decision is built on. */
export const EMAIL_LOOKUP = /lower\(/;
/** The statement whose result the `already-linked` decision is built on. */
export const AUTH_LOOKUP = /where "players"\."auth_user_id" = \?/;

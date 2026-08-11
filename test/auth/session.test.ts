import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { createAuth } from "../../src/auth/factory.js";
import {
  AUTHENTICATED_PREFIX,
  SIGN_IN_PATH,
  requirePlayer,
  requireSession,
  sessionMiddleware,
} from "../../src/auth/session.js";
import { getDb } from "../../src/db/client.js";
import type { Bindings, AppEnv } from "../../src/env.js";
import { players, session as sessionTable } from "../../src/db/schema.js";
import type { Message, Notifier, SendResult } from "../../src/notify/notifier.js";
import { resetDatabase } from "../support/factories.js";

const BASE_URL = "http://localhost:8787";
const EMAIL = "someone@example.com";
const NOW = new Date("2026-08-11T09:00:00Z");
/**
 * Explicitly constructed, never derived by subtracting from a clock read.
 * `Date.now()` is frozen between I/O in workerd and the test isolate's clock
 * drifts from the Worker's, so "expired" here is a date nothing can argue
 * about rather than "a moment ago".
 */
const LONG_EXPIRED = new Date("2020-01-01T00:00:00Z");

class RecordingNotifier implements Notifier {
  readonly sent: Message[] = [];
  send(messages: readonly Message[]): Promise<SendResult[]> {
    this.sent.push(...messages);
    return Promise.resolve(messages.map((): SendResult => ({ ok: true, providerMessageId: null })));
  }
}

function bindings(overrides: Partial<Bindings> = {}): Bindings {
  return { ...env, BETTER_AUTH_URL: BASE_URL, SIGNIN_ALLOWLIST: EMAIL, ...overrides };
}

/**
 * A D1 binding that counts the statements run through it.
 *
 * The structural stand-in for "anonymous traffic is still fast". A wall-clock
 * assertion would be flaky under workerd's frozen `Date.now()`; "no statement
 * was issued at all" is the property that actually matters and it is exact.
 */
function countingDb(): { binding: D1Database; statements: () => number } {
  let count = 0;
  const real = env.DB;
  const binding = {
    prepare(query: string) {
      count += 1;
      return real.prepare(query);
    },
    batch<T = unknown>(statements: D1PreparedStatement[]) {
      count += statements.length;
      return real.batch<T>(statements);
    },
    exec(query: string) {
      count += 1;
      return real.exec(query);
    },
    dump: () => real.dump(),
    withSession: (constraint?: string) => real.withSession(constraint),
  } as unknown as D1Database;
  return { binding, statements: () => count };
}

/**
 * Signs a real user in through Better Auth's own magic-link flow and returns
 * the cookie header a browser would then send.
 *
 * Deliberately not hand-built from the `session` table: the cookie carries an
 * HMAC of the token, so a hand-written one would only ever prove that the
 * middleware rejects forgeries. Never asserted on, printed or logged — only
 * passed straight back as a request header.
 */
async function signIn(): Promise<{ cookie: string; userId: string }> {
  const notifier = new RecordingNotifier();
  const auth = createAuth(bindings(), getDb(env.DB), NOW, notifier);

  const requested = await auth.handler(
    new Request(`${BASE_URL}/api/auth/sign-in/magic-link`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE_URL },
      body: JSON.stringify({ email: EMAIL }),
    }),
  );
  expect(requested.status).toBe(200);

  const link = /https?:\/\/[^\s"]*magic-link\/verify\?[^\s"]*/.exec(notifier.sent[0]!.text);
  expect(link).not.toBeNull();
  // The link carries `callbackURL=/`, so a successful verification is a
  // redirect to the site root that also sets the session cookie.
  const verified = await auth.handler(new Request(link![0], { headers: { origin: BASE_URL } }));
  expect(verified.status).toBe(302);

  const cookie = verified.headers
    .getSetCookie()
    .map((value) => value.split(";")[0]!)
    .join("; ");
  expect(cookie).not.toBe("");

  const [row] = await getDb(env.DB).select().from(sessionTable);
  expect(row).toBeDefined();
  return { cookie, userId: row!.userId };
}

/**
 * A minimal app mounting the same middleware and guards `src/app.ts` does,
 * with probe routes behind each one. Using probes rather than real product
 * routes keeps these tests about the guards, which is what has to be pinned
 * one at a time.
 */
function guardedApp() {
  const app = new Hono<AppEnv>();
  app.use(AUTHENTICATED_PREFIX, sessionMiddleware);
  app.get("/app/whoami", (c) =>
    c.json({
      userId: c.get("session")?.user.id ?? null,
      playerId: c.get("player")?.id ?? null,
    }),
  );
  app.get("/app/private", requireSession, (c) => c.text("private"));
  app.get("/app/mine", requirePlayer, (c) => c.text(`player ${c.get("player")!.id}`));
  app.onError((error, c) => c.text(`unhandled: ${error.message}`, 500));
  return app;
}

function get(path: string, cookie?: string) {
  return new Request(`${BASE_URL}${path}`, cookie ? { headers: { cookie } } : undefined);
}

beforeEach(async () => {
  await resetDatabase();
});

describe("session middleware", () => {
  it("leaves an anonymous public request untouched, and issues no session query", async () => {
    const db = countingDb();

    const response = await createApp().fetch(get("/"), bindings({ DB: db.binding }));

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Make The Team");
    expect(db.statements()).toBe(0);
  });

  it("does not resolve a session on a public path even when a cookie is present", async () => {
    const { cookie } = await signIn();
    const db = countingDb();

    const response = await createApp().fetch(get("/", cookie), bindings({ DB: db.binding }));

    expect(response.status).toBe(200);
    // The scoping decision, pinned: the holding page is not an authenticated
    // route, so it pays nothing for a session it will never read.
    expect(db.statements()).toBe(0);
  });

  it("costs an anonymous request nothing even on an authenticated path", async () => {
    const db = countingDb();

    const response = await guardedApp().fetch(get("/app/whoami"), bindings({ DB: db.binding }));

    expect(await response.json()).toEqual({ userId: null, playerId: null });
    // No cookie means no token to look up: Better Auth answers null without
    // reaching the database at all.
    expect(db.statements()).toBe(0);
  });

  it("resolves a valid session onto the context", async () => {
    const { cookie, userId } = await signIn();

    const response = await guardedApp().fetch(get("/app/whoami", cookie), bindings());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ userId, playerId: null });
  });

  it("resolves the linked Player alongside the session", async () => {
    const { cookie, userId } = await signIn();
    const db = getDb(env.DB);
    const playerId = crypto.randomUUID();
    await db.insert(players).values({ id: playerId, name: "Ada", email: EMAIL, authUserId: userId });

    const response = await guardedApp().fetch(get("/app/whoami", cookie), bindings());

    expect(await response.json()).toEqual({ userId, playerId });
  });

  it("treats an expired session as anonymous, not as an error", async () => {
    const { cookie } = await signIn();
    await getDb(env.DB).update(sessionTable).set({ expiresAt: LONG_EXPIRED });

    const response = await guardedApp().fetch(get("/app/whoami", cookie), bindings());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ userId: null, playerId: null });
  });

  it("treats a tampered or malformed cookie as anonymous, not as an error", async () => {
    const { cookie } = await signIn();
    const name = cookie.split("=")[0]!;
    const tampered = [
      // Same token, signature flipped.
      `${cookie.slice(0, -1)}${cookie.endsWith("a") ? "b" : "a"}`,
      // Right name, contents from a stale deploy.
      `${name}=not-a-token-at-all`,
      `${name}=`,
      `${name}=%%%.%%%`,
    ];

    for (const value of tampered) {
      const response = await guardedApp().fetch(get("/app/whoami", value), bindings());
      expect(response.status, "a bad cookie must never be an error").toBe(200);
      expect(await response.json()).toEqual({ userId: null, playerId: null });
    }
  });

  it("does not leave a session behind when the lookup itself fails", async () => {
    // A broken binding is the one case where the middleware cannot answer
    // honestly. It must still not take a public-looking page down: anonymous,
    // logged, no throw.
    //
    // The cookie is what makes this test load-bearing. Without one Better Auth
    // short-circuits to null before touching D1, the binding below is never
    // called, and the middleware's `catch` is never entered — an earlier
    // version of this test did exactly that and passed with the `catch`
    // replaced by a rethrow.
    const { cookie } = await signIn();
    const fail = () => {
      throw new Error("D1 is unavailable");
    };
    const broken = { prepare: fail, batch: fail, exec: fail } as unknown as D1Database;

    const response = await guardedApp().fetch(get("/app/whoami", cookie), bindings({ DB: broken }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ userId: null, playerId: null });
  });
});

describe("requireSession", () => {
  it("redirects an anonymous request to sign-in rather than erroring", async () => {
    const response = await guardedApp().fetch(get("/app/private"), bindings());

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(SIGN_IN_PATH);
  });

  it("redirects an expired session to sign-in rather than erroring", async () => {
    const { cookie } = await signIn();
    await getDb(env.DB).update(sessionTable).set({ expiresAt: LONG_EXPIRED });

    const response = await guardedApp().fetch(get("/app/private", cookie), bindings());

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(SIGN_IN_PATH);
  });

  it("lets a valid session through", async () => {
    const { cookie } = await signIn();

    const response = await guardedApp().fetch(get("/app/private", cookie), bindings());

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("private");
  });
});

describe("requirePlayer", () => {
  it("redirects to sign-in when there is no session at all", async () => {
    const response = await guardedApp().fetch(get("/app/mine"), bindings());

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(SIGN_IN_PATH);
  });

  it("answers 403 with a page, not a 500, when the session has no Player", async () => {
    // The current normal state: linking is not wired yet, so *every* session
    // that exists today has no Player.
    const { cookie } = await signIn();

    const response = await guardedApp().fetch(get("/app/mine", cookie), bindings());

    expect(response.status).toBe(403);
    const body = await response.text();
    expect(body).toContain("<h1>");
    expect(body).not.toContain("unhandled:");
  });

  it("passes the resolved Player to the handler", async () => {
    const { cookie, userId } = await signIn();
    const playerId = crypto.randomUUID();
    await getDb(env.DB)
      .insert(players)
      .values({ id: playerId, name: "Ada", email: EMAIL, authUserId: userId });

    const response = await guardedApp().fetch(get("/app/mine", cookie), bindings());

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(`player ${playerId}`);
  });

  it("ignores a Player row that belongs to a different identity", async () => {
    const { cookie } = await signIn();
    await getDb(env.DB)
      .insert(players)
      .values({
        id: crypto.randomUUID(),
        name: "Someone else",
        email: "other@example.com",
        authUserId: "some-other-auth-user",
      });

    const response = await guardedApp().fetch(get("/app/mine", cookie), bindings());

    expect(response.status).toBe(403);
    expect(await getDb(env.DB).select().from(players).where(eq(players.name, "Someone else"))).toHaveLength(1);
  });
});

import { SELF, env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createApp } from "../../src/app.js";
import {
  AUTHENTICATED_PREFIX,
  DASHBOARD_PATH,
  SIGN_IN_COMPLETE_PATH,
  SIGN_IN_PATH,
  SIGN_OUT_PATH,
  requirePlayer,
  sessionMiddleware,
} from "../../src/auth/session.js";
import { getDb } from "../../src/db/client.js";
import { ConsoleNotifier } from "../../src/notify/console-notifier.js";
import type { Message } from "../../src/notify/notifier.js";
import {
  players,
  session as sessionTable,
  user as userTable,
  verification,
} from "../../src/db/schema.js";
import type { AppEnv, Bindings } from "../../src/env.js";
import { resetDatabase } from "../support/factories.js";

/**
 * The origin every request in this file is made against.
 *
 * It matches `BETTER_AUTH_URL` in `wrangler.jsonc`, which is what `SELF.fetch`
 * runs with — Better Auth's origin checks compare against it, so a test that
 * used a different host would be testing the CSRF rejection path by accident.
 */
const ORIGIN = "https://makethe.team";

/**
 * The address the test bindings allowlist (`vitest.config.ts`). `SELF.fetch`
 * runs the real Worker with the real bindings and gives no way to override
 * them per request, so the happy path has to use this address.
 */
const ALLOWED = "test-only-not-a-real-address@example.com";
const NOT_ALLOWED = "stranger@example.com";

function bindings(overrides: Partial<Bindings> = {}): Bindings {
  return { ...env, BETTER_AUTH_URL: ORIGIN, SIGNIN_ALLOWLIST: ALLOWED, ...overrides };
}

/** `POST /sign-in` exactly as the page's form does it: urlencoded, same-origin. */
function requestLink(email: string) {
  return new Request(`${ORIGIN}${SIGN_IN_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN },
    body: new URLSearchParams({ email }),
  });
}

/**
 * The sign-in link this deployment actually emailed.
 *
 * Captured off `ConsoleNotifier` — the notifier the test bindings select —
 * rather than rebuilt from the `verification` row, because the emailed URL is
 * the only place `POST /sign-in`'s choice of `callbackURL` is observable, and
 * that choice is what makes the linking step run at all. Rebuilding the URL
 * here would have quietly supplied the query parameter the route is supposed
 * to be setting.
 *
 * The spy is installed around a single request and always removed.
 */
async function askForLink(app: ReturnType<typeof createApp>, email: string) {
  const sent: Message[] = [];
  const spy = vi
    .spyOn(ConsoleNotifier.prototype, "send")
    .mockImplementation((messages: readonly Message[]) => {
      sent.push(...messages);
      return Promise.resolve(messages.map(() => ({ ok: true, providerMessageId: null })));
    });
  try {
    const response = await app.fetch(requestLink(email), bindings());
    return { response, sent };
  } finally {
    spy.mockRestore();
  }
}

/** The `/api/auth/magic-link/verify` URL out of the message that was sent. */
function linkIn(sent: Message[]): string {
  expect(sent).toHaveLength(1);
  const match = /https?:\/\/[^\s"]*magic-link\/verify\?[^\s"]*/.exec(sent[0]!.text);
  expect(match, "the email must carry a verification link").not.toBeNull();
  return match![0];
}

/** Follows the emailed link once and returns the cookie a browser would keep. */
function followLink(url: string, cookie?: string) {
  return new Request(url, { headers: { origin: ORIGIN, ...(cookie ? { cookie } : {}) } });
}

function cookieFrom(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0]!)
    .join("; ");
}

/**
 * The whole browser journey: ask for a link, follow it, arrive wherever the
 * app sends you. Returns the cookie jar and the final redirect target.
 *
 * Only the app's own public surface is used — no hand-built session rows and
 * no hand-built cookies, both of which would prove only that a forgery is
 * accepted.
 */
async function signIn(email = ALLOWED) {
  const app = createApp();
  const { response, sent } = await askForLink(app, email);
  expect(response.status).toBe(200);

  const verified = await app.fetch(followLink(linkIn(sent)), bindings());
  const cookie = cookieFrom(verified);
  expect(cookie).not.toBe("");

  // Better Auth redirects to whatever `POST /sign-in` asked for; following it
  // is what actually runs the linking step.
  const landed = await app.fetch(
    new Request(new URL(verified.headers.get("location")!, ORIGIN), { headers: { cookie } }),
    bindings(),
  );
  return { cookie, verified, landed };
}

beforeEach(async () => {
  await resetDatabase();
});

describe("GET /sign-in", () => {
  it("renders one email field, a submit button and no password field", async () => {
    const response = await SELF.fetch(`${ORIGIN}${SIGN_IN_PATH}`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(body).toContain('type="email"');
    expect(body).toContain('name="email"');
    expect(body).toContain("<button");
    expect(body).not.toContain("password");
  });

  it("works with no JavaScript at all", async () => {
    const body = await (await SELF.fetch(`${ORIGIN}${SIGN_IN_PATH}`)).text();

    expect(body).not.toContain("<script");
    expect(body).toContain('method="post"');
    expect(body).toContain(`action="${SIGN_IN_PATH}"`);
  });

  it("explains a link that did not work without echoing the error back", async () => {
    const payload = "INVALID_TOKEN</style><marquee>pwned";
    const body = await (
      await SELF.fetch(`${ORIGIN}${SIGN_IN_PATH}?error=${encodeURIComponent(payload)}`)
    ).text();

    expect(body).toMatch(/expired|already been used/i);
    // The query value is a boolean signal, never content: nothing from the URL
    // reaches the page, escaped or otherwise.
    expect(body).not.toContain("INVALID_TOKEN");
    expect(body).not.toContain("marquee");
    expect(body).not.toContain("pwned");
  });

  it("sends an already-signed-in visitor to the dashboard", async () => {
    const { cookie } = await signIn();

    const response = await createApp().fetch(
      new Request(`${ORIGIN}${SIGN_IN_PATH}`, { headers: { cookie } }),
      bindings(),
    );

    // Proof the session mount reaches `/sign-in`, which sits outside
    // AUTHENTICATED_PREFIX.
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(DASHBOARD_PATH);
  });
});

describe("POST /sign-in", () => {
  it("renders check-your-inbox and issues a link for an allowlisted address", async () => {
    const response = await createApp().fetch(requestLink(ALLOWED), bindings());

    expect(response.status).toBe(200);
    expect(await response.text()).toMatch(/inbox/i);
    expect(await getDb(env.DB).select().from(verification)).toHaveLength(1);
  });

  /**
   * Task 3's property, at the page level this time. Anything that differs
   * between these responses — body, status, a flash, a cookie, a redirect —
   * tells a stranger whether an address is known to this deployment.
   */
  it("answers identically whatever the outcome", async () => {
    const app = createApp();
    const observable = async (response: Response) => ({
      status: response.status,
      statusText: response.statusText,
      setCookie: response.headers.getSetCookie(),
      headers: [...response.headers].sort(([a], [b]) => a.localeCompare(b)),
      body: await response.text(),
    });

    // A registered Player, an allowlisted stranger, a non-allowlisted address,
    // an address that is not an address at all, and a missing field.
    await getDb(env.DB)
      .insert(players)
      .values({ id: crypto.randomUUID(), name: "Ada", email: ALLOWED });

    const known = await observable(await app.fetch(requestLink(ALLOWED), bindings()));
    await resetDatabase();
    const unknown = await observable(await app.fetch(requestLink(NOT_ALLOWED), bindings()));
    await resetDatabase();
    const nonsense = await observable(await app.fetch(requestLink("not-an-email"), bindings()));
    await resetDatabase();
    const blank = await observable(await app.fetch(requestLink(""), bindings()));
    await resetDatabase();
    const missing = await observable(
      await app.fetch(
        new Request(`${ORIGIN}${SIGN_IN_PATH}`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN },
          body: "",
        }),
        bindings(),
      ),
    );

    for (const [name, other] of Object.entries({ unknown, nonsense, blank, missing })) {
      expect(other, `${name} must be indistinguishable from a known address`).toEqual(known);
    }
  });

  it("sends nothing for an address that is not allowlisted", async () => {
    await createApp().fetch(requestLink(NOT_ALLOWED), bindings());

    // The verification row is written before the gate runs (a recorded
    // footnote in task 3), so the observable "nothing was sent" is the
    // notifier, which the console log line stands in for here.
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await createApp().fetch(requestLink(NOT_ALLOWED), bindings());
      expect(logSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe("verification", () => {
  it("signs a person in, creates their Player and lands them on the dashboard", async () => {
    const { verified, landed } = await signIn();

    expect(verified.status).toBe(302);
    expect(landed.status).toBe(302);
    expect(landed.headers.get("location")).toBe(DASHBOARD_PATH);

    const [player] = await getDb(env.DB).select().from(players);
    expect(player).toBeDefined();
    expect(player!.email).toBe(ALLOWED);
    expect(player!.authUserId).not.toBeNull();
    expect(player!.emailVerifiedAt).not.toBeNull();
    expect(player!.name).not.toBe("");
  });

  it("adopts a Player who was added by someone else", async () => {
    const playerId = crypto.randomUUID();
    await getDb(env.DB)
      .insert(players)
      .values({ id: playerId, name: "Ada Lovelace", email: ALLOWED });

    await signIn();

    const rows = await getDb(env.DB).select().from(players);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(playerId);
    // The squad's name for someone is not overwritten by the provider's.
    expect(rows[0]!.name).toBe("Ada Lovelace");
    expect(rows[0]!.authUserId).not.toBeNull();
  });

  /**
   * The security boundary. `linkPlayerOnSignIn` refuses to match an address
   * the provider has not verified — but only if the caller passes `null`
   * instead of the address. Passing `user.email` unconditionally here would be
   * account takeover by typing someone else's address, so the gate is pinned
   * on its own.
   */
  it("never claims an existing Player for an unverified address", async () => {
    const playerId = crypto.randomUUID();
    await getDb(env.DB)
      .insert(players)
      .values({ id: playerId, name: "Ada Lovelace", email: ALLOWED });

    const app = createApp();
    const { sent } = await askForLink(app, ALLOWED);
    const verified = await app.fetch(followLink(linkIn(sent)), bindings());
    const cookie = cookieFrom(verified);

    // The provider marks a magic-link address verified, so the only way to
    // reach the gate is to withdraw that fact and re-run linking.
    await getDb(env.DB).update(userTable).set({ emailVerified: false });

    const landed = await app.fetch(
      new Request(`${ORIGIN}${SIGN_IN_COMPLETE_PATH}`, { headers: { cookie } }),
      bindings(),
    );
    expect(landed.status).toBe(302);

    const rows = await getDb(env.DB).select().from(players);
    // Ada's row is untouched; the unverified identity got a Player of its own.
    const ada = rows.find((row) => row.id === playerId)!;
    expect(ada.authUserId).toBeNull();
    expect(rows).toHaveLength(2);
  });

  it("rejects a link that has already been used", async () => {
    const app = createApp();
    const { sent } = await askForLink(app, ALLOWED);
    const url = linkIn(sent);

    const first = await app.fetch(followLink(url), bindings());
    expect(first.status).toBe(302);
    expect(cookieFrom(first)).not.toBe("");

    const second = await app.fetch(followLink(url), bindings());

    expect(second.status).toBe(302);
    const target = new URL(second.headers.get("location")!, ORIGIN);
    expect(target.pathname).toBe(SIGN_IN_PATH);
    expect(target.searchParams.get("error")).toBeTruthy();
    // No second session was minted.
    expect(await getDb(env.DB).select().from(sessionTable)).toHaveLength(1);
  });

  it("rejects a link that has expired", async () => {
    const app = createApp();
    const { sent } = await askForLink(app, ALLOWED);

    // Constructed, never derived by subtracting from a clock read: `Date.now()`
    // is frozen between I/O in workerd and the test isolate's clock drifts from
    // the Worker's.
    await getDb(env.DB)
      .update(verification)
      .set({ expiresAt: new Date("2020-01-01T00:00:00Z") });

    const response = await app.fetch(followLink(linkIn(sent)), bindings());

    expect(response.status).toBe(302);
    expect(new URL(response.headers.get("location")!, ORIGIN).pathname).toBe(SIGN_IN_PATH);
    expect(cookieFrom(response)).toBe("");
    expect(await getDb(env.DB).select().from(sessionTable)).toHaveLength(0);
  });

  it("redirects to sign-in when reached without a session", async () => {
    const response = await createApp().fetch(
      new Request(`${ORIGIN}${SIGN_IN_COMPLETE_PATH}`),
      bindings(),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(SIGN_IN_PATH);
  });

  it("explains a conflict instead of taking the account over", async () => {
    const { cookie } = await signIn();
    // Hand the Player to a different identity, then re-run linking. This is
    // what a second provider identity on one address looks like.
    await getDb(env.DB).update(players).set({ authUserId: "some-other-identity" });

    const response = await createApp().fetch(
      new Request(`${ORIGIN}${SIGN_IN_COMPLETE_PATH}`, { headers: { cookie } }),
      bindings(),
    );

    expect(response.status).toBe(409);
    const body = await response.text();
    expect(body).toContain("<h1>");
    expect(body).toContain(SIGN_OUT_PATH);
    const [player] = await getDb(env.DB).select().from(players);
    expect(player!.authUserId).toBe("some-other-identity");
  });

  it("explains an address held by more than one Player", async () => {
    const { cookie } = await signIn();
    const db = getDb(env.DB);
    // Two rows differing only in case, which `players_email_unique` permits.
    await db.update(players).set({ authUserId: null });
    await db
      .insert(players)
      .values({ id: crypto.randomUUID(), name: "Ada", email: ALLOWED.toUpperCase() });

    const response = await createApp().fetch(
      new Request(`${ORIGIN}${SIGN_IN_COMPLETE_PATH}`, { headers: { cookie } }),
      bindings(),
    );

    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).toContain("<h1>");
    expect(body).toContain(SIGN_OUT_PATH);
  });

  it("explains an address held by a guest", async () => {
    const { cookie } = await signIn();
    const db = getDb(env.DB);
    await db.delete(players);
    await db
      .insert(players)
      .values({ id: crypto.randomUUID(), name: "Ada", email: ALLOWED, isGuest: true });

    const response = await createApp().fetch(
      new Request(`${ORIGIN}${SIGN_IN_COMPLETE_PATH}`, { headers: { cookie } }),
      bindings(),
    );

    expect(response.status).toBe(500);
    expect(await response.text()).toContain("<h1>");
  });
});

describe("sign out", () => {
  it("ends the session and sends the person back to sign-in", async () => {
    const { cookie } = await signIn();
    expect(await getDb(env.DB).select().from(sessionTable)).toHaveLength(1);

    const response = await createApp().fetch(
      new Request(`${ORIGIN}${SIGN_OUT_PATH}`, {
        method: "POST",
        headers: { cookie, origin: ORIGIN },
      }),
      bindings(),
    );

    expect(response.status).toBe(302);
    expect(new URL(response.headers.get("location")!, ORIGIN).pathname).toBe(SIGN_IN_PATH);
    expect(await getDb(env.DB).select().from(sessionTable)).toHaveLength(0);

    // And the cookie is actually cleared in the browser, not merely deleted
    // server-side.
    expect(response.headers.getSetCookie().join(";")).toMatch(/Max-Age=0|Expires=/i);
  });

  /**
   * A `GET` sign-out is triggerable by any `<img>` tag or link prefetcher on
   * any page in the world. Pinned on its own, both spellings, because "the
   * form uses POST" is not the same statement as "GET cannot do it".
   */
  it.each([SIGN_OUT_PATH, "/signout", "/api/auth/sign-out"])(
    "does not sign out on GET %s",
    async (path) => {
      const { cookie } = await signIn();

      const response = await createApp().fetch(
        new Request(`${ORIGIN}${path}`, { headers: { cookie } }),
        bindings(),
      );

      expect(response.status).not.toBe(302);
      expect(response.headers.getSetCookie()).toEqual([]);
      // The only thing that matters: the session is still there afterwards.
      expect(await getDb(env.DB).select().from(sessionTable)).toHaveLength(1);
    },
  );

  it("refuses a cross-site POST", async () => {
    const { cookie } = await signIn();

    const response = await createApp().fetch(
      new Request(`${ORIGIN}${SIGN_OUT_PATH}`, {
        method: "POST",
        headers: { cookie, origin: "https://evil.test" },
      }),
      bindings(),
    );

    expect(response.status).toBe(403);
    expect(await getDb(env.DB).select().from(sessionTable)).toHaveLength(1);
  });

  it("is harmless when there is no session to end", async () => {
    const response = await createApp().fetch(
      new Request(`${ORIGIN}${SIGN_OUT_PATH}`, { method: "POST", headers: { origin: ORIGIN } }),
      bindings(),
    );

    expect(response.status).toBe(302);
  });
});

describe("the no-Player exit", () => {
  /**
   * `requirePlayer`'s 403 body, reached through the guard itself.
   *
   * Behind a probe route rather than the real dashboard because the dashboard
   * is the next task and does not exist yet — but the guard, the renderer and
   * the session are all the real ones, so what is asserted here is the page a
   * person will actually be shown.
   */
  function guardedApp() {
    const app = new Hono<AppEnv>();
    app.use(AUTHENTICATED_PREFIX, sessionMiddleware);
    app.get(`${DASHBOARD_PATH}/probe`, requirePlayer, (c) => c.text("ok"));
    return app;
  }

  it("offers a way out of the 403 instead of stranding the person", async () => {
    // A session whose identity has no Player: the state every refusal outcome
    // leaves behind, and the one `requirePlayer` answers 403 for.
    const { cookie } = await signIn();
    await getDb(env.DB).delete(players);

    const response = await guardedApp().fetch(
      new Request(`${ORIGIN}${DASHBOARD_PATH}/probe`, { headers: { cookie } }),
      bindings(),
    );

    expect(response.status).toBe(403);
    const body = await response.text();
    // An exit, not a dead end: a sign-out form (POST, not a link) and a way
    // home.
    expect(body).toContain(`action="${SIGN_OUT_PATH}"`);
    expect(body).toContain('method="post"');
    expect(body).toContain('href="/"');
    expect(body).not.toMatch(/type=.?password/i);
    expect(body).not.toContain("<script");
  });

  it("takes the sign-out button on that page all the way through", async () => {
    const { cookie } = await signIn();
    await getDb(env.DB).delete(players);

    // Exactly what the form on the 403 page posts.
    const response = await createApp().fetch(
      new Request(`${ORIGIN}${SIGN_OUT_PATH}`, {
        method: "POST",
        headers: { cookie, origin: ORIGIN },
      }),
      bindings(),
    );

    expect(response.status).toBe(302);
    expect(await getDb(env.DB).select().from(sessionTable)).toHaveLength(0);
  });
});

describe("no password field anywhere (TR-16)", () => {
  /**
   * Every page the app can render, driven through the app itself rather than
   * through the view functions, so a future page that forgets to use `layout`
   * is still covered. The list is deliberately exhaustive over the app's
   * routes — a new page that renders a password field has to be added here to
   * be missed.
   */
  it("renders no password input on any reachable page", async () => {
    const { cookie } = await signIn();
    const db = getDb(env.DB);
    await db.delete(players);

    const pages: Array<[string, Request]> = [
      ["home", new Request(`${ORIGIN}/`)],
      ["robots", new Request(`${ORIGIN}/robots.txt`)],
      ["not found", new Request(`${ORIGIN}/nope`)],
      ["sign-in", new Request(`${ORIGIN}${SIGN_IN_PATH}`)],
      ["sign-in error", new Request(`${ORIGIN}${SIGN_IN_PATH}?error=INVALID_TOKEN`)],
      ["check inbox", requestLink(ALLOWED)],
      ["no player", new Request(`${ORIGIN}${DASHBOARD_PATH}`, { headers: { cookie } })],
      ["complete", new Request(`${ORIGIN}${SIGN_IN_COMPLETE_PATH}`, { headers: { cookie } })],
      ["bad respond token", new Request(`${ORIGIN}/r/not-a-token`)],
      ["bad leave token", new Request(`${ORIGIN}/leave/not-a-token`)],
    ];

    const app = createApp();
    for (const [name, request] of pages) {
      const body = await (await app.fetch(request, bindings())).text();
      expect(body, `${name} must not contain a password field`).not.toMatch(/type=.?password/i);
      expect(body, `${name} must not need JavaScript`).not.toContain("<script");
    }
  });
});

describe("session scoping", () => {
  it("still resolves no session on the public holding page", async () => {
    const { cookie } = await signIn();

    // The second mount is `/sign-in` and its children, not `*`: `/` must keep
    // paying nothing for a session it never reads.
    const response = await createApp().fetch(
      new Request(`${ORIGIN}/`, { headers: { cookie } }),
      bindings(),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).not.toMatch(/sign out/i);
  });
});

describe("no open redirect", () => {
  /**
   * Task 4 shipped no `?next=` parameter on purpose and this task adds none.
   * These are the values that would matter if one were ever added; the
   * assertion is that the destination is a fixed path regardless.
   */
  const hostile = [
    "//evil.test",
    "https://evil.test",
    "/\\evil.test",
    "\\\\evil.test",
    "%2f%2fevil.test",
    "https:%2F%2Fevil.test",
  ];

  it.each(hostile)("ignores a next=%s on the sign-in page", async (next) => {
    const { cookie } = await signIn();

    const response = await createApp().fetch(
      new Request(`${ORIGIN}${SIGN_IN_PATH}?next=${encodeURIComponent(next)}`, {
        headers: { cookie },
      }),
      bindings(),
    );

    expect(response.headers.get("location")).toBe(DASHBOARD_PATH);
  });

  it.each(hostile)("ignores a next=%s on sign-out", async (next) => {
    const { cookie } = await signIn();

    const response = await createApp().fetch(
      new Request(`${ORIGIN}${SIGN_OUT_PATH}?next=${encodeURIComponent(next)}`, {
        method: "POST",
        headers: { cookie, origin: ORIGIN },
        body: new URLSearchParams({ next }),
      }),
      bindings(),
    );

    expect(new URL(response.headers.get("location")!, ORIGIN).origin).toBe(ORIGIN);
  });

  it("ignores a callbackURL a stranger puts on the verification link", async () => {
    const app = createApp();
    const { sent } = await askForLink(app, ALLOWED);
    const url = new URL(linkIn(sent));
    url.searchParams.set("callbackURL", "https://evil.test/steal");

    const response = await app.fetch(followLink(url.toString()), bindings());

    // Better Auth's own origin check refuses it; what must never happen is a
    // session cookie leaving alongside a redirect off-site.
    const location = response.headers.get("location");
    if (location !== null) {
      expect(new URL(location, ORIGIN).origin).toBe(ORIGIN);
    }
  });
});

describe("linked identity is idempotent", () => {
  it("re-running completion does not create a second Player", async () => {
    const { cookie } = await signIn();
    const before = await getDb(env.DB).select().from(players);
    expect(before).toHaveLength(1);

    const again = await createApp().fetch(
      new Request(`${ORIGIN}${SIGN_IN_COMPLETE_PATH}`, { headers: { cookie } }),
      bindings(),
    );

    expect(again.status).toBe(302);
    expect(again.headers.get("location")).toBe(DASHBOARD_PATH);
    expect(await getDb(env.DB).select().from(players)).toHaveLength(1);
  });

  it("keeps the first verification timestamp when signing in again", async () => {
    await signIn();
    const [first] = await getDb(env.DB).select().from(players);
    const stamp = first!.emailVerifiedAt;

    await signIn();

    const [after] = await getDb(env.DB)
      .select()
      .from(players)
      .where(eq(players.id, first!.id));
    expect(after!.emailVerifiedAt).toEqual(stamp);
  });
});

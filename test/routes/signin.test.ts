import { SELF, env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createApp } from "../../src/app.js";
import {
  AUTHENTICATED_PREFIX,
  DASHBOARD_PATH,
  PASSKEYS_PATH,
  SIGN_IN_COMPLETE_PATH,
  SIGN_IN_PATH,
  SIGN_OUT_PATH,
  requirePlayer,
  sessionMiddleware,
} from "../../src/auth/session.js";
import { getDb } from "../../src/db/client.js";
import {
  fixtures,
  games,
  memberships,
  passkey,
  players,
  session as sessionTable,
  user as userTable,
  verification,
} from "../../src/db/schema.js";
import { openFixture } from "../../src/domain/open-fixture.js";
import { signCancelToken } from "../../src/domain/token.js";
import type { AppEnv } from "../../src/env.js";
import { SCRIPT_BLOCKS } from "../../src/views/scripts.js";
import { insertGame, resetDatabase } from "../support/factories.js";
import { EMAIL_LOOKUP, interferingBinding } from "../support/interference.js";
// The whole browser journey through sign-in lives in `test/support/sign-in.ts`
// so the dashboard suite can reach a real session the same way this one does —
// see that module for why nothing here builds a cookie or a session row.
import {
  ALLOWED,
  ORIGIN,
  askForLink,
  bindings,
  cookieFrom,
  followLink,
  linkIn,
  requestLink,
  signIn,
} from "../support/sign-in.js";

const NOT_ALLOWED = "stranger@example.com";

/**
 * `requirePlayer`'s 403 body, reached through the guard itself.
 *
 * Behind a probe route rather than the real dashboard because the dashboard
 * is the next task and does not exist yet — but the guard, the renderer and
 * the session are all the real ones, so what is asserted here is the page a
 * person will actually be shown. Shared by "the no-Player exit" tests and the
 * TR-16 enumeration below, so the two cannot drift onto different probes.
 */
function guardedApp() {
  const app = new Hono<AppEnv>();
  app.use(AUTHENTICATED_PREFIX, sessionMiddleware);
  app.get(`${DASHBOARD_PATH}/probe`, requirePlayer, (c) => c.text("ok"));
  return app;
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

  /**
   * The rule M5 Task 8 must not break: **with scripting off, this page is
   * exactly as usable as it was before passkeys existed.**
   *
   * This used to be `expect(body).not.toContain("<script")`, which stopped
   * being true the moment WebAuthn — a browser API with no server-side
   * substitute — arrived. Asserting the absence of a tag was never the point
   * though; the point is that nothing a person needs depends on script. So
   * the page is reduced to what a browser with scripting disabled would
   * actually have (every `<script>` element deleted, which is *all* of the
   * behaviour, because the test below this one proves there are no inline
   * handlers or `javascript:` URLs anywhere), and then the entire magic-link
   * journey is driven from that reduced markup alone: the request is built
   * from the form's own `action`, `method` and field name as parsed out of
   * it, not from constants this test happens to know.
   *
   * The passkey affordance is asserted *absent from view* rather than absent
   * from the markup — it ships `hidden`, and `[hidden] { display: none
   * !important }` in `STYLES` is what makes that binding rather than a UA
   * default a later rule could beat.
   */
  it("is completely usable with scripting disabled", async () => {
    const served = await (await SELF.fetch(`${ORIGIN}${SIGN_IN_PATH}`)).text();

    // What a browser with scripting turned off is left holding.
    const withoutScript = served.replace(/<script[\s\S]*?<\/script>/g, "");
    expect(withoutScript, "removing the scripts must remove all script").not.toContain("<script");

    // The passkey button is in the markup but not on the page: it is revealed
    // only by the script that was just removed.
    expect(withoutScript).toMatch(/<div class="passkey" id="passkey" hidden>/);

    // Everything the baseline needs, read *out of the reduced page*.
    const form = /<form([^>]*)>([\s\S]*?)<\/form>/.exec(withoutScript);
    expect(form, "the email form must survive with scripting off").not.toBeNull();
    const formAttributes = form![1]!;
    const formBody = form![2]!;
    expect(formAttributes).toMatch(/method="post"/);
    expect(formAttributes).toMatch(new RegExp(`action="${SIGN_IN_PATH}"`));
    expect(formBody, "a submit button, not a scripted one").toMatch(/<button[^>]*type="submit"/);
    expect(formBody).toMatch(/<label for="email"/);
    const field = /<input[^>]*\bname="([^"]+)"[^>]*>/.exec(formBody);
    expect(field, "the form must carry an input to type into").not.toBeNull();
    expect(formBody).toMatch(/\brequired\b/);

    // And it genuinely works end to end, driven only by what is above.
    const action = /action="([^"]+)"/.exec(formAttributes)![1]!;
    const app = createApp();
    const { response, sent } = await askForLink(app, ALLOWED);
    expect(new URL(requestLink(ALLOWED).url).pathname, "same action the form names").toBe(action);
    expect(field![1], "same field name the route reads").toBe("email");
    expect(response.status).toBe(200);

    const verified = await app.fetch(followLink(linkIn(sent)), bindings());
    const cookie = cookieFrom(verified);
    expect(cookie).not.toBe("");
    const landed = await app.fetch(
      new Request(new URL(verified.headers.get("location")!, ORIGIN), { headers: { cookie } }),
      bindings(),
    );
    expect(landed.headers.get("location")).toBe(DASHBOARD_PATH);
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

  /**
   * `create-raced` is the one outcome `linkPlayerOnSignIn`'s bounded retry loop
   * produces rather than any single read, so it cannot be reached by seeding a
   * row and calling the route once — the seam has to be the same deterministic
   * interleaving `test/auth/link-player.test.ts` uses to drive the function
   * directly (`../support/interference.js`), run this time through the real
   * `/sign-in/complete` route so the *page* — not just the function — is pinned.
   * A rival row for the same address is deleted immediately before every email
   * lookup and reinserted immediately after, so all three attempts decide to
   * create and then lose the insert to the row that reappeared underneath them.
   */
  it("gives up with create-raced when every attempt loses, and offers a retry", async () => {
    const app = createApp();
    const { sent } = await askForLink(app, ALLOWED);
    const verified = await app.fetch(followLink(linkIn(sent)), bindings());
    const cookie = cookieFrom(verified);
    expect(cookie).not.toBe("");

    const rivalId = crypto.randomUUID();
    const racing = interferingBinding(env.DB, {
      match: EMAIL_LOOKUP,
      before: async () => {
        await getDb(env.DB).delete(players).where(eq(players.id, rivalId));
      },
      after: async () => {
        await getDb(env.DB)
          .insert(players)
          .values({ id: rivalId, name: "Rival", email: ALLOWED });
      },
    });

    const response = await app.fetch(
      new Request(`${ORIGIN}${SIGN_IN_COMPLETE_PATH}`, { headers: { cookie } }),
      bindings({ DB: racing }),
    );

    expect(response.status).toBe(503);
    const body = await response.text();
    // The one page in the flow with a retry link — it is what makes this
    // outcome different from the three terminal refusals, and a wrong target
    // here would strand someone in a loop.
    expect(body).toContain(`href="${SIGN_IN_COMPLETE_PATH}"`);
    expect(body).toMatch(/try again/i);
    expect(body).not.toMatch(/type=.?password/i);
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
   * Every page the app can actually render HTML for, driven through the app
   * itself (or, where HTTP cannot reach it in this milestone, through the
   * real guard/renderer behind a probe route) rather than through the bare
   * view functions — so a future page that forgets to use `layout` is still
   * covered. Each entry asserts a phrase distinctive to *that* page, not just
   * the absence of a password field, so a 404 or an empty redirect body can
   * never masquerade as coverage of the page it was meant to stand in for.
   *
   * `renderLinkProblemPage()` also answers `app.onError`'s 500 (an unexpected
   * throw), not just the 200 bad-token paths exercised here — but it is the
   * same renderer producing byte-identical output either way
   * (`test/routes/error-handler.test.ts` pins that identity independently),
   * so exercising the 200 path here is exhaustive over its content without
   * re-deriving a server fault.
   *
   * `/sign-in/complete`'s three success outcomes (`linked`, `already-linked`,
   * `created`) are deliberately absent: all three are a 302 with an empty
   * body, so there is no HTML there for a password field to hide in, and
   * asserting on `""` would be exactly the false coverage this test used to
   * have. What that route *does* render — the four `renderLinkRefusalPage`
   * outcomes — is covered below instead.
   */
  it("renders no password input on any reachable page", async () => {
    type Page = { name: string; body: string; distinctive: RegExp };
    const pages: Page[] = [];

    async function capture(
      name: string,
      distinctive: RegExp,
      request: Request,
      app: Hono<AppEnv> = createApp(),
    ) {
      const body = await (await app.fetch(request, bindings())).text();
      pages.push({ name, body, distinctive });
    }

    // Stateless pages: no session, no linking outcome, safe to run in any order.
    await capture("home", /Getting a regular game on/, new Request(`${ORIGIN}/`));
    await capture("robots", /User-agent/i, new Request(`${ORIGIN}/robots.txt`));
    await capture("not found", /Not found/, new Request(`${ORIGIN}/nope`));
    await capture("sign-in", /Email me a sign-in link/, new Request(`${ORIGIN}${SIGN_IN_PATH}`));
    await capture(
      "sign-in error",
      /expired|already been used/i,
      new Request(`${ORIGIN}${SIGN_IN_PATH}?error=INVALID_TOKEN`),
    );
    await capture("check inbox", /Check your inbox/i, requestLink(ALLOWED));
    await capture("bad respond token", /This link isn't working/i, new Request(`${ORIGIN}/r/not-a-token`));
    await capture("bad leave token", /This link isn't working/i, new Request(`${ORIGIN}/leave/not-a-token`));

    // The no-Player 403: reached through the real guard and renderer behind a
    // probe route, since `/app` has no route of its own until the dashboard
    // task — a plain `GET DASHBOARD_PATH` here would be a 404 and prove
    // nothing, which is exactly the defect this rewrite fixes.
    await resetDatabase();
    {
      const { cookie } = await signIn();
      await getDb(env.DB).delete(players);
      await capture(
        "no player (403)",
        /We can't find your player/,
        new Request(`${ORIGIN}${DASHBOARD_PATH}/probe`, { headers: { cookie } }),
        guardedApp(),
      );
    }

    // The dashboard, signed in and with a real fixture on it, so the card
    // markup — not just the empty state — is covered.
    await resetDatabase();
    {
      const { cookie } = await signIn();
      const db = getDb(env.DB);
      const [player] = await db.select().from(players);
      const gameId = await insertGame(db, { name: "Thursday 7-a-side" });
      const fixtureId = crypto.randomUUID();
      await db.insert(fixtures).values({
        id: fixtureId,
        gameId,
        kicksOffAt: new Date("2030-06-13T18:00:00Z"),
        minPlayers: 1,
        maxPlayers: 14,
        prefersEvenNumbers: true,
        shortWarningOffsetHours: 12,
        durationMinutes: 60,
      });
      await db
        .insert(memberships)
        .values({ id: crypto.randomUUID(), gameId, playerId: player!.id, active: true });
      await openFixture(db, fixtureId, new Date("2030-06-01T09:00:00Z"));

      await capture(
        "dashboard",
        /Your games/,
        new Request(`${ORIGIN}${DASHBOARD_PATH}`, { headers: { cookie } }),
      );

      // The one page whose whole reason to exist is an enhancement (M5 Task
      // 8). Captured with a passkey already registered so the list branch is
      // covered too, not just the empty state.
      await getDb(env.DB).insert(passkey).values({
        id: crypto.randomUUID(),
        userId: (await getDb(env.DB).select().from(userTable))[0]!.id,
        publicKey: "not-a-real-key",
        credentialID: "not-a-real-credential",
        counter: 0,
        deviceType: "singleDevice",
        backedUp: false,
        createdAt: new Date("2030-06-01T09:00:00Z"),
      });
      await capture(
        "passkeys",
        /Add a passkey|You haven't added a passkey yet/,
        new Request(`${ORIGIN}${PASSKEYS_PATH}`, { headers: { cookie } }),
      );

      // M4's owner-cancellation pages. Both render HTML, so both are captured
      // rather than excused — the confirmation page in particular is the one
      // that takes free text from an owner, which is why the CSP this suite
      // guards exists at all. The membership seeded above is upgraded to
      // `owner` so `cancelFixture`'s entitlement check passes; without it the
      // route correctly refuses and we would capture the shared failure page
      // twice while believing we had covered the confirm page.
      await db
        .update(memberships)
        .set({ role: "owner" })
        .where(eq(memberships.playerId, player!.id));
      const cancelToken = await signCancelToken(
        {
          ownerPlayerId: player!.id,
          fixtureId,
          expiresAt: new Date("2030-06-13T18:00:00Z").getTime(),
        },
        env.CANCEL_TOKEN_SECRET,
      );
      await capture(
        "cancel confirm",
        /Cancel this game\?/,
        new Request(`${ORIGIN}/cancel/${cancelToken}`),
      );
      await capture(
        "cancel done",
        /is cancelled|has been cancelled/i,
        new Request(`${ORIGIN}/cancel/${cancelToken}`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "reason=",
        }),
      );

      // The game-creation form (Task 6, J1).
      await capture(
        "game form",
        /Set up a game/,
        new Request(`${ORIGIN}/g/new`, { headers: { cookie } }),
      );

      // The owner's game overview (Task 7, TR-18). The membership was already
      // promoted to `owner` above for the cancellation captures, so the same
      // player is entitled to this game too.
      await capture(
        "game overview",
        /Invite people/,
        new Request(`${ORIGIN}/g/${gameId}`, { headers: { cookie } }),
      );

      // The game-edit form (Task 8). Same owner membership as the overview
      // capture above, so this reaches the 200 branch rather than the 404.
      await capture(
        "game edit",
        /Edit Thursday 7-a-side/,
        new Request(`${ORIGIN}/g/${gameId}/edit`, { headers: { cookie } }),
      );

      // The owner's one-fixture page (J6b Task 4). Same owner membership and
      // fixture as the captures above.
      await capture(
        "owner fixture",
        /Back to the game/,
        new Request(`${ORIGIN}/g/${gameId}/f/${fixtureId}`, { headers: { cookie } }),
      );

      // The squad-removal confirmation (Task 9, J6a). A second member is added
      // to the squad so this captures a removable member's own page, rather
      // than the game's only (organiser) member.
      const removableId = crypto.randomUUID();
      await db.insert(players).values({ id: removableId, name: "Sam Okafor", email: "sam@example.com" });
      await db.insert(memberships).values({ id: crypto.randomUUID(), gameId, playerId: removableId, active: true });
      await capture(
        "squad remove confirm",
        /Remove Sam Okafor\?/,
        new Request(`${ORIGIN}/g/${gameId}/squad/${removableId}/remove`, { headers: { cookie } }),
      );

      // The public invite page and the page a join lands on (Task 11, J1).
      // Fetched with no cookie, deliberately: these are the two pages a
      // stranger holding a link can reach, and a session must not be needed
      // for either.
      const [invited] = await db.select().from(games).where(eq(games.id, gameId));
      await capture("invite", /Join the squad/, new Request(`${ORIGIN}/j/${invited!.inviteToken}`));

      // `POST /j/:token` on its `already-member` branch — the signed-in
      // player above is already in this squad, so this renders
      // `renderJoinOutcomePage` (the template this route has of its own, and
      // the thing being covered) without starting the N-6 background send.
      // The `joined` branch would hand a send to `waitUntil`, whose
      // `notification_log` row can land after the next `resetDatabase()` in
      // this test and break that reset's `DELETE FROM players` on a foreign
      // key — a failure that would surface in some unrelated capture below.
      // `test/routes/join.test.ts` covers the `joined` branch of the same
      // renderer, waiting for the send properly.
      await capture(
        "join outcome",
        /already in this squad/,
        new Request(`${ORIGIN}/j/${invited!.inviteToken}`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN },
          body: new URLSearchParams({ name: "Ada", email: ALLOWED }),
        }),
      );
    }

    // The four `renderLinkRefusalPage` outcomes, each reached through the real
    // `/sign-in/complete` route with the DB state that produces it.
    await resetDatabase();
    {
      const { cookie } = await signIn();
      await getDb(env.DB).update(players).set({ authUserId: "some-other-identity" });
      await capture(
        "link conflict (409)",
        /already in use/i,
        new Request(`${ORIGIN}${SIGN_IN_COMPLETE_PATH}`, { headers: { cookie } }),
      );
    }

    await resetDatabase();
    {
      const { cookie } = await signIn();
      const db = getDb(env.DB);
      await db.update(players).set({ authUserId: null });
      await db.insert(players).values({ id: crypto.randomUUID(), name: "Ada", email: ALLOWED.toUpperCase() });
      await capture(
        "ambiguous email (500)",
        /more than one player/i,
        new Request(`${ORIGIN}${SIGN_IN_COMPLETE_PATH}`, { headers: { cookie } }),
      );
    }

    await resetDatabase();
    {
      const { cookie } = await signIn();
      const db = getDb(env.DB);
      await db.delete(players);
      await db.insert(players).values({ id: crypto.randomUUID(), name: "Ada", email: ALLOWED, isGuest: true });
      await capture(
        "email held by a guest (500)",
        /guest entry/i,
        new Request(`${ORIGIN}${SIGN_IN_COMPLETE_PATH}`, { headers: { cookie } }),
      );
    }

    await resetDatabase();
    {
      // The one outcome a single read can't produce — see the route-level
      // "gives up with create-raced" test above for why the interleaving is
      // constructed this way.
      const app = createApp();
      const { sent } = await askForLink(app, ALLOWED);
      const verified = await app.fetch(followLink(linkIn(sent)), bindings());
      const cookie = cookieFrom(verified);
      const rivalId = crypto.randomUUID();
      const racing = interferingBinding(env.DB, {
        match: EMAIL_LOOKUP,
        before: async () => {
          await getDb(env.DB).delete(players).where(eq(players.id, rivalId));
        },
        after: async () => {
          await getDb(env.DB).insert(players).values({ id: rivalId, name: "Rival", email: ALLOWED });
        },
      });
      const body = await (
        await app.fetch(
          new Request(`${ORIGIN}${SIGN_IN_COMPLETE_PATH}`, { headers: { cookie } }),
          bindings({ DB: racing }),
        )
      ).text();
      pages.push({ name: "create-raced (503)", body, distinctive: /Nearly there/ });
    }

    expect(pages.map((page) => page.name).sort()).toEqual(
      [
        "home",
        "robots",
        "not found",
        "sign-in",
        "sign-in error",
        "check inbox",
        "bad respond token",
        "bad leave token",
        "no player (403)",
        "dashboard",
        "passkeys",
        "link conflict (409)",
        "ambiguous email (500)",
        "email held by a guest (500)",
        "create-raced (503)",
        "cancel confirm",
        "cancel done",
        "game form",
        "game overview",
        "game edit",
        "owner fixture",
        "squad remove confirm",
        "invite",
        "join outcome",
      ].sort(),
    );

    /**
     * The three pages that are *allowed* a `<script>`, and why the assertion
     * below is not simply "no page has one" any more.
     *
     * Until M5 Task 8 this loop asserted `not.toContain("<script")` on every
     * page, which was the strongest available statement while the codebase
     * had no client JavaScript at all. Passkeys are a browser API, so that
     * became false for the two passkey pages — but deleting the assertion
     * would have given up the property it was really pinning, which is *not*
     * "there is no script" but **"script appears only where it is needed, in
     * a form a strict CSP can allow, and nothing depends on it"**. So it is
     * split three ways instead:
     *
     * - every page *not* named here must still contain no `<script` at all —
     *   the original assertion, unweakened, over eleven of the fourteen pages;
     * - every page named here must actually carry one (an enhancement that
     *   silently stopped shipping would otherwise pass);
     * - and every script that does ship must be a bare `<script>` tag whose
     *   text is a member of `SCRIPT_BLOCKS`, which is what M4's
     *   Content-Security-Policy will hash. That closes the hole the type
     *   system cannot see: `layout()`'s `pageScripts` is typed against the
     *   enumeration, but a page's `body` is a raw string and could carry a
     *   `<script>` nobody enumerated.
     *
     * Plus, below the loop, the property that makes "scripting disabled" a
     * single testable condition rather than a per-element question: no page
     * anywhere attaches behaviour through an inline handler attribute or a
     * `javascript:` URL, so removing the script blocks removes *all* of it.
     */
    const mayCarryScript = new Set(["sign-in", "sign-in error", "passkeys", "game overview"]);

    for (const { name, body, distinctive } of pages) {
      expect(body, `${name} must actually be that page`).toMatch(distinctive);
      expect(body, `${name} must not contain a password field`).not.toMatch(/type=.?password/i);

      const scripts = [...body.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)];

      if (!mayCarryScript.has(name)) {
        expect(body, `${name} must not need JavaScript`).not.toContain("<script");
        continue;
      }

      expect(scripts.length, `${name} must carry the passkey enhancement`).toBeGreaterThan(0);
      for (const [, attributes, js] of scripts) {
        // No `src` (unreachable under M4's `default-src 'none'`), no `type`,
        // no `nonce`: only a bare inline tag is covered by a SHA-256 hash of
        // its own text.
        expect(attributes, `${name}'s script tag must carry no attributes`).toBe("");
        expect(
          SCRIPT_BLOCKS as readonly string[],
          `${name} ships script that is not in SCRIPT_BLOCKS, so M4's CSP will not hash it`,
        ).toContain(js);
      }
    }

    for (const { name, body } of pages) {
      expect(body, `${name} must attach no inline event handler`).not.toMatch(/\son[a-z]+\s*=/i);
      expect(body, `${name} must contain no javascript: URL`).not.toMatch(/javascript:/i);
    }

    pinRoutesToPages(pages.map((page) => page.name));
  });
});

/**
 * Ties the enumeration above to what the app actually serves.
 *
 * The `capture(...)` list above is hand-maintained by page name — nothing
 * forces a new route to be added to it. Proved: adding
 * `app.get("/about", (c) => c.html("<script>window.sneak=1</script>"))` to
 * `src/app.ts` and re-running `signin.test.ts` + `scripts.test.ts` passed
 * 47/47 with the script sitting outside every guard above (M5 Task 8 review,
 * Important-2). So this walks Hono's own `app.routes` — the router's record
 * of what it actually dispatches, not what a comment says it dispatches — and
 * demands that every route be either named as the source of one of the
 * captured pages, or excluded here with a reason. A route that is neither
 * fails this function immediately, before it matters whether the route's body
 * has a `<script>` in it at all.
 *
 * `ALL`-method routes whose path ends `/*` are middleware mounts (the
 * site-wide header middleware, the two session mounts, and Better Auth's own
 * `/api/auth/*` sub-router) rather than page handlers, so they are filtered
 * out rather than enumerated: middleware renders no page of its own, and
 * `/api/auth/*` is the plugin's body to guard, not this app's — this project
 * never writes to it.
 */
function pinRoutesToPages(capturedPageNames: readonly string[]): void {
  const EXCLUDED_ROUTES: Readonly<Record<string, string>> = {
    "POST /r/:token":
      "renders through the same two functions as GET /r/:token — " +
      "renderFixtureForViewer or renderLinkProblemPage (src/routes/respond.ts) " +
      "— so it has no template of its own that could carry an un-enumerated " +
      "script; its own script/password assertion lives in " +
      "test/routes/respond-get.test.ts.",
    "POST /sign-out":
      "never returns HTML on any branch — a plain-text 403 or a 302 redirect " +
      "only (src/routes/signin.ts).",
    "POST /app":
      "never returns HTML on any branch — every outcome is a redirect or a " +
      "plain-text 400/403/404 (src/routes/dashboard.ts).",
    "POST /g/new":
      "renders through the same renderGameFormPage as GET /g/new on its only " +
      "HTML-returning branch (a rejected submission) — no template of its " +
      "own that could carry an un-enumerated script — and its other branches " +
      "are a plain-text 403 or a redirect (src/routes/games.ts); its own " +
      "script/password assertion lives in test/routes/games.test.ts.",
    "POST /g/:id/invite/rotate":
      "never returns HTML on any branch — a plain-text 403 (wrong origin), a " +
      "plain-text 404 (entitlement failure) or a 303 redirect only " +
      "(src/routes/games.ts); its own status-code coverage lives in " +
      "test/routes/games.test.ts.",
    "POST /g/:id/edit":
      "renders through the same renderGameFormPage as GET /g/:id/edit on its " +
      "only HTML-returning branch (a rejected submission) — no template of " +
      "its own that could carry an un-enumerated script — and its other " +
      "branches are a plain-text 403 (wrong origin), a plain-text 404 " +
      "(entitlement failure) or a 303 redirect (src/routes/games.ts); its own " +
      "script/password assertion lives in test/routes/games.test.ts.",
    "POST /g/:id/squad/:playerId/remove":
      "on its one HTML-returning branch (the last-organiser refusal) it renders " +
      "through the same renderGameOverviewPage as GET /g/:id — no template of " +
      "its own that could carry an un-enumerated script — and its other " +
      "branches are a plain-text 403 (wrong origin), a plain-text 404 " +
      "(entitlement failure) or a 303 redirect (src/routes/games.ts); its own " +
      "status-code coverage lives in test/routes/squad.test.ts.",
    "POST /g/:id/squad/:playerId/role":
      "on its one HTML-returning branch (the last-organiser refusal) it renders " +
      "through the same renderGameOverviewPage as GET /g/:id — no template of " +
      "its own that could carry an un-enumerated script — and its other " +
      "branches are a plain-text 400 (bad role), a plain-text 403 (wrong " +
      "origin), a plain-text 404 (entitlement failure) or a 303 redirect " +
      "(src/routes/games.ts); its own status-code coverage lives in " +
      "test/routes/squad.test.ts.",
    "POST /g/:id/f/:fixtureId/response/:playerId":
      "renders through the same renderOwnerFixturePage as GET /g/:id/f/:fixtureId on its " +
      "two HTML-returning branches (BR-8's over-capacity confirmation and the " +
      "fixture-not-open refusal) — no template of its own that could carry an " +
      "un-enumerated script — and its other branches are a plain-text 400 (bad intent), " +
      "a plain-text 403 (wrong origin), a plain-text 404 (entitlement failure) or a 303 " +
      "redirect (src/routes/games.ts); its own status-code coverage lives in " +
      "test/routes/owner-fixture.test.ts.",
  };

  const ROUTE_TO_PAGE: Readonly<Record<string, string>> = {
    "GET /robots.txt": "robots",
    "GET /": "home",
    "GET /r/:token": "bad respond token",
    "GET /leave/:token": "bad leave token",
    "GET /cancel/:token": "cancel confirm",
    "POST /cancel/:token": "cancel done",
    "GET /sign-in": "sign-in",
    "POST /sign-in": "check inbox",
    "GET /sign-in/complete": "link conflict (409)",
    "GET /app": "dashboard",
    "GET /app/passkeys": "passkeys",
    "GET /g/new": "game form",
    "GET /g/:id": "game overview",
    "GET /g/:id/edit": "game edit",
    "GET /g/:id/squad/:playerId/remove": "squad remove confirm",
    "GET /g/:id/f/:fixtureId": "owner fixture",
    "GET /j/:token": "invite",
    "POST /j/:token": "join outcome",
  };

  const registered = new Set(
    createApp()
      .routes.filter((route) => !(route.method === "ALL" && route.path.endsWith("/*")))
      .map((route) => `${route.method} ${route.path}`),
  );

  for (const key of registered) {
    if (key in EXCLUDED_ROUTES) continue;
    expect(
      ROUTE_TO_PAGE,
      `${key} is a registered route this enumeration does not know about — ` +
        "capture it as a page above, or add it to EXCLUDED_ROUTES with a reason",
    ).toHaveProperty(key);
    expect(
      capturedPageNames,
      `${key} claims coverage from a page named "${ROUTE_TO_PAGE[key]}" that was never captured`,
    ).toContain(ROUTE_TO_PAGE[key]);
  }

  // The reverse direction: a stale entry naming a route that no longer exists
  // would silently stop meaning anything.
  for (const key of [...Object.keys(ROUTE_TO_PAGE), ...Object.keys(EXCLUDED_ROUTES)]) {
    expect(registered.has(key), `${key} no longer exists as a registered route — remove it`).toBe(
      true,
    );
  }
}

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

  /**
   * The plugin runs `originCheck` over all three of `callbackURL`,
   * `errorCallbackURL` and `newUserCallbackURL`
   * (`better-auth/dist/plugins/magic-link/index.mjs:119-127`), and every one is
   * attacker-settable on the emailed URL — a stranger who intercepts or guesses
   * the link can rewrite the query string before a victim opens it. All three
   * must land the same way: a flat 403 with no `Location` and no `Set-Cookie`,
   * never a redirect off-site and never a session handed out alongside one.
   * Unconditional (no `if (location !== null)`) so a 500 or a route that
   * stopped existing would fail this test rather than pass it vacuously.
   */
  it.each(["callbackURL", "errorCallbackURL", "newUserCallbackURL"])(
    "refuses an off-origin %s a stranger puts on the verification link",
    async (param) => {
      const app = createApp();
      const { sent } = await askForLink(app, ALLOWED);
      const url = new URL(linkIn(sent));
      url.searchParams.set(param, "https://evil.test/steal");

      const response = await app.fetch(followLink(url.toString()), bindings());

      expect(response.status).toBe(403);
      expect(response.headers.get("location")).toBeNull();
      expect(response.headers.getSetCookie()).toEqual([]);
    },
  );
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

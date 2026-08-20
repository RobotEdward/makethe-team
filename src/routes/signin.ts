import { Hono } from "hono";
import { createAuth } from "../auth/factory.js";
import type { LinkPlayerResult } from "../auth/link-player.js";
import { linkPlayerOnSignIn } from "../auth/link-player.js";
import {
  AUTH_API_PREFIX,
  DASHBOARD_PATH,
  SIGN_IN_COMPLETE_PATH,
  SIGN_IN_PATH,
  SIGN_OUT_PATH,
} from "../auth/paths.js";
import { requireSession } from "../auth/session.js";
import { getDb } from "../db/client.js";
import type { AppEnv, Bindings } from "../env.js";
import { renderCheckInboxPage, renderLinkRefusalPage, renderSignInPage } from "../views/signin.js";

export const signIn = new Hono<AppEnv>();

/**
 * Better Auth's own endpoints, mounted whole.
 *
 * A pass-through and nothing more: the handler owns `/sign-in/magic-link`,
 * `/magic-link/verify`, `/sign-out` and the rest of its surface, and wrapping
 * any of them here would mean re-implementing checks (origin, token
 * consumption, cookie signing) that it already does correctly.
 *
 * `createAuth` is called per request with the request's own `db` handle, never
 * memoised and never handed a second Drizzle wrapper — see the deadlock note
 * on `createAuth` itself.
 *
 * The verification endpoint this exposes is **`GET /api/auth/magic-link/verify`**
 * (`AUTH_API_PREFIX` + the plugin's own `/magic-link/verify`). That path is the
 * plugin's, read out of `better-auth/plugins/magic-link`, not guessed: the
 * plugin builds the emailed URL itself from `baseURL` + `basePath` and there is
 * no option to move it.
 */
signIn.all(`${AUTH_API_PREFIX}/*`, (c) => {
  const now = new Date(Date.now());
  return createAuth(c.env, getDb(c.env.DB), now).handler(c.req.raw);
});

/**
 * The sign-in page.
 *
 * Bounces an already-signed-in visitor to the dashboard rather than offering
 * to sign them in again — which needs a resolved session on a path outside
 * `AUTHENTICATED_PREFIX`, hence the second `sessionMiddleware` mount in
 * `src/app.ts`.
 *
 * **No `?next=`.** Both destinations this flow can send someone to are fixed
 * constants, so there is no redirect target taken from the request anywhere in
 * this file, and therefore no open redirect to allowlist. Task 4 flagged
 * adding one as a surface to avoid, and nothing here needs it: the trial has a
 * single page behind sign-in. If a deep link back to where someone started is
 * ever wanted, it has to arrive as a path-only, same-origin value validated
 * before use, with the hostile forms (`//evil.test`, `https://evil.test`,
 * `/\evil.test`, backslashes and encoded variants) tested — do not add it
 * casually.
 */
signIn.get(SIGN_IN_PATH, (c) => {
  if (c.get("session")) return c.redirect(DASHBOARD_PATH, 302);

  // Presence, not content: nothing from the query string reaches the page.
  return c.html(
    renderSignInPage({
      linkFailed: c.req.query("error") !== undefined,
      signedOut: c.req.query("signed-out") !== undefined,
    }),
  );
});

/**
 * Ask for a sign-in link.
 *
 * **The response is the same page, always.** Not merely for an unknown address
 * versus a known one, but for an address that is not on the trial allowlist,
 * an address that is not an address, a missing field, a notifier that is on
 * fire, and a Better Auth that rejected the request outright. Task 3 proved
 * that property byte-for-byte at the endpoint; the whole job of this handler
 * is not to reintroduce a difference one layer up, which is why every branch
 * ends at the same `renderCheckInboxPage()` and nothing about the outcome is
 * ever read.
 *
 * The internal request is built here rather than forwarding the browser's, for
 * two reasons: the form posts urlencoded and the endpoint wants JSON, and the
 * `callbackURL`/`errorCallbackURL` are *this route's* decision, not this
 * page's visitor's. That claim is scoped to this handler only —
 * `POST /api/auth/sign-in/magic-link` is also reachable directly, mounted
 * whole by `signIn.all(`${AUTH_API_PREFIX}/*`, …)` above, and a third party
 * can post to it with any same-origin `callbackURL` they like (an off-origin
 * one is refused by Better Auth's own `originCheck`). The worst case is an
 * allowlisted victim's emailed link landing somewhere other than
 * `/sign-in/complete`, so linking never runs and they meet the no-Player 403
 * — an annoyance with a documented exit, not a takeover. Judged acceptable
 * rather than worth constraining; see `docs/known-issues.md`.
 * Its `origin` header is this deployment's own, which passes Better Auth's
 * form-CSRF check unconditionally. That is deliberate and not a hole: the only
 * effect a cross-site post could have is to email a sign-in link to an address
 * the attacker chose, which they can already do by posting here directly, and
 * no session is created or destroyed. (The link itself still has to be opened
 * from the recipient's inbox.)
 */
signIn.post(SIGN_IN_PATH, async (c) => {
  const now = new Date(Date.now());
  const email = await readEmailField(c.req.raw.clone());

  try {
    const auth = createAuth(c.env, getDb(c.env.DB), now);
    await auth.handler(
      new Request(new URL(`${AUTH_API_PREFIX}/sign-in/magic-link`, c.env.BETTER_AUTH_URL), {
        method: "POST",
        headers: { "content-type": "application/json", origin: originOf(c.env) },
        body: JSON.stringify({
          email,
          callbackURL: SIGN_IN_COMPLETE_PATH,
          errorCallbackURL: SIGN_IN_PATH,
        }),
      }),
    );
  } catch (error) {
    // Swallowed on purpose. A thrown error here would become the app's 500
    // page for whichever addresses happened to reach the failing branch, and a
    // 500 for some addresses and a 200 for others is the enumeration oracle
    // this whole flow exists to avoid. Never logs the address.
    console.error(
      `sign-in request failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
  }

  return c.html(renderCheckInboxPage());
});

/**
 * Read `email` out of the posted form without ever throwing.
 *
 * A missing field, a body that is not a form, a body that is not there at all
 * and a duplicated field must all answer the same page as a well-formed post,
 * so this returns a string in every case and lets Better Auth's own schema be
 * the thing that rejects nonsense — silently, on the far side of the identical
 * response.
 */
async function readEmailField(request: Request): Promise<string> {
  try {
    const form = await request.formData();
    const value = form.get("email");
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}

/**
 * Finish signing in: connect the authenticated identity to a domain Player.
 *
 * This is where Better Auth's `callbackURL` lands after a verification link is
 * opened, and it is a normal page rather than a step hidden inside the auth
 * handler for one reason: linking has six distinct refusal outcomes and four of
 * them need to say something different to a human. A redirect out of the
 * middleware could only ever carry an error code.
 *
 * Safe to re-open at any time: `linkPlayerOnSignIn` answers `already-linked`
 * for an identity that has a Player, so a bookmark, a double-click or a retry
 * after `create-raced` all end on the dashboard rather than creating anything.
 */
signIn.get(SIGN_IN_COMPLETE_PATH, requireSession, async (c) => {
  const now = new Date(Date.now());
  const { user } = c.get("session")!;

  const result = await linkPlayerOnSignIn(getDb(c.env.DB), {
    authUserId: user.id,
    // ---- The security boundary. ----
    // `verifiedEmail` is "the address the provider has itself verified", and
    // passing `user.email` unconditionally would make it "the address someone
    // typed" — which `linkPlayerOnSignIn` would then use to claim an existing
    // Player. That is account takeover by typing a colleague's address, so the
    // `emailVerified` flag gates it here, at the only call site, and the
    // unverified case becomes `null` (a Player of their own, claiming nothing)
    // rather than a match.
    verifiedEmail: user.emailVerified ? user.email : null,
    name: displayName(user),
    now,
  });

  switch (result.outcome) {
    // Three ways to have a Player, one destination.
    case "linked":
    case "already-linked":
    case "created":
      return c.redirect(DASHBOARD_PATH, 302);

    // Four refusals, one page (M20 B6) — see `renderLinkRefusalPage`.
    // `create-raced` is the retryable one and offers a retry; the other
    // three need a human and say which one, in the reason line.
    case "conflict":
    case "ambiguous-email":
    case "email-held-by-guest":
    case "create-raced": {
      // Logged without the address (this repo is public) but with the ids, so
      // the data problems above are actually findable. `create-raced` and
      // `conflict` are expected states rather than faults, so this is a
      // warning, not an error.
      console.warn(`sign-in could not link a player: ${result.outcome} ${playerIdsOf(result)}`);
      const { html, status } = renderLinkRefusalPage(result.outcome);
      return c.html(html, status);
    }
  }
});

/** The ids a refusal names, for the log line. Never the email address. */
function playerIdsOf(result: LinkPlayerResult): string {
  if ("playerIds" in result) return result.playerIds.join(",");
  if ("playerId" in result) return result.playerId;
  return "";
}

/**
 * The name a *newly created* Player gets (`linkPlayerOnSignIn` never renames
 * an existing one).
 *
 * Better Auth's magic-link sign-up sets `name` to `""` when the request did not
 * carry one, and this form never does, so in practice every new Player would
 * otherwise be nameless in their squad's list. The local part of their own
 * verified address is the best guess available and is something they typed
 * themselves; the constant is only for an address with nothing before the `@`,
 * which the provider's own validation makes unreachable.
 */
function displayName(user: { name: string; email: string }): string {
  const given = user.name.trim();
  if (given !== "") return given;
  const localPart = user.email.split("@")[0]?.trim() ?? "";
  return localPart === "" ? "New player" : localPart;
}

/**
 * End the session.
 *
 * `POST` only. There is deliberately no `GET` route on this path — not even
 * one that renders a confirmation — because the moment a sign-out is reachable
 * by `GET` it is reachable by every `<img src>`, prefetcher and link scanner
 * that touches a page, and a `GET` here would sign people out at random.
 *
 * Better Auth *does* origin-check `/api/auth/sign-out` router-wide
 * (`originCheckMiddleware`, installed on `/**` for every non-GET request) —
 * but this handler rebuilds the internal request with its own `origin` before
 * handing it to that endpoint (see `originOf(c.env)` below), which satisfies
 * Better Auth's check unconditionally and suppresses it on this path. That
 * rewrite is what makes this local check load-bearing, not an absence of one
 * upstream: a browser always sends `Origin` on a cross-site form post, so
 * refusing a mismatched one closes cross-site sign-out entirely. A missing
 * `Origin` is allowed through — that is a non-browser client acting on its own
 * behalf, which cannot be a cross-site request.
 *
 * The destination is the fixed sign-in page, never anything from the request:
 * see the `?next=` note on `GET /sign-in`.
 */
signIn.post(SIGN_OUT_PATH, async (c) => {
  const origin = c.req.header("origin");
  if (origin !== undefined && origin !== originOf(c.env)) {
    return c.text("Forbidden", 403);
  }

  const now = new Date(Date.now());
  const auth = createAuth(c.env, getDb(c.env.DB), now);
  const ended = await auth.handler(
    new Request(new URL(`${AUTH_API_PREFIX}/sign-out`, c.env.BETTER_AUTH_URL), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: originOf(c.env),
        // Forwarded verbatim and never read, logged or stored here: it is a
        // live credential, and this handler's only business with it is handing
        // it to the endpoint that revokes it.
        cookie: c.req.header("cookie") ?? "",
      },
      body: "{}",
    }),
  );

  const response = c.redirect(`${SIGN_IN_PATH}?signed-out`, 302);
  // The cookie-clearing `Set-Cookie` headers are the entire point of the call
  // above; without carrying them onto the redirect the browser would keep
  // sending a token that no longer resolves.
  for (const cookie of ended.headers.getSetCookie()) {
    response.headers.append("set-cookie", cookie);
  }
  return response;
});

/** This deployment's own origin, as Better Auth's checks compare it. */
function originOf(env: Bindings): string {
  return new URL(env.BETTER_AUTH_URL).origin;
}

import { SIGN_IN_COMPLETE_PATH, SIGN_IN_PATH } from "../auth/paths.js";
import { layout } from "./layout.js";
import { signOutForm } from "./sign-out-form.js";
import { PASSKEY_SIGN_IN_JS } from "./scripts.js";
import { PASSKEY_STYLES_CSS, SIGNIN_STYLES_CSS } from "./styles.js";

/**
 * What the sign-in page has to say beyond the form itself.
 *
 * Both are booleans rather than strings on purpose. The only things that can
 * set them arrive in the query string — `?error=` from Better Auth's own
 * verification failure redirect, `?signed-out` from this app's sign-out — and
 * a query string is attacker-controlled. Reducing them to booleans at the
 * boundary means nothing from the URL can reach the page at all, escaped or
 * otherwise, and the page cannot be turned into a billboard by a link someone
 * else sends.
 */
export interface SignInPageOptions {
  /** A verification link did not work: expired, already used, or unknown. */
  linkFailed: boolean;
  /** They arrived here by signing out, rather than by being turned away. */
  signedOut: boolean;
}

/**
 * The sign-in page: one email field, one button, no password field (TR-16).
 *
 * `type="email"` gets the right keyboard on a phone and a free format check in
 * the browser; `required` and `autocomplete="email"` are the rest of what a
 * no-JavaScript form can offer. Nothing here validates the address seriously —
 * `POST /sign-in` answers identically whatever is typed, deliberately, so
 * client-side strictness would only annoy people whose real address the
 * pattern disagreed with.
 *
 * **The email form is the baseline and it is complete on its own.** The
 * passkey block below it ships `hidden` and is revealed only by
 * `PASSKEY_SIGN_IN_JS`, which reveals nothing unless the browser has WebAuthn
 * — so with scripting off this page is byte-for-byte as usable as it was
 * before passkeys existed, minus an element nobody can see. Note there is no
 * `onclick` and no `javascript:` anywhere: all behaviour is attached by the
 * enumerated script or it does not exist, which is what makes "scripting off"
 * a single, testable condition.
 *
 * The passkey block goes *after* the form for the same reason: the thing that
 * always works is the thing that comes first.
 */
export function renderSignInPage({ linkFailed, signedOut }: SignInPageOptions): string {
  const notice = linkFailed
    ? `<p class="nudge">That sign-in link didn't work. It may have expired, or already been used — each one works once, for a few minutes. Enter your email address for a fresh one.</p>`
    : signedOut
      ? `<p class="nudge">You're signed out.</p>`
      : "";

  return layout({
    title: "Sign in — Make The Team",
    pageStyles: [SIGNIN_STYLES_CSS, PASSKEY_STYLES_CSS],
    pageScripts: [PASSKEY_SIGN_IN_JS],
    body: `
      <h1>Sign in</h1>
      <p>We'll email you a link that signs you in. Nothing to remember, nothing to set up.</p>
      ${notice}
      <form class="signin" method="post" action="${SIGN_IN_PATH}">
        <label for="email">Your email address</label>
        <input id="email" name="email" type="email" autocomplete="email" inputmode="email"
               autocapitalize="off" spellcheck="false" required autofocus>
        <button class="button primary" type="submit">Email me a sign-in link</button>
      </form>
      <div class="passkey" id="passkey" hidden>
        <p>Already added a passkey to this account?</p>
        <button class="button" type="button" id="passkey-button">Sign in with a passkey</button>
        <p class="nudge" id="passkey-problem" hidden></p>
      </div>
    `,
  });
}

/**
 * The one answer `POST /sign-in` ever gives.
 *
 * Takes no arguments, and that is the whole point: the response to a sign-in
 * request must be identical whether the address is unknown, known, on the
 * trial allowlist or not on it, and whether or not the email actually went
 * out. A parameter here — even a well-meant "we've emailed <address>" — is an
 * enumeration oracle, so there is nowhere for one to go.
 *
 * The wording is careful for the same reason: "if that address can sign in"
 * promises nothing about whether it can.
 */
export function renderCheckInboxPage(): string {
  return layout({
    title: "Check your inbox — Make The Team",
    body: `
      <h1>Check your inbox</h1>
      <p>If that address can sign in, a link is on its way. It works once, and it expires after a few minutes.</p>
      <p>Nothing arrived? Check your spam folder, then <a href="${SIGN_IN_PATH}">try again</a>.</p>
    `,
    centred: true,
  });
}

/**
 * Which refusal `linkPlayerOnSignIn` produced, in the terms a person needs.
 *
 * The four outcomes below are the ones a real person can land on, and they are
 * genuinely different situations: one is retryable, one needs them to use a
 * different address, and two need a human to repair data. Collapsing them into
 * one "something went wrong" page would leave three of those four people with
 * no idea what to do next.
 */
export type LinkRefusal = "conflict" | "ambiguous-email" | "email-held-by-guest" | "create-raced";

/**
 * The page for a refusal, and the status it is served with.
 *
 * Every one of them carries a sign-out button, because in three of the four
 * cases the person is signed in as an identity that cannot get any further,
 * and signing out with a different address is either the fix or the only way
 * to stop being stuck.
 */
export function renderLinkRefusalPage(refusal: LinkRefusal): { html: string; status: 409 | 500 | 503 } {
  switch (refusal) {
    case "conflict":
      return {
        status: 409,
        html: layout({
          title: "That email is already in use — Make The Team",
          body: `
            <h1>That email is already in use</h1>
            <p>Your player already belongs to a different sign-in. We won't move it across automatically — that is exactly what it would look like if someone else were trying to take the account over.</p>
            <p>Sign in the way you did the first time, or ask whoever organises your game to sort it out.</p>
            ${signOutForm("Sign out and try a different address")}
            <p><a href="/">Back to Make The Team</a></p>
          `,
          centred: true,
        }),
      };

    case "ambiguous-email":
      return {
        status: 500,
        html: layout({
          title: "We need a hand with your record — Make The Team",
          body: `
            <h1>We need a hand with your record</h1>
            <p>Your email address appears on more than one player, and we can't tell which one is you. Picking one at random is not something we're willing to do with your account.</p>
            <p>Ask whoever organises your game to remove the duplicate, then sign in again.</p>
            ${signOutForm("Sign out and try a different address")}
            <p><a href="/">Back to Make The Team</a></p>
          `,
          centred: true,
        }),
      };

    case "email-held-by-guest":
      return {
        status: 500,
        html: layout({
          title: "We need a hand with your record — Make The Team",
          body: `
            <h1>We need a hand with your record</h1>
            <p>Your email address is attached to a guest entry — someone an organiser added by hand. Guest entries aren't accounts, so we can't sign you in as one.</p>
            <p>Ask whoever organises your game to turn it into a proper player, then sign in again.</p>
            ${signOutForm("Sign out and try a different address")}
            <p><a href="/">Back to Make The Team</a></p>
          `,
          centred: true,
        }),
      };

    case "create-raced":
      return {
        status: 503,
        html: layout({
          title: "Nearly there — Make The Team",
          body: `
            <h1>Nearly there</h1>
            <p>You're signed in, but something else was changing your record at the same moment and we backed off rather than guess. Nothing is broken and nothing was lost.</p>
            <p><a href="${SIGN_IN_COMPLETE_PATH}">Try again</a> — it should go through this time.</p>
            ${signOutForm()}
          `,
          centred: true,
        }),
      };
  }
}

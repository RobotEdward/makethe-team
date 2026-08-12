import { AUTH_API_PREFIX, PASSKEYS_PATH, SIGN_IN_COMPLETE_PATH } from "../auth/paths.js";

/**
 * Every line of client-side JavaScript this app can emit, in one place.
 *
 * # Why there is any at all
 *
 * There was none until M5 Task 8, and the bar for adding some is high: the
 * rule is a guideline rather than an absolute, but JavaScript has to *earn*
 * its place. WebAuthn earns it on the only ground that counts — it is a
 * browser API (`navigator.credentials`), and there is no server-side
 * substitute for it at any price. Passkeys are therefore an **enhancement**
 * and the magic link stays the baseline: every page below is fully usable
 * with scripting off, and the passkey affordance simply is not present. Each
 * block starts by feature-detecting and returns without touching the page if
 * anything it needs is missing, so "scripting off" and "scripting on, no
 * WebAuthn" are the same experience.
 *
 * # Why they are enumerated rather than written at the call site
 *
 * Exactly the argument `src/views/styles.ts` makes for `<style>` blocks, and
 * with sharper teeth. M4 shipped a Content-Security-Policy containing
 * **`script-src 'none'`**, set deliberately on the stated grounds that this
 * site had no client JavaScript at all. Adding these blocks made that false,
 * and `src/security/csp.ts` now emits `script-src` as the SHA-256 hash of
 * every entry in `SCRIPT_BLOCKS` below, computed at runtime from these
 * exported constants — never pasted, so the header cannot go stale. Not
 * `'unsafe-inline'` and not `'unsafe-hashes'`: these are plain inline
 * `<script>` elements, which a bare hash covers. `test/views/scripts.test.ts`
 * fails the moment `src/security/csp.ts` stops naming `SCRIPT_BLOCKS`.
 *
 * # A hash lets a script run. It does not let it do anything.
 *
 * **Read this before adding a block that talks to the network.** `script-src`
 * governs execution and nothing else. Every *other* thing a script might do
 * is a separate directive, and any directive the header does not name falls
 * back to `default-src` — which is `'none'`. That is not a theoretical
 * hazard: these two blocks shipped to production able to run and unable to
 * `fetch` anything, because the header named no `connect-src`. Both passkey
 * buttons revealed themselves and then failed on every browser, and no
 * request ever reached the Worker, so nothing server-side could have caught
 * it (post-mortem in `docs/known-issues.md`).
 *
 * `connect-src 'self'` now covers the `fetch` calls, and
 * `test/security/csp.test.ts` reads the `fetch("…")` targets straight out of
 * `SCRIPT_BLOCKS` and asserts each one is a same-origin absolute path the
 * directive permits. A new block that fetches a *new* same-origin path is
 * therefore already covered. A block that needs anything else — an image, a
 * web font, a worker, a WebSocket to another host — needs its own directive
 * added to `src/security/csp.ts` and its own assertion, and will otherwise
 * fail exactly as silently as this one did.
 *
 * Inline and same-origin only. `default-src 'none'` forbids external hosts
 * and there is no CDN in this project, so nothing here may grow a `src=`
 * attribute or fetch anything off-origin.
 *
 * A block that exists but was never added to `PAGE_SCRIPT_BLOCKS` fails to
 * *compile* at the `layout()` call site (`pageScripts` is typed
 * `PageScriptBlock`), and a `<script>` smuggled directly into a page's `body`
 * string — which the type cannot see — fails
 * `test/routes/signin.test.ts`'s page enumeration, which checks every
 * script on every reachable page against `SCRIPT_BLOCKS`.
 */

/**
 * Sign in with a passkey, from the sign-in page.
 *
 * The affordance ships `hidden` and this reveals it, so a browser that never
 * runs this — scripting off, an old browser, a CSP that blocks it — shows a
 * page identical to the one before passkeys existed. Feature detection is
 * total: no `PublicKeyCredential`, no JSON serialisation helpers, no
 * `navigator.credentials.get`, and the button stays hidden rather than
 * appearing and failing.
 *
 * `PublicKeyCredential.parseRequestOptionsFromJSON` / `credential.toJSON()`
 * are used instead of hand-rolled base64url conversion, and instead of
 * `@simplewebauthn/browser`: an external script is unreachable under
 * `default-src 'none'`, and a bundled one could not be hashed from source the
 * way `SCRIPT_BLOCKS` requires. A browser too old for those two methods is a
 * browser that keeps the magic link, which is exactly the intended fallback.
 *
 * Lands on `/sign-in/complete` rather than the dashboard: verification mints
 * the session, and that page is what connects the session to a domain Player
 * (and renders the four refusals when it can't). Skipping it would give a
 * passkey holder a session with no Player and the 403.
 *
 * The failure message is deliberately generic and nothing from the error is
 * shown or logged — a WebAuthn error can name a credential id, and this page
 * is reachable by anyone.
 */
export const PASSKEY_SIGN_IN_JS = `
(function () {
  var section = document.getElementById("passkey");
  var button = document.getElementById("passkey-button");
  var problem = document.getElementById("passkey-problem");
  if (!section || !button || !problem) return;
  if (typeof window.PublicKeyCredential !== "function") return;
  if (typeof window.PublicKeyCredential.parseRequestOptionsFromJSON !== "function") return;
  if (typeof window.PublicKeyCredential.prototype.toJSON !== "function") return;
  if (!navigator.credentials || typeof navigator.credentials.get !== "function") return;

  section.hidden = false;

  button.addEventListener("click", function () {
    problem.hidden = true;
    button.disabled = true;
    fetch("${AUTH_API_PREFIX}/passkey/generate-authenticate-options", {
      credentials: "same-origin",
      headers: { accept: "application/json" }
    }).then(function (response) {
      if (!response.ok) throw new Error("options");
      return response.json();
    }).then(function (options) {
      return navigator.credentials.get({
        publicKey: window.PublicKeyCredential.parseRequestOptionsFromJSON(options)
      });
    }).then(function (credential) {
      if (!credential) throw new Error("cancelled");
      return fetch("${AUTH_API_PREFIX}/passkey/verify-authentication", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ response: credential.toJSON() })
      });
    }).then(function (response) {
      if (!response.ok) throw new Error("verify");
      window.location.assign("${SIGN_IN_COMPLETE_PATH}");
    }).catch(function () {
      problem.textContent = "That passkey didn't work. Ask for an email link instead.";
      problem.hidden = false;
      button.disabled = false;
    });
  });
})();
`;

/**
 * Add a passkey, from `/app/passkeys`.
 *
 * The mirror image of the block above, and the same discipline: the button
 * ships `hidden`, the page explains itself without it, and the list of
 * passkeys already registered is server-rendered so the page says something
 * true even when this never runs.
 *
 * Registration is gated on an existing session by the *server*
 * (`registration.requireSession` in `src/auth/factory.ts`, plus
 * `requirePlayer` on the page) — nothing here is a check, and this script
 * could be replayed by hand with no session and get a 401 from Better Auth.
 *
 * Reloads rather than appending a row on success, so the list a player sees
 * is always the one in the database rather than this script's guess at it.
 */
export const PASSKEY_REGISTER_JS = `
(function () {
  var section = document.getElementById("passkey-add");
  var button = document.getElementById("passkey-add-button");
  var problem = document.getElementById("passkey-problem");
  if (!section || !button || !problem) return;
  if (typeof window.PublicKeyCredential !== "function") return;
  if (typeof window.PublicKeyCredential.parseCreationOptionsFromJSON !== "function") return;
  if (typeof window.PublicKeyCredential.prototype.toJSON !== "function") return;
  if (!navigator.credentials || typeof navigator.credentials.create !== "function") return;

  section.hidden = false;

  button.addEventListener("click", function () {
    problem.hidden = true;
    button.disabled = true;
    fetch("${AUTH_API_PREFIX}/passkey/generate-register-options", {
      credentials: "same-origin",
      headers: { accept: "application/json" }
    }).then(function (response) {
      if (!response.ok) throw new Error("options");
      return response.json();
    }).then(function (options) {
      return navigator.credentials.create({
        publicKey: window.PublicKeyCredential.parseCreationOptionsFromJSON(options)
      });
    }).then(function (credential) {
      if (!credential) throw new Error("cancelled");
      return fetch("${AUTH_API_PREFIX}/passkey/verify-registration", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ response: credential.toJSON() })
      });
    }).then(function (response) {
      if (!response.ok) throw new Error("verify");
      window.location.assign("${PASSKEYS_PATH}");
    }).catch(function () {
      problem.textContent = "That didn't work. Nothing was saved — you can try again.";
      problem.hidden = false;
      button.disabled = false;
    });
  });
})();
`;

/**
 * Copy the invite link to the clipboard, from `/g/:id`.
 *
 * The first script in this project that is pure convenience rather than a
 * browser-only capability, and it earns its place on the terms the module
 * comment sets: the page is complete without it. The link renders in a
 * `readonly` input that can be selected and copied by hand, and this only
 * adds a button beside it. Scripting off, or an old browser without
 * `navigator.clipboard`, is the same page minus one button.
 *
 * No `fetch`, so it adds nothing to `connect-src`. If a future version of this
 * block ever does talk to the network, re-read the "a hash lets a script run"
 * section above first.
 */
export const COPY_INVITE_JS = `
(function () {
  var input = document.getElementById("invite-url");
  var button = document.getElementById("invite-copy");
  if (!input || !button) return;
  if (!navigator.clipboard || typeof navigator.clipboard.writeText !== "function") return;

  button.hidden = false;

  button.addEventListener("click", function () {
    navigator.clipboard.writeText(input.value).then(function () {
      var original = button.textContent;
      button.textContent = "Copied";
      setTimeout(function () { button.textContent = original; }, 2000);
    }).catch(function () {
      // The input is still there and still selectable — say so rather than
      // failing silently, which is the diagnosability lesson from the passkey
      // scripts' bare .catch() (docs/known-issues.md).
      button.textContent = "Press and hold to copy";
    });
  });
})();
`;

/**
 * Every page-specific script, for `layout()`'s `pageScripts` parameter to be
 * typed against. See the module comment for what enforces membership.
 */
export const PAGE_SCRIPT_BLOCKS = [PASSKEY_SIGN_IN_JS, PASSKEY_REGISTER_JS, COPY_INVITE_JS] as const;

export type PageScriptBlock = (typeof PAGE_SCRIPT_BLOCKS)[number];

/**
 * The complete set of `<script>` blocks the app can ever emit. Unlike
 * `STYLE_BLOCKS` there is no site-wide member: nothing runs on a page that
 * did not ask for it, and no page asks for script unless passkeys need it.
 *
 * **This is the value a CSP's `script-src` hashing must map over** — see the
 * module comment for the exact change M4's `src/security/csp.ts` has to make.
 */
export const SCRIPT_BLOCKS = [...PAGE_SCRIPT_BLOCKS] as const;

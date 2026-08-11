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
 * with sharper teeth. The sibling **M4** branch (unmerged as of this file)
 * ships a Content-Security-Policy containing **`script-src 'none'`**, set
 * deliberately on the stated grounds that this site had no client JavaScript
 * at all. That is no longer true. Once the branches merge,
 * **`src/security/csp.ts` must do two things**:
 *
 * 1. Emit `script-src` as the SHA-256 hashes of every entry in
 *    `SCRIPT_BLOCKS` below (`'sha256-…' 'sha256-…'`), computed at runtime from
 *    these exported constants exactly as it already computes `style-src`
 *    hashes — never pasted, so the header cannot go stale. Not
 *    `'unsafe-inline'`, and not `'unsafe-hashes'`: these are plain inline
 *    `<script>` elements, which a bare hash covers.
 * 2. Switch its two hardcoded style imports to mapping `STYLE_BLOCKS` from
 *    `src/views/styles.ts` — the instruction Task 7 already left there, now
 *    with a second reason to act on it.
 *
 * Until that happens, `script-src 'none'` will drop these scripts outright
 * and the passkey buttons will silently never appear. `test/views/scripts.test.ts`
 * turns that from a comment someone might not read into a **failing test the
 * moment `src/security/csp.ts` exists without naming `SCRIPT_BLOCKS`** — a
 * comment on this branch cannot fire, and this project has already had to
 * upgrade one merge marker to a tripwire for precisely that reason.
 *
 * Inline and same-origin only. M4's `default-src 'none'` forbids external
 * hosts and there is no CDN in this project, so nothing here may grow a
 * `src=` attribute or fetch anything off-origin.
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
 * Every page-specific script, for `layout()`'s `pageScripts` parameter to be
 * typed against. See the module comment for what enforces membership.
 */
export const PAGE_SCRIPT_BLOCKS = [PASSKEY_SIGN_IN_JS, PASSKEY_REGISTER_JS] as const;

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

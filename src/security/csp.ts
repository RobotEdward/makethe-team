import { SCRIPT_BLOCKS } from "../views/scripts.js";
import { STYLE_BLOCKS } from "../views/styles.js";

/**
 * The two hosts M10's typeface needs, and the only external origins any page
 * is allowed to touch.
 *
 * Exported so `test/security/csp.test.ts` asserts on exactly these rather than
 * on a pasted string, and so the test can prove the policy is no *wider* than
 * this — a `font-src https:` would satisfy "the fonts load" and give away the
 * whole point of having the directive.
 *
 * Adopted over an objection recorded in the M10 spec §2.4: every page load now
 * discloses the visitor's IP to Google. `/privacy` must say so, and
 * `docs/known-issues.md` carries it on the list that page is written from.
 */
export const FONT_ORIGINS = ["https://fonts.googleapis.com", "https://fonts.gstatic.com"] as const;

/**
 * `Content-Security-Policy` for every page this Worker serves (BR-14 /
 * Task 7 finally justifies it — see `docs/known-issues.md`, which deferred
 * this to "M4, alongside the next page that takes user input").
 *
 * This only governs HTTP responses from `src/app.ts`. Nothing here touches
 * `src/notify/templates/*`: those render email HTML, delivered through a
 * provider (Resend) to mail clients that need their inline styles to work
 * and that never see this header — a CSP is meaningless there and is not
 * applied.
 *
 * Every directive is deliberate:
 *
 * - `default-src 'none'` — the strictest possible baseline. Nothing is
 *   fetched, embedded, connected to, or executed unless a more specific
 *   directive below allows it.
 * - `script-src` — hashes, one per entry in `SCRIPT_BLOCKS`. This was
 *   `'none'` until M5 added passkeys, on the grounds that the whole site is
 *   server-rendered; WebAuthn is a browser API with no server-side
 *   substitute, so it is the one feature that earns client JavaScript.
 * - `connect-src 'self'` — what the passkey scripts do *after* they are
 *   allowed to run. A `script-src` hash permits execution and nothing more;
 *   `connect-src` governs `fetch`/XHR/WebSocket separately and, like every
 *   directive that is simply absent, falls back to `default-src` — which
 *   here is `'none'`. Leaving it out is why both passkey buttons failed in
 *   production while every server-side test passed: the browser refused the
 *   `fetch` to Better Auth's endpoints before it left the device, so the
 *   scripts hit their generic catch and the Worker logged no request at all.
 *   `'self'` is exactly right and must not be widened — every URL these
 *   scripts call is a same-origin absolute path, which
 *   `test/security/csp.test.ts` asserts by reading the calls out of
 *   `SCRIPT_BLOCKS` rather than trusting this comment.
 * - `style-src` — the one directive a naive `default-src 'self'` breaks:
 *   every page inlines a `<style>` block (`STYLES` in
 *   `src/views/layout.ts`), and the cancellation-confirm page inlines a
 *   second one (`CANCEL_STYLES_CSS` in `src/views/cancel.ts`). Allowed by
 *   **hash**, not `'unsafe-inline'` and not a nonce:
 *     - `'unsafe-inline'` would defeat the point of having a style-src at
 *       all for the one kind of content this site actually inlines.
 *     - A nonce needs a fresh value generated per request and threaded
 *       through every `layout()` call (and, separately, through
 *       `renderCancelConfirmPage`) — real plumbing for content that never
 *       changes per-request.
 *     - A hash of a *pasted* string would silently go stale the next time
 *       either stylesheet changes. Both hashes below are computed from the
 *       same exported constants the pages actually render, so they can
 *       never drift from what ships — the CSP changes automatically the
 *       moment the CSS does, with no manual step to forget.
 *   M10 also allows `FONT_ORIGINS[0]` (`https://fonts.googleapis.com`) by
 *   **host**: the Google Fonts stylesheet is external and cannot be hashed,
 *   so it is named by origin instead, while every inline block above stays
 *   hash-allowed and nothing wider is opened.
 * - `font-src` — `FONT_ORIGINS[1]` (`https://fonts.gstatic.com`), where the
 *   font *files* the stylesheet references actually live. This does **not**
 *   fall back to `default-src` and must be named explicitly, or the
 *   stylesheet loads fine and every font file is then refused — a failure
 *   mode indistinguishable from "the CSS works" until the fallback stack
 *   appears on screen.
 * - `form-action 'self'` — both forms this site has (`POST /r/:token`,
 *   `POST /cancel/:token`) submit to a same-origin relative path. Neither
 *   `default-src` nor `style-src`'s allowance covers this directive; it does
 *   not fall back to `default-src` and must be named explicitly.
 * - `frame-ancestors 'none'` — nothing about this product is meant to be
 *   embedded; deny framing outright. Also does not fall back to
 *   `default-src` and must be named explicitly.
 * - `base-uri 'none'` — no page has any legitimate use for a `<base>`
 *   element; closing this off costs nothing. Also does not fall back to
 *   `default-src`.
 */

async function sha256Base64(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return btoa(String.fromCharCode(...new Uint8Array(digest)));
}

let cached: Promise<string> | undefined;

/**
 * Builds (and caches, for the lifetime of the isolate) the full header
 * value. Async because hashing is async — cheap enough, and done once, not
 * once per request.
 */
export function cspHeader(): Promise<string> {
  cached ??= buildCspHeader();
  return cached;
}

async function buildCspHeader(): Promise<string> {
  // Mapped over the two enumerations rather than naming blocks individually.
  // M5 split the single stylesheet into six blocks and added the first two
  // client scripts; a hardcoded pair of style hashes would have silently
  // dropped most of the site's CSS, and `script-src 'none'` would have blocked
  // passkeys outright. `STYLE_BLOCKS` and `SCRIPT_BLOCKS` are the complete
  // sets, and their element types are literal unions, so a block that is not
  // enumerated cannot reach `layout()` in the first place — which is what
  // keeps this hashing exhaustive without anyone having to remember it.
  const [styleHashes, scriptHashes] = await Promise.all([
    Promise.all(STYLE_BLOCKS.map(sha256Base64)),
    Promise.all(SCRIPT_BLOCKS.map(sha256Base64)),
  ]);

  const sources = (hashes: string[]) => hashes.map((hash) => `'sha256-${hash}'`).join(" ");

  return [
    "default-src 'none'",
    `style-src ${sources(styleHashes)} ${FONT_ORIGINS[0]}`,
    // Does not fall back to default-src — see the header comment.
    `font-src ${FONT_ORIGINS[1]}`,
    // Not 'none' any more, and deliberately not 'unsafe-inline': passkeys are
    // the one feature that cannot work server-side (WebAuthn is a browser
    // API), so their two scripts are allowed by hash and nothing else is.
    `script-src ${sources(scriptHashes)}`,
    // The scripts' whole purpose. Without this they execute and then cannot
    // reach a single endpoint — see the header comment.
    "connect-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join("; ");
}

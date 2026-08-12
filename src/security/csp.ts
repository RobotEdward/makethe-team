import { SCRIPT_BLOCKS } from "../views/scripts.js";
import { STYLE_BLOCKS } from "../views/styles.js";

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
 * - `script-src 'none'` — the whole site is server-rendered with no client
 *   JavaScript (a hard rule for this project, not an oversight), so this is
 *   free to be maximally strict rather than merely `'self'`.
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
    `style-src ${sources(styleHashes)}`,
    // Not 'none' any more, and deliberately not 'unsafe-inline': passkeys are
    // the one feature that cannot work server-side (WebAuthn is a browser
    // API), so their two scripts are allowed by hash and nothing else is.
    `script-src ${sources(scriptHashes)}`,
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join("; ");
}

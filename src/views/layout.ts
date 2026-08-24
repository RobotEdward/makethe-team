import {
  ACCOUNT_PATH,
  ADMIN_PATH,
  APPLE_TOUCH_ICON_PATH,
  DASHBOARD_PATH,
  MANIFEST_PATH,
} from "../auth/paths.js";
import { PRESENCE_JS, SERVICE_WORKER_JS, type PageScriptBlock } from "./scripts.js";
import type { PageStyleBlock } from "./styles.js";

/** The three destinations the signed-in header offers. */
export type NavSection = "games" | "account" | "admin";

/**
 * The signed-in page header's inputs (M16).
 *
 * `isAdmin` is display only — it decides whether the Admin link is *drawn*,
 * never whether the screen behind it answers. The admin handlers re-ask
 * `user.is_admin` fresh on every request (TR-18), so a stale or forged nav
 * flag can render a link and nothing more.
 */
export interface PageNav {
  isAdmin: boolean;
  current: NavSection;
}

export interface LayoutOptions {
  title: string;
  body: string;
  /**
   * Render the signed-in header above `main`. Absent means no header at all —
   * which is the whole mechanism keeping it off the public and token-link
   * pages: their visitors often hold no session, and a "Games" link that
   * bounces to sign-in is worse than no link. Only session-bearing pages
   * (`/app/*`, `/g/*`) pass this.
   */
  nav?: PageNav;
  /**
   * CSS beyond the shared primitives below, specific to this page alone.
   * Zero, one, or more blocks — the dashboard, for instance, passes both the
   * fixture-display block it reuses and its own on top (`src/views/styles.ts`).
   * Each renders as its own `<style>` tag.
   *
   * Typed against `PageStyleBlock` — the union of blocks listed in
   * `PAGE_STYLE_BLOCKS` in `src/views/styles.ts` — so passing anything not
   * enumerated there fails to compile. See that file's module comment for
   * why: the sibling M4 branch hashes exactly that enumeration for its CSP,
   * and an un-enumerated block ships CSS the browser will silently drop
   * under it.
   */
  pageStyles?: readonly PageStyleBlock[];
  /**
   * Client-side JavaScript for this page alone. **Almost every page should
   * leave this unset** — see `PAGE_SCRIPT_BLOCKS` in `src/views/scripts.ts`
   * for the current, authoritative list of what exists; naming them here too
   * is exactly the kind of second list that goes stale the next time one is
   * added or removed (as this comment's own history shows: it named two of
   * the four current blocks after M9 Task 7 added a third). A page that sets
   * this must still be completely usable when the script never runs (see
   * `src/views/scripts.ts` for the whole argument).
   *
   * That "almost every page" is about *this* parameter only. `layout()` also
   * emits `SERVICE_WORKER_JS` on every single page (M13), but not through
   * here: registering the service worker is an app-wide job, not something
   * any one page opts into, so it is never passed as a `pageScripts` entry —
   * see that constant's own comment in `src/views/scripts.ts`.
   *
   * Typed against `PageScriptBlock` — the union of blocks listed in
   * `PAGE_SCRIPT_BLOCKS` — for the same reason `pageStyles` is: M4's
   * Content-Security-Policy will allow inline script by SHA-256 hash of that
   * enumeration, so an un-enumerated block is script the browser silently
   * drops. Passing anything not enumerated fails to compile.
   */
  pageScripts?: readonly PageScriptBlock[];
  /**
   * Centre this page's content. The default is left (see `main` in `STYLES`).
   *
   * True only for pages that say one thing and offer nothing to scan: the
   * holding page, a link problem, and the terminal cancellation pages. A page
   * with a form, a list, or more than about three sentences is left-aligned,
   * because centred prose wraps ragged and centred controls have no shared
   * edge to follow.
   */
  centred?: boolean;
}

/**
 * The colour the OS chrome around this app is painted: the browser's address
 * bar, the task switcher card, and the manifest's `theme_color` once
 * installed (M13). One export rather than two independently pasted literals
 * — `src/routes/pwa.ts`'s manifest imports this rather than carrying its own
 * copy — because a mismatch between the two is exactly the failure this
 * constant exists to rule out: one colour in the task switcher and another
 * in the browser chrome, on the same app (see the test in
 * `test/views/layout.test.ts` this backs).
 *
 * Equal to `STYLES`' light-mode `--accent` below, but not derived from it:
 * `--accent` is inside a template literal, dark-mode included, and the
 * `theme-color` meta tag and the manifest both take one static value with no
 * light/dark split of their own — there is no single light-mode substring to
 * extract from `STYLES` that would be less fragile than stating the value
 * once, here, and having both `STYLES` and this constant agree on it.
 */
export const THEME_COLOR = "#c67139";

/**
 * Shared primitives only: tokens, reset, body/typography, and the handful of
 * controls (buttons, the sign-out form, the generic notice box) reused
 * across otherwise-unrelated pages. Everything specific to one page or one
 * family of pages lives in `src/views/styles.ts` instead and is passed in
 * via `pageStyles` — see `LayoutOptions.pageStyles` above for why that split
 * is enforced, not just conventional.
 *
 * Exported because `src/security/csp.ts` hashes its exact content for
 * `style-src` rather than carrying a pasted value, so the hash can never
 * drift from what actually ships. It is one member of `STYLE_BLOCKS` in
 * `src/views/styles.ts`; the CSP must hash every member, not just this one.
 *
 * The light-mode `--accent` below is interpolated from `THEME_COLOR` rather
 * than a second pasted `#c67139` — see that constant's own comment for why
 * a third literal here would be exactly the drift risk it exists to close
 * off. The dark-mode `--accent` a few lines down stays its own literal:
 * `THEME_COLOR` is deliberately the one value the OS chrome and the
 * manifest use with no light/dark split of their own, so there is nothing
 * for a *second* theme colour to derive from.
 */
export const STYLES = `
  :root {
    color-scheme: light dark;
    --fg: #201e1d; --bg: #efe3cd;
    --card: #f5ead8; --card-raised: #f9f4ed; --field: #ebddc5;
    /* Contrast floors for every pair are enforced by test/views/contrast.test.ts. */
    --mut: #645c50; --line: #d6c9b3;
    --accent: ${THEME_COLOR}; --accent-fg: #fff7f0; --accent-mut: #ffe1d0;
    --link: #8c491a;
    --ok: #8fa073; --ok-bg: #e1eecc; --ok-fg: #3d472b;
    --warn: #8a4c14; --warn-bg: #ffe1d0;
    --wait: #f6a06b; --wait-fg: #402310;
    /* Irreversible actions only — call off, remove, leave, erase. Never used
       for anything a person can undo. --warn used to carry both this and
       "unsettled", which is why the three genuinely irreversible buttons in
       the product were styled as neither. See the M10 spec §2.1. */
    --danger: #a4321f; --danger-fg: #fbfaf8;
    --t-title: 2rem; --t-lead: 1.25rem; --t-body: 1rem; --t-support: 0.875rem;
    --mono: "IBM Plex Mono", ui-monospace, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --fg: #ede5d8; --bg: #221f1b;
      --card: #2b2721; --card-raised: #322d26; --field: #3a342b;
      --mut: #a89e8f; --line: #3a352d;
      --accent: #d98a55; --accent-fg: #2a1608; --accent-mut: #3a2818;
      --link: #e0a878;
      --ok: #a3b585; --ok-bg: #2c3320; --ok-fg: #cfe0b0;
      --warn: #f0b285; --warn-bg: #43301f;
      --wait: #f6a06b; --wait-fg: #402310;
      --danger: #e8705a; --danger-fg: #1a0d0a;
    }
  }
  * { box-sizing: border-box; }
  /* The passkey affordances ship hidden and are revealed by script.
     display:none is only the UA default, so a later display:flex on the same
     element would silently un-hide it and show a button to someone whose
     browser cannot use it. This makes the attribute mean what it says. */
  [hidden] { display: none !important; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    padding: 2rem 1.25rem; background: var(--bg); color: var(--fg);
    font: var(--t-body)/1.6 "Figtree", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  /* Left by default. Centring is opt-in via centred on layout(), for pages
     that are a single statement and nothing else. Until M10 the default was
     centre and FORM_CSS overrode it back, so the product ran in two
     alignments at once — the design review's finding 6. */
  main { max-width: 30rem; width: 100%; text-align: left; }
  main.centred { text-align: center; }
  /* The signed-in header (M16). Shares main's 30rem column so the name and
     the page's own content keep one left edge. */
  /* Two rows, not the default equal split: the header's row hugs its content
     at the top and main centres in what remains — without this the grid gives
     each row half the viewport and the header floats mid-air on short pages. */
  body.with-header { grid-template-rows: auto 1fr; }
  .site-header {
    width: 100%; max-width: 30rem;
    display: flex; align-items: center; justify-content: space-between; gap: 1rem;
    border-bottom: 1px solid var(--line); margin-bottom: 1.5rem;
  }
  .site-header .site-name {
    color: var(--fg); font-weight: 700; text-decoration: none;
    display: inline-flex; align-items: center; min-height: 44px;
  }
  .site-header nav { display: flex; gap: 1.1rem; }
  /* min-height 44px: the link's whole padded box is the tap target — a bare
     text link is ~20px, well under the phone floor the buttons obey. */
  .site-header nav a {
    color: var(--mut); text-decoration: none; font-weight: 500;
    display: inline-flex; align-items: center; min-height: 44px;
  }
  .site-header nav a[aria-current="page"] {
    color: var(--fg); font-weight: 600;
    text-decoration: underline; text-decoration-color: var(--accent);
    text-decoration-thickness: 2px; text-underline-offset: 0.4em;
  }
  h1 { font-family: "Caprasimo", "Figtree", serif; font-weight: 400; font-size: var(--t-title); letter-spacing: 0; margin: 0 0 0.5rem; }
  h2 { font-family: "Caprasimo", "Figtree", serif; font-weight: 400; font-size: var(--t-lead); margin: 2rem 0 0.6rem; }
  p { color: var(--mut); margin: 0; }
  a { color: var(--link); }
  .danger-link { color: var(--danger); font-weight: 600; }

  /* A label for a control whose meaning is obvious to a sighted reader from
     the row it sits in, and invisible to a screen reader without this.
     Clipped rather than display:none or the hidden attribute, both of which
     take the text out of the accessibility tree as well as off the screen,
     leaving the control with no name at all. A global primitive, beside
     .nudge below: a page that forgot to load a block defining it would render
     the label as ordinary body text next to every control, which is exactly
     how this was found (M34). */
  .visually-hidden {
    position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0;
    overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0;
  }

  .nudge {
    margin-top: 1rem; padding: 0.7rem 1rem; border-radius: 1rem;
    background: var(--warn-bg); color: var(--warn); font-size: var(--t-support); text-align: left;
  }
  /* The one success notice shape. B4's broadcast receipt is the first to
     wear it; anything later that says "that worked" uses this, not a new
     class. */
  .nudge.ok { background: var(--ok-bg); color: var(--ok-fg); }

  /* Script-injected only, on any page, so it lives here rather than in a
     page block. Fixed to the bottom edge: an installed app has no reload
     control of its own, and covering content would punish someone mid-form. */
  .update-overlay {
    position: fixed; left: 50%; bottom: 1rem; transform: translateX(-50%);
    width: calc(100% - 2rem); max-width: 28rem;
    display: flex; align-items: center; justify-content: space-between; gap: 1rem;
    padding: 0.8rem 1rem; border: 1px solid var(--line); border-radius: 1rem;
    background: var(--card-raised); color: var(--fg);
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.18);
  }
  .update-overlay .button { flex: 0 0 auto; min-height: 44px; padding: 0.5rem 1rem; font-size: var(--t-body); margin: 0; }

  .button {
    flex: 1; display: flex; align-items: center; justify-content: center;
    min-height: 52px; padding: 0.85rem 1.25rem;
    border: none; border-radius: 999px;
    background: var(--field); color: var(--fg);
    font: inherit; font-size: var(--t-lead); font-weight: 700;
    cursor: pointer; -webkit-tap-highlight-color: transparent;
  }
  .button:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
  .button:active { transform: translateY(1px); }
  /* A solid fill for the one action a page wants emphasised — unmistakable
     against the outlined default, in both themes, without relying on colour
     alone. No longer used to echo ?intent= on the two response-collecting
     pages (M10 §3.1: their own chosen-* classes carry that job now); still
     used standalone elsewhere, e.g. the account-erasure page's cancel
     action. Deliberately vague about which pages by name — this block is
     the one inlined into every page including the holding page, where a
     handful of words describing anything operational are asserted absent. */
  .button.primary {
    background: var(--accent); color: var(--accent-fg);
  }
  /* Filled, like .primary, because a destructive action is still the primary
     thing on the page it appears on — the fill says "this is the action", the
     colour says "and it cannot be undone". Four pages use it, which is why it
     is here and not in CANCEL_STYLES_CSS where it started.

     Both --danger and --accent are now warm red-orange hues, close enough in
     hue that a deuteranope reading a filled button of either colour is
     relying on the label, not the colour, to tell them apart — light:
     #a4321f (--danger) vs #c67139 (--accent); dark: #e8705a vs #d98a55,
     whose relative luminance sits within 1.12:1 of each other. That is safe
     today only because M10 §3.2 keeps red and orange filled buttons off the
     same screen — no page shows both at once. If a future page ever needs
     to, that separation is what makes this safe and it stops being true the
     moment both appear together. */
  .button.danger {
    background: var(--danger); color: var(--danger-fg);
  }
  .button.danger:focus-visible { outline: 3px solid var(--danger); outline-offset: 2px; }

  /* Sign-out is a real action but never the point of the page it sits on, so
     it gets the plain filled default rather than the primary fill. */
  .signout { margin: 1.25rem 0; }
`;

/**
 * Escapes the five characters HTML gives special meaning: `&`, `<`, `>`,
 * `"` and `'`. Every caller in this codebase interpolates into either a
 * text node or a double-quoted attribute — never a single-quoted attribute,
 * never inline JS/CSS — so `"` alone was long enough to stop attribute
 * breakout. `'` is escaped anyway (as `&#39;`, the conventional numeric
 * form, since HTML has no named entity for it) because this function is
 * shared: the moment a future caller interpolates into a single-quoted
 * attribute, the gap becomes exploitable, and there is no test today that
 * would catch that caller being added. Backtick (`` ` ``) is deliberately
 * left unescaped: it has no special meaning in HTML text, attributes, or
 * attribute-quoting in any browser, so escaping it would be theatre, not
 * defence — see `docs/known-issues.md` if this reasoning needs revisiting.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function navLink(href: string, label: string, section: NavSection, current: NavSection): string {
  return `<a href="${escapeHtml(href)}"${section === current ? ` aria-current="page"` : ""}>${label}</a>`;
}

function renderHeader(nav: PageNav): string {
  const links = [
    navLink(DASHBOARD_PATH, "Games", "games", nav.current),
    navLink(ACCOUNT_PATH, "Account", "account", nav.current),
    ...(nav.isAdmin ? [navLink(ADMIN_PATH, "Admin", "admin", nav.current)] : []),
  ];
  return `<header class="site-header"><a class="site-name" href="${escapeHtml(
    DASHBOARD_PATH,
  )}">Make The Team</a><nav aria-label="Main">${links.join("")}</nav></header>`;
}

export function layout({ title, body, pageStyles, pageScripts, centred, nav }: LayoutOptions): string {
  const styleTags = [STYLES, ...(pageStyles ?? [])].map((css) => `<style>${css}</style>`).join("\n");
  // No attributes on the tag — not `src`, not `type`, not `nonce`. A bare
  // inline `<script>` is what a CSP SHA-256 hash of the block's exact text
  // covers, and it is what `test/routes/signin.test.ts` insists on finding.
  //
  // SERVICE_WORKER_JS goes first and unconditionally, ahead of whatever
  // pageScripts carries — mirroring STYLES leading pageStyles above — because
  // it is the one block every page emits regardless of what it opts into via
  // `pageScripts` (see that field's comment on `LayoutOptions`).
  // PRESENCE_JS on exactly the pages that carry `nav`, which is this file's
  // existing test for "a session is on this page" (see `LayoutOptions.nav`).
  // Gating on the header rather than on a per-page opt-in is what keeps the
  // ping off `/`, `/join/:token` and `/r/:token` — pages a stranger opens
  // from a link, with no session to report — without every signed-in page
  // having to remember to ask for it.
  const scriptTags = [SERVICE_WORKER_JS, ...(nav === undefined ? [] : [PRESENCE_JS]), ...(pageScripts ?? [])]
    .map((js) => `<script>${js}</script>`)
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Caprasimo&family=Figtree:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<link rel="manifest" href="${MANIFEST_PATH}">
<!-- iOS reads only this. It ignores the manifest's icon list entirely. -->
<link rel="apple-touch-icon" href="${APPLE_TOUCH_ICON_PATH}">
<meta name="theme-color" content="${THEME_COLOR}">
<title>${escapeHtml(title)}</title>
${styleTags}
</head>
<body${nav === undefined ? "" : ` class="with-header"`}>${nav === undefined ? "" : renderHeader(nav)}<main${centred ? ` class="centred"` : ""}>${body}</main>${scriptTags}</body>
</html>
`;
}

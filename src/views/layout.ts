import type { PageScriptBlock } from "./scripts.js";
import type { PageStyleBlock } from "./styles.js";

export interface LayoutOptions {
  title: string;
  body: string;
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
   * Client-side JavaScript for this page alone — in practice, only the two
   * passkey enhancements. **Almost every page should leave this unset**, and
   * a page that sets it must still be completely usable when the script never
   * runs (see `src/views/scripts.ts` for the whole argument).
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
 */
export const STYLES = `
  :root {
    color-scheme: light dark;
    --fg: #1c1b19; --bg: #fbfaf8;
    /* #6b6862, one shade lighter than this, read at ~4.0:1 against --line —
       under the 4.5 AA floor for 14px text on a rounded neutral pill, which
       is what most of a fourth of the response categories render in early in
       the week (M10 whole-branch review, Minor 6). Darkened to read at
       ~4.7:1 against --line while staying readable as the same neutral grey
       against --bg, which it also sits on everywhere else. Kept free of file
       paths and page names on purpose — this constant renders on error pages
       and the public holding page too, both of which forbid exactly that. */
    --mut: #635f59; --line: #e3ded4;
    --accent: #1f6f4a; --accent-fg: #fbfaf8; --accent-mut: #e3efe7;
    --warn: #8a5a10; --warn-bg: #f7ecd8;
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
      --fg: #e6e3de; --bg: #16181a; --mut: #9b968e; --line: #2c2f30;
      --accent: #3fae7c; --accent-fg: #08170f; --accent-mut: #17251d;
      --warn: #d9a441; --warn-bg: #2b230f;
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
    font: var(--t-body)/1.6 "Instrument Sans", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  /* Left by default. Centring is opt-in via centred on layout(), for pages
     that are a single statement and nothing else. Until M10 the default was
     centre and FORM_CSS overrode it back, so the product ran in two
     alignments at once — the design review's finding 6. */
  main { max-width: 30rem; width: 100%; text-align: left; }
  main.centred { text-align: center; }
  h1 { font-size: var(--t-title); letter-spacing: -0.02em; margin: 0 0 0.5rem; }
  h2 { font-size: var(--t-lead); margin: 2rem 0 0.6rem; }
  p { color: var(--mut); margin: 0; }
  a { color: var(--accent); }
  .danger-link { color: var(--danger); font-weight: 600; }

  .nudge {
    margin-top: 1rem; padding: 0.7rem 1rem; border-radius: 0.6rem;
    background: var(--warn-bg); color: var(--warn); font-size: var(--t-support); text-align: left;
  }

  .button {
    flex: 1; display: flex; align-items: center; justify-content: center;
    min-height: 52px; padding: 0.85rem 1.25rem;
    border-radius: 0.65rem; border: 2px solid var(--line);
    background: var(--bg); color: var(--fg);
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
    background: var(--accent); border-color: var(--accent); color: var(--accent-fg);
  }
  /* Filled, like .primary, because a destructive action is still the primary
     thing on the page it appears on — the fill says "this is the action", the
     colour says "and it cannot be undone". Four pages use it, which is why it
     is here and not in CANCEL_STYLES_CSS where it started.

     Relative luminance: --danger and --accent are close enough that a
     deuteranope reading a filled button of either colour is relying on the
     label, not the colour, to tell them apart — light: #a4321f (--danger) is
     about 0.10, #1f6f4a (--accent) about 0.12; dark: #e8705a about 0.295,
     #3fae7c about 0.324. That is safe today only because M10 §3.2 keeps red
     and green filled buttons off the same screen — no page shows both at
     once. If a future page ever needs to, that separation is what makes this
     safe and it stops being true the moment both appear together. */
  .button.danger {
    background: var(--danger); border-color: var(--danger); color: var(--danger-fg);
  }
  .button.danger:focus-visible { outline: 3px solid var(--danger); outline-offset: 2px; }

  /* Sign-out is a real action but never the point of the page it sits on, so
     it gets the outlined button rather than the filled one. */
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

export function layout({ title, body, pageStyles, pageScripts, centred }: LayoutOptions): string {
  const styleTags = [STYLES, ...(pageStyles ?? [])].map((css) => `<style>${css}</style>`).join("\n");
  // No attributes on the tag — not `src`, not `type`, not `nonce`. A bare
  // inline `<script>` is what a CSP SHA-256 hash of the block's exact text
  // covers, and it is what `test/routes/signin.test.ts` insists on finding.
  const scriptTags = (pageScripts ?? []).map((js) => `<script>${js}</script>`).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<title>${escapeHtml(title)}</title>
${styleTags}
</head>
<body><main${centred ? ` class="centred"` : ""}>${body}</main>${scriptTags}</body>
</html>
`;
}

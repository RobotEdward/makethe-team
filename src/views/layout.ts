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
}

/**
 * Shared primitives only: tokens, reset, body/typography, and the handful of
 * controls (buttons, the sign-out form, the generic notice box) reused
 * across otherwise-unrelated pages. Everything specific to one page or one
 * family of pages lives in `src/views/styles.ts` instead and is passed in
 * via `pageStyles` — see `LayoutOptions.pageStyles` above for why that split
 * is enforced, not just conventional.
 */
export const STYLES = `
  :root {
    color-scheme: light dark;
    --fg: #1c1b19; --bg: #fbfaf8; --mut: #6b6862; --line: #e3ded4;
    --accent: #1f6f4a; --accent-fg: #fbfaf8; --accent-mut: #e3efe7;
    --warn: #8a5a10; --warn-bg: #f7ecd8;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --fg: #e6e3de; --bg: #16181a; --mut: #9b968e; --line: #2c2f30;
      --accent: #3fae7c; --accent-fg: #08170f; --accent-mut: #17251d;
      --warn: #d9a441; --warn-bg: #2b230f;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    padding: 2rem 1.25rem; background: var(--bg); color: var(--fg);
    font: 16px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  main { max-width: 30rem; width: 100%; text-align: center; }
  h1 { font-size: 2rem; letter-spacing: -0.02em; margin: 0 0 0.5rem; }
  h2 { font-size: 1.05rem; margin: 2rem 0 0.6rem; text-align: left; }
  p { color: var(--mut); margin: 0; }
  a { color: var(--accent); }

  .nudge {
    margin-top: 1rem; padding: 0.7rem 1rem; border-radius: 0.6rem;
    background: var(--warn-bg); color: var(--warn); font-size: 0.92rem; text-align: left;
  }

  .button {
    flex: 1; display: flex; align-items: center; justify-content: center;
    min-height: 52px; padding: 0.85rem 1.25rem;
    border-radius: 0.65rem; border: 2px solid var(--line);
    background: var(--bg); color: var(--fg);
    font: inherit; font-size: 1.05rem; font-weight: 700;
    cursor: pointer; -webkit-tap-highlight-color: transparent;
  }
  .button:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
  .button:active { transform: translateY(1px); }
  /* Emphasised action from ?intent= — a solid fill is unmistakable against
     the outlined default, in both themes, without relying on colour alone. */
  .button.primary {
    background: var(--accent); border-color: var(--accent); color: var(--accent-fg);
  }

  /* Sign-out is a real action but never the point of the page it sits on, so
     it gets the outlined button rather than the filled one. */
  .signout { margin: 1.25rem 0; }
`;

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function layout({ title, body, pageStyles }: LayoutOptions): string {
  const styleTags = [STYLES, ...(pageStyles ?? [])].map((css) => `<style>${css}</style>`).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
${styleTags}
</head>
<body><main>${body}</main></body>
</html>
`;
}

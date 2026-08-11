export interface LayoutOptions {
  title: string;
  body: string;
}

const STYLES = `
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

  .venue, .kickoff { font-size: 0.95rem; }
  .kickoff { margin-bottom: 0.75rem; }

  .status-badge {
    display: inline-block; margin-top: 0.5rem;
    padding: 0.3rem 0.85rem; border-radius: 999px; border: 1px solid var(--line);
    font-weight: 600; font-size: 0.9rem; color: var(--fg);
  }
  .status-badge.status-confirmed { border-color: var(--accent); color: var(--accent); }
  .status-badge.status-short, .status-badge.status-cancelled { border-color: var(--warn); color: var(--warn); }
  .spots { margin-top: 0.4rem; font-size: 0.9rem; }

  .nudge {
    margin-top: 1rem; padding: 0.7rem 1rem; border-radius: 0.6rem;
    background: var(--warn-bg); color: var(--warn); font-size: 0.92rem; text-align: left;
  }

  .viewer-headline {
    margin-top: 1.5rem; font-size: 1.4rem; font-weight: 700; color: var(--fg); line-height: 1.3;
  }
  /* A waitlisted viewer must never read as confirmed (BR-5): same warn
     colour the roster already uses for a waitlisted row, so it is visually
     distinct from the accent-coloured "confirmed" badge that can appear
     right below it. */
  .viewer-headline.warn { color: var(--warn); }

  .read-only {
    margin-top: 1.25rem; padding: 0.85rem 1rem; border-radius: 0.6rem;
    border: 1px dashed var(--line); color: var(--mut); font-size: 0.95rem; text-align: left;
  }

  /* Two big, unmistakable tap targets: stacked on a phone, side by side once
     there is room for both without cramping. */
  .responses {
    display: flex; flex-direction: column; gap: 0.75rem;
    margin: 1.5rem 0 0.5rem;
  }
  @media (min-width: 30rem) {
    .responses { flex-direction: row; }
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

  /* Sign-in: the same stacked, full-width, big-tap-target shape as the
     response buttons above, so the two pages read as one product. The input
     borrows the button's border, radius and height rather than introducing a
     second control style. */
  .signin { display: flex; flex-direction: column; gap: 0.6rem; margin: 1.5rem 0 0.5rem; }
  .signin label { text-align: left; font-size: 0.95rem; color: var(--mut); }
  .signin input {
    width: 100%; min-height: 52px; padding: 0.85rem 1rem;
    border-radius: 0.65rem; border: 2px solid var(--line);
    background: var(--bg); color: var(--fg); font: inherit; font-size: 1.05rem;
  }
  .signin input:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
  .signin .button { margin-top: 0.25rem; }

  /* Sign-out is a real action but never the point of the page it sits on, so
     it gets the outlined button rather than the filled one. */
  .signout { margin: 1.25rem 0; }

  .roster {
    list-style: none; margin: 0; padding: 0; text-align: left;
    border-top: 1px solid var(--line);
  }
  .roster li {
    display: flex; align-items: baseline; justify-content: space-between; gap: 1rem;
    padding: 0.6rem 0.1rem; border-bottom: 1px solid var(--line);
  }
  .roster .name { color: var(--fg); }
  .roster .status { font-size: 0.85rem; color: var(--mut); white-space: nowrap; }
  .roster .status-in { color: var(--accent); font-weight: 600; }
  .roster .status-waitlisted { color: var(--warn); font-weight: 600; }
`;

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function layout({ title, body }: LayoutOptions): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<style>${STYLES}</style>
</head>
<body><main>${body}</main></body>
</html>
`;
}

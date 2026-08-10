export interface LayoutOptions {
  title: string;
  body: string;
}

const STYLES = `
  :root { color-scheme: light dark; --fg: #1c1b19; --bg: #fbfaf8; --mut: #6b6862; }
  @media (prefers-color-scheme: dark) { :root { --fg: #e6e3de; --bg: #16181a; --mut: #9b968e; } }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    padding: 2rem; background: var(--bg); color: var(--fg);
    font: 16px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  main { max-width: 30rem; text-align: center; }
  h1 { font-size: 2rem; letter-spacing: -0.02em; margin: 0 0 0.5rem; }
  p { color: var(--mut); margin: 0; }
`;

function escapeHtml(value: string): string {
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

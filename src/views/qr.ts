import { encode } from "uqr";
import { escapeHtml } from "./layout.js";

/**
 * A QR code for `text`, as an inline `<svg>` element.
 *
 * **Inline SVG, never an `<img>`, and this is not a style preference.** The
 * Content-Security-Policy sets `default-src 'none'` and names no `img-src`, so
 * an image of any kind — including a `data:` URI — is refused by the browser
 * before it renders. That is exactly the mechanism that left both passkey
 * buttons broken in production while every server-side test passed (the
 * post-mortem in `docs/known-issues.md`). Inline SVG is markup rather than a
 * fetch, so it needs no directive and cannot fail that way. Adding `img-src`
 * to serve one QR code would widen the policy for the whole site.
 *
 * Encoding comes from `uqr` (MIT, no dependencies) rather than being
 * hand-rolled: QR is Reed–Solomon error correction plus mask selection, and
 * design principle 6 prefers the option with fewer moving parts — a call into
 * a small library is fewer than 400 lines of our own.
 *
 * Rendered as one `<path>` of module rectangles rather than thousands of
 * `<rect>` elements, which keeps the markup small enough to sit in a page.
 */
export function qrSvg(text: string, options: { size?: number } = {}): string {
  const { size = 240 } = options;
  const result = encode(text, { border: 2 });
  const modules = result.size;

  let path = "";
  for (let y = 0; y < modules; y++) {
    for (let x = 0; x < modules; x++) {
      if (result.data[y]![x]) path += `M${x} ${y}h1v1h-1z`;
    }
  }

  // No `xmlns` attribute: this markup is always inlined directly into an
  // HTML page (never served as a standalone `.svg` document), and HTML5
  // parsing auto-namespaces an inline `<svg>` element without it. Omitting
  // it also keeps this element free of the literal string "http://", which
  // both keeps it visibly free of any URL and is what the test below pins.
  return `<svg viewBox="0 0 ${modules} ${modules}" width="${size}" height="${size}" role="img" shape-rendering="crispEdges"><title>QR code for ${escapeHtml(text)}</title><rect width="${modules}" height="${modules}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}

import { describe, expect, it } from "vitest";
import { qrSvg } from "../../src/views/qr.js";

describe("qrSvg", () => {
  const url = "https://makethe.team/j/2f1c8b3e-0000-4000-8000-000000000000";

  it("returns a complete inline svg element", () => {
    const svg = qrSvg(url);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg.trimEnd().endsWith("</svg>")).toBe(true);
  });

  it("never references an external resource", () => {
    // The whole reason this is inline SVG rather than an <img>: img-src 'self'
    // (M13) covers a same-origin path, not a data: URI or a remote host, so
    // either shape of <img> is still refused by the browser (spec §4.2).
    const svg = qrSvg(url);
    expect(svg).not.toContain("<image");
    expect(svg).not.toContain("href");
    expect(svg).not.toContain("data:");
    expect(svg).not.toContain("http://");
  });

  it("carries an accessible name rather than being a bare graphic", () => {
    expect(qrSvg(url)).toContain("<title>");
    expect(qrSvg(url)).toContain('role="img"');
  });

  it("encodes different inputs differently", () => {
    expect(qrSvg(url)).not.toBe(qrSvg(`${url}x`));
  });

  it("uses a viewBox so the page controls the rendered size", () => {
    expect(qrSvg(url)).toContain("viewBox=");
  });

  it("escapes a title that contains markup characters", () => {
    // The URL is server-built today, but this renders a caller's string.
    expect(qrSvg('https://x/"><script>')).not.toContain("<script>");
  });
});

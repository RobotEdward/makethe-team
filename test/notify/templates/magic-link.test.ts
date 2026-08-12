import { describe, expect, it } from "vitest";
import { renderMagicLinkEmail } from "../../../src/notify/templates/magic-link.js";

const url = "https://maketheteam.example/api/auth/magic-link/verify?token=abc123&callbackURL=%2F";

describe("renderMagicLinkEmail", () => {
  it("renders both an HTML and a text rendition, each carrying the link", () => {
    const email = renderMagicLinkEmail({ signInUrl: url, expiresInLabel: "5 minutes" });

    expect(email.subject).toBe("Your sign-in link");
    expect(email.html).toContain("<!doctype html>");
    expect(email.text).not.toContain("<");

    // The HTML rendition escapes for an attribute; the text one carries the
    // URL verbatim, so a mail client can linkify it.
    expect(email.html).toContain(`href="${url.replace(/&/g, "&amp;")}"`);
    expect(email.text).toContain(url);
  });

  it("says how long the link lasts, in both renditions, using the caller's label", () => {
    const email = renderMagicLinkEmail({ signInUrl: url, expiresInLabel: "17 minutes" });

    expect(email.html).toContain("17 minutes");
    expect(email.text).toContain("17 minutes");
  });

  it("escapes everything it interpolates", () => {
    const hostile = 'https://evil.example/"><script>alert(1)</script>';
    const email = renderMagicLinkEmail({ signInUrl: hostile, expiresInLabel: "<b>soon</b>" });

    expect(email.html).not.toContain("<script>");
    expect(email.html).not.toContain("<b>soon</b>");
    expect(email.html).toContain("&lt;script&gt;");
  });

  it("tells a recipient who did not ask for it that they can ignore it", () => {
    const email = renderMagicLinkEmail({ signInUrl: url, expiresInLabel: "5 minutes" });

    expect(email.html.toLowerCase()).toContain("ignore this email");
    expect(email.text.toLowerCase()).toContain("ignore this email");
  });
});

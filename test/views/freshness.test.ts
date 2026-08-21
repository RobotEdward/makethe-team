import { describe, expect, it } from "vitest";
import { FRESHNESS_AGE_ATTRIBUTE, FRESHNESS_ATTRIBUTE, FRESHNESS_JS, PAGE_SCRIPT_BLOCKS } from "../../src/views/scripts.js";
import { renderFreshness } from "../../src/views/freshness.js";
import { FRESHNESS_CSS, PAGE_STYLE_BLOCKS } from "../../src/views/styles.js";

/**
 * The freshness bar (M24): "Updated 3 minutes ago · Refresh", plus the
 * silent re-fetch that is the point of it.
 *
 * An installed app resumed after twenty minutes re-shows the document the
 * browser already had. Every page here is `private, no-store`, so a
 * *navigation* is always fresh — the staleness is purely that no navigation
 * happens. Hence a bar whose link is an ordinary GET of the page's own path
 * (the whole no-script story) and a script that re-fetches on resume.
 */
describe("the freshness bar", () => {
  it("links Refresh at the page's own path", () => {
    expect(renderFreshness("/g/abc")).toContain(`href="/g/abc"`);
    expect(renderFreshness("/g/abc")).toContain("Refresh");
  });

  it("escapes the path it is given", () => {
    // Every interpolation goes through escapeHtml, href included.
    expect(renderFreshness(`/r/a"b&c`)).toContain(`href="/r/a&quot;b&amp;c"`);
  });

  it("ships the age hidden, for the script to reveal", () => {
    // With scripting off there is no clock to count from, and a served-in
    // "Updated just now" would still be saying it an hour later. The link
    // beside it works either way, which is what keeps the bar honest.
    const html = renderFreshness("/app");
    expect(html).toMatch(new RegExp(`${FRESHNESS_AGE_ATTRIBUTE}[^>]*hidden`));
  });

  it("carries the two attributes the script reads", () => {
    const html = renderFreshness("/app");
    expect(html).toContain(FRESHNESS_ATTRIBUTE);
    expect(html).toContain(FRESHNESS_AGE_ATTRIBUTE);
  });
});

describe("the freshness script", () => {
  it("is enumerated, so the CSP hashes it", () => {
    expect(PAGE_SCRIPT_BLOCKS as readonly string[]).toContain(FRESHNESS_JS);
  });

  it("retires the reload once a form has been touched", () => {
    // The organiser's fixture page carries the team picker, whose in-progress
    // pick lives nowhere but the DOM until Save. Reloading over it destroys
    // work. `dirty` is checked before every reload; these are the events that
    // set it, and the picker needs all four (a drag and Randomise both set
    // `.checked` from script, which fires neither `input` nor `change`).
    for (const event of ["input", "change", "dragend", "click"]) {
      expect(FRESHNESS_JS).toContain(`"${event}"`);
    }
    expect(FRESHNESS_JS).toContain("if (dirty) return;");
  });

  it("reloads only a page that is both visible and stale", () => {
    expect(FRESHNESS_JS).toContain("if (document.hidden) return;");
    expect(FRESHNESS_JS).toContain("location.reload()");
  });
});

describe("the freshness stylesheet", () => {
  it("is enumerated, so the browser does not drop it", () => {
    // A block absent from PAGE_STYLE_BLOCKS is hashed by nothing in
    // src/security/csp.ts, so its CSS silently fails to apply in production
    // while every test still passes.
    expect(PAGE_STYLE_BLOCKS as readonly string[]).toContain(FRESHNESS_CSS);
  });
});

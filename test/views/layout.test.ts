import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { escapeHtml, layout, STYLES, THEME_COLOR } from "../../src/views/layout.js";
import { APPLE_TOUCH_ICON_PATH, MANIFEST_PATH } from "../../src/auth/paths.js";
import { PAGE_STYLE_BLOCKS } from "../../src/views/styles.js";

describe("escapeHtml", () => {
  // Direct unit coverage for the shared escaping function used by six
  // callers, including every email template that now reaches real inboxes
  // via NOTIFIER=resend — previously pinned only incidentally through the
  // page/email tests that happen to interpolate a matching character.
  it.each([
    ["&", "&amp;"],
    ["<", "&lt;"],
    [">", "&gt;"],
    ['"', "&quot;"],
    ["'", "&#39;"],
  ])("escapes %j as %j", (input, expected) => {
    expect(escapeHtml(input)).toBe(expected);
  });

  it("leaves backtick unescaped — deliberate, not an oversight", () => {
    // Backtick has no special meaning in HTML text, attributes, or
    // attribute-quoting in any browser, so escaping it would be theatre,
    // not defence (see the doc comment on escapeHtml in src/views/layout.ts
    // and docs/known-issues.md). Pinning this so the choice reads as
    // intentional, not forgotten.
    expect(escapeHtml("`")).toBe("`");
  });

  it("escapes every special character together, leaving ordinary text and backticks untouched", () => {
    const input = `it's a "test" with \`backticks\` <b>&amp;</b>`;
    expect(escapeHtml(input)).toBe(
      "it&#39;s a &quot;test&quot; with `backticks` &lt;b&gt;&amp;amp;&lt;/b&gt;",
    );
  });

  it("is a no-op on a string with none of the five special characters", () => {
    expect(escapeHtml("Thursday 7-a-side at Oxford Sports Park")).toBe(
      "Thursday 7-a-side at Oxford Sports Park",
    );
  });
});

describe("layout", () => {
  it("defaults to left alignment and offers centring as an opt-in", () => {
    const left = layout({ title: "T", body: "<p>x</p>" });
    expect(left).toContain("<main>");
    const centred = layout({ title: "T", body: "<p>x</p>", centred: true });
    expect(centred).toContain(`<main class="centred">`);
  });

  it("defines a danger colour in both themes", () => {
    // A token defined only in the light block leaves every danger button
    // invisible-to-unreadable for a dark-mode viewer, and no server-side test
    // renders a theme. This is the only thing that catches it.
    const dark = STYLES.slice(STYLES.indexOf("prefers-color-scheme: dark"));
    expect(dark).toContain("--danger:");
    expect(dark).toContain("--danger-fg:");
  });

  it("puts every font size on the four-step scale", () => {
    // Guards §2.2. A fifteenth size can still be added — but not silently.
    const sizes = [...`${STYLES}${PAGE_STYLE_BLOCKS.join("")}`.matchAll(/font-size:\s*([^;]+);/g)]
      .map((m) => (m[1] ?? "").trim())
      .filter((v) => !v.startsWith("var(--t-"));
    expect(sizes).toEqual([]);
  });

  it("preconnects and swaps, so a slow font never blanks the page", () => {
    const html = layout({ title: "T", body: "" });
    expect(html).toContain(`rel="preconnect" href="https://fonts.gstatic.com" crossorigin`);
    expect(html).toContain("display=swap");
  });

  it("keeps the system stack behind the webfont", () => {
    // If the font request is blocked, this is the whole appearance of the
    // product. It must still be the stack that shipped before M10.
    expect(STYLES).toContain(`"Instrument Sans", ui-sans-serif, system-ui`);
  });
});

describe("the installable app's head (M13)", () => {
  it("links the manifest and the apple-touch-icon on every page", async () => {
    // Both are needed and neither substitutes for the other: Android reads
    // the manifest's icon list, and iOS ignores that list completely and
    // reads only the apple-touch-icon link. Ship one and half your players
    // get a screenshot of the page as their home-screen icon.
    const body = await (await SELF.fetch("https://makethe.team/")).text();

    expect(body).toContain(`<link rel="manifest" href="${MANIFEST_PATH}">`);
    expect(body).toContain(`<link rel="apple-touch-icon" href="${APPLE_TOUCH_ICON_PATH}">`);
  });

  it("sets a theme colour matching the manifest", async () => {
    // A mismatch shows as one colour in the task switcher and another in the
    // browser chrome, on the same app. Asserted against THEME_COLOR rather
    // than a pasted literal — test/routes/pwa.test.ts asserts the manifest's
    // theme_color against the same constant, so the two tests can't drift
    // onto two different "correct" colours.
    const body = await (await SELF.fetch("https://makethe.team/")).text();

    expect(body).toContain(`<meta name="theme-color" content="${THEME_COLOR}">`);
  });
});

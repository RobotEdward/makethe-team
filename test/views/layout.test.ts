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

  /**
   * Every file that is allowed to pass `centred: true`, and no others.
   *
   * Each of these is a page you read once and leave: the public holding page,
   * a broken link, the three terminal cancellation outcomes, and the five
   * terminal sign-in states. None of them has a list, a table, or a row of
   * anything — nothing an eye has to scan down.
   *
   * `src/routes/home.ts` is in here on purpose: the holding page composes its
   * own layout call from the routes directory rather than a view module, so a
   * scan restricted to `src/views/` would report it as an offender.
   */
  const TERMINAL_CENTRED = [
    "src/routes/home.ts",
    "src/views/cancel.ts",
    "src/views/link-problem.ts",
    "src/views/offline.ts",
    "src/views/signin.ts",
  ];

  it("centres only pages that are a single statement with nothing to scan", () => {
    // Spec §2.1. Centring a page that has anything to scan turns a list into a
    // poster: the eye loses the left edge it was following and every row has
    // to be re-found. The rule is invisible at review time because a centred
    // page still renders, still passes every fetch-level test, and only looks
    // wrong next to the eleven pages that are left-aligned — so it is pinned
    // here instead.
    //
    // Source text rather than rendered HTML: several of these call sites are
    // behind auth or a signed token, and a test that had to reach them all
    // would guard whichever ones it could log into. `import.meta.glob` is
    // resolved by Vite at transform time, so this works inside the workers
    // pool where `node:fs` does not (same mechanism as scripts.test.ts).
    // Comments are stripped first so prose mentioning the option cannot make
    // a file look like an offender.
    const sources = import.meta.glob("../../src/**/*.ts", {
      query: "?raw",
      import: "default",
      eager: true,
    }) as Record<string, string>;

    const offenders = Object.entries(sources)
      .filter(([, source]) =>
        source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "").includes("centred: true"),
      )
      .map(([path]) => path.replace(/^(\.\.\/)+/, ""))
      .filter((path) => !TERMINAL_CENTRED.includes(path))
      .sort();

    expect(
      offenders,
      "centred: true is only for a page that is a single statement with " +
        "nothing to scan (spec §2.1). A scannable page — anything with a " +
        "list, a table, a form, or repeated rows — must be left-aligned, or " +
        "it reads as a poster instead of a list. Fix: drop `centred: true` " +
        "from the file(s) in the diff below. Add a page to TERMINAL_CENTRED only " +
        "if it is genuinely terminal: one message, one action at most, and " +
        "nothing the eye has to scan down.",
    ).toEqual([]);
  });

  it("finds the terminal centred pages where the enumeration says they are", () => {
    // Without this, the guard above stays green after a listed file is renamed
    // or its `centred: true` removed — the enumeration would quietly become a
    // list of paths that permit nothing, and the real offender it was written
    // to catch could take one of those names.
    const sources = import.meta.glob("../../src/**/*.ts", {
      query: "?raw",
      import: "default",
      eager: true,
    }) as Record<string, string>;

    const centred = Object.entries(sources)
      .filter(([, source]) => source.includes("centred: true"))
      .map(([path]) => path.replace(/^(\.\.\/)+/, ""))
      .sort();

    expect(centred).toEqual([...TERMINAL_CENTRED].sort());
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

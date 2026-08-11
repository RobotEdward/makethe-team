import { describe, expect, it } from "vitest";
import { escapeHtml } from "../../src/views/layout.js";

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

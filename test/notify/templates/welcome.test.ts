import { describe, expect, it } from "vitest";
import { renderWelcomeEmail, type WelcomeEmailPayload } from "../../../src/notify/templates/welcome.js";

const BASE: WelcomeEmailPayload = {
  playerName: "Alex",
  gameName: "Thursday 7-a-side",
  venueName: "Oxford Sports Park",
  whenLocal: "Thursday 20 August at 19:00",
  dashboardUrl: "https://makethe.team/app",
  leaveUrl: "https://makethe.team/leave/tok123",
};

describe("renderWelcomeEmail", () => {
  it("names the game in the subject", () => {
    expect(renderWelcomeEmail(BASE).subject).toContain("Thursday 7-a-side");
  });

  it("says which fixture is their first, because it is not the current one (BR-2)", () => {
    const { html, text } = renderWelcomeEmail(BASE);
    for (const rendition of [html, text]) {
      expect(rendition).toContain("Thursday 20 August at 19:00");
      expect(rendition.toLowerCase()).toMatch(/first game/);
    }
  });

  it("stays honest when there is no scheduled fixture yet", () => {
    const { text, html } = renderWelcomeEmail({ ...BASE, whenLocal: null });
    expect(text).not.toContain("null");
    expect(html).not.toContain("null");
    // Not merely silent: it says *why* there is no date rather than leaving a gap.
    expect(text.toLowerCase()).toMatch(/isn't in the diary yet/);
  });

  it("both renditions carry the venue", () => {
    const { html, text } = renderWelcomeEmail(BASE);
    for (const rendition of [html, text]) expect(rendition).toContain(BASE.venueName);
  });

  it("explains the day-before email and its two buttons, so the first one is not a surprise", () => {
    const { html, text } = renderWelcomeEmail(BASE);
    for (const rendition of [html, text]) {
      expect(rendition.toLowerCase()).toMatch(/day before/);
      // The apostrophe is an entity in the HTML rendition (`escapeHtml` escapes
      // `'`), a bare character in the text one.
      expect(rendition.toLowerCase()).toMatch(/can(?:&#39;|')t make it/);
    }
  });

  it("escapes a name containing markup", () => {
    const { html } = renderWelcomeEmail({ ...BASE, playerName: '<script>alert(1)</script>' });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes the game and venue names too", () => {
    const { html } = renderWelcomeEmail({
      ...BASE,
      gameName: "<b>Thursday</b> Kickabout",
      venueName: `Nice pitch" onmouseover="alert(1)`,
    });
    expect(html).toContain("&lt;b&gt;Thursday&lt;/b&gt;");
    expect(html).not.toContain('onmouseover="alert(1)"');
    expect(html).toContain("&quot;");
  });

  it("escapes the URL it embeds, so a quote in one cannot break out of the attribute", () => {
    const { html } = renderWelcomeEmail({ ...BASE, dashboardUrl: `https://makethe.team/app" onclick="alert(1)` });
    expect(html).not.toContain('onclick="alert(1)"');
    expect(html).toContain("&quot;");
  });

  it("offers a text alternative for every link in the HTML", () => {
    const { text } = renderWelcomeEmail(BASE);
    expect(text).toContain("https://makethe.team/app");
    expect(text).toContain(BASE.leaveUrl);
  });

  it("carries a leave link, worded for someone who has just joined", () => {
    const { html, text } = renderWelcomeEmail(BASE);
    expect(html).toContain(BASE.leaveUrl);
    for (const rendition of [html, text]) {
      expect(rendition.toLowerCase()).toMatch(/leave this game/);
    }
  });

  it("the text rendition contains no HTML tags", () => {
    const { text } = renderWelcomeEmail(BASE);
    expect(text).not.toMatch(/<[a-zA-Z!/][^>]*>/);
  });

  it("is pure: the same payload renders byte-identically twice", () => {
    expect(renderWelcomeEmail(BASE)).toEqual(renderWelcomeEmail(BASE));
  });
});

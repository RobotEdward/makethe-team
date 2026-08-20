import { describe, expect, it } from "vitest";
import { renderPromotionEmail, type PromotionEmailPayload } from "../../../src/notify/templates/promotion.js";

const BASE: PromotionEmailPayload = {
  playerName: "Edward Cooper",
  gameName: "Thursday 7-a-side",
  venueName: "Oxford Sports Park",
  kicksOffAtLocal: "Thursday 13 August, 19:00",
  respondInUrl: "https://makethe.team/r/tok123?intent=in",
  respondOutUrl: "https://makethe.team/r/tok123?intent=out",
  leaveUrl: "https://makethe.team/leave/tok123",
};

describe("renderPromotionEmail", () => {
  it("subject names the game and says the player is in", () => {
    const { subject } = renderPromotionEmail(BASE);
    expect(subject).toContain(BASE.gameName);
    expect(subject.toLowerCase()).toMatch(/you.re in/);
  });

  it("both renditions say a spot opened up and that the player is off the waitlist", () => {
    const { html, text } = renderPromotionEmail(BASE);
    for (const rendition of [html, text]) {
      expect(rendition.toLowerCase()).toMatch(/spot/);
      expect(rendition.toLowerCase()).toMatch(/waitlist/);
    }
  });

  it("both renditions carry the fixture's when and where", () => {
    const { html, text } = renderPromotionEmail(BASE);
    for (const rendition of [html, text]) {
      expect(rendition).toContain(BASE.venueName);
      expect(rendition).toContain(BASE.kicksOffAtLocal);
    }
  });

  it("both renditions contain both response links", () => {
    const { html, text } = renderPromotionEmail(BASE);
    for (const rendition of [html, text]) {
      expect(rendition).toContain(BASE.respondInUrl);
      expect(rendition).toContain(BASE.respondOutUrl);
    }
  });

  it("the 'can't make it' link is offered, so a promoted player can hand the spot straight back", () => {
    const { html, text } = renderPromotionEmail(BASE);
    expect(html.toLowerCase()).toMatch(/can.t make it/);
    expect(text.toLowerCase()).toMatch(/can.t make it/);
  });

  it("the accept action is the filled one, matching the reminder's treatment", () => {
    const { html } = renderPromotionEmail(BASE);
    // The `?intent=in` anchor carries the solid background; the `out` one is outlined.
    const inAnchor = html.slice(html.indexOf(`href="${BASE.respondInUrl}"`));
    expect(inAnchor.slice(0, 400)).toContain("background-color:#c67139");
  });

  it("the text rendition contains no HTML tags", () => {
    const { text } = renderPromotionEmail(BASE);
    expect(text).not.toMatch(/<[a-zA-Z!/][^>]*>/);
  });

  it("the unsubscribe/leave link is present in both renditions (BR-22)", () => {
    const { html, text } = renderPromotionEmail(BASE);
    expect(html).toContain(BASE.leaveUrl);
    expect(text).toContain(BASE.leaveUrl);
    expect(html.toLowerCase()).toMatch(/leave/);
    expect(text.toLowerCase()).toMatch(/leave/);
  });

  it("escapes player, venue, and game names in the HTML rendition", () => {
    const dirty: PromotionEmailPayload = {
      ...BASE,
      playerName: '<script>alert("player")</script>',
      venueName: `Nice pitch" onmouseover="alert(1)`,
      gameName: "<b>Thursday</b> Kickabout",
    };
    const { html } = renderPromotionEmail(dirty);

    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain('onmouseover="alert(1)"');
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&quot;");
    expect(html).toContain("&lt;b&gt;Thursday&lt;/b&gt;");
  });

  it("escapes the URLs it embeds, so a quote in one cannot break out of the attribute", () => {
    const { html } = renderPromotionEmail({
      ...BASE,
      respondInUrl: `https://makethe.team/r/tok" onclick="alert(1)`,
    });
    expect(html).not.toContain('onclick="alert(1)"');
    expect(html).toContain("&quot;");
  });

  it("is pure: the same payload renders byte-identically twice", () => {
    expect(renderPromotionEmail(BASE)).toEqual(renderPromotionEmail(BASE));
  });
});

import { describe, expect, it } from "vitest";
import { renderReminderEmail, type ReminderEmailPayload } from "../../../src/notify/templates/reminder.js";

const BASE: ReminderEmailPayload = {
  playerName: "Edward Cooper",
  gameName: "Thursday 7-a-side",
  venueName: "Oxford Sports Park",
  kicksOffAtLocal: "Thursday 13 August, 19:00",
  inCount: 9,
  spotsLeft: 1,
  respondInUrl: "https://makethe.team/r/tok123?intent=in",
  respondOutUrl: "https://makethe.team/r/tok123?intent=out",
  leaveUrl: "https://makethe.team/leave/tok123",
};

describe("renderReminderEmail", () => {
  it("subject names the game and the day", () => {
    const { subject } = renderReminderEmail(BASE);
    expect(subject).toContain(BASE.gameName);
    expect(subject.toLowerCase()).toContain("tomorrow");
  });

  it("both renditions contain both response links", () => {
    const { html, text } = renderReminderEmail(BASE);
    for (const rendition of [html, text]) {
      expect(rendition).toContain(BASE.respondInUrl);
      expect(rendition).toContain(BASE.respondOutUrl);
    }
  });

  it("the text rendition contains no HTML tags", () => {
    const { text } = renderReminderEmail(BASE);
    expect(text).not.toMatch(/<[a-zA-Z!/][^>]*>/);
  });

  it("the unsubscribe/leave link is present in both renditions (BR-22)", () => {
    const { html, text } = renderReminderEmail(BASE);
    expect(html).toContain(BASE.leaveUrl);
    expect(text).toContain(BASE.leaveUrl);
    expect(html.toLowerCase()).toMatch(/leave/);
    expect(text.toLowerCase()).toMatch(/leave/);
  });

  it("escapes player, venue, and game names in the HTML rendition", () => {
    const dirty: ReminderEmailPayload = {
      ...BASE,
      playerName: '<script>alert("player")</script>',
      venueName: `Nice pitch" onmouseover="alert(1)`,
      gameName: "<b>Thursday</b> Kickabout",
    };
    const { html } = renderReminderEmail(dirty);

    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain('onmouseover="alert(1)"');
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&quot;");
    expect(html).toContain("&lt;b&gt;Thursday&lt;/b&gt;");
  });

  it("carries the escaped names into the text rendition unescaped (plain text, not HTML)", () => {
    const dirty: ReminderEmailPayload = {
      ...BASE,
      playerName: "O'Brien",
      venueName: "Bob & Sons Ground",
    };
    const { text } = renderReminderEmail(dirty);
    expect(text).toContain("O'Brien");
    expect(text).toContain("Bob & Sons Ground");
  });

  it("includes the venue, kickoff time, and spots-left count in both renditions", () => {
    const { html, text } = renderReminderEmail(BASE);
    for (const rendition of [html, text]) {
      expect(rendition).toContain(BASE.venueName);
      expect(rendition).toContain(BASE.kicksOffAtLocal);
      expect(rendition).toContain(String(BASE.spotsLeft));
      expect(rendition).toContain(String(BASE.inCount));
    }
  });

  it("never uses forbidden vocabulary in either rendition", () => {
    const { html, text, subject } = renderReminderEmail(BASE);
    for (const rendition of [html.toLowerCase(), text.toLowerCase(), subject.toLowerCase()]) {
      for (const word of ["rsvp", "event", "match", "user"]) expect(rendition).not.toContain(word);
    }
  });

  it("does not claim the tap itself confirms the response — the copy names a second, explicit step", () => {
    const { html, text } = renderReminderEmail(BASE);
    for (const rendition of [html.toLowerCase(), text.toLowerCase()]) {
      expect(rendition).not.toMatch(/click here to confirm/);
      expect(rendition).toMatch(/tap once more to confirm/);
    }
  });

  it("contains no <script> tag under any input (TR-4 applies to email too)", () => {
    const { html } = renderReminderEmail(BASE);
    expect(html).not.toContain("<script");
  });
});

/**
 * M45. Asking "can you play?" of somebody who accepted weeks ago reads as
 * though their answer went missing, so the day-before email confirms instead.
 */
describe("renderReminderEmail, for a player who already holds a slot", () => {
  const CONFIRMED: ReminderEmailPayload = { ...BASE, confirmed: true };

  it("says they are in, and asks nothing", () => {
    const { html, text } = renderReminderEmail(CONFIRMED);

    expect(html).toContain("You&#39;re in.");
    expect(text).toContain("You're in.");
    expect(html).not.toContain(">I'm in<");
    expect(text).not.toContain("I'm in:");
  });

  it("keeps the way out", () => {
    // Load-bearing, not decoration. Every tier release and every promotion in
    // the product is driven by an early dropout, so the one day-before email
    // must carry a way to say "actually, I can't" — a player sent hunting for
    // the app is a player who becomes a no-show instead.
    const { html, text } = renderReminderEmail(CONFIRMED);

    expect(html).toContain(BASE.respondOutUrl);
    expect(html).toContain("Can't make it");
    expect(text).toContain("Can't make it:");
    expect(text).toContain(BASE.respondOutUrl);
  });

  it("keeps the same subject, so it is still findable in an inbox", () => {
    expect(renderReminderEmail(CONFIRMED).subject).toBe(renderReminderEmail(BASE).subject);
  });

  it("still says nothing is recorded until the second tap", () => {
    // The out link behaves exactly as it always did, and the honesty about
    // link-prefetching that the asking copy carries applies to it unchanged.
    const { html, text } = renderReminderEmail(CONFIRMED);

    expect(html).toContain("nothing is recorded until then");
    expect(text).toContain("nothing is recorded until then");
    // Singular now: there is only one link left to describe.
    expect(text).not.toContain("Either link");
  });

  it("leaves the asking copy alone when the flag is absent", () => {
    // The default matters: every caller and test predating M45 means "ask".
    const { html, text } = renderReminderEmail(BASE);

    expect(html).toContain(">I'm in<");
    expect(text).toContain("I'm in:");
    expect(html).not.toContain("You&#39;re in.");
  });
});

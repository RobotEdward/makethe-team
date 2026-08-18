import { describe, expect, it } from "vitest";
import { renderBroadcastEmail, type BroadcastEmailPayload } from "../../../src/notify/templates/broadcast.js";

const base: BroadcastEmailPayload = {
  playerName: "Sam",
  gameName: "Thursday 5-a-side",
  organiserName: "Jamie",
  subject: "Pitch has moved",
  message: "We're on the astro tonight.\n\nBring dark shirts.",
  whenLocal: "Thu 18 Feb, 7:30pm",
  venueName: "Riverside Park",
  leaveUrl: "https://makethe.team/leave/abc",
};

describe("the broadcast email (N-10)", () => {
  it("uses the organiser's subject verbatim", () => {
    expect(renderBroadcastEmail(base).subject).toBe("Pitch has moved");
  });

  it("says who sent it, in both parts", () => {
    const email = renderBroadcastEmail(base);
    expect(email.html).toContain("Jamie");
    expect(email.text).toContain("Jamie");
    expect(email.html).toContain("Thursday 5-a-side");
  });

  it("renders a blank line as a paragraph break and a single newline as a line break", () => {
    const email = renderBroadcastEmail(base);
    expect(email.html).toContain("We&#39;re on the astro tonight.");
    expect(email.html).toContain("Bring dark shirts.");
    const singleLine = renderBroadcastEmail({ ...base, message: "One\nTwo" });
    expect(singleLine.html).toContain("One<br>Two");
  });

  it("escapes everything a person typed", () => {
    // The first template in the catalogue rendering text a person typed. A
    // subject or a message reaching the HTML unescaped is a stored XSS in
    // whatever mail client renders it.
    const email = renderBroadcastEmail({
      ...base,
      subject: `<script>alert("s")</script>`,
      message: `<img src=x onerror=alert(1)> & "quotes"`,
    });
    expect(email.html).not.toContain("<script>");
    expect(email.html).not.toContain("<img src=x");
    expect(email.html).toContain("&lt;script&gt;");
    expect(email.html).toContain("&lt;img src=x");
  });

  it("does not autolink or interpret anything else in the message", () => {
    const email = renderBroadcastEmail({ ...base, message: "See https://example.com and **bold**" });
    expect(email.html).not.toContain("<a href=\"https://example.com\"");
    expect(email.html).not.toContain("<strong>");
    expect(email.html).toContain("**bold**");
  });

  it("carries the fixture's when and where when it has one", () => {
    const email = renderBroadcastEmail(base);
    expect(email.html).toContain("Thu 18 Feb, 7:30pm");
    expect(email.html).toContain("Riverside Park");
  });

  it("says nothing about a fixture for a game-scoped send", () => {
    // A game-scoped broadcast has no fixture. Rendering an empty date line is
    // how "Your first game is null" reaches an inbox (see welcome.ts).
    const email = renderBroadcastEmail({ ...base, whenLocal: null, venueName: null });
    expect(email.html).not.toContain("Riverside Park");
    expect(email.html).not.toContain("undefined");
    expect(email.html).not.toContain("null");
  });

  it("carries a working leave link (BR-22)", () => {
    expect(renderBroadcastEmail(base).html).toContain("https://makethe.team/leave/abc");
    expect(renderBroadcastEmail(base).text).toContain("https://makethe.team/leave/abc");
  });
});

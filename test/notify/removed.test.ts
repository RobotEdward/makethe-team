import { describe, expect, it } from "vitest";
import { renderRemovedEmail } from "../../src/notify/templates/removed.js";

describe("renderRemovedEmail", () => {
  const rendered = renderRemovedEmail({ playerName: "Sam Okafor", gameName: "Thursday 7-a-side" });

  it("names the game in the subject", () => {
    expect(rendered.subject).toContain("Thursday 7-a-side");
  });

  it("greets the player and says they will get no more email about it", () => {
    expect(rendered.text).toContain("Sam Okafor");
    expect(rendered.text).toContain("Thursday 7-a-side");
    expect(rendered.text.toLowerCase()).toContain("no more");
  });

  it("carries no leave link, because there is nothing left to leave", () => {
    // The one email in the catalogue for which BR-22 is satisfied by the
    // subject matter. See the module comment.
    expect(rendered.html).not.toContain("/leave/");
    expect(rendered.text).not.toContain("/leave/");
  });

  it("escapes a name containing markup", () => {
    const nasty = renderRemovedEmail({ playerName: "<script>alert(1)</script>", gameName: "A & B" });
    expect(nasty.html).not.toContain("<script>");
    expect(nasty.html).toContain("&amp;");
  });
});

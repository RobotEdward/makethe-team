import { describe, expect, it } from "vitest";
import {
  renderAttentionEmail,
  type AttentionEmailPayload,
} from "../../../src/notify/templates/attention.js";

/**
 * N-4, the owner attention email. The template is pure (TR-20): no clock, no
 * bindings, no database, no date formatting — every string arriving is
 * already exactly what should be shown.
 */

const BASE: AttentionEmailPayload = {
  ownerName: "Olive Owner",
  gameName: "Thursday 7-a-side",
  venueName: "Oxford Sports Park",
  kicksOffAtLocal: "Thursday 13 August, 19:00",
  problem: { kind: "short", inCount: 8, minPlayers: 10 },
  inPlayers: ["Ada", "Blake", "Cleo"],
  nonResponders: ["Dev", "Esme"],
  cancelUrl: "https://makethe.team/cancel/tok.sig",
  ceilingReached: false,
};

function render(overrides: Partial<AttentionEmailPayload> = {}) {
  return renderAttentionEmail({ ...BASE, ...overrides });
}

describe("renderAttentionEmail", () => {
  it("names the game in the subject", () => {
    expect(render().subject).toContain("Thursday 7-a-side");
  });

  it("says how many short, in both renditions", () => {
    const email = render({ problem: { kind: "short", inCount: 8, minPlayers: 10 } });
    expect(email.subject).toContain("2 short");
    expect(email.text).toContain("2 players short");
    expect(email.html).toContain("2 players short");
  });

  it("uses the singular when exactly one short", () => {
    const email = render({ problem: { kind: "short", inCount: 9, minPlayers: 10 } });
    expect(email.text).toContain("1 player short");
    expect(email.text).not.toContain("1 players short");
  });

  it("describes an odd number as a different problem from being short", () => {
    const short = render({ problem: { kind: "short", inCount: 8, minPlayers: 10 } });
    const uneven = render({ problem: { kind: "uneven", inCount: 11 } });

    expect(uneven.subject).not.toEqual(short.subject);
    expect(uneven.text).toContain("odd number");
    expect(uneven.html).toContain("odd number");
    // The two asks are genuinely different: never tell an owner with a full,
    // odd squad that they are short of players.
    expect(uneven.text).not.toContain("short");
    expect(uneven.html).not.toMatch(/\bshort\b/);
  });

  it("lists the current squad and the non-responders separately", () => {
    const email = render();
    expect(email.text).toContain("Ada");
    expect(email.text).toContain("Dev");
    expect(email.html).toContain("Blake");
    expect(email.html).toContain("Esme");
    expect(email.text).toMatch(/In \(3\)/);
    expect(email.text).toMatch(/Not answered yet \(2\)/);
  });

  it("says so plainly when everyone has answered", () => {
    const email = render({ nonResponders: [] });
    expect(email.text).toContain("Everyone has answered");
    expect(email.html).toContain("Everyone has answered");
  });

  it("says so plainly when nobody is in", () => {
    const email = render({ inPlayers: [], problem: { kind: "short", inCount: 0, minPlayers: 10 } });
    expect(email.text).toContain("Nobody is in yet");
    expect(email.html).toContain("Nobody is in yet");
  });

  it("carries the cancel link in both renditions", () => {
    const email = render();
    expect(email.html).toContain('href="https://makethe.team/cancel/tok.sig"');
    expect(email.text).toContain("https://makethe.team/cancel/tok.sig");
  });

  it("escapes every interpolated string in the HTML rendition", () => {
    const email = render({
      ownerName: '<script>alert("x")</script>',
      gameName: "Tom & Jerry's <b>Game</b>",
      venueName: "<img src=x onerror=1>",
      inPlayers: ["<i>Ada</i>"],
      nonResponders: ["<u>Dev</u>"],
      cancelUrl: 'https://makethe.team/cancel/a"b',
    });

    expect(email.html).not.toContain("<script>");
    expect(email.html).not.toContain("<img src=x");
    expect(email.html).not.toContain("<i>Ada</i>");
    expect(email.html).not.toContain("<u>Dev</u>");
    expect(email.html).toContain("&amp;");
    expect(email.html).toContain('href="https://makethe.team/cancel/a&quot;b"');
  });

  it("carries no ceiling warning when the ceiling is not biting", () => {
    const email = render({ ceilingReached: false });
    expect(email.text).not.toContain("daily email limit");
    expect(email.html).not.toContain("daily email limit");
  });

  it("warns about the daily email limit when it is biting (TR-31)", () => {
    const email = render({ ceilingReached: true });
    expect(email.text).toContain("daily email limit");
    expect(email.html).toContain("daily email limit");
  });

  it("pairs every colour with its own background-color", () => {
    // `docs/known-issues.md` carries a dark-mode caveat for the older
    // templates, which set `color` without a matching `background-color` and
    // so become unreadable when a client inverts the page. This template must
    // not add to that list.
    const html = render({ ceilingReached: true }).html;
    for (const style of html.matchAll(/style="([^"]*)"/g)) {
      const declarations = style[1] ?? "";
      if (/(^|;)\s*color:/.test(declarations)) {
        expect(declarations).toMatch(/background-color:/);
      }
    }
  });
});

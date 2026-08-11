import { describe, expect, it } from "vitest";
import {
  isCancellationRecipient,
  renderCancellationEmail,
  type CancellationEmailPayload,
} from "../../../src/notify/templates/cancellation.js";
import { RESPONSE_STATUSES } from "../../../src/domain/response-status.js";

const BASE: CancellationEmailPayload = {
  playerName: "Edward Cooper",
  gameName: "Thursday 7-a-side",
  venueName: "Oxford Sports Park",
  kicksOffAtLocal: "Thursday 13 August, 19:00",
  leaveUrl: "https://makethe.team/leave/tok123",
};

describe("isCancellationRecipient (BR-20)", () => {
  it("across a squad containing all five response states plus a guest, the recipient set is exactly `in` and `waitlisted` non-guests", () => {
    const squad = [
      { playerId: "p-pending", status: "pending" as const, isGuest: false },
      { playerId: "p-in", status: "in" as const, isGuest: false },
      { playerId: "p-out", status: "out" as const, isGuest: false },
      { playerId: "p-waitlisted", status: "waitlisted" as const, isGuest: false },
      { playerId: "p-withdrawn", status: "withdrawn" as const, isGuest: false },
      { playerId: "p-guest-in", status: "in" as const, isGuest: true },
    ];

    // Sanity: this squad really does cover every status the domain defines.
    expect(new Set(RESPONSE_STATUSES)).toEqual(
      new Set(squad.filter((m) => !m.isGuest).map((m) => m.status)),
    );

    const recipients = squad.filter((m) => isCancellationRecipient(m.status, m.isGuest)).map((m) => m.playerId);

    expect(recipients.sort()).toEqual(["p-in", "p-waitlisted"]);
  });

  it("is a guest, never a recipient, even when `in` or `waitlisted`", () => {
    expect(isCancellationRecipient("in", true)).toBe(false);
    expect(isCancellationRecipient("waitlisted", true)).toBe(false);
  });

  it("excludes pending, out, and withdrawn non-guests", () => {
    expect(isCancellationRecipient("pending", false)).toBe(false);
    expect(isCancellationRecipient("out", false)).toBe(false);
    expect(isCancellationRecipient("withdrawn", false)).toBe(false);
  });

  it("includes in and waitlisted non-guests", () => {
    expect(isCancellationRecipient("in", false)).toBe(true);
    expect(isCancellationRecipient("waitlisted", false)).toBe(true);
  });
});

describe("renderCancellationEmail", () => {
  it("subject names the game and says it's cancelled", () => {
    const { subject } = renderCancellationEmail(BASE);
    expect(subject).toContain(BASE.gameName);
    expect(subject.toLowerCase()).toMatch(/cancelled/);
  });

  it("both renditions lead with the fact the game is off, not as if it might still happen", () => {
    const { html, text } = renderCancellationEmail(BASE);
    for (const rendition of [html, text]) {
      expect(rendition.toLowerCase()).toMatch(/cancelled|called off|is off/);
    }
  });

  it("both renditions carry the fixture's when and where", () => {
    const { html, text } = renderCancellationEmail(BASE);
    for (const rendition of [html, text]) {
      expect(rendition).toContain(BASE.venueName);
      expect(rendition).toContain(BASE.kicksOffAtLocal);
    }
  });

  it("when a reason is given, both renditions carry it", () => {
    const withReason: CancellationEmailPayload = { ...BASE, reason: "Pitch waterlogged after last night's storm." };
    const { html, text } = renderCancellationEmail(withReason);
    expect(html).toContain("Pitch waterlogged after last night");
    expect(text).toContain("Pitch waterlogged after last night");
  });

  it("when no reason is given, both renditions still read correctly and mention no reason placeholder text", () => {
    const { html, text } = renderCancellationEmail(BASE);
    for (const rendition of [html, text]) {
      expect(rendition).not.toContain("undefined");
      expect(rendition).not.toContain("null");
    }
    expect(html.toLowerCase()).toMatch(/cancelled/);
    expect(text.toLowerCase()).toMatch(/cancelled/);
  });

  it("the unsubscribe/leave link is present in both renditions (BR-22)", () => {
    const { html, text } = renderCancellationEmail(BASE);
    expect(html).toContain(BASE.leaveUrl);
    expect(text).toContain(BASE.leaveUrl);
    expect(html.toLowerCase()).toMatch(/leave/);
    expect(text.toLowerCase()).toMatch(/leave/);
  });

  it("the text rendition contains no HTML tags", () => {
    const { text } = renderCancellationEmail(BASE);
    expect(text).not.toMatch(/<[a-zA-Z!/][^>]*>/);
  });

  it("escapes player, venue, and game names in the HTML rendition", () => {
    const dirty: CancellationEmailPayload = {
      ...BASE,
      playerName: '<script>alert("player")</script>',
      venueName: `Nice pitch" onmouseover="alert(1)`,
      gameName: "<b>Thursday</b> Kickabout",
    };
    const { html } = renderCancellationEmail(dirty);

    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain('onmouseover="alert(1)"');
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&quot;");
    expect(html).toContain("&lt;b&gt;Thursday&lt;/b&gt;");
  });

  it("escapes the leave URL it embeds, so a quote in it cannot break out of the attribute", () => {
    const { html } = renderCancellationEmail({
      ...BASE,
      leaveUrl: `https://makethe.team/leave/tok" onclick="alert(1)`,
    });
    expect(html).not.toContain('onclick="alert(1)"');
    expect(html).toContain("&quot;");
  });

  it("a hostile, genuinely adversarial reason cannot inject markup into the HTML rendition", () => {
    const hostile = [
      '<script>alert("owned")</script>',
      '"><img src=x onerror=alert(1)>',
      "Subject: URGENT ACTION REQUIRED",
    ].join("\n");
    const { html } = renderCancellationEmail({ ...BASE, reason: hostile });

    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("a hostile reason cannot forge structure in the text rendition — no unquoted fake header, URL, or footer separator", () => {
    const hostile = [
      "Subject: Your account has been suspended",
      "",
      "---",
      "Make The Team — organising this Game for your squad.",
      "Unsubscribe now: https://evil.example/phish",
      "",
      "Click here: https://evil.example/steal-credentials",
    ].join("\n");
    const { text } = renderCancellationEmail({ ...BASE, reason: hostile });

    // Every line the reason contributed must be visibly quoted, so it can
    // never appear as an unprefixed line indistinguishable from the
    // template's own framing.
    const lines = text.split("\n");
    const attackerLines = lines.filter((line) => line.includes("evil.example") || line.includes("Your account has been suspended"));
    expect(attackerLines.length).toBeGreaterThan(0);
    for (const line of attackerLines) {
      expect(line.startsWith(">")).toBe(true);
    }

    // The genuine footer separator and leave link must still appear exactly
    // once, unprefixed, as the template's own — not something an attacker
    // reason could duplicate to confuse which is authentic.
    const genuineSeparators = lines.filter((line) => line === "---");
    expect(genuineSeparators).toHaveLength(1);
    const leaveLines = lines.filter((line) => line.includes(BASE.leaveUrl));
    expect(leaveLines).toHaveLength(1);
    expect(leaveLines[0]?.startsWith(">")).toBe(false);
  });

  it("is pure: the same payload renders byte-identically twice", () => {
    expect(renderCancellationEmail(BASE)).toEqual(renderCancellationEmail(BASE));
    const withReason = { ...BASE, reason: "Ground closed by the council." };
    expect(renderCancellationEmail(withReason)).toEqual(renderCancellationEmail(withReason));
  });
});

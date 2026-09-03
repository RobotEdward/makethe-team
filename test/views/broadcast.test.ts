import { describe, expect, it } from "vitest";
import { renderBroadcastPage, type BroadcastPageParams } from "../../src/views/broadcast.js";
import { AUDIENCE_LABELS, type BroadcastAudience } from "../../src/domain/broadcast-audience.js";
import type { BroadcastFormValues } from "../../src/domain/broadcast-form.js";
import { escapeHtml } from "../../src/views/layout.js";
import { FORM_CSS, NOTIFY_MATRIX_CSS, WHATSAPP_CSS } from "../../src/views/styles.js";
import { BROADCAST_WHATSAPP_JS } from "../../src/views/scripts.js";

const COUNTS: Record<BroadcastAudience, number> = {
  everyone: 18,
  playing: 12,
  waitlisted: 3,
  pending: 2,
  unavailable: 1,
};

const VALUES: BroadcastFormValues = {
  subject: "",
  message: "",
  email: true,
  push: true,
  audience: "playing",
};

const BASE: BroadcastPageParams = {
  nav: { isAdmin: false, current: "games" } as const,
  gameId: "g-1",
  gameName: "Thursday 7-a-side",
  fixture: { id: "f-1", whenLocal: "Thu 20 Aug, 7:00pm" },
  counts: COUNTS,
  reachableCount: 12,
  values: VALUES,
  offered: { email: true, push: true },
};

function params(over: Partial<BroadcastPageParams> = {}): BroadcastPageParams {
  return { ...BASE, ...over };
}

describe("renderBroadcastPage", () => {
  it("renders four audience radios on the fixture page, named by AUDIENCE_LABELS, with playing checked and each carrying its count", () => {
    const html = renderBroadcastPage(params());
    for (const [audience, label] of Object.entries(AUDIENCE_LABELS) as [BroadcastAudience, string][]) {
      if (audience === "everyone") continue;
      expect(html).toContain(escapeCount(label, COUNTS[audience]));
    }
    expect(html).toMatch(/id="audience-playing"[^>]*checked/);
    expect((html.match(/type="radio" name="audience"/g) ?? []).length).toBe(4);
  });

  it("renders no audience radios on the game page, and says it goes to everyone", () => {
    const html = renderBroadcastPage(params({ fixture: undefined }));
    expect(html).not.toContain('name="audience"');
    expect(html).toContain("everyone in the squad");
  });

  it("renders both channel checkboxes, both checked by default", () => {
    const html = renderBroadcastPage(params());
    expect(html).toMatch(/id="email"[^>]*checked/);
    expect(html).toMatch(/id="push"[^>]*checked/);
  });

  it("omits a channel's checkbox and explains why when the administrator does not offer it (M37)", () => {
    const html = renderBroadcastPage(params({ offered: { email: false, push: true } }));
    expect(html).not.toContain('name="email"');
    expect(html).toMatch(/id="push"[^>]*checked/);
    expect(html).toContain("Email is switched off for everyone by the site administrator.");
  });

  it("names the channel-aware reachable count on the submit button, not the audience's own count", () => {
    // `reachableCount` is the audience narrowed by the ticked channels; the
    // radio still shows the audience's channel-agnostic 3.
    const html = renderBroadcastPage(
      params({ values: { ...VALUES, audience: "waitlisted", push: false }, reachableCount: 2 }),
    );
    expect(html).toContain("Send to 2 players");
    expect(html).not.toContain("Send to 3 players");
    expect(html).toContain(escapeCount(AUDIENCE_LABELS.waitlisted, 3));
  });

  it("names the reachable count on the game-scoped submit button", () => {
    const html = renderBroadcastPage(params({ fixture: undefined, reachableCount: 18 }));
    expect(html).toContain("Send to 18 players");
  });

  it("says one player, not one players", () => {
    const html = renderBroadcastPage(params({ reachableCount: 1 }));
    expect(html).toContain("Send to 1 player<");
  });

  it("proposes no no-op at zero, and leaves the button enabled so the server refusal explains why", () => {
    const html = renderBroadcastPage(params({ reachableCount: 0 }));
    expect(html).toContain("Nobody to send to");
    expect(html).not.toContain("Send to 0 players");
    expect(html).not.toMatch(/<button[^>]*disabled/);
  });

  it("does not read as a second problem when the channel selection is what failed", () => {
    // No channel ticked makes the reachable count zero by arithmetic, not
    // because the audience is empty; "Nobody to send to" beside "Pick at
    // least one way to send this" would name a problem that isn't there.
    const html = renderBroadcastPage(
      params({
        values: { ...VALUES, email: false, push: false },
        reachableCount: 0,
        errors: [{ field: "channels", message: "Pick at least one way to send this — email, push, or both." }],
      }),
    );
    expect(html).toContain("Pick at least one way to send this");
    expect(html).not.toContain("Nobody to send to");
    expect(html).toContain("Send to 12 players");
  });

  it("posts to the fixture-scoped action on the fixture page", () => {
    const html = renderBroadcastPage(params());
    expect(html).toContain('method="post"');
    expect(html).toContain('action="/g/g-1/f/f-1/message"');
  });

  it("posts to the game-scoped action on the game page", () => {
    const html = renderBroadcastPage(params({ fixture: undefined }));
    expect(html).toContain('action="/g/g-1/message"');
  });

  it("escapes a game name containing markup, everywhere it appears", () => {
    const html = renderBroadcastPage(params({ gameName: `<script>alert(1)</script>` }));
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("re-renders a submitted subject and message with markup escaped, and a textarea-closing message does not close the textarea", () => {
    const html = renderBroadcastPage(
      params({
        values: {
          ...VALUES,
          subject: `<b>hi</b>`,
          message: `</textarea><script>alert(1)</script>`,
        },
      }),
    );
    expect(html).not.toContain("</textarea><script>");
    expect(html).toContain("&lt;/textarea&gt;&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;b&gt;hi&lt;/b&gt;");
    // Exactly one real closing tag: the textarea's own.
    expect((html.match(/<\/textarea>/g) ?? []).length).toBe(1);
  });

  it("renders field errors against their fields, and a problem above the form", () => {
    const html = renderBroadcastPage(
      params({
        problem: "You've already sent the daily limit of messages for this squad.",
        errors: [
          { field: "subject", message: "Give the message a subject." },
          { field: "message", message: "Write a message." },
          { field: "channels", message: "Pick at least one way to send this — email, push, or both." },
        ],
      }),
    );
    expect(html).toContain("You&#39;ve already sent the daily limit");
    expect(html).toContain("Give the message a subject.");
    expect(html).toContain("Write a message.");
    expect(html).toContain("Pick at least one way to send this");
    const problemAt = html.indexOf("daily limit");
    const formAt = html.indexOf("<form");
    expect(problemAt).toBeGreaterThan(-1);
    expect(formAt).toBeGreaterThan(-1);
    expect(problemAt).toBeLessThan(formAt);
  });

  it("does not imply a forged audience selection was what was submitted", () => {
    const html = renderBroadcastPage(
      params({
        // The parser substitutes the default audience for a forged value —
        // there is no radio for a value that isn't one of the four — so the
        // error text must not read as "you picked Playing".
        values: { ...VALUES, audience: "playing" },
        errors: [{ field: "audience", message: "Pick who this message goes to." }],
      }),
    );
    expect(html).toContain("Pick who this message goes to.");
    expect(html).not.toMatch(/you (picked|selected|chose)/i);
  });

  it("passes FORM_CSS in pageStyles and emits no style attribute", () => {
    const html = renderBroadcastPage(params());
    expect(html.indexOf(FORM_CSS)).toBeGreaterThan(-1);
    expect(html).not.toMatch(/style="/);
  });

  // Task 8 left `.notify-admin-off` (channelControl's disabled-channel hint)
  // with no declared style — a class the browser drops silently. This block
  // is what declares it; the page must actually ship it.
  it("ships NOTIFY_MATRIX_CSS, which declares .notify-admin-off", () => {
    const html = renderBroadcastPage(params());
    expect(html.indexOf(NOTIFY_MATRIX_CSS)).toBeGreaterThan(-1);
  });

  it("links back to the fixture page when fixture-scoped", () => {
    const html = renderBroadcastPage(params());
    expect(html).toContain('class="back-link"');
    expect(html).toContain('href="/g/g-1/f/f-1"');
  });

  it("links back to the game page when game-scoped", () => {
    const html = renderBroadcastPage(params({ fixture: undefined }));
    expect(html).toContain('href="/g/g-1"');
  });
});

function escapeCount(label: string, n: number): string {
  return `${escapeHtml(label)} (${n})`;
}

describe("Post to WhatsApp too (M22)", () => {
  it("ships a hidden panel with a wa.me anchor for the script to fill, the script, and the card's styles", () => {
    const html = renderBroadcastPage(BASE);
    expect(html).toContain('<div class="whatsapp" id="whatsapp" hidden>');
    expect(html).toContain('<a class="button" id="whatsapp-link" href="https://wa.me/?text=" target="_blank" rel="noopener">Open in WhatsApp</a>');
    expect(html).toContain(BROADCAST_WHATSAPP_JS);
    expect(html).toContain(WHATSAPP_CSS);
  });

  it("renders every id the script looks up, so it cannot silently no-op", () => {
    const html = renderBroadcastPage(BASE);
    const ids = [...BROADCAST_WHATSAPP_JS.matchAll(/getElementById\("([^"]+)"\)/g)].map((m) => m[1]!);
    expect(ids.length).toBe(4);
    for (const id of ids) expect(html, id).toContain(`id="${id}"`);
  });

  it("keeps the anchor outside the form, so tapping it cannot submit", () => {
    const html = renderBroadcastPage(BASE);
    expect(html.indexOf("</form>")).toBeLessThan(html.indexOf('id="whatsapp-link"'));
  });
});

/**
 * An audience with nobody in it cannot be sent to, and the page should say so
 * before the organiser writes a message rather than after (M52).
 *
 * The radios previously rendered identically at any count, so "Playing (0)"
 * looked as available as "Not answered yet (3)" — and since the form opened on
 * `playing` regardless, the usual first sight of this page was an empty
 * audience selected and a primary button reading "Nobody to send to".
 */
describe("renderBroadcastPage empty audiences", () => {
  const empties: Record<BroadcastAudience, number> = {
    everyone: 0,
    playing: 0,
    waitlisted: 0,
    pending: 0,
    unavailable: 0,
  };

  it("disables an audience nobody is in", () => {
    const html = renderBroadcastPage(
      params({ counts: { ...COUNTS, waitlisted: 0 }, values: { ...VALUES, audience: "playing" } }),
    );

    expect(html).toMatch(/id="audience-waitlisted"[^>]*disabled/);
    expect(html).not.toMatch(/id="audience-playing"[^>]*disabled/);
  });

  it("marks the empty label so the reason is visible, not just the count", () => {
    const html = renderBroadcastPage(params({ counts: { ...COUNTS, pending: 0 } }));

    expect(html).toContain("audience-none");
  });

  /**
   * Never the checked one: a disabled radio that is also checked is a form
   * whose selected value cannot be submitted, and browsers differ on what they
   * then send.
   */
  it("never disables the audience it has checked", () => {
    const html = renderBroadcastPage(
      params({ counts: empties, values: { ...VALUES, audience: "playing" } }),
    );

    expect(html).not.toMatch(/id="audience-playing"[^>]*disabled/);
  });

  it("says plainly when there is nobody to message at all", () => {
    const html = renderBroadcastPage(
      params({ counts: empties, reachableCount: 0, values: { ...VALUES, audience: "playing" } }),
    );

    expect(html).toContain("Nobody has answered this fixture yet");
  });

  it("says nothing of the kind when somebody is reachable", () => {
    expect(renderBroadcastPage(params())).not.toContain("Nobody has answered this fixture yet");
  });
});


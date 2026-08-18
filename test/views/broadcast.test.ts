import { describe, expect, it } from "vitest";
import { renderBroadcastPage, type BroadcastPageParams } from "../../src/views/broadcast.js";
import { AUDIENCE_LABELS, type BroadcastAudience } from "../../src/domain/broadcast-audience.js";
import type { BroadcastFormValues } from "../../src/domain/broadcast-form.js";
import { escapeHtml } from "../../src/views/layout.js";
import { FORM_CSS } from "../../src/views/styles.js";

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
  gameId: "g-1",
  gameName: "Thursday 7-a-side",
  fixture: { id: "f-1", whenLocal: "Thu 20 Aug, 7:00pm" },
  counts: COUNTS,
  values: VALUES,
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

  it("names the count for the selected audience on the submit button", () => {
    const html = renderBroadcastPage(params({ values: { ...VALUES, audience: "waitlisted" } }));
    expect(html).toContain("Send to 3 players");
  });

  it("names the count for everyone on the game-scoped submit button", () => {
    const html = renderBroadcastPage(params({ fixture: undefined }));
    expect(html).toContain("Send to 18 players");
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

import { describe, expect, it } from "vitest";
import { linkIdFor, renderWhatsAppCard, WHATSAPP_CARD_ID } from "../../src/views/whatsapp.js";
import { PAGE_STYLE_BLOCKS, WHATSAPP_CSS } from "../../src/views/styles.js";
import { BROADCAST_WHATSAPP_JS, COPY_BUTTON_JS, PAGE_SCRIPT_BLOCKS, WHATSAPP_LINKS_JS } from "../../src/views/scripts.js";
import { broadcastMessage } from "../../src/domain/whatsapp-message.js";

describe("renderWhatsAppCard", () => {
  const one = renderWhatsAppCard({
    messages: [{ id: "whatsapp-open", label: "Numbers", text: "A & B <c>\nline two" }],
  });

  it("is a card the nudge's #whatsapp fragment can land on", () => {
    expect(one).toContain(`id="${WHATSAPP_CARD_ID}"`);
    expect(WHATSAPP_CARD_ID).toBe("whatsapp");
    expect(one).toContain("<h2>Post to WhatsApp</h2>");
  });

  it("shows the message in a read-only textarea, escaped", () => {
    expect(one).toContain('<textarea id="whatsapp-open"');
    expect(one).toContain("readonly");
    expect(one).toContain("A &amp; B &lt;c&gt;\nline two</textarea>");
  });

  it("links straight into WhatsApp with the text encoded, in a new tab", () => {
    expect(one).toContain(`href="https://wa.me/?text=${encodeURIComponent("A & B <c>\nline two")}"`);
    expect(one).toContain('target="_blank" rel="noopener"');
    expect(one).toContain(">Open in WhatsApp</a>");
  });

  it("ships a hidden Copy button wired to the textarea, for the copy script to reveal", () => {
    expect(one).toContain('data-copy="whatsapp-open" hidden>Copy</button>');
  });

  it("does not label a lone message, and labels each of several", () => {
    expect(one).not.toContain("<h3>");
    const two = renderWhatsAppCard({
      messages: [
        { id: "whatsapp-teams", label: "Teams", text: "t" },
        { id: "whatsapp-open", label: "Numbers", text: "n" },
      ],
    });
    expect(two).toContain("<h3>Teams</h3>");
    expect(two).toContain("<h3>Numbers</h3>");
    expect(two.indexOf("<h3>Teams</h3>")).toBeLessThan(two.indexOf("<h3>Numbers</h3>"));
  });

  it("escapes a label", () => {
    const card = renderWhatsAppCard({
      messages: [
        { id: "a", label: "<b>", text: "x" },
        { id: "b", label: "y", text: "z" },
      ],
    });
    expect(card).toContain("<h3>&lt;b&gt;</h3>");
  });
});

describe("WHATSAPP_CSS", () => {
  it("is registered, so the CSP hashes it and the browser applies it", () => {
    expect(PAGE_STYLE_BLOCKS).toContain(WHATSAPP_CSS);
  });

  it("namespaces every rule under .whatsapp, so it cannot collide with another block at equal specificity", () => {
    const selectors = WHATSAPP_CSS.replace(/\/\*[\s\S]*?\*\//g, "")
      .split("}")
      .map((rule) => rule.split("{")[0]!.trim())
      .filter((selector) => selector !== "");
    expect(selectors.length).toBeGreaterThan(0);
    for (const selector of selectors) {
      for (const part of selector.split(",")) expect(part.trim()).toMatch(/^\.whatsapp\b/);
    }
  });
});

describe("COPY_BUTTON_JS", () => {
  it("is registered, so the CSP hashes it", () => {
    expect(PAGE_SCRIPT_BLOCKS).toContain(COPY_BUTTON_JS);
  });

  it("works from data-copy, not a single hard-coded id, so one block serves every copy button", () => {
    expect(COPY_BUTTON_JS).toContain("[data-copy]");
    expect(COPY_BUTTON_JS).not.toContain('getElementById("invite-copy")');
  });

  it("makes no network request", () => {
    expect(COPY_BUTTON_JS).not.toContain("fetch(");
  });
});

describe("BROADCAST_WHATSAPP_JS", () => {
  it("is registered, so the CSP hashes it", () => {
    expect(PAGE_SCRIPT_BLOCKS).toContain(BROADCAST_WHATSAPP_JS);
  });

  interface FakeField {
    value: string;
    handler: (() => void) | null;
    addEventListener(type: string, handler: () => void): void;
  }
  const field = (value: string): FakeField => ({
    value,
    handler: null,
    addEventListener(type, handler) {
      if (type === "input") this.handler = handler;
    },
  });

  function run(subject: string, message: string, base = "https://wa.me/?text=") {
    const panel = { hidden: true };
    let href = base;
    const link = {
      getAttribute: (name: string) => (name === "href" ? base : null),
      setAttribute: (name: string, value: string) => {
        if (name === "href") href = value;
      },
    };
    const subjectField = field(subject);
    const messageField = field(message);
    const byId: Record<string, unknown> = {
      whatsapp: panel,
      "whatsapp-link": link,
      subject: subjectField,
      message: messageField,
    };
    const documentFake = { getElementById: (id: string) => byId[id] ?? null };
    new Function("document", BROADCAST_WHATSAPP_JS)(documentFake);
    return { panel, href: () => href, subjectField, messageField };
  }

  it("reveals the panel and fills the link from the fields, exactly as broadcastMessage would", () => {
    const { panel, href } = run("Shin pads", "Bring them & boots.");
    expect(panel.hidden).toBe(false);
    expect(href()).toBe(`https://wa.me/?text=${encodeURIComponent(broadcastMessage({ subject: "Shin pads", message: "Bring them & boots." }))}`);
    expect(decodeURIComponent(href().slice("https://wa.me/?text=".length))).toBe("Shin pads\n\nBring them & boots.");
  });

  it("sends the message alone when the subject is blank", () => {
    const { href } = run("   ", "Just this.");
    expect(decodeURIComponent(href().slice("https://wa.me/?text=".length))).toBe("Just this.");
  });

  it("keeps the link in step as the organiser types", () => {
    const { href, subjectField, messageField } = run("", "");
    subjectField.value = "Late";
    subjectField.handler?.();
    messageField.value = "Kick-off is 19:30";
    messageField.handler?.();
    expect(decodeURIComponent(href().slice("https://wa.me/?text=".length))).toBe("Late\n\nKick-off is 19:30");
  });

  it("holds no off-origin URL of its own — the wa.me prefix comes from the anchor", () => {
    expect(BROADCAST_WHATSAPP_JS).not.toContain("wa.me");
    const { href } = run("a", "b", "https://example.test/?q=");
    expect(href().startsWith("https://example.test/?q=")).toBe(true);
  });

  it("leaves the page alone when any of its elements is missing", () => {
    const documentFake = { getElementById: () => null };
    expect(() => new Function("document", BROADCAST_WHATSAPP_JS)(documentFake)).not.toThrow();
  });
});

describe("COPY_BUTTON_JS behaviour", () => {
  function run(options: { hasClipboard: boolean; targetExists: boolean }) {
    const button = {
      hidden: true,
      textContent: "Copy",
      clickHandler: null as (() => void) | null,
      getAttribute: (name: string) => (name === "data-copy" ? "the-field" : null),
      addEventListener(type: string, handler: () => void) {
        if (type === "click") this.clickHandler = handler;
      },
    };
    const written: string[] = [];
    const documentFake = {
      querySelectorAll: (selector: string) => (selector === "button[data-copy]" ? [button] : []),
      getElementById: (id: string) => (id === "the-field" && options.targetExists ? { value: "hello" } : null),
    };
    const navigatorFake = options.hasClipboard
      ? { clipboard: { writeText: (text: string) => (written.push(text), Promise.resolve()) } }
      : {};
    new Function("document", "navigator", "setTimeout", COPY_BUTTON_JS)(documentFake, navigatorFake, () => undefined);
    return { button, written };
  }

  it("reveals a button whose target exists and copies the target's value on click", async () => {
    const { button, written } = run({ hasClipboard: true, targetExists: true });
    expect(button.hidden).toBe(false);
    button.clickHandler?.();
    await Promise.resolve();
    expect(written).toEqual(["hello"]);
    expect(button.textContent).toBe("Copied");
  });

  it("leaves a button hidden when its target is missing, or when there is no clipboard", () => {
    expect(run({ hasClipboard: true, targetExists: false }).button.hidden).toBe(true);
    expect(run({ hasClipboard: false, targetExists: true }).button.hidden).toBe(true);
  });
});

describe("the Include switches (M38)", () => {
  const OPTIONS = [
    { key: "squad" as const, label: "Link for the squad", line: "In or out?: https://makethe.team/g/g1" },
    { key: "invite" as const, label: "Link for someone new", line: "New here?: https://makethe.team/j/t1" },
  ];
  const FIXED = "⚽ Thursday Fives\n9 in so far — 1 more needed.";
  const FULL = [FIXED, ...OPTIONS.map((option) => option.line)].join("\n");

  const card = renderWhatsAppCard({
    messages: [{ id: "whatsapp-open", label: "Numbers", text: FULL, options: OPTIONS }],
  });

  it("renders every line, ticked, so a browser with no scripting gets the whole message", () => {
    // The switches only ever subtract — see `WhatsAppMessage.options`. This is
    // the property that keeps the invite link in the message for a reader
    // whose browser never runs the block below.
    expect(card).toContain(escapeForTextarea(FULL));
    expect(card.match(/<input type="checkbox" checked/g)).toHaveLength(2);
  });

  it("ships the switches hidden, for the script to reveal", () => {
    expect(card).toContain('class="whatsapp-options" data-target="whatsapp-open" hidden');
  });

  it("labels each switch with the words openMessageParts gave it", () => {
    expect(card).toContain("Link for the squad");
    expect(card).toContain("Link for someone new");
  });

  it("gives the wa.me anchor an id, so the script can keep its href in step", () => {
    expect(card).toContain('id="whatsapp-open-link"');
    expect(linkIdFor("whatsapp-open")).toBe("whatsapp-open-link");
  });

  it("renders no switches for a message that has none", () => {
    const plain = renderWhatsAppCard({ messages: [{ id: "a", label: "L", text: "t" }] });
    expect(plain).not.toContain("whatsapp-options");
  });

  it("is registered, so the CSP hashes it", () => {
    expect(PAGE_SCRIPT_BLOCKS).toContain(WHATSAPP_LINKS_JS);
  });

  it("names no off-origin URL of its own", () => {
    expect(WHATSAPP_LINKS_JS).not.toContain("wa.me");
  });

  it("makes no network request", () => {
    expect(WHATSAPP_LINKS_JS).not.toContain("fetch(");
  });

  /** The card's DOM, reduced to what the block actually touches. */
  function run() {
    const base = "https://wa.me/?text=";
    let href = base + encodeURIComponent(FULL);
    const field = { value: FULL };
    const link = {
      getAttribute: (name: string) => (name === "href" ? href : null),
      setAttribute: (name: string, value: string) => {
        if (name === "href") href = value;
      },
    };
    const boxes = OPTIONS.map((option) => ({
      checked: true,
      handler: null as (() => void) | null,
      getAttribute: (name: string) => (name === "data-line" ? option.line : null),
      addEventListener(type: string, handler: () => void) {
        if (type === "change") this.handler = handler;
      },
    }));
    const group = {
      hidden: true,
      getAttribute: (name: string) => (name === "data-target" ? "whatsapp-open" : null),
      querySelectorAll: () => boxes,
    };
    const byId: Record<string, unknown> = { "whatsapp-open": field, "whatsapp-open-link": link };
    const documentFake = {
      querySelectorAll: () => [group],
      getElementById: (id: string) => byId[id] ?? null,
    };
    new Function("document", WHATSAPP_LINKS_JS)(documentFake);
    const change = () => boxes[0]!.handler!();
    return { group, field, boxes, change, text: () => decodeURIComponent(href.slice(base.length)) };
  }

  it("reveals the switches and changes nothing while all are ticked", () => {
    const { group, field, text } = run();
    expect(group.hidden).toBe(false);
    expect(field.value).toBe(FULL);
    expect(text()).toBe(FULL);
  });

  it("drops just the unticked line, from the textarea and the wa.me link alike", () => {
    const { boxes, field, change, text } = run();
    boxes[1]!.checked = false;
    change();

    const expected = [FIXED, OPTIONS[0]!.line].join("\n");
    expect(field.value).toBe(expected);
    expect(text()).toBe(expected);
  });

  it("leaves an announcement with no link when everything is unticked", () => {
    // Deliberately allowed: an organiser posting "we're on for Wednesday" and
    // nothing else is a real message, and there is no minimum to enforce.
    const { boxes, field, change, text } = run();
    boxes[0]!.checked = false;
    boxes[1]!.checked = false;
    change();

    expect(field.value).toBe(FIXED);
    expect(text()).toBe(FIXED);
  });

  it("puts a line back when its box is re-ticked, in message order", () => {
    const { boxes, field, change } = run();
    boxes[0]!.checked = false;
    change();
    expect(field.value).toBe([FIXED, OPTIONS[1]!.line].join("\n"));

    boxes[0]!.checked = true;
    change();
    expect(field.value).toBe(FULL);
  });

  it("does nothing at all when the card is not on the page", () => {
    const documentFake = { querySelectorAll: () => [], getElementById: () => null };
    expect(() => new Function("document", WHATSAPP_LINKS_JS)(documentFake)).not.toThrow();
  });
});

/** The textarea's escaped form, as `escapeHtml` writes it. */
function escapeForTextarea(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

import { describe, expect, it } from "vitest";
import { renderWhatsAppCard, WHATSAPP_CARD_ID } from "../../src/views/whatsapp.js";
import { PAGE_STYLE_BLOCKS, WHATSAPP_CSS } from "../../src/views/styles.js";
import { BROADCAST_WHATSAPP_JS, COPY_BUTTON_JS, PAGE_SCRIPT_BLOCKS } from "../../src/views/scripts.js";
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

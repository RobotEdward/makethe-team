import { describe, expect, it } from "vitest";
import { STYLE_BLOCKS } from "../../src/views/styles.js";

/**
 * Design-system lints for M67 (the aesthetic fixes). Each rule is a global
 * invariant over every registered style block — the same shape as the
 * font-size scale test in `layout.test.ts` — because a rule that holds "on
 * the pages we checked" is how nineteen border radii accumulated.
 *
 * Each starts warn-only and is switched to failing by the phase that makes it
 * true. A rule left warn-only reports its offenders on every run, so the
 * remaining work is always visible.
 */
const ENFORCE = {
  radii: true,
  spacing: true,
  uppercase: true,
  mono: true,
  cardToken: true,
  accentMutToken: true,
};

interface Rule {
  selector: string;
  body: string;
}

/** Every leaf rule in every block, comments stripped, at-rule preludes kept on the selector. */
function rules(): Rule[] {
  const out: Rule[] = [];
  for (const block of STYLE_BLOCKS) {
    const css = block.replace(/\/\*[\s\S]*?\*\//g, "");
    const stack: string[] = [];
    let buffer = "";
    for (const char of css) {
      if (char === "{") {
        stack.push(buffer.trim());
        buffer = "";
      } else if (char === "}") {
        const selector = stack.pop() ?? "";
        if (buffer.trim()) out.push({ selector: [...stack, selector].join(" » "), body: buffer.trim() });
        buffer = "";
      } else {
        buffer += char;
      }
    }
  }
  return out;
}

function declarations(rule: Rule): [string, string][] {
  return rule.body
    .split(";")
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => {
      const colon = d.indexOf(":");
      return [d.slice(0, colon).trim(), d.slice(colon + 1).trim()] as [string, string];
    });
}

function check(name: keyof typeof ENFORCE, offenders: string[]): void {
  if (ENFORCE[name]) {
    expect(offenders, offenders.join("\n")).toEqual([]);
  } else if (offenders.length > 0) {
    console.warn(`[design-lint:${name}] ${offenders.length} offender(s), warn-only:\n  ${offenders.join("\n  ")}`);
  }
}

describe("design-system lints (M67)", () => {
  it("draws every border radius from the three radius tokens, or 50% for dots", () => {
    // The two shapes that are not surfaces: the checkbox's small square
    // corner, and the offline page's app-icon silhouette.
    const EXEMPT: Record<string, string> = { 'input[type="checkbox"]': "6px", ".offline-mark": "22%" };
    const offenders = rules().flatMap((rule) =>
      declarations(rule)
        .filter(([, value]) => EXEMPT[rule.selector.split(" » ").pop() ?? ""] !== value)
        .filter(([prop]) => prop === "border-radius" || /^border-(top|bottom)-(left|right)-radius$/.test(prop))
        .filter(([, value]) => !value.replace(/\s*!important/, "").split(/\s+/).every((v) => v === "0" || v === "50%" || /^var\(--r-(pill|card|field)\)$/.test(v)))
        .map(([prop, value]) => `${rule.selector} { ${prop}: ${value} }`),
    );
    check("radii", offenders);
  });

  it("draws every margin, padding and gap from the spacing tokens", () => {
    // body's page padding is the frame, not rhythm inside it.
    const EXEMPT = new Set(["body"]);
    const offenders = rules().flatMap((rule) =>
      EXEMPT.has(rule.selector)
        ? []
        : declarations(rule)
            .filter(([prop]) => /^(margin|padding)(-(top|right|bottom|left|block|inline)(-(start|end))?)?$|^(row-|column-)?gap$/.test(prop))
            .filter(([, value]) => !value.replace(/\s*!important/, "").split(/\s+(?![^(]*\))/).every((v) => v === "0" || v === "auto" || /^var\(--s-[0-6]\)$/.test(v) || /^calc\(.*var\(--s-[0-6]\).*\)$/.test(v) || /^calc\(\(1\.6em - 20px\) \/ 2\)$/.test(v)))
            .map(([prop, value]) => `${rule.selector} { ${prop}: ${value} }`),
    );
    check("spacing", offenders);
  });

  it("sets no uppercase eyebrows and no wide letter-spacing", () => {
    const offenders = rules().flatMap((rule) =>
      declarations(rule)
        .filter(([prop, value]) => (prop === "text-transform" && value === "uppercase") || (prop === "letter-spacing" && parseFloat(value) > 0.02))
        .map(([prop, value]) => `${rule.selector} { ${prop}: ${value} }`),
    );
    check("uppercase", offenders);
  });

  it("uses the mono face only for copyable text", () => {
    const offenders = rules()
      .filter((rule) => rule.body.includes("var(--mono)") && !/^\.copyable\b/.test(rule.selector.split(" » ").pop() ?? ""))
      .map((rule) => rule.selector);
    check("mono", offenders);
  });

  it("no longer references the retired --card token", () => {
    const offenders = rules().filter((rule) => /var\(--card\)/.test(rule.body)).map((rule) => rule.selector);
    check("cardToken", offenders);
  });

  it("no longer references the retired --accent-mut token", () => {
    const offenders = rules().filter((rule) => rule.body.includes("--accent-mut")).map((rule) => rule.selector);
    check("accentMutToken", offenders);
  });
});

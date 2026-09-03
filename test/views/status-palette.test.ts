import { describe, expect, it } from "vitest";
import {
  RECORD_CSS,
  FIXTURE_STYLES_CSS,
  FIXTURE_STYLES_CSS as STYLES,
  FORM_CSS,
} from "../../src/views/styles.js";

/**
 * §5 of `screens.md` states the palette rule as a product-wide invariant:
 * green is reserved for success and confirmation, amber for the waitlist and
 * for attention. Nothing enforced it, and the rule was broken in the one place
 * it matters most.
 *
 * `.status-badge.status-short` — the badge meaning *this fixture may not
 * happen* — shipped with `--ok-bg`/`--ok-fg`, byte-identical to
 * `.status-open`. Two independent design reviewers found it on the same day,
 * on four different pages, because a badge that says "needs more players" in
 * the reassuring colour is indistinguishable from a healthy one at a glance.
 *
 * This is the enumerating guard the invariant should have had from the start
 * (CLAUDE.md, "Working on a milestone" rule 1): every status badge is listed
 * with the palette pair it is allowed to wear and why. A new badge that is not
 * listed fails, and so does a listed one that changes colour family.
 */

/**
 * The palette families a badge's *background* may draw on.
 *
 * Background rather than the whole declaration, because the background is what
 * carries the signal at a glance — and because `status-cancelled` pairs an
 * accent background with warn-coloured text, so matching anywhere in the rule
 * would put it in two families at once.
 */
type Family = "ok" | "warn" | "muted" | "accent";

const BACKGROUNDS: Record<Family, readonly string[]> = {
  ok: ["--ok-bg", "--ok-fg"],
  warn: ["--warn-bg"],
  muted: ["--field"],
  accent: ["--accent-mut"],
};

const BADGES: readonly { klass: string; family: Family; why: string }[] = [
  {
    klass: "status-confirmed",
    family: "ok",
    why: "The game is on. This is the success state the green is reserved for.",
  },
  {
    klass: "status-short",
    family: "warn",
    why:
      "Needs more players — a fixture that may be called off, and a job for " +
      "the organiser. It wore the success pair until M52; see this file's header.",
  },
  {
    klass: "status-open",
    family: "ok",
    why: "Open for answers and nothing is wrong. Neutral-positive, so green.",
  },
  {
    klass: "status-cancelled",
    family: "accent",
    why: "Called off. Not a warning to act on — it has already happened.",
  },
  {
    klass: "status-played",
    family: "muted",
    why: "Over. Carries no call to action, so it recedes.",
  },
  {
    klass: "status-scheduled",
    family: "muted",
    why: "Not open yet. Nothing to do, so it recedes.",
  },
];

/** The declaration body for one `.status-badge.<klass>` rule. */
function ruleFor(klass: string): string | null {
  const match = new RegExp(
    `\\.status-badge\\.${klass}\\b[^{]*\\{([^}]*)\\}`,
  ).exec(STYLES);
  return match === null ? null : match[1]!;
}

/** The custom property named by that rule's `background`, if any. */
function backgroundToken(rule: string): string | null {
  return /background:\s*var\((--[a-z-]+)\)/.exec(rule)?.[1] ?? null;
}

describe("status badge palette", () => {
  it.each(BADGES)("$klass draws on the $family family — $why", ({ klass, family }) => {
    const rule = ruleFor(klass);
    expect(rule, `no .status-badge.${klass} rule found in STYLES`).not.toBeNull();

    const token = backgroundToken(rule!);
    expect(token, `.status-badge.${klass} sets no background custom property`).not.toBeNull();

    const used = Object.entries(BACKGROUNDS)
      .filter(([, tokens]) => tokens.includes(token!))
      .map(([name]) => name);

    expect(used).toEqual([family]);
  });

  /**
   * The specific confusion that shipped: two badges meaning opposite things
   * rendering identically. Asserted on the rules rather than the families so
   * it still fails if both are moved to the same new pair.
   */
  it("does not render 'needs more players' identically to 'open'", () => {
    expect(ruleFor("status-short")?.trim()).not.toBe(ruleFor("status-open")?.trim());
  });

  /**
   * Every badge class the stylesheet declares must be enumerated above. Without
   * this the guard is only as good as whoever remembered to extend it, which is
   * exactly how the original rule went unenforced.
   */
  it("enumerates every status badge the stylesheet declares", () => {
    const declared = [...STYLES.matchAll(/\.status-badge\.([a-z-]+)/g)].map((m) => m[1]!);

    expect([...new Set(declared)].sort()).toEqual(BADGES.map((b) => b.klass).sort());
  });
});

/**
 * Three separate "it reads as the opposite of what it means" defects, all
 * found by the M52 design review, all one rule each.
 */
describe("controls that read as the wrong thing", () => {
  /**
   * A text input with no border, beside a select the browser draws its own
   * border and chevron on, reads as the disabled one of the pair. Worst on the
   * account page, where the editable Name field sits directly above the
   * read-only email printed as plain text, and the two look equally uneditable.
   */
  it("gives text inputs a resting border, like the selects beside them", () => {
    const rule = /\.field input, \.field select, \.field textarea \{([^}]*)\}/.exec(FORM_CSS)?.[1] ?? "";

    expect(rule, "the shared field rule must not set border: none").not.toMatch(/border:\s*none/);
    expect(rule).toMatch(/border:\s*1px solid/);
  });

  /**
   * At "0 of 14 in" the capacity track was a solid full-width bar in the same
   * grey as the page's section rules, with a zero-width fill over it — so the
   * only mark on screen said "full". Two reviewers read it that way on first
   * look, and it sits exactly where a player checks whether there is a place.
   */
  it("does not paint an empty capacity track in the same ink as a full one", () => {
    const track = /\.capacity \.track \{([^}]*)\}/.exec(FIXTURE_STYLES_CSS)?.[1] ?? "";
    const fill = /\.capacity \.fill \{([^}]*)\}/.exec(FIXTURE_STYLES_CSS)?.[1] ?? "";

    const trackInk = /background:\s*var\((--[a-z-]+)\)/.exec(track)?.[1];
    const fillInk = /background:\s*var\((--[a-z-]+)\)/.exec(fill)?.[1];

    expect(trackInk).toBeDefined();
    expect(trackInk).not.toBe(fillInk);
    // A recessed groove, so an empty track reads as a container rather than as
    // a bar that happens to be the wrong colour.
    expect(track).toMatch(/inset/);
  });

  /**
   * "Your record"'s total row differed from the game rows by font weight
   * alone, and inherited the last row's bottom border as its only separator.
   */
  it("separates the All games total from the rows above it", () => {
    const rule = /table\.record tfoot th, table\.record tfoot td \{([^}]*)\}/.exec(RECORD_CSS)?.[1] ?? "";

    expect(rule).toMatch(/border-top:/);
  });
});

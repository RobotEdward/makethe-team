import { describe, expect, it } from "vitest";
import { STYLES } from "../../src/views/layout.js";

/**
 * WCAG 2.1 relative luminance and contrast ratio. The token block is the
 * single source of every colour in the product, so checking the declared
 * pairs here checks every page at once — the failure this prevents is a
 * palette nudge that quietly drops body text under the AA floor on one
 * theme while the other still reads fine.
 */
function channel(v: number): number {
  const s = v / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}
function luminance(hex: string): number {
  const n = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(n.slice(i, i + 2), 16));
  return 0.2126 * channel(r!) + 0.7152 * channel(g!) + 0.0722 * channel(b!);
}
function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** The declarations of one theme, `--name` -> `#rrggbb`. */
function tokens(theme: "light" | "dark"): Record<string, string> {
  const darkAt = STYLES.indexOf("prefers-color-scheme: dark");
  expect(darkAt).toBeGreaterThan(-1);
  const slice = theme === "light" ? STYLES.slice(0, darkAt) : STYLES.slice(darkAt);
  const out: Record<string, string> = {};
  for (const m of slice.matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{6})/g)) out[m[1]!] = m[2]!;
  return out;
}

/** [foreground token, ground token, minimum ratio]. 4.5 for text, 3 for large/UI. */
const PAIRS: readonly [string, string, number][] = [
  ["--fg", "--bg", 4.5],
  ["--fg", "--card", 4.5],
  ["--fg", "--card-raised", 4.5],
  ["--fg", "--field", 4.5],
  // The going answer block (M20 B7) is an --ok-bg card holding the viewer's
  // headline, which is --fg.
  ["--fg", "--ok-bg", 4.5],
  ["--mut", "--bg", 4.5],
  ["--mut", "--card", 4.5],
  ["--mut", "--card-raised", 4.5],
  // The closed answer block (M20 B7) is a --field card holding the read-only
  // sentence, which is --mut small text.
  ["--mut", "--field", 4.5],
  ["--link", "--bg", 4.5],
  ["--link", "--card", 4.5],
  ["--link", "--card-raised", 4.5],
  // Button text renders at var(--t-lead) bold — WCAG large text, 3:1 floor.
  // Never put small text in these two fills; small text uses the -bg/-fg
  // pale pairs above, which hold the 4.5 floor.
  ["--accent-fg", "--accent", 3],
  ["--danger-fg", "--danger", 3],
  ["--ok-fg", "--ok-bg", 4.5],
  ["--warn", "--warn-bg", 4.5],
  ["--wait-fg", "--wait", 4.5],
  // Accent fills are identified by their AA-passing label text (the
  // --accent-fg/--accent pair above), so WCAG 1.4.11 does not require the
  // fill/ground boundary itself to clear a floor. This pair stays only as a
  // drift tripwire against an accent so pale it stops reading as a fill.
  ["--accent", "--bg", 2.5],
  ["--line", "--bg", 1.2],
];

describe.each(["light", "dark"] as const)("the %s palette", (theme) => {
  const t = tokens(theme);
  it.each(PAIRS)("%s on %s reads at %s:1 or better", (fgTok, bgTok, floor) => {
    expect(t[fgTok], `${fgTok} missing from the ${theme} block`).toBeDefined();
    expect(t[bgTok], `${bgTok} missing from the ${theme} block`).toBeDefined();
    expect(ratio(t[fgTok]!, t[bgTok]!)).toBeGreaterThanOrEqual(floor);
  });
});

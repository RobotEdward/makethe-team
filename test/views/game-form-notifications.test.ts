import { describe, expect, it } from "vitest";
import { renderGameFormPage, ownerNotificationRows, type NotificationRowView } from "../../src/views/game-form.js";
import { FORM_CSS, NOTIFY_MATRIX_CSS } from "../../src/views/styles.js";
import { cellsWithScope } from "../../src/notify/notification-controls.js";
import type { EffectiveSettings } from "../../src/notify/notification-settings.js";

const BASE = {
  nav: { isAdmin: false, current: "games" } as const,
  action: "/x",
  heading: "h",
  submitLabel: "s",
  values: {},
  errors: [],
  warnings: [],
  showAdvanced: true,
  gameId: "g1",
};

/**
 * A stub `EffectiveSettings` — all cells owner-on/admin-on unless overridden
 * — fed through `ownerNotificationRows`, so these tests exercise the same
 * grouping code the route runs rather than hand-built `NotificationRowView`s
 * the real path never produces.
 */
function rows(
  overrides: Partial<Record<string, { ownerWants?: boolean; adminAllows?: boolean }>> = {},
): NotificationRowView[] {
  const settings: EffectiveSettings = {
    isEnabled: () => true,
    adminAllows: (type, channel) => overrides[`${type}.${channel}`]?.adminAllows ?? true,
    ownerWants: (_gameId, type, channel) => overrides[`${type}.${channel}`]?.ownerWants ?? true,
  };
  return ownerNotificationRows("g1", settings);
}

describe("the owner notifications matrix", () => {
  it("renders a header row naming both channels and one row per owner type", () => {
    const html = renderGameFormPage({ ...BASE, notifications: rows() });
    expect(html).toContain("<th>Email</th>");
    expect(html).toContain("<th>Push</th>");
    for (const type of ["n1", "n4", "n9", "n11", "n12", "n13"]) expect(html).toContain(`data-notification="${type}"`);
  });

  it("renders a dash, not a control, for a channel a notification has no version of", () => {
    const html = renderGameFormPage({ ...BASE, notifications: rows() });
    expect(html).not.toContain('name="notify.n11.email"');
    expect(html).not.toContain('name="notify.n11.email.seen"');
    expect(html).toMatch(/data-notification="n11"[\s\S]*?<td class="notify-cell notify-none">—<\/td>/);
  });

  it("renders an administrator-disabled cell unchecked, disabled, without its marker, and says why", () => {
    const html = renderGameFormPage({ ...BASE, notifications: rows({ "n9.email": { ownerWants: true, adminAllows: false } }) });
    expect(html).toMatch(/name="notify\.n9\.email"[^>]*disabled/);
    expect(html).not.toMatch(/name="notify\.n9\.email"[^>]*checked/);
    expect(html).not.toContain('name="notify.n9.email.seen"');
    expect(html).toContain("Email is switched off for everyone by the site administrator. Your own setting is kept and comes back if they turn it on again.");
    // A screen reader announces the checkbox's row and channel even though
    // it is disabled and un-focusable — same accessible name as the enabled
    // branch gives, so a table of "Email"/"Push" columns is not the reader's
    // only way to tell one disabled checkbox from another.
    expect(html).toMatch(/name="notify\.n9\.email"[^>]*aria-label="[^"]+"/);
  });

  it("ticks a cell from the owner's stored value", () => {
    const html = renderGameFormPage({ ...BASE, notifications: rows({ "n1.push": { ownerWants: false } }) });
    expect(html).not.toMatch(/name="notify\.n1\.push"[^>]*checked/);
    expect(html).toMatch(/name="notify\.n1\.email"[^>]*checked/);
  });

  it("does not put matrix rows under .switch-row, whose grid rules would misplace the checkboxes", () => {
    // FORM_CSS's `.switch-row input { grid-column: 2; grid-row: 1 / span 2 }`
    // is what broke the mockup's alignment as soon as a row had a third child.
    const html = renderGameFormPage({ ...BASE, notifications: rows() });
    expect(html).not.toMatch(/class="[^"]*switch-row[^"]*notify-row/);
  });

  it("ships NOTIFY_MATRIX_CSS after FORM_CSS", () => {
    const html = renderGameFormPage({ ...BASE, notifications: rows() });
    const form = html.indexOf(FORM_CSS);
    const matrix = html.indexOf(NOTIFY_MATRIX_CSS);
    expect(form).toBeGreaterThan(-1);
    expect(matrix).toBeGreaterThan(-1);
    expect(form).toBeLessThan(matrix);
  });

  it("uses no inline style attribute", () => {
    expect(renderGameFormPage({ ...BASE, notifications: rows() })).not.toMatch(/ style="/);
  });

  it("covers every owner-scoped catalogue type", () => {
    // A guard on the test's own stub: if the catalogue grows an owner cell,
    // `rows()` must produce a row for it or the tests above pass vacuously.
    const types = new Set(cellsWithScope("owner").map((c) => c.type));
    const rendered = new Set(rows().map((r) => r.type));
    expect(rendered).toEqual(types);
  });
});

/**
 * The Invites fieldset's dependent controls (M52).
 *
 * With "Ask in priority order" off, the fallback select and the invite-order
 * link below it are inert — the order is not consulted at all — but they
 * rendered fully enabled and at full contrast, which the M52 design review
 * read as inert settings presented as live ones.
 *
 * They are dimmed rather than `disabled`, and the dimming is CSS rather than
 * script. Disabling them would stop an owner turning priority order on and
 * setting its fallback in the same pass, which is the only pass most owners
 * will make; and `:has()` lets the state follow the checkbox live with no
 * JavaScript, so it is still right on a page that never runs any.
 */
describe("the Invites fieldset's dependants", () => {
  const render = (gated: boolean) =>
    renderGameFormPage({
      ...BASE,
      values: { gatedInvitesEnabled: gated ? "on" : "" },
      notifications: rows(),
    } as never);

  it("groups them so their state can follow the switch", () => {
    expect(render(false)).toContain("gated-dependants");
    expect(render(true)).toContain("gated-dependants");
  });

  it("says they only apply while priority order is on", () => {
    expect(render(false)).toContain("only while");
  });

  it("leaves them submittable, so one pass can turn it on and set it up", () => {
    // Never `disabled`: an owner ticking the switch and choosing the fallback
    // in the same save is the ordinary case.
    const html = render(false);
    const fieldset = /<fieldset class="notify-group">\s*<legend>Invites<\/legend>([\s\S]*?)<\/fieldset>/.exec(html)?.[1] ?? "";

    expect(fieldset).toContain("gatedFallbackHoursBefore");
    expect(fieldset).not.toContain("disabled");
  });
});

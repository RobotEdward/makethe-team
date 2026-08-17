import { describe, expect, it } from "vitest";
import type { TeamId } from "../../src/domain/teams.js";
import { renderTeamPicker, type TeamPickerParams } from "../../src/views/team-picker.js";

const NAMES: Record<TeamId, string> = { a: "Reds", b: "Bibs" };

const member = (playerId: string, team: TeamId | null) => ({
  playerId,
  name: `Player ${playerId}`,
  erasedAt: null,
  isGuest: false,
  team,
});

const BASE: TeamPickerParams = {
  gameId: "g-1",
  fixtureId: "f-1",
  names: NAMES,
  members: [member("p-1", null), member("p-2", null)],
  counts: { a: 0, b: 0 },
  uneven: false,
  published: false,
  needsAnotherLook: false,
  announcementOutstanding: false,
};

/**
 * Every shape this fragment can be rendered in, by the fields that change what
 * it puts on screen. `unassignedProblem` and `uneven` only add a paragraph, so
 * they are varied once rather than crossed — the buttons are what this file is
 * counting, and a `<p>` cannot become one.
 */
const STATES: readonly { name: string; params: TeamPickerParams }[] = [
  { name: "nobody in yet", params: { ...BASE, members: [] } },
  { name: "nobody picked yet", params: BASE },
  { name: "a part-made pick", params: { ...BASE, members: [member("p-1", "a"), member("p-2", null)] } },
  { name: "a whole pick, unpublished", params: { ...BASE, members: [member("p-1", "a"), member("p-2", "b")], counts: { a: 1, b: 1 } } },
  { name: "the squad moved under an unpublished pick", params: { ...BASE, needsAnotherLook: true } },
  { name: "published, and nothing has changed since", params: { ...BASE, members: [member("p-1", "a"), member("p-2", "b")], published: true } },
  { name: "published, with an announcement now out of date", params: { ...BASE, members: [member("p-1", "a"), member("p-2", "b")], published: true, announcementOutstanding: true } },
  { name: "published, and the squad has moved since", params: { ...BASE, published: true, needsAnotherLook: true } },
  { name: "a publish refused for want of sides", params: { ...BASE, members: [member("p-1", "a"), member("p-2", null)], unassignedProblem: ["Player p-2"] } },
  { name: "uneven sides", params: { ...BASE, members: [member("p-1", "a"), member("p-2", null)], uneven: true, counts: { a: 1, b: 0 } } },
];

/** `.button.primary` and `.button.danger` — the two filled treatments. */
const filledButtons = (html: string) => html.match(/class="button (?:primary|danger)"/g) ?? [];

describe("one filled button per screen", () => {
  it.each(STATES)("spends at most one fill on $name", ({ name, params }) => {
    const html = renderTeamPicker(params);
    // M12 §2.2 — never two fills on one screen, and this fragment is a whole
    // screen's worth: the picker's form and the publish form are both on it
    // for the whole of a fixture's picking life.
    expect(
      filledButtons(html).length,
      `${name} renders ${filledButtons(html).length} filled buttons`,
    ).toBeLessThanOrEqual(1);
  });

  it("gives the fill to the act that emails the squad, not to the one that tells nobody", () => {
    const html = renderTeamPicker({ ...BASE, members: [member("p-1", "a"), member("p-2", "b")] });
    expect(html).toContain(`<button class="button primary" type="submit">Publish teams</button>`);
    expect(html).toContain(`<button class="button" type="submit">Save teams</button>`);
  });

  it("keeps both buttons pressable with scripting off", () => {
    // The class change is presentation only: both are still submits inside
    // their own real form, which is what makes the picker work without the
    // drag-and-drop enhancement.
    const html = renderTeamPicker({ ...BASE, members: [member("p-1", "a"), member("p-2", "b")] });
    expect(html).toContain(`action="/g/g-1/f/f-1/teams"`);
    expect(html).toContain(`action="/g/g-1/f/f-1/teams/publish"`);
    expect(html.match(/type="submit"/g)).toHaveLength(2);
  });
});

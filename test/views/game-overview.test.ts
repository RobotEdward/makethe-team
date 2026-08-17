import { describe, expect, it } from "vitest";
import { LIFECYCLES, type Lifecycle } from "../../src/domain/lifecycle.js";
import { fixtureStatusWords } from "../../src/views/fixture.js";
import { renderGameOverviewPage } from "../../src/views/game-overview.js";
import { FIXTURE_STYLES_CSS, FORM_CSS, INVITE_CSS, SQUAD_STYLES_CSS } from "../../src/views/styles.js";

const BASE = {
  gameId: "g-1",
  gameName: "Thursday 7-a-side",
  venueName: "Venue Name",
  venueAddress: null,
  timezone: "Europe/London",
  maxPlayers: 14,
  prefersEvenNumbers: true,
  inviteToken: "invite-token",
  squad: [] as Array<{ playerId: string; name: string; role: "player" | "owner"; isGuest: boolean }>,
  upcoming: [] as Array<{ id: string; kicksOffAt: Date; lifecycle: Lifecycle; inCount: number }>,
};

const KICKOFF = new Date("2026-03-05T19:00:00Z");

const render = (overrides: Partial<typeof BASE> = {}) =>
  renderGameOverviewPage({ ...BASE, viewerPlayerId: "p-owner", ...overrides });

describe("squad controls", () => {
  const squad = [
    { playerId: "p-owner", name: "Edward Charles", role: "owner" as const, isGuest: false },
    { playerId: "p-sam", name: "Sam Okafor", role: "player" as const, isGuest: false },
  ];

  it("offers a remove link for each member", () => {
    const html = renderGameOverviewPage({ ...BASE, viewerPlayerId: "p-owner", squad });
    expect(html).toContain('href="/g/g-1/squad/p-sam/remove"');
    expect(html).toContain('href="/g/g-1/squad/p-owner/remove"');
  });

  it("offers promotion for a player and demotion for an organiser", () => {
    const html = renderGameOverviewPage({ ...BASE, viewerPlayerId: "p-owner", squad });
    // Extract each member's row and verify the role form's value is opposite to their current role.
    // Sam Okafor (player) should have value="owner"; Edward Charles (organiser) should have value="player".
    // `[^<]` after `<li>` rather than `[\s\S]*?`: the lazy form starts at the
    // *first* `<li>` in the document and runs to the first `</li>` after the
    // name, so Sam's "row" spanned Edward's row too and the assertions below
    // could pass on Edward's markup.
    const samRow = html.match(/<li>(?:(?!<\/li>)[\s\S])*?Sam Okafor[\s\S]*?<\/li>/);
    expect(samRow).toBeTruthy();
    expect(samRow![0]).toContain('action="/g/g-1/squad/p-sam/role"');
    expect(samRow![0]).toContain('value="owner"');

    const edwardRow = html.match(/<li>[\s\S]*?Edward Charles[\s\S]*?<\/li>/);
    expect(edwardRow).toBeTruthy();
    expect(edwardRow![0]).toContain('action="/g/g-1/squad/p-owner/role"');
    expect(edwardRow![0]).toContain('value="player"');
  });

  it("marks the viewer's own row so they know which one they are", () => {
    const html = renderGameOverviewPage({ ...BASE, viewerPlayerId: "p-owner", squad });
    expect(html).toContain("(you)");
  });

  it("shows a problem message when one is passed", () => {
    const html = renderGameOverviewPage({ ...BASE, viewerPlayerId: "p-owner", squad, problem: "Nope." });
    expect(html).toContain("Nope.");
  });

  it("shows no problem message otherwise", () => {
    expect(renderGameOverviewPage({ ...BASE, viewerPlayerId: "p-owner", squad })).not.toContain("class=\"problem\"");
  });

  it("uses no inline style attribute", () => {
    expect(renderGameOverviewPage({ ...BASE, viewerPlayerId: "p-owner", squad })).not.toMatch(/style="/);
  });
});

describe("per-member disclosure (M10 §3.8)", () => {
  const m = (name: string) => ({ playerId: `p-${name}`, name, role: "player" as const, isGuest: false });
  const params = (overrides: Partial<typeof BASE> & { squad: typeof BASE.squad }) => ({
    ...BASE,
    viewerPlayerId: "p-owner",
    ...overrides,
  });

  it("puts role and removal behind a per-member disclosure", () => {
    const html = renderGameOverviewPage(params({ squad: [m("Callum"), m("Freya")] }));
    expect(html).toContain("<summary>Manage</summary>");
    // Both controls still there, and still reachable with no JavaScript —
    // details/summary is a native element, not an enhancement.
    expect(html).toContain("Make an organiser");
    expect(html).toContain(">Remove</a>");
  });

  it("gives every member their own disclosure", () => {
    const html = renderGameOverviewPage(params({ squad: [m("Callum"), m("Freya")] }));
    expect(html.match(/<summary>Manage<\/summary>/g)).toHaveLength(2);
  });
});

describe("the invite card (M12 §4)", () => {
  /**
   * The invite card's markup, anchored on `id="invite-url"` — the one thing
   * inside it that is an identifier rather than a shape.
   *
   * This was a regex running from `<div class="card">` to the first
   * `</form>\s*</div>`, which depended on the rotate form being the card's
   * only form and on the exact whitespace between two closing tags. Reformat
   * the template and it would have kept "passing" while returning a slice
   * that no longer contained what the assertions below check.
   */
  const cardOf = (html: string) => {
    const open = html.indexOf('<div class="card">');
    if (open === -1) return undefined;
    // Walk to the </div> that actually closes it, counting nesting, rather
    // than guessing at the first one that follows some other landmark.
    let depth = 0;
    for (const tag of html.slice(open).matchAll(/<div\b|<\/div>/g)) {
      depth += tag[0] === "</div>" ? -1 : 1;
      if (depth === 0) {
        const card = html.slice(open, open + tag.index + "</div>".length);
        return card.includes('id="invite-url"') ? card : undefined;
      }
    }
    return undefined;
  };

  it("puts the link, its QR and the rotate form in one card", () => {
    const card = cardOf(render());
    expect(card).toBeDefined();
    // All three, inside the *card* — not merely somewhere in the document,
    // which was true before the card existed.
    expect(card).toContain('<div class="invite-link">');
    expect(card).toContain('<details class="qr-toggle">');
    expect(card).toContain('action="/g/g-1/invite/rotate"');
  });

  it("folds the QR away behind a native disclosure, not a script", () => {
    const html = render();
    expect(html).toContain('<details class="qr-toggle">');
    expect(html).toContain("<summary>Show the QR code</summary>");
    // The QR lives inside that details, so a browser with scripting off still
    // opens it. A second script on this page would mean it does not.
    expect(html).toMatch(/<details class="qr-toggle">\s*<summary>Show the QR code<\/summary>\s*<div class="qr">/);
    expect(html.match(/<script/g) ?? []).toHaveLength(1);
  });

  it("keeps the rotate form an outlined button, not a second filled one", () => {
    const card = cardOf(render())!;
    expect(card).toContain('<button class="button" type="submit">Replace this link</button>');
    expect(card).not.toContain("button primary");
    expect(card).not.toContain("button danger");
  });
});

describe("destructive controls", () => {
  const squad = [{ playerId: "p-sam", name: "Sam Okafor", role: "player" as const, isGuest: false }];

  it("marks removing someone as destructive rather than as ordinary navigation", () => {
    const html = render({ squad });
    expect(html).toContain(
      '<a class="danger-link" href="/g/g-1/squad/p-sam/remove">Remove</a>',
    );
  });

  it("keeps removal a link, so it never becomes a second filled button", () => {
    // M10 §3.2: --danger and --accent must not both appear as fills on one
    // screen, and .danger-link is for links only.
    expect(render({ squad })).not.toMatch(/class="button[^"]*danger/);
  });
});

describe("coming up", () => {
  const fixture = (lifecycle: Lifecycle) => ({ id: "f-1", kicksOffAt: KICKOFF, lifecycle, inCount: 6 });
  const detailOf = (html: string) => html.match(/<span class="detail">([^<]*)<\/span>/)?.[1];

  /**
   * The words each stored lifecycle must reach the page as, written out here
   * rather than read from `fixtureStatusWords`: asserting the page against the
   * same helper it calls would pass however the helper is wired, including not
   * at all. This is the page's own contract with whoever reads it.
   */
  const WORDS: Record<Lifecycle, string> = {
    scheduled: "Not open yet",
    open: "Open for responses",
    cancelled: "Cancelled",
    played: "Played",
  };

  it.each(LIFECYCLES)("says in words what a %s fixture's state is", (lifecycle) => {
    const detail = detailOf(render({ upcoming: [fixture(lifecycle)] }));
    expect(detail).toBe(`${WORDS[lifecycle]} — 6 in`);
  });

  it("never prints the stored lifecycle value at whoever is reading", () => {
    for (const lifecycle of LIFECYCLES) {
      const detail = detailOf(render({ upcoming: [fixture(lifecycle)] }))!;
      // Not a substring check: "Not open yet" contains "open". The row must
      // not *be* the raw token, which is what it used to render.
      expect(detail.startsWith(`${lifecycle},`)).toBe(false);
      expect(detail).not.toBe(`${lifecycle} — 6 in`);
    }
  });

  it("uses the same words the single-fixture page does", () => {
    // One table, not two, or the organiser's page and the player's start
    // disagreeing about what a fixture's state is called.
    for (const lifecycle of LIFECYCLES) {
      expect(WORDS[lifecycle]).toBe(fixtureStatusWords(lifecycle));
    }
  });

  it("does not dress a fixture list as a squad", () => {
    const html = render({ upcoming: [fixture("open")] });
    expect(html).toContain('<ul class="fixtures">');
    // Exactly one squad list on the page — the squad's. A future rule written
    // for a squad row must not be able to reach the fixture list.
    expect(html.match(/<ul class="squad">/g)).toHaveLength(1);
  });

  it("still links each fixture to its own page", () => {
    const html = render({ upcoming: [fixture("open")] });
    expect(html).toContain('href="/g/g-1/f/f-1"');
  });

  it("says so when there is nothing coming up", () => {
    expect(render()).toContain('<ul class="fixtures"><li>No fixtures scheduled.</li></ul>');
  });
});

describe("getting back out", () => {
  it("offers one way back, styled", () => {
    const html = render();
    expect(html).toContain('<p class="back-link"><a href="/app">Back to your games</a></p>');
  });

  it("ships the block that styles it", () => {
    // .back-link's rule is in FIXTURE_STYLES_CSS. Without the block on the
    // page the class is inert — and no fetch-level test runs a CSS engine.
    expect(render()).toContain(FIXTURE_STYLES_CSS);
  });

  it("ships the block that styles the invite card", () => {
    expect(render()).toContain(INVITE_CSS);
  });
});

describe("a lifecycle this build does not know", () => {
  // The column has no CHECK constraint (see the migration), so `Lifecycle` is
  // a claim about the schema, not a guarantee about the rows. A legacy row, a
  // hand-applied fix, or a newer deploy mid-rollout can put a value here that
  // the words table has no entry for. `as never` is how that row is expressed
  // in a test the type system would otherwise forbid writing.
  const LEGACY = "abandoned" as never;
  const row = { id: "f-1", kicksOffAt: KICKOFF, lifecycle: LEGACY, inCount: 6 };

  it("still renders the organiser's page", () => {
    // Not a cosmetic assertion. An unmapped key was `undefined`, and every
    // caller hands the result to escapeHtml, which calls .replace on it — so
    // before the fallback this threw a TypeError and 500'd the whole page.
    // That is strictly worse than the raw token this task replaced, which at
    // least rendered.
    expect(() => render({ upcoming: [row] })).not.toThrow();
  });

  it("says so in words rather than printing nothing or the raw value", () => {
    const detail = render({ upcoming: [row] }).match(/<span class="detail">([^<]*)<\/span>/)?.[1];
    expect(detail).toBe("Status unknown — 6 in");
    expect(detail).not.toContain("undefined");
    expect(detail).not.toContain("abandoned");
  });

  it("does not claim an unreadable fixture is one of the states it knows", () => {
    // "Not open yet" is the tempting fallback and it is a specific claim about
    // a real fixture. Admitting ignorance is cheap; misleading the organiser
    // about whether people can respond is not.
    expect(fixtureStatusWords(LEGACY)).toBe("Status unknown");
    for (const known of LIFECYCLES) {
      expect(fixtureStatusWords(LEGACY)).not.toBe(fixtureStatusWords(known));
    }
  });

  it("still links the fixture, so the organiser can go and look at it", () => {
    expect(render({ upcoming: [row] })).toContain('href="/g/g-1/f/f-1"');
  });
});

describe("the squad list is styled too", () => {
  it("ships the block that draws the squad list's own container", () => {
    // Without SQUAD_STYLES_CSS the squad had no top border while the fixture
    // list right below it did, so on the page this task exists to finish the
    // squad read as the unstyled one.
    expect(render()).toContain(SQUAD_STYLES_CSS);
  });

  it("keeps a squad row a grid, not the flex row SQUAD_STYLES_CSS would impose", () => {
    // Both blocks write `ul.squad > li` at identical specificity, so the one
    // passed last wins. FORM_CSS's grid is deliberate: flex wrapping made a
    // row's shape depend on how long the member's name was, so two rows of
    // identical markup laid out differently (M10 whole-branch review).
    // Ordering is invisible to every other assertion in this file — this is
    // the only thing standing between that bug and a silent return.
    const html = render({ squad: [{ playerId: "p-sam", name: "Sam Okafor", role: "player", isGuest: false }] });
    expect(html.indexOf(SQUAD_STYLES_CSS)).toBeLessThan(html.indexOf(FORM_CSS));
  });
});

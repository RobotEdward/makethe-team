import { describe, expect, it } from "vitest";
import { gamePastFixturesPath } from "../../src/auth/paths.js";
import { LIFECYCLES, type Lifecycle } from "../../src/domain/lifecycle.js";
import type { SquadSignals } from "../../src/domain/presence.js";
import { fixtureStatusWords } from "../../src/views/fixture.js";
import { renderGameOverviewPage } from "../../src/views/game-overview.js";
import { PRESENCE_JS, SERVICE_WORKER_JS } from "../../src/views/scripts.js";
import { FIXTURE_STYLES_CSS, FORM_CSS, INVITE_CSS, SQUAD_STYLES_CSS } from "../../src/views/styles.js";

/** A member nothing is wrong with: no markers on the row (M33). */
const REACHABLE: SquadSignals = {
  notInstalled: false,
  noPush: false,
  deliveryTrouble: false,
  quiet: false,
};

const BASE = {
  nav: { isAdmin: false, current: "games" } as const,
  gameId: "g-1",
  gameName: "Thursday 7-a-side",
  venueName: "Venue Name",
  venueAddress: null,
  timezone: "Europe/London",
  maxPlayers: 14,
  prefersEvenNumbers: true,
  inviteToken: "invite-token",
  archivedOn: null,
  squad: [] as Array<{
    playerId: string;
    name: string;
    role: "player" | "owner";
    isGuest: boolean;
    muted: boolean;
    unconfirmed: boolean;
    signals: SquadSignals;
  }>,
  upcoming: [] as Array<{ id: string; kicksOffAt: Date; lifecycle: Lifecycle; inCount: number }>,
  lastResult: null as { fixtureId: string; words: string } | null,
};

const KICKOFF = new Date("2026-03-05T19:00:00Z");

const render = (overrides: Partial<typeof BASE> = {}) =>
  renderGameOverviewPage({ ...BASE, viewerPlayerId: "p-owner", ...overrides });

describe("squad controls", () => {
  const squad = [
    { playerId: "p-owner", name: "Edward Charles", role: "owner" as const, isGuest: false, muted: false, unconfirmed: false, signals: REACHABLE },
    { playerId: "p-sam", name: "Sam Okafor", role: "player" as const, isGuest: false, muted: false, unconfirmed: false, signals: REACHABLE },
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
  const m = (name: string) => ({ playerId: `p-${name}`, name, role: "player" as const, isGuest: false, muted: false, unconfirmed: false, signals: REACHABLE });
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
    // opens it. A second *page* script here would mean it does not — but M13
    // Task 5 put the site-wide service worker registration on every page, so
    // the raw <script> count is no longer the right thing to assert (it's now
    // 3: SERVICE_WORKER_JS plus this page's two own — the Copy button and,
    // since M24, the freshness bar). Filtered out the same way nine other
    // test files on this branch already do (see
    // test/routes/team-picker.test.ts) so the assertion still means what it
    // says: exactly the scripts this page opts into beyond the site-wide one,
    // and the QR is not among them.
    expect(html).toMatch(/<details class="qr-toggle">\s*<summary>Show the QR code<\/summary>\s*<div class="qr">/);
    // PRESENCE_JS is filtered alongside SERVICE_WORKER_JS for the same
    // reason: M33 put it on every page that carries the signed-in header,
    // so it is not something this page opts into either.
    const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)];
    const ownScripts = scripts.filter(([, , js]) => js !== SERVICE_WORKER_JS && js !== PRESENCE_JS);
    expect(ownScripts).toHaveLength(2);
  });

  it("keeps the rotate form an outlined button, not a second filled one", () => {
    const card = cardOf(render())!;
    expect(card).toContain('<button class="button" type="submit">Replace this link</button>');
    expect(card).not.toContain("button primary");
    expect(card).not.toContain("button danger");
  });

  it("offers a way to message the whole squad, outside the invite card and its rotate form (M15 Task 10)", () => {
    // Its own block, not a control of `POST /invite/rotate`: nested in that
    // form it read as part of replacing the invite link. Still `button`, never
    // `button primary` — the rotate button is this page's one primary action.
    const html = render();
    expect(html).toContain(`<p class="actions"><a class="button" href="/g/g-1/message">Message everyone</a></p>`);
    expect(cardOf(html)!).not.toContain("Message everyone");
  });
});

describe("destructive controls", () => {
  const squad = [
    { playerId: "p-sam", name: "Sam Okafor", role: "player" as const, isGuest: false, muted: false, unconfirmed: false, signals: REACHABLE },
  ];

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

  /**
   * Global Constraint 9's 44px floor. A fixture row measured about 45px, but
   * the only interactive thing in it is an inline `<a>` whose hit area is its
   * own line box — roughly 25px. `min-height` does nothing to an inline box,
   * so `display: flex` is the load-bearing declaration: it blockifies the
   * anchor, and `flex: 1` makes it fill everything the state and count leave.
   *
   * The needle carries its opening brace — a bare selector needle
   * prefix-matches, which is how a `.w-5` assertion earlier in M12 was
   * silently satisfied by `.w-50`'s rule.
   */
  it("gives the fixture link a real tap target instead of a line box", () => {
    expect(INVITE_CSS).toContain("ul.fixtures > li > a {");
    const rule = INVITE_CSS.slice(INVITE_CSS.indexOf("ul.fixtures > li > a {"));
    const body = rule.slice(0, rule.indexOf("}"));
    expect(body).toContain("display: flex");
    expect(body).toContain("min-height: 44px");
    // Never a bare descendant selector reaching into list items: that is how
    // `.squad li` captured `li.chip` and beat `.chip` on specificity once.
    expect(INVITE_CSS).not.toContain(".fixtures a {");
    expect(INVITE_CSS).not.toContain(".fixtures li {");
  });

  it("says so when there is nothing coming up", () => {
    expect(render()).toContain('<ul class="fixtures"><li>No fixtures scheduled.</li></ul>');
  });
});

describe("element ordering (M20 B1)", () => {
  it("puts fixtures first, squad second, invite last", () => {
    const html = render();
    const coming = html.indexOf("Coming up");
    const squad = html.indexOf("Squad (");
    const invite = html.indexOf("Invite people");
    const message = html.indexOf("Message everyone");
    // Presence first: indexOf's -1 sorts before everything, so an absent
    // section would pass the order assertions vacuously.
    for (const at of [coming, squad, invite, message]) expect(at).toBeGreaterThan(-1);
    expect(coming).toBeLessThan(squad);
    expect(squad).toBeLessThan(invite);
    expect(invite).toBeLessThan(message);
  });
});

describe("getting back out", () => {
  it("offers the way back through the header, not a body back link (M16)", () => {
    const html = render();
    expect(html).toContain(`<header class="site-header">`);
    expect(html).not.toContain(`class="back-link"`);
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
    const html = render({
      squad: [
        { playerId: "p-sam", name: "Sam Okafor", role: "player", isGuest: false, muted: false, unconfirmed: false, signals: REACHABLE },
      ],
    });
    const squadAt = html.indexOf(SQUAD_STYLES_CSS);
    const formAt = html.indexOf(FORM_CSS);
    // Both presence assertions are load-bearing, and they belong in this test
    // rather than only in the neighbouring one: `indexOf` returns -1 for an
    // absent block, and -1 is less than everything, so the order comparison
    // passes vacuously on a page that ships neither. `test/views/leave.test.ts`
    // and `test/views/remove-member.test.ts` pair them the same way.
    expect(squadAt).toBeGreaterThan(-1);
    expect(formAt).toBeGreaterThan(-1);
    expect(squadAt).toBeLessThan(formAt);
  });
});

/**
 * The way into the past-fixtures page (M27). A page nothing links to is
 * unreachable except by typing its URL — the failure `renderYourSquadsSection`
 * on the dashboard exists to prevent, which had already happened once for
 * `/g/new`.
 */
describe("game overview — the link to past fixtures (M27)", () => {
  it("links to the game's past fixtures", () => {
    const html = render();
    expect(html).toContain(`href="${gamePastFixturesPath(BASE.gameId)}"`);
  });
});

/**
 * The "Unconfirmed" badge (M39, BR-52): a member seated before confirm-to-join
 * existed, whose `email_verified_at` has stayed null. Guests carry no address
 * to confirm, so the route never marks one even if `unconfirmed` were passed
 * true — the view still asserts that here so a future edit to the row markup
 * can't reintroduce the badge for a guest by rendering `unconfirmed` unguarded.
 */
describe("the unconfirmed badge (M39, BR-52)", () => {
  it("marks a member whose email has never been verified", () => {
    const html = render({
      squad: [
        { playerId: "p-sam", name: "Sam Okafor", role: "player", isGuest: false, muted: false, unconfirmed: true, signals: REACHABLE },
        { playerId: "p-freya", name: "Freya Quinn", role: "player", isGuest: false, muted: false, unconfirmed: false, signals: REACHABLE },
      ],
    });
    const samRow = html.slice(html.indexOf("Sam Okafor"), html.indexOf("Freya Quinn"));
    const freyaRow = html.slice(html.indexOf("Freya Quinn"));
    expect(samRow).toContain('<span class="member-unconfirmed">Unconfirmed</span>');
    expect(freyaRow).not.toContain('<span class="member-unconfirmed">Unconfirmed</span>');
  });
});

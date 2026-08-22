import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../src/db/client.js";
import { getFixtureWithSquad } from "../src/db/queries.js";
import { fixtureView } from "../src/domain/fixture-view.js";
import { teamNames } from "../src/domain/teams.js";
import {
  fixtureStatusWords,
  renderFixturePage,
  renderPublishedTeamsSection,
  renderStatusLine,
  viewerHeadlineOpen,
} from "../src/views/fixture.js";
import { renderDashboardPage } from "../src/views/dashboard.js";
import { renderOwnerFixturePage } from "../src/views/owner-fixture.js";
import { renderPastFixturesPage } from "../src/views/past-fixtures.js";
import { squadStatusLabel } from "../src/views/squad-row.js";
import { audienceSelectsStatus } from "../src/domain/broadcast-audience.js";
import { deriveResult, tally } from "../src/domain/result.js";
import { outcomeNames, renderResultPanel } from "../src/views/result.js";
import type { SquadMember } from "../src/db/queries.js";
import { insertFixture, insertGame, insertMembership, insertPlayer, insertResponse, resetDatabase } from "./support/factories.js";
import { ALLOWED, ORIGIN, signIn } from "./support/sign-in.js";
import { players } from "../src/db/schema.js";
import { ACCOUNT_PATH } from "../src/auth/paths.js";
import { eq } from "drizzle-orm";

/**
 * Every place a value read out of the database is turned into words, and the
 * proof that each of them survives a value this build has never heard of.
 *
 * This file exists because fixing these one at a time demonstrably did not
 * work. The same defect was found four separate times on one branch —
 * `fixtureStatusWords`, then `renderStatusLine` three lines below it, then
 * `squadStatusLabel` and `viewerHeadlineOpen`, and a fifth
 * (`historyStatusLabel`) turned up in a file that had already been fixed once.
 * Each was a lookup keyed by a stored value with no fallback, each returned
 * `undefined`, and `undefined` reaches `escapeHtml`, which calls `.replace` on
 * it and 500s the page.
 *
 * The root cause is one line of schema and one line of type. Every one of
 * these columns is a bare `text NOT NULL` with **no CHECK constraint** —
 * `fixtures.lifecycle` (`migrations/0000_lonely_jack_flag.sql`),
 * `responses.status` (`migrations/0001_gifted_preak.sql`), `responses.team`
 * (`migrations/0010_ambiguous_pyro.sql`). Drizzle's `text(..., { enum })` is a
 * type-level assertion and nothing more, so the union type is a claim about
 * the schema and not a guarantee about the rows. `noUncheckedIndexedAccess`
 * does not help either: indexing a `Record` with a key of its own union type
 * is typed as present, so the compiler sees no `| undefined` to complain
 * about. Nothing in the toolchain catches this. That is what this file is for.
 *
 * A CHECK constraint is the real fix and is recorded as a follow-up; it is a
 * migration, which this milestone does not allow.
 *
 * The sibling invariant is `test/played-fixture-freeze.test.ts`: this file
 * proves a renderer survives a value it has never heard of, that one proves a
 * played fixture's rows never change under one.
 *
 * The value below is what a row like that looks like. `as never` is how it is
 * written in a test the type system would otherwise forbid.
 */
const OUT_OF_UNION = "abandoned" as never;

const KICKOFF = new Date("2026-08-13T18:00:00Z");
const NOW = new Date("2026-08-13T09:00:00Z");

function member(overrides: Partial<SquadMember> = {}): SquadMember {
  return {
    playerId: "p-1",
    name: "Ada Okafor",
    erasedAt: null,
    status: "in",
    team: null,
    waitlistRank: null,
    setBy: null,
    source: "token",
    isGuest: false,
    ...overrides,
  };
}

function facts(lifecycle: "open" | never = "open") {
  return {
    lifecycle,
    kicksOffAt: KICKOFF,
    inCount: 3,
    minPlayers: 8,
    maxPlayers: 10,
    prefersEvenNumbers: false,
    shortWarningOffsetHours: 12,
  };
}

/**
 * The enumeration. One entry per lookup, named for the function that owns it
 * and for the column it reads, so adding a lookup means adding a line here
 * deliberately rather than discovering the omission in production.
 *
 * `reach` feeds the out-of-union value in the way a real request would and
 * returns whatever the reader would see. Every entry is asserted the same way:
 * it must not throw, it must return a string, and that string must not contain
 * "undefined" — the three shapes this defect takes.
 */
const LOOKUPS: readonly { name: string; column: string; reach: () => string }[] = [
  {
    name: "audienceSelectsStatus (src/domain/broadcast-audience.ts)",
    column: "responses.status",
    // Not a rendered value — the function returns a boolean — so the
    // assertions below exercise the shape they can: it must not throw, and
    // the boolean it returns must not have collapsed into the string
    // "undefined" or leaked the raw stored token by way of String().
    reach: () => String(audienceSelectsStatus("playing", OUT_OF_UNION)),
  },
  {
    name: "fixtureStatusWords (src/views/fixture.ts)",
    column: "fixtures.lifecycle",
    reach: () => fixtureStatusWords(OUT_OF_UNION),
  },
  {
    name: "renderStatusLine (src/views/fixture.ts)",
    column: "fixtures.lifecycle",
    reach: () => renderStatusLine(fixtureView({ ...facts(), lifecycle: OUT_OF_UNION }, NOW), 0),
  },
  {
    name: "viewerHeadlineOpen (src/views/fixture.ts)",
    column: "responses.status",
    reach: () => viewerHeadlineOpen({ status: OUT_OF_UNION, waitlistRank: null }),
  },
  {
    name: "viewerHeadlineClosed, via renderFixturePage on a played fixture (src/views/fixture.ts)",
    column: "responses.status",
    // Module-private and reachable only through the page, which is the point:
    // it is guarded by its one caller today, and a fallback that exists only
    // because one caller happens to check is how the missing one next to it
    // stayed invisible.
    reach: () =>
      renderFixturePage({
        gameName: "Thursday 7-a-side",
        venueName: "Oxford Sports Park",
        kicksOffAtLocal: "Thursday 13 August, 19:00",
        view: fixtureView({ ...facts(), lifecycle: "played" }, NOW),
        squad: [member()],
        inCount: 1,
        waitlistCount: 0,
        viewer: { playerId: "p-1", status: OUT_OF_UNION, waitlistRank: null },
        token: "tok-1",
        teams: null,
        intent: null,
        readOnlyReason: "played",
      }),
  },
  {
    name: "squadStatusLabel (src/views/squad-row.ts)",
    column: "responses.status",
    reach: () => squadStatusLabel(member({ status: OUT_OF_UNION })),
  },
  {
    name: "renderOwnerFixturePage's status span (src/views/owner-fixture.ts)",
    column: "responses.status",
    reach: () =>
      renderOwnerFixturePage({
        nav: { isAdmin: false, current: "games" } as const,
        gameId: "g-1",
        gameName: "Thursday 7-a-side",
        fixtureId: "f-1",
        kicksOffAtLocal: "Thursday 13 August, 19:00",
        venueName: "Oxford Sports Park",
        inCount: 1,
        maxPlayers: 10,
        view: fixtureView(facts(), NOW),
        squad: [member({ status: OUT_OF_UNION })],
        viewerPlayerId: "p-1",
        teamNames: { a: "Reds", b: "Blues" },
        prefersEvenNumbers: false,
        teamsPublished: false,
        teamsNeedAnotherLook: false,
        announcementOutstanding: false,
        teamsEmailEnabled: true,
        cancellationReason: null,
      }),
  },
  {
    name: "renderPastFixturesPage's row state (src/views/past-fixtures.ts)",
    column: "fixtures.lifecycle",
    // The lifecycle reaches this page twice per row — once through
    // `fixtureStatusWords` for the words, once as the status badge's own
    // class suffix — and only the first has a fallback. The second is
    // interpolated straight into an attribute, which is why it goes through
    // `escapeHtml` there and why this row is enumerated here (M27).
    reach: () =>
      renderPastFixturesPage({
        nav: { isAdmin: false, current: "games" } as const,
        gameId: "g-1",
        gameName: "Thursday 7-a-side",
        rows: [
          {
            fixtureId: "f-1",
            kicksOffAtLocal: "Thursday 13 August, 19:00",
            lifecycle: OUT_OF_UNION,
            inCount: 3,
          },
        ],
        owner: true,
      }),
  },
  {
    name: "renderDashboardPage's row headline (src/views/dashboard.ts)",
    column: "responses.status",
    reach: () =>
      renderDashboardPage({
        nav: { isAdmin: false, current: "games" } as const,
        playerName: "Ada Okafor",
        rows: [
          {
            fixtureId: "f-1",
            gameId: "g-1",
            gameName: "Thursday 7-a-side",
            venueName: "Oxford Sports Park",
            kicksOffAtLocal: "Thursday 13 August, 19:00",
            view: fixtureView(facts(), NOW),
            waitlistCount: 0,
            myStatus: OUT_OF_UNION,
            owner: false,
          },
        ],
        squads: [],
        resultsNeeded: [],
        recentlyPlayed: null,
      }),
  },
  {
    name: "renderPublishedTeamsSection's side name (src/views/fixture.ts)",
    column: "responses.team",
    reach: () =>
      renderPublishedTeamsSection(
        {
          names: teamNames({ teamAName: "Reds", teamBName: "Blues" }),
          yourSide: OUT_OF_UNION,
          awaitingSide: false,
        },
        [member({ status: "in", team: OUT_OF_UNION })],
      ),
  },
  {
    name: "renderResultPanel, locked branch (src/views/result.ts)",
    column: "fixture_result_claims.outcome",
    reach: () => {
      const names = outcomeNames({ teamAName: "Bibs", teamBName: "Skins" });
      const claims = [
        { playerId: "p-1", outcome: OUT_OF_UNION, scoreA: null, scoreB: null, filedAt: NOW },
      ];
      return renderResultPanel({
        names,
        candidates: tally(claims),
        derived: deriveResult(claims, new Set()),
        locked: true,
        writable: false,
        eligible: true,
        rostered: true,
        yourPlayerId: "p-1",
        deadlineLocal: "Sat 15 Aug, 7:00pm",
        actionPath: "/g/g-1/f/f-1/result",
        clearPath: "/g/g-1/f/f-1/result/clear",
      });
    },
  },
  {
    // The locked branch above reaches `outcomeLabel` through `renderLocked`.
    // The candidate list reaches the same lookup through a different
    // function (`renderRow`, via `renderCandidates`) while the panel is
    // still open to argument -- a separate call site the locked case cannot
    // exercise, and the shape a real claim takes before any lock.
    name: "renderResultPanel, writable candidate list (src/views/result.ts)",
    column: "fixture_result_claims.outcome",
    reach: () => {
      const names = outcomeNames({ teamAName: "Bibs", teamBName: "Skins" });
      const claims = [
        { playerId: "p-1", outcome: OUT_OF_UNION, scoreA: null, scoreB: null, filedAt: NOW },
      ];
      return renderResultPanel({
        names,
        candidates: tally(claims),
        derived: null,
        locked: false,
        writable: true,
        eligible: true,
        rostered: true,
        yourPlayerId: "p-1",
        deadlineLocal: "Sat 15 Aug, 7:00pm",
        actionPath: "/g/g-1/f/f-1/result",
        clearPath: "/g/g-1/f/f-1/result/clear",
      });
    },
  },
];

describe("every stored value this app turns into words", () => {
  it.each(LOOKUPS)("$name survives a $column value it has never heard of", ({ reach }) => {
    let result: string;
    expect(() => {
      result = reach();
    }).not.toThrow();

    expect(typeof result!).toBe("string");
    // The three shapes the defect takes: a throw (above), the literal word
    // "undefined" rendered at a reader, or the raw database token shown as
    // though it were English. The token is checked against the *text* a reader
    // sees, because a page may legitimately carry the stored value in a class
    // attribute, where it is escaped and invisible.
    expect(result!).not.toContain("undefined");
    expect(result!.replace(/<[^>]+>/g, "")).not.toContain(OUT_OF_UNION);
  });
});

/**
 * The two lookups on the account page, which are private to
 * `src/routes/account.ts` and reachable only by asking for the page. Both are
 * in the enumeration because the file has now had one of each: its fixture
 * lookup was fixed in this milestone's first pass, and its response lookup —
 * three functions further down the same file — was still unguarded after it.
 */
describe("the account page's own lookups", () => {
  const db = getDb(env.DB);

  beforeEach(resetDatabase);

  it("renders a history row whose stored values it has never heard of", async () => {
    const { cookie } = await signIn();
    const [viewer] = await db.select().from(players).where(eq(players.email, ALLOWED));
    const me = viewer!.id;
    const gameId = await insertGame(db);
    await insertMembership(db, gameId, me);
    // Both columns at once: the fixture's lifecycle (`fixtureStatusLabel`) and
    // the viewer's own answer (`historyStatusLabel`). Either one alone used to
    // take the whole page down.
    const fixtureId = await insertFixture(db, gameId, {
      lifecycle: OUT_OF_UNION,
      kicksOffAt: KICKOFF,
      venueOverride: "Unreadable row",
    });
    await insertResponse(db, fixtureId, me, { status: OUT_OF_UNION });

    const response = await SELF.fetch(`${ORIGIN}${ACCOUNT_PATH}`, { headers: { cookie }, redirect: "manual" });
    expect(response.status).toBe(200);

    const body = await response.text();
    const start = body.indexOf("Unreadable row");
    expect(start, "expected the row to render at all").toBeGreaterThan(-1);
    const row = body.slice(start, body.indexOf("</li>", start));
    expect(row).toContain("Status unknown");
    expect(row).not.toContain("undefined");
    expect(row).not.toContain(OUT_OF_UNION);
  });
});

describe("the sort key a stored status feeds", () => {
  const db = getDb(env.DB);

  beforeEach(resetDatabase);

  it("puts a row it cannot read somewhere definite instead of returning NaN", async () => {
    // Not a rendering bug and so not caught by anything above: an unmapped key
    // made `SQUAD_ORDER[a.status] - SQUAD_ORDER[b.status]` NaN, and a
    // comparator that returns NaN neither throws nor sorts — it hands back an
    // arbitrary order that changes with the input. The quietest member of this
    // family.
    const gameId = await insertGame(db);
    const fixtureId = await insertFixture(db, gameId, { lifecycle: "open", kicksOffAt: KICKOFF });
    const first = await insertPlayer(db, { name: "Ada", email: "ada@example.test" });
    const odd = await insertPlayer(db, { name: "Nia", email: "nia@example.test" });
    const last = await insertPlayer(db, { name: "Sam", email: "sam@example.test" });
    await insertMembership(db, gameId, first);
    await insertMembership(db, gameId, odd);
    await insertMembership(db, gameId, last);
    await insertResponse(db, fixtureId, first, { status: "in" });
    await insertResponse(db, fixtureId, odd, { status: OUT_OF_UNION });
    await insertResponse(db, fixtureId, last, { status: "out" });

    const withSquad = await getFixtureWithSquad(db, fixtureId);
    expect(withSquad).not.toBeNull();

    const order = withSquad!.squad.map((m) => m.name);
    expect(order).toHaveLength(3);
    // Definite, and last: the two statuses this build understands keep their
    // documented order, and the one it does not goes after both rather than
    // anywhere the comparator happens to land it.
    expect(order).toEqual(["Ada", "Sam", "Nia"]);
  });
});

/**
 * The guard that makes the enumeration above hard to forget rather than merely
 * documented: the source itself, checked for the two shapes this defect has
 * taken every time.
 *
 * `import.meta.glob` is resolved by Vite at transform time, so it works inside
 * the workers pool where `node:fs` does not — the same mechanism
 * `test/views/layout.test.ts` uses to police `centred: true`.
 */
function sources(): Record<string, string> {
  return import.meta.glob("../src/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<
    string,
    string
  >;
}

/** Comments stripped, so prose about a defect cannot look like the defect. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/** The stored columns whose values are unions this build can fail to know. */
const STORED_KEY = /status|lifecycle|\bteam\b|byday/;

/**
 * Lookup sites that are total for a reason the scanner cannot see. Each one is
 * a deliberate entry with the reason written down — which is the point: a new
 * unguarded lookup fails the test, and silencing it costs an explanation.
 */
const TOTAL_BY_CONSTRUCTION: readonly { site: string; why: string; proof: string }[] = [
  {
    site: "names[id]",
    why: "src/views/team-picker.ts — `id` is iterated from the TEAM_IDS literal, never read from a row.",
    proof: "TEAM_IDS.map(side)",
  },
  {
    site: "names[team]",
    why: "src/notify/send-teams.ts — the `inSquad` filter is `isTeamId(member.team)`, so a side this build cannot name never reaches the lookup.",
    proof: "isTeamId(member.team)",
  },
  {
    site: "WEEKDAY_NAMES[rule.byday]",
    why: "src/domain/recurrence/parse.ts — a WeeklyRule only exists via parseRecurrenceRule, which throws RecurrenceError unless BYDAY is one of WEEKDAYS.",
    proof: "isWeekday(byday)",
  },
];

describe("the shapes this defect keeps taking, checked against the source", () => {
  it("gives every switch over a stored value a default", () => {
    const offenders: string[] = [];
    for (const [path, source] of Object.entries(sources())) {
      const text = code(source);
      for (const match of text.matchAll(/switch\s*\(([^)]*)\)\s*\{/g)) {
        if (!STORED_KEY.test(match[1]!)) continue;
        // Walk to the matching brace rather than guessing where the switch
        // ends: several of these have block-bodied cases with braces of their
        // own, and a regex that stopped at the first `}` would read the wrong
        // body and pass.
        const open = match.index! + match[0].length - 1;
        let depth = 0;
        let end = text.length;
        for (let i = open; i < text.length; i++) {
          if (text[i] === "{") depth++;
          else if (text[i] === "}" && --depth === 0) {
            end = i;
            break;
          }
        }
        if (!text.slice(open, end).includes("default:")) {
          offenders.push(`${path.replace(/^(\.\.\/)+/, "")} — switch (${match[1]!.trim()})`);
        }
      }
    }

    expect(
      offenders.sort(),
      "A switch over a value read from the database must have a `default`. " +
        "Without one it returns `undefined` for a row this build has never " +
        "heard of, `escapeHtml` calls `.replace` on that, and the page 500s. " +
        "Every one of these columns is a bare `text NOT NULL` with no CHECK " +
        "constraint, so the union type is a claim about the schema and not a " +
        "guarantee about the rows. Fix: add a `default` returning the same " +
        "wording the rest of the product uses, and add the function to " +
        "LOOKUPS at the top of this file.",
    ).toEqual([]);
  });

  it("gives every table indexed by a stored value a fallback", () => {
    const allowed = new Set(TOTAL_BY_CONSTRUCTION.map((entry) => entry.site));
    const offenders: string[] = [];
    for (const [path, source] of Object.entries(sources())) {
      const text = code(source);
      for (const match of text.matchAll(/\b([A-Z][A-Z_0-9]{2,}|names)\[([^\]]+)\]/g)) {
        const site = match[0];
        const key = match[2]!;
        // `names[...]` is a team-name table whatever it is keyed by; the
        // upper-case tables only count when the key is a stored one.
        if (match[1] !== "names" && !STORED_KEY.test(key)) continue;
        if (allowed.has(site)) continue;
        // The fallback may be a few characters further on than the lookup —
        // `const label = TABLE[key];` then `label ?? FALLBACK` — so the window
        // is the statement and its neighbours rather than the line.
        const window = text.slice(match.index!, match.index! + 200);
        if (!window.includes("??")) {
          offenders.push(`${path.replace(/^(\.\.\/)+/, "")} — ${site}`);
        }
      }
    }

    expect(
      offenders.sort(),
      "A table indexed by a value read from the database needs a `??` " +
        "fallback. `noUncheckedIndexedAccess` will not flag it: indexing a " +
        "Record with a key of its own union type is typed as present, so the " +
        "compiler sees nothing. Fix: add a fallback and an entry in LOOKUPS " +
        "at the top of this file — or, if the key genuinely cannot come from " +
        "a row, add the site to TOTAL_BY_CONSTRUCTION with the reason.",
    ).toEqual([]);
  });

  it("keeps TOTAL_BY_CONSTRUCTION honest", () => {
    // Without this the allowlist rots into a set of strings that permit
    // nothing, and the next real offender can quietly take one of those names.
    const text = Object.values(sources()).map(code).join("\n");
    for (const entry of TOTAL_BY_CONSTRUCTION) {
      expect(text, `${entry.site} is allowlisted but no longer exists: ${entry.why}`).toContain(entry.site);
      // And the thing that makes it total is still there. Without this the
      // allowlist is a promise nobody checks: deleting the filter or the
      // validator that makes one of these safe would leave the site
      // allowlisted and unguarded, which is the exact position this whole
      // file exists to make impossible.
      expect(text, `${entry.site} is allowlisted because: ${entry.why} — but that is no longer true`).toContain(
        entry.proof,
      );
    }
  });
});

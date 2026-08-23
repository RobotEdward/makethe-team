import { describe, expect, it } from "vitest";
import { renderAdminUsagePage, type AdminUsagePageParams } from "../../src/views/admin-usage.js";

const AT = new Date("2026-08-22T19:30:00Z");

const BASE: AdminUsagePageParams = {
  nav: { isAdmin: true, current: "admin" },
  generatedAt: AT,
  scale: {
    games: 3,
    activeMemberships: 41,
    players: 44,
    guests: 2,
    signedIn: 30,
    erased: 1,
    pushDevices: 12,
  },
  recent: {
    gamesCreated: 1,
    fixturesCreated: 4,
    fixturesOpened: 4,
    fixturesCancelled: 0,
    responsesRecorded: 63,
    signIns: 9,
  },
  extended: {
    gamesCreated: 3,
    fixturesCreated: 16,
    fixturesOpened: 15,
    fixturesCancelled: 1,
    responsesRecorded: 240,
    signIns: 34,
  },
  outcomes: {
    total: 12,
    cancelled: 1,
    played: 11,
    reachedMin: 9,
    teamsPublished: 7,
    resultFiled: 5,
  },
  limits: {
    emailsToday: 17,
    notificationFailures: 0,
    unopenedPastFixtures: 0,
    tableRows: [
      { table: "responses", rows: 240 },
      { table: "notification_log", rows: 88 },
    ],
  },
  emailCeiling: 50,
  games: [
    {
      gameId: "g-1",
      name: "Thursday 7-a-side",
      owners: ["Ali Khan", "Sam Doe"],
      squadSize: 18,
      recentFixtures: 4,
      invited: 72,
      responded: 54,
      lastActivityAt: new Date("2026-08-21T18:00:00Z"),
    },
  ],
  gamesShown: 25,
};

describe("renderAdminUsagePage", () => {
  it("stamps when the numbers were read, in UTC", () => {
    expect(renderAdminUsagePage(BASE)).toContain("UTC");
  });

  it("shows the scale figures", () => {
    const html = renderAdminUsagePage(BASE);
    expect(html).toContain("41");
    expect(html).toContain("Active squad places");
  });

  it("shows both windows side by side", () => {
    const html = renderAdminUsagePage(BASE);
    expect(html).toContain("7 days");
    expect(html).toContain("28 days");
  });

  it("shows today's sends against the ceiling", () => {
    expect(renderAdminUsagePage(BASE)).toContain("17 of 50");
  });

  it("turns a response count into a percentage", () => {
    expect(renderAdminUsagePage(BASE)).toContain("75%");
  });

  it("shows a dash rather than a division by zero when nobody was invited", () => {
    const html = renderAdminUsagePage({
      ...BASE,
      games: [{ ...BASE.games[0]!, invited: 0, responded: 0 }],
    });
    expect(html).not.toContain("NaN");
    expect(html).toContain("—");
  });

  it("keeps quiet about unopened past fixtures when there are none", () => {
    expect(renderAdminUsagePage(BASE)).not.toContain("never opened");
  });

  it("flags unopened past fixtures when there are some", () => {
    const html = renderAdminUsagePage({
      ...BASE,
      limits: { ...BASE.limits, unopenedPastFixtures: 3 },
    });
    expect(html).toContain("never opened");
  });

  it("says so rather than rendering an empty table when there are no games", () => {
    const html = renderAdminUsagePage({ ...BASE, games: [] });
    expect(html).toContain("No games yet");
  });

  it("dates a game's last activity to the day, with no time of day", () => {
    // The per-game table has five columns and has to survive a phone. A full
    // timestamp wrapped onto three lines per row and pushed the header labels
    // into hyphenating mid-word.
    const html = renderAdminUsagePage(BASE);
    expect(html).toContain("21 Aug 2026");
    expect(html).not.toContain("21 August at 18:00");
  });

  it("says nothing kicked off rather than talking about a share of zero", () => {
    const html = renderAdminUsagePage({
      ...BASE,
      outcomes: { total: 0, cancelled: 0, played: 0, reachedMin: 0, teamsPublished: 0, resultFiled: 0 },
    });
    expect(html).toContain("No fixtures kicked off in the last 28 days");
    expect(html).not.toContain("share is of the 0");
  });

  it("names the game's owners under the game name", () => {
    const html = renderAdminUsagePage(BASE);
    expect(html).toContain("Ali Khan, Sam Doe");
  });

  it("says so rather than showing a blank when a game has no active owner", () => {
    const html = renderAdminUsagePage({ ...BASE, games: [{ ...BASE.games[0]!, owners: [] }] });
    expect(html).toContain("Nobody");
  });

  it("escapes an owner name", () => {
    const html = renderAdminUsagePage({
      ...BASE,
      games: [{ ...BASE.games[0]!, owners: ["<script>alert(1)</script>"] }],
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes a game name", () => {
    const html = renderAdminUsagePage({
      ...BASE,
      games: [{ ...BASE.games[0]!, name: "<script>alert(1)</script>" }],
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

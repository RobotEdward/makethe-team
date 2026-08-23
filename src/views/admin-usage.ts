import type {
  ActivityCounts,
  GameUsageRow,
  LimitCounts,
  OutcomeCounts,
  ScaleCounts,
} from "../db/usage-queries.js";
import { formatLocalDateTime, formatLocalShortDate } from "../domain/time/zone.js";
import { escapeHtml, layout, type PageNav } from "./layout.js";
import { ADMIN_TOOLS_CSS } from "./styles.js";

export interface AdminUsagePageParams {
  /** The signed-in header (M16); see PageNav in layout.ts. */
  nav: PageNav;
  /** When the route read these numbers. Everything here is a live read. */
  generatedAt: Date;
  scale: ScaleCounts;
  /** The 7-day column. */
  recent: ActivityCounts;
  /** The 28-day column. */
  extended: ActivityCounts;
  /** Fixtures by kickoff over the same 28 days as `extended`. */
  outcomes: OutcomeCounts;
  limits: LimitCounts;
  /** The parsed `MAX_EMAILS_PER_DAY` ceiling the quota enforces. */
  emailCeiling: number;
  games: readonly GameUsageRow[];
  /** The cap the route applied, so the page can say the list is truncated. */
  gamesShown: number;
}

/** Same UTC-and-say-so stamp as the delivery page, for the same reason. */
function utcStamp(at: Date): string {
  return `${formatLocalDateTime(at, "Etc/UTC")} UTC`;
}

/**
 * The day alone, for the per-game table's last column.
 *
 * A full timestamp there wrapped onto three lines on a phone and squeezed the
 * four numeric columns until their headers hyphenated mid-word. Nothing on
 * this page turns on the hour a squad last answered something.
 */
function utcDay(at: Date): string {
  return formatLocalShortDate(at, "Etc/UTC");
}

/**
 * A share as a whole-number percentage, or an em dash.
 *
 * The dash, not "0%", when the denominator is zero: a fixture nobody was
 * asked about has no response rate, and rendering that as 0% would put a
 * game with no invitations next to one everybody ignored and call them the
 * same thing. `NaN%` is what the arithmetic produces unguarded.
 */
function share(part: number, whole: number): string {
  if (whole <= 0) return "—";
  return `${Math.round((part / whole) * 100)}%`;
}

function figure(label: string, value: number): string {
  return `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(String(value))}</dd></div>`;
}

function windowRow(label: string, recent: number, extended: number): string {
  return `<tr>
    <td>${escapeHtml(label)}</td>
    <td class="usage-number">${escapeHtml(String(recent))}</td>
    <td class="usage-number">${escapeHtml(String(extended))}</td>
  </tr>`;
}

function outcomeRow(label: string, value: number, of: number): string {
  return `<tr>
    <td>${escapeHtml(label)}</td>
    <td class="usage-number">${escapeHtml(String(value))}</td>
    <td class="usage-number">${escapeHtml(share(value, of))}</td>
  </tr>`;
}

/**
 * The owners' names, under the game name rather than in a column of their own.
 *
 * A sixth column would squeeze the four numeric ones until their headers
 * hyphenated mid-word on a phone, which is the failure this table already had
 * once. "Nobody" rather than an empty line: a game whose owner has left the
 * squad is the interesting case on this page, and a blank reads as a bug.
 */
function ownerLine(owners: readonly string[]): string {
  const text = owners.length === 0 ? "Nobody" : owners.join(", ");
  return `<span class="usage-owner">${escapeHtml(text)}</span>`;
}

function gameRow(row: GameUsageRow): string {
  return `<tr>
    <td class="usage-name">${escapeHtml(row.name)}${ownerLine(row.owners)}</td>
    <td class="usage-number">${escapeHtml(String(row.squadSize))}</td>
    <td class="usage-number">${escapeHtml(String(row.recentFixtures))}</td>
    <td class="usage-number">${escapeHtml(share(row.responded, row.invited))}</td>
    <td class="usage-day">${escapeHtml(utcDay(row.lastActivityAt))}</td>
  </tr>`;
}

/**
 * The usage screen (M32): is anybody using this, and is it working for them?
 *
 * Every number is a `count(*)` read at request time — there is no rollup
 * table and nothing is cached, so the page cannot go stale and no write path
 * had to learn about it. The cost of that is a page that does a dozen small
 * queries; it is admin-only and loaded by one person occasionally.
 *
 * No chart. Three numbers in a row answer "is this going up" as well as a
 * sparkline would, and a chart would need either a script this page does not
 * have or an inline `style` attribute the CSP would strip.
 */
export function renderAdminUsagePage(params: AdminUsagePageParams): string {
  const { scale, recent, extended, outcomes, limits, games } = params;

  const gamesHtml =
    games.length === 0
      ? `<p>No games yet.</p>`
      : `<div class="usage-scroll"><table class="admin-log">
          <thead><tr>
            <th>Game</th><th class="usage-number">Squad</th>
            <th class="usage-number">Fixtures</th><th class="usage-number">Answered</th>
            <th class="usage-day">Last activity</th>
          </tr></thead>
          <tbody>${games.map(gameRow).join("")}</tbody>
        </table></div>
        ${
          games.length >= params.gamesShown
            ? `<p class="tool-note">Showing the ${escapeHtml(String(params.gamesShown))} most recently active games.</p>`
            : ""
        }`;

  // Only rendered when non-zero. A permanent "0 fixtures never opened" row is
  // a line an operator learns to skip, which is the opposite of what a smell
  // test is for.
  const sweepWarning =
    limits.unopenedPastFixtures === 0
      ? ""
      : `<p class="usage-warning">${escapeHtml(String(limits.unopenedPastFixtures))} fixture(s) reached kickoff having never opened. The hourly sweep may have stopped.</p>`;

  return layout({
    nav: params.nav,
    title: "Usage — Make The Team",
    pageStyles: [ADMIN_TOOLS_CSS],
    body: `
      <h1>Usage</h1>
      <p class="tool-note">Read at ${escapeHtml(utcStamp(params.generatedAt))}.</p>

      <h2>Scale now</h2>
      <dl class="usage-figures">
        ${figure("Games", scale.games)}
        ${figure("Active squad places", scale.activeMemberships)}
        ${figure("People", scale.players)}
        ${figure("Of whom signed in", scale.signedIn)}
        ${figure("Of whom guests", scale.guests)}
        ${figure("Erased", scale.erased)}
        ${figure("Push devices", scale.pushDevices)}
      </dl>

      <h2>Activity</h2>
      <table class="admin-log">
        <thead><tr>
          <th></th><th class="usage-number">7 days</th><th class="usage-number">28 days</th>
        </tr></thead>
        <tbody>
          ${windowRow("Games created", recent.gamesCreated, extended.gamesCreated)}
          ${windowRow("Fixtures created", recent.fixturesCreated, extended.fixturesCreated)}
          ${windowRow("Fixtures opened", recent.fixturesOpened, extended.fixturesOpened)}
          ${windowRow("Fixtures cancelled", recent.fixturesCancelled, extended.fixturesCancelled)}
          ${windowRow("Answers given", recent.responsesRecorded, extended.responsesRecorded)}
          ${windowRow("Sign-ins", recent.signIns, extended.signIns)}
        </tbody>
      </table>

      <h2>Did it work</h2>
      ${
        // The denominator sentence reads as nonsense on a fresh deployment
        // ("the share is of the 0 that went ahead"), which is the first state
        // any new operator sees.
        outcomes.total === 0
          ? `<p class="tool-note">No fixtures kicked off in the last 28 days.</p>`
          : `<p class="tool-note">
              Fixtures that kicked off in the last 28 days: ${escapeHtml(String(outcomes.total))},
              of which ${escapeHtml(String(outcomes.cancelled))} cancelled. The share is of the
              ${escapeHtml(String(outcomes.played))} that went ahead.
            </p>`
      }
      <table class="admin-log">
        <thead><tr>
          <th></th><th class="usage-number">Fixtures</th><th class="usage-number">Share</th>
        </tr></thead>
        <tbody>
          ${outcomeRow("Reached min players", outcomes.reachedMin, outcomes.played)}
          ${outcomeRow("Teams published", outcomes.teamsPublished, outcomes.played)}
          ${outcomeRow("Result filed", outcomes.resultFiled, outcomes.played)}
        </tbody>
      </table>

      <h2>Limits</h2>
      ${sweepWarning}
      <dl class="usage-figures">
        <div>
          <dt>Emails sent today</dt>
          <dd>${escapeHtml(String(limits.emailsToday))} of ${escapeHtml(String(params.emailCeiling))}</dd>
        </div>
        ${figure("Failed sends (7 days)", limits.notificationFailures)}
      </dl>
      <table class="admin-log">
        <thead><tr><th>Table</th><th class="usage-number">Rows</th></tr></thead>
        <tbody>${limits.tableRows
          .map(
            (t) =>
              `<tr><td>${escapeHtml(t.table)}</td><td class="usage-number">${escapeHtml(String(t.rows))}</td></tr>`,
          )
          .join("")}</tbody>
      </table>
      <p class="tool-note">
        Row counts, not bytes: nothing available to a Worker converts one to the other, so
        there is no honest figure to show against D1's 5&nbsp;GB storage ceiling.
      </p>

      <h2>Per game</h2>
      ${gamesHtml}
    `,
  });
}

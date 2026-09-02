import { fixturePath } from "../auth/paths.js";
import type { TimelineEntry } from "../domain/timeline.js";
import { escapeHtml, layout, type PageNav } from "./layout.js";
import { TIMELINE_CSS } from "./styles.js";

export interface TimelinePageParams {
  nav: PageNav;
  gameId: string;
  fixtureId: string;
  gameName: string;
  /** Already formatted in the game's timezone by the caller (TR-5). */
  kicksOffAtLocal: string;
  /**
   * Newest first, with every instant already formatted in the game's timezone
   * by the caller — this view never touches a `Date`, for the same reason no
   * other view does (TR-5).
   */
  entries: readonly { atLocal: string; actor: string | null; subject: string | null; title: string; detail: string | null }[];
}

/**
 * Format one entry's `at` for display. Exported so the route can map
 * `TimelineEntry` without this view needing a timezone.
 */
export type RenderableEntry = TimelinePageParams["entries"][number];

export function toRenderable(entry: TimelineEntry, atLocal: string): RenderableEntry {
  return { atLocal, actor: entry.actor, subject: entry.subject, title: entry.title, detail: entry.detail };
}

/**
 * One fixture's history, for its organiser (M46).
 *
 * The "since" note is not a disclaimer to be trimmed later. This page is
 * assembled from `audit_log` and `notification_log`, which began recording
 * these events when the feature shipped; no backfill is possible because the
 * facts were never stored. An organiser reading an empty week and concluding
 * nothing happened would be wrong in exactly the way the page exists to
 * prevent.
 */
export function renderTimelinePage(params: TimelinePageParams): string {
  const { gameId, fixtureId } = params;

  const items = params.entries
    .map((entry) => {
      // "Automatically" rather than a name, and never "somebody": the sweep
      // opening a fixture and an organiser opening it early are otherwise the
      // same row, and that difference is what this page is for.
      //
      // A subject with no actor is prefixed "to". Without it a send read
      // "Ed · by email", which is a sentence about Ed having sent something —
      // exactly backwards, since Ed is who it went to and nobody sent it.
      const who =
        entry.actor === null
          ? entry.subject === null
            ? "Automatically"
            : `to ${escapeHtml(entry.subject)}`
          : entry.subject === null
            ? `by ${escapeHtml(entry.actor)}`
            : `${escapeHtml(entry.subject)} — by ${escapeHtml(entry.actor)}`;

      const detail = entry.detail === null ? "" : ` · ${escapeHtml(entry.detail)}`;

      return `
      <li>
        <span class="timeline-when">${escapeHtml(entry.atLocal)}</span>
        <span class="timeline-what">${escapeHtml(entry.title)}</span>
        <span class="timeline-who">${who}${detail}</span>
      </li>`;
    })
    .join("");

  const body = `
    <h1>What has happened</h1>
    <p class="kickoff">${escapeHtml(params.gameName)} — ${escapeHtml(params.kicksOffAtLocal)}</p>
    <p class="timeline-note">Invitations, answers and organiser actions, newest first. Only what has happened since this page was added — nothing before that was recorded.</p>
    ${
      params.entries.length === 0
        ? `<p class="timeline-empty">Nothing yet.</p>`
        : `<ol class="timeline">${items}</ol>`
    }
    <p class="back-link"><a href="${escapeHtml(fixturePath(gameId, fixtureId))}">Back to the fixture</a></p>
  `;

  return layout({
    nav: params.nav,
    title: `What has happened — ${params.gameName}`,
    body,
    pageStyles: [TIMELINE_CSS],
  });
}

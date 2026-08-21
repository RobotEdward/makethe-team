import { escapeHtml } from "./layout.js";
import { FRESHNESS_AGE_ATTRIBUTE, FRESHNESS_ATTRIBUTE } from "./scripts.js";

/**
 * The freshness bar (M24), for the foot of every page whose facts move under
 * the reader: the dashboard, both game pages, and both fixture pages.
 *
 * The problem it answers is an installed app, not a cache. These pages are
 * all `private, no-store`, so any navigation re-renders them — but an app
 * reopened after twenty minutes performs no navigation, and re-shows the
 * document the browser already had. `FRESHNESS_JS` turns the resume itself
 * into a re-fetch; this markup is what it reads, and what stands in for it
 * when no script runs.
 *
 * The link is the whole no-script story: an ordinary GET of the page's own
 * path, which is exactly what "refresh" means here. It is not a form, and
 * nothing it reaches mutates anything (TR-15).
 *
 * The age ships `hidden` — the same contract every enhancement here uses —
 * because with no clock to count from there is nothing truthful to say. A
 * server-rendered "Updated just now" would still be saying it an hour later,
 * which is worse than the silence.
 *
 * @param refreshPath the page's own path, as the reader reached it.
 */
export function renderFreshness(refreshPath: string): string {
  return `
    <p class="freshness" ${FRESHNESS_ATTRIBUTE}>
      <span class="freshness-age" ${FRESHNESS_AGE_ATTRIBUTE} hidden>Updated just now</span>
      <a class="freshness-refresh" href="${escapeHtml(refreshPath)}">Refresh</a>
    </p>
  `;
}

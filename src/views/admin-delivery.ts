import { formatLocalDateTime } from "../domain/time/zone.js";
import { escapeHtml, layout, type PageNav } from "./layout.js";
import { ADMIN_TOOLS_CSS } from "./styles.js";

/**
 * One `notification_log` row, as the delivery page lists it. Fields are the
 * stored strings themselves, rendered as-is (escaped) rather than through a
 * label lookup: a status this view has never heard of must render as itself,
 * not crash the page (`test/stored-lookups.test.ts`'s whole genre).
 */
export interface DeliveryLogRow {
  notificationType: string;
  channel: string;
  status: string;
  error: string | null;
  createdAt: Date;
}

export interface AdminDeliveryPageParams {
  /** The signed-in header (M16); see PageNav in layout.ts. */
  nav: PageNav;
  /** Today's UTC send count from `email_quota` (0 when no row yet). */
  sentToday: number;
  /** The parsed `MAX_EMAILS_PER_DAY` ceiling the quota enforces. */
  ceiling: number;
  /** Which notifier this deployment is configured with (`NOTIFIER`). */
  notifierName: string;
  /** Newest first, already capped by the route (max 20). */
  rows: readonly DeliveryLogRow[];
}

/** Same UTC-and-say-so stamp as the sign-in doctor, for the same reason. */
function utcStamp(at: Date): string {
  return `${formatLocalDateTime(at, "Etc/UTC")} UTC`;
}

/**
 * The email delivery page (M17): is anything stopping mail going out?
 *
 * Two failure shapes this page exists to make visible without `wrangler`:
 * the daily ceiling filling up (quota fails closed, silently by design), and
 * a provider rejecting sends (durable `error` on the `notification_log` row).
 * Magic-link emails are counted by the quota but do not write log rows, so
 * the count and the table are deliberately presented as two facts, not one.
 */
export function renderAdminDeliveryPage(params: AdminDeliveryPageParams): string {
  const { sentToday, ceiling, notifierName, rows } = params;

  const logRows = rows.map(
    (r) => `<tr>
      <td>${escapeHtml(utcStamp(r.createdAt))}</td>
      <td>${escapeHtml(r.notificationType)}</td>
      <td>${escapeHtml(r.channel)}</td>
      <td>${escapeHtml(r.status)}</td>
      <td>${r.error === null ? "" : escapeHtml(r.error)}</td>
    </tr>`,
  );
  const logHtml =
    logRows.length === 0
      ? `<p>No notifications recorded yet.</p>`
      : `<table class="admin-log">
          <thead><tr><th>When</th><th>Type</th><th>Channel</th><th>Status</th><th>Error</th></tr></thead>
          <tbody>${logRows.join("")}</tbody>
        </table>`;

  return layout({
    nav: params.nav,
    title: "Email delivery — Make The Team",
    pageStyles: [ADMIN_TOOLS_CSS],
    body: `
      <h1>Email delivery</h1>
      <p>Sent today (UTC): ${sentToday} of ${ceiling}. Once the ceiling is reached, further email quietly waits for tomorrow. Notifier: ${escapeHtml(notifierName)}.</p>
      <h2>Recent notifications</h2>
      <p>Game notifications, newest first. Sign-in link emails count against the ceiling but are not logged here.</p>
      ${logHtml}
    `,
  });
}

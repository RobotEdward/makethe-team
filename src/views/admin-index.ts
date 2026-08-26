import {
  ADMIN_ALLOWLIST_PATH,
  ADMIN_DELIVERY_PATH,
  ADMIN_NOTIFICATIONS_PATH,
  ADMIN_SIGNIN_DOCTOR_PATH,
  ADMIN_USAGE_PATH,
} from "../auth/paths.js";
import { escapeHtml, layout, type PageNav } from "./layout.js";
import { ADMIN_TOOLS_CSS } from "./styles.js";

export interface AdminIndexPageParams {
  /** The signed-in header (M16); see PageNav in layout.ts. */
  nav: PageNav;
}

/**
 * The admin index (M17): where the header's Admin link lands.
 *
 * A list of links rather than a dashboard of live numbers, on purpose: each
 * tool's page carries its own data, so this page has nothing to go stale and
 * a new admin tool is one more `<li>` — the menu scales by addition, not by
 * rework.
 */
export function renderAdminIndexPage(params: AdminIndexPageParams): string {
  return layout({
    nav: params.nav,
    title: "Admin — Make The Team",
    pageStyles: [ADMIN_TOOLS_CSS],
    body: `
      <h1>Admin</h1>
      <ul class="admin-tools">
        <li>
          <a href="${escapeHtml(ADMIN_ALLOWLIST_PATH)}">Sign-up allow list</a>
          <p class="tool-note">Who can create an account without an invite, and whether the list is in effect at all.</p>
        </li>
        <li>
          <a href="${escapeHtml(ADMIN_SIGNIN_DOCTOR_PATH)}">Sign-in doctor</a>
          <p class="tool-note">Check whether an address can sign in, and see recent refused attempts.</p>
        </li>
        <li>
          <a href="${escapeHtml(ADMIN_DELIVERY_PATH)}">Email delivery</a>
          <p class="tool-note">Today's send count against the daily ceiling, and recent notification outcomes.</p>
        </li>
        <li>
          <a href="${escapeHtml(ADMIN_USAGE_PATH)}">Usage</a>
          <p class="tool-note">How many teams, how much activity, and how close anything is to a limit.</p>
        </li>
        <li>
          <a href="${escapeHtml(ADMIN_NOTIFICATIONS_PATH)}">Notifications</a>
          <p class="tool-note">Which automated messages may go out at all, by email and by push, across every game.</p>
        </li>
      </ul>
    `,
  });
}

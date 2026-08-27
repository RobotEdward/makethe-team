import { ADMIN_NOTIFICATIONS_SET_PATH } from "../auth/paths.js";
import type { AdminNotificationSwitches } from "../domain/app-settings.js";
import { NOTIFICATION_TYPES, type NotificationType } from "../notify/dedupe-key.js";
import { NOTIFICATION_CONTROLS } from "../notify/notification-controls.js";
import type { Channel } from "../notify/notifier.js";
import { escapeHtml, layout, type PageNav } from "./layout.js";
import { ADMIN_NOTIFICATIONS_CSS, ADMIN_TOOLS_CSS } from "./styles.js";

/** What each notification is, in the operator's words. The catalogue says what is switchable; this says what it is. */
const NAMES: Record<NotificationType, string> = {
  n1: "Fixture reminder", n2: "Promoted from the waitlist", n3: "Fixture cancelled",
  n4: "Fixture short or uneven (to the owner)", n5: "Sign-in link", n6: "Welcome to the squad",
  n7: "Removed from a squad", n8: "Erasure scheduled", n9: "Teams published",
  n10: "Organiser broadcast", n11: "Group-chat nudge (to the owner)", n12: "How did it go?",
  n13: "Team pick handed over", n14: "Join confirmation",
};

const WHY_NEVER: Partial<Record<NotificationType, string>> = {
  n2: "A player moved into the team who is never told turns up to nothing.",
  n3: "The squad would turn up to a game that is off.",
  n5: "Switching it off locks every player out with no way back in.",
  n8: "The confirmation of a data-erasure request.",
};

export interface AdminNotificationsPageParams {
  nav: PageNav;
  switches: AdminNotificationSwitches;
}

export function renderAdminNotificationsPage(params: AdminNotificationsPageParams): string {
  const { switches } = params;
  const cell = (type: NotificationType, channel: Channel): string => {
    if (!NOTIFICATION_CONTROLS[type].channels.includes(channel)) return `<td class="notify-cell notify-none">—</td>`;
    const on = switches.isOn(type, channel);
    return `<td class="notify-cell">
      <form method="post" action="${escapeHtml(ADMIN_NOTIFICATIONS_SET_PATH)}">
        <input type="hidden" name="type" value="${escapeHtml(type)}">
        <input type="hidden" name="channel" value="${escapeHtml(channel)}">
        ${on ? "" : `<input type="hidden" name="on" value="on">`}
        <button class="button${on ? " danger" : ""}" type="submit" aria-label="${escapeHtml(`${NAMES[type]} by ${channel}: turn ${on ? "off" : "on"}`)}">${on ? "On" : "Off"}</button>
      </form>
    </td>`;
  };
  const row = (type: NotificationType): string => `
    <tr data-notification="${escapeHtml(type)}">
      <td class="notify-what"><span class="notify-label">${escapeHtml(NAMES[type])}</span> <span class="hint">${escapeHtml(type.toUpperCase())}</span></td>
      ${cell(type, "email")}${cell(type, "push")}
    </tr>`;
  const neverRow = (type: NotificationType): string => `
    <tr data-notification="${escapeHtml(type)}">
      <td class="notify-what"><span class="notify-label">${escapeHtml(NAMES[type])}</span> <span class="hint">${escapeHtml(WHY_NEVER[type] ?? "")}</span></td>
      <td class="notify-cell notify-none" colspan="2">No control</td>
    </tr>`;
  const band = (title: string, note: string, types: NotificationType[], render: (t: NotificationType) => string) => `
    <h2>${escapeHtml(title)}</h2>
    <p class="tool-note">${escapeHtml(note)}</p>
    <table class="admin-notify">
      <thead><tr><th class="notify-what">Notification</th><th>Email</th><th>Push</th></tr></thead>
      <tbody>${types.map(render).join("")}</tbody>
    </table>`;
  const of = (scope: "owner" | "admin" | "none") => NOTIFICATION_TYPES.filter((t) => NOTIFICATION_CONTROLS[t].scope === scope);

  return layout({
    nav: params.nav,
    title: "Notifications — Admin — Make The Team",
    pageStyles: [ADMIN_TOOLS_CSS, ADMIN_NOTIFICATIONS_CSS],
    body: `
      <h1>Notifications</h1>
      <p>Off here is off for every game. An owner's own setting is kept underneath and comes back when you turn a channel on again.</p>
      ${band("Owners can also switch these off per game", "Sent only when both you and the game's owner allow it.", of("owner"), row)}
      ${band("Administrator only", "No per-game setting. For the organiser broadcast, off removes that channel from the message form.", of("admin"), row)}
      ${band("Never switched off", "Absent from every settings screen on purpose.", of("none"), neverRow)}
    `,
  });
}

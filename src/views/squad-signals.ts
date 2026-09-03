import { QUIET_DAYS, type SquadSignals } from "../domain/presence.js";
import { escapeHtml } from "./layout.js";

/**
 * The reachability markers on an organiser's squad row (M33).
 *
 * Shown **only when something is true of the member**, never as four slots
 * with three of them empty: a marker that is present on every row is a marker
 * nobody reads, and a healthy fourteen-person squad has to stay scannable as
 * the list of names it mostly is.
 *
 * Each marker is an icon *and* a text label, not an icon alone. A `title`
 * attribute is reachable with a mouse and by nothing else — no touch, no
 * screen reader on most combinations — so the words are in the markup, and
 * `.signal-label` hides them from sighted users without hiding them from the
 * accessibility tree. Never `hidden`, never `display: none`: both take the
 * text out of that tree as well, which is exactly the failure this avoids.
 *
 * The icons carry `aria-hidden` and no `<title>` of their own, so a screen
 * reader announces each marker once rather than twice.
 */

/** 16px, stroke-only, sized and coloured by `.signal svg` from CSS. */
function icon(paths: string): string {
  return `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;
}

/** A phone with a line struck through it. */
const NOT_INSTALLED_ICON = icon(
  `<rect x="4.25" y="1.25" width="7.5" height="13.5" rx="1.5"/><path d="M2 14 14 2"/>`,
);

/** A bell with the same strike, so the pair reads as one family. */
const NO_PUSH_ICON = icon(
  `<path d="M4.2 6.4a3.8 3.8 0 0 1 7.6 0c0 2.6.9 3.4 1.2 4.1H3a6 6 0 0 0 1.2-4.1Z"/><path d="M6.6 12.8a1.6 1.6 0 0 0 2.8 0"/><path d="M2.4 13.6 13.6 2.4"/>`,
);

/** A warning triangle: the one marker that means something is broken. */
const TROUBLE_ICON = icon(`<path d="M8 2.2 14.6 13.6H1.4Z"/><path d="M8 6.6v3.1"/><path d="M8 11.8h.01"/>`);

/** A clock, for time having passed rather than anything having gone wrong. */
const QUIET_ICON = icon(`<circle cx="8" cy="8" r="6.1"/><path d="M8 4.4V8l2.5 2.1"/>`);

/**
 * `notInstalled` and `noPush` are muted, `deliveryTrouble` and `quiet` are
 * not. The first two describe a player who is perfectly reachable by email
 * and has simply not opted into anything — the ordinary state of most
 * squads, and not a fault to be coloured like one. The other two are the two
 * an organiser may need to act on.
 */
const MARKERS = [
  { key: "notInstalled", icon: NOT_INSTALLED_ICON, label: "App not installed", tone: "quiet" },
  { key: "noPush", icon: NO_PUSH_ICON, label: "No push notifications", tone: "quiet" },
  { key: "deliveryTrouble", icon: TROUBLE_ICON, label: "Messages are failing", tone: "warn" },
  {
    key: "quiet",
    icon: QUIET_ICON,
    // Worded from the constant rather than as "two weeks", so the copy cannot
    // drift away from the threshold `squadSignals` actually applies.
    label: `Not seen for ${QUIET_DAYS} days`,
    tone: "warn",
  },
] as const satisfies ReadonlyArray<{
  key: keyof SquadSignals;
  icon: string;
  label: string;
  tone: "quiet" | "warn";
}>;

/**
 * The markers for one member, or an empty string when there is nothing to
 * say — which is the common case, and must add no markup at all.
 */
/**
 * How many of the markers a surface wants (M52).
 *
 * `"actionable"` is the squad row: only the markers that mean something is
 * wrong and an organiser can do something about it. The header above says a
 * marker present on every row is a marker nobody reads, and two of the four
 * are true of almost every player — most people never install the app and
 * never turn push on — so the row was carrying two or three glyphs each with
 * no legend on the page, and the two worth acting on were indistinguishable
 * from them at that size.
 *
 * `"all"` is the member's own page, where somebody has gone specifically to
 * find out about one person and there is room to say it in words.
 *
 * The default is the row's scope, so a new caller cannot put the quiet pair
 * back on a list by forgetting the argument.
 */
export type SignalScope = "actionable" | "all";

export function renderSquadSignals(
  signals: SquadSignals,
  scope: SignalScope = "actionable",
): string {
  const shown = MARKERS.filter(
    (marker) => signals[marker.key] && (scope === "all" || marker.tone === "warn"),
  );
  if (shown.length === 0) return "";

  const items = shown
    .map(
      (marker) =>
        `<span class="signal signal-${marker.tone}" title="${escapeHtml(marker.label)}">${marker.icon}<span class="signal-label">${escapeHtml(marker.label)}</span></span>`,
    )
    .join("");
  return `<span class="member-signals">${items}</span>`;
}

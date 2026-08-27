import { NOTIFICATION_TYPES, type NotificationType } from "./dedupe-key.js";
import type { Channel } from "./notifier.js";

/**
 * Who may switch a notification off, per channel (M37).
 *
 * `owner`: the game owner has a per-game switch and the administrator a
 * global one; effective = admin AND owner. `admin`: global switch only.
 * `none`: never switchable — absent from every settings screen by
 * construction, because a control that must never be used is better absent
 * than present-and-disabled (spec §2).
 *
 * A `Record` over the whole union, not a partial map: adding `n15` to
 * `NOTIFICATION_TYPES` is a typecheck error here until somebody says what it
 * is, the same discipline the `notification_type` column enum already buys.
 *
 * `channels` lists only the legs that exist in code. `n11` has no email leg
 * and is not getting one — `src/sweep/group-nudge.ts` records the reasoning,
 * reviewed and upheld in this design.
 */
export type ControlScope = "owner" | "admin" | "none";

export interface Control {
  scope: ControlScope;
  channels: readonly Channel[];
}

const BOTH: readonly Channel[] = ["email", "push"];
const NONE: readonly Channel[] = [];

export const NOTIFICATION_CONTROLS: Record<NotificationType, Control> = {
  n1: { scope: "owner", channels: BOTH },
  n2: { scope: "none", channels: NONE },
  n3: { scope: "none", channels: NONE },
  n4: { scope: "owner", channels: BOTH },
  n5: { scope: "none", channels: NONE },
  n6: { scope: "admin", channels: BOTH },
  n7: { scope: "admin", channels: BOTH },
  n8: { scope: "none", channels: NONE },
  n9: { scope: "owner", channels: BOTH },
  n10: { scope: "admin", channels: BOTH },
  n11: { scope: "owner", channels: ["push"] },
  n12: { scope: "owner", channels: BOTH },
  n13: { scope: "owner", channels: BOTH },
  n14: { scope: "admin", channels: ["email"] },
};

export interface ControlCell {
  type: NotificationType;
  channel: Channel;
}

/** Every (type, channel) with the given scope, in catalogue order. */
export function cellsWithScope(scope: "owner" | "admin"): ControlCell[] {
  const cells: ControlCell[] = [];
  for (const type of NOTIFICATION_TYPES) {
    const control = NOTIFICATION_CONTROLS[type];
    if (control.scope !== scope) continue;
    for (const channel of control.channels) cells.push({ type, channel });
  }
  return cells;
}

/** `n9.email` — the one spelling shared by `app_settings` keys and form field names. */
export function cellKey(type: NotificationType, channel: Channel): string {
  return `${type}.${channel}`;
}

export function isNotificationType(value: string): value is NotificationType {
  return (NOTIFICATION_TYPES as readonly string[]).includes(value);
}

const CHANNELS: readonly string[] = ["email", "push"];

export function isChannel(value: string): value is Channel {
  return CHANNELS.includes(value);
}

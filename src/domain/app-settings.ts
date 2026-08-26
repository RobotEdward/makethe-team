import { eq, like, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { appSettings } from "../db/schema.js";
import type { NotificationType } from "../notify/dedupe-key.js";
import type { Channel } from "../notify/notifier.js";

/** The `app_settings.key` of the operator's open-sign-ups switch (M30). */
const OPEN_SIGNUPS = "open_signups";

/**
 * The stored value that means on. Anything else — a missing row, `"off"`, a
 * value a later build wrote and this one has never heard of — means off.
 */
const ON = "on";

/**
 * Is the sign-in gate open to everyone, rather than to the allow list (M30)?
 *
 * **Fails closed**, and deliberately reads a single exact string rather than
 * anything truthy. `app_settings.value` is a bare `text NOT NULL` with no
 * CHECK constraint, so the row holds whatever was written to it; a reader that
 * treated "not off" as on would open a trial-only site to the whole internet
 * on a typo, silently, whereas failing the other way is reported by the first
 * person who cannot sign in. Same direction, and the same reasoning, as
 * `isSignInAllowlisted`'s treatment of a missing `SIGNIN_ALLOWLIST`.
 */
export async function isOpenSignups(db: Db): Promise<boolean> {
  const [row] = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, OPEN_SIGNUPS))
    .limit(1);
  return row?.value === ON;
}

/**
 * Turn the switch on or off, writing `"off"` rather than deleting the row so
 * the admin screen can distinguish "an operator turned this off" from "nobody
 * has ever touched it" if it ever needs to. Upserts: the operator pressing the
 * same button twice, or two tabs racing, must not be a primary-key error.
 */
export async function setOpenSignups(db: Db, on: boolean): Promise<void> {
  const value = on ? ON : "off";
  await db
    .insert(appSettings)
    .values({ key: OPEN_SIGNUPS, value })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value, updatedAt: sql`(unixepoch() * 1000)` },
    });
}

/** `app_settings.key` prefix for the administrator's notification switches (M37). */
const NOTIFY_PREFIX = "notify.";

/** The stored value that means off. Anything else means on — see `loadAdminNotificationSwitches`. */
const OFF = "off";

export function adminNotificationKey(type: NotificationType, channel: Channel): string {
  return `${NOTIFY_PREFIX}${type}.${channel}`;
}

export interface AdminNotificationSwitches {
  isOn(type: NotificationType, channel: Channel): boolean;
}

/**
 * Every administrator notification switch, in one query (M37).
 *
 * **Fails open — the opposite direction from `isOpenSignups` above, on
 * purpose.** There the safe direction is "refuse", because the row guards
 * sign-in. Here a missing row means nobody has ever touched the setting, and
 * defaulting that to off would mean deploying the migration silently stops
 * every notification in the product. So only the exact string `"off"` means
 * off; a missing row, or a value a later build wrote and this one has never
 * heard of, means on. Two readers, one table, opposite safe directions, each
 * saying why.
 */
export async function loadAdminNotificationSwitches(db: Db): Promise<AdminNotificationSwitches> {
  const rows = await db
    .select({ key: appSettings.key, value: appSettings.value })
    .from(appSettings)
    .where(like(appSettings.key, `${NOTIFY_PREFIX}%`));
  const off = new Set(rows.filter((row) => row.value === OFF).map((row) => row.key));
  return { isOn: (type, channel) => !off.has(adminNotificationKey(type, channel)) };
}

/** Upserts, as `setOpenSignups` does and for the same two-tabs reason. */
export async function setAdminNotificationChannel(
  db: Db,
  type: NotificationType,
  channel: Channel,
  on: boolean,
): Promise<void> {
  const value = on ? "on" : OFF;
  await db
    .insert(appSettings)
    .values({ key: adminNotificationKey(type, channel), value })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value, updatedAt: sql`(unixepoch() * 1000)` },
    });
}

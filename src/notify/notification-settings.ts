import { inArray, sql } from "drizzle-orm";
import { chunk, INSERT_CHUNK_SIZE } from "../db/chunk.js";
import type { Db } from "../db/client.js";
import { gameNotificationSettings } from "../db/schema.js";
import { loadAdminNotificationSwitches } from "../domain/app-settings.js";
import type { NotificationType } from "./dedupe-key.js";
import { NOTIFICATION_CONTROLS, cellKey, isChannel, isNotificationType } from "./notification-controls.js";
import type { Channel } from "./notifier.js";

/**
 * The answer to "may this notification go out on this channel for this game?"
 * (M37), resolved as `admin AND owner` for owner-scoped types and `admin`
 * alone for administrator-scoped ones.
 *
 * Loaded once for a set of games and then answered from memory: the hourly
 * sweep asks about every due fixture, and a resolver that touched D1 per
 * fixture would be an N+1 on the hottest path in the product. `isEnabled`
 * performs no I/O.
 *
 * Asked at the send path, before `insertQueuedLogRows`, never in a notifier
 * decorator: a `Message` carries no game id, and a message filtered after the
 * `queued` row is reserved leaves a row that never sends and never retries
 * (spec §5).
 */
export interface EffectiveSettings {
  isEnabled(gameId: string, type: NotificationType, channel: Channel): boolean;
  /** The administrator's answer alone. */
  adminAllows(type: NotificationType, channel: Channel): boolean;
  /** The owner's stored row alone, `true` when absent. */
  ownerWants(gameId: string, type: NotificationType, channel: Channel): boolean;
}

export async function loadNotificationSettings(db: Db, gameIds: readonly string[]): Promise<EffectiveSettings> {
  const admin = await loadAdminNotificationSwitches(db);

  // Only rows that say off are kept: absence means on, so an `enabled = 1`
  // row and no row are the same answer.
  const ownerOff = new Set<string>();
  const unique = [...new Set(gameIds)];
  for (const batch of chunk(unique, INSERT_CHUNK_SIZE)) {
    const rows = await db
      .select({
        gameId: gameNotificationSettings.gameId,
        type: gameNotificationSettings.notificationType,
        channel: gameNotificationSettings.channel,
        enabled: gameNotificationSettings.enabled,
      })
      .from(gameNotificationSettings)
      .where(inArray(gameNotificationSettings.gameId, batch));
    for (const row of rows) {
      // Both columns are bare text with no CHECK: a row this build does not
      // recognise is dropped, never used to index NOTIFICATION_CONTROLS.
      if (!isNotificationType(row.type) || !isChannel(row.channel)) continue;
      if (!row.enabled) ownerOff.add(`${row.gameId}:${cellKey(row.type, row.channel)}`);
    }
  }

  const ownerWants = (gameId: string, type: NotificationType, channel: Channel): boolean =>
    !ownerOff.has(`${gameId}:${cellKey(type, channel)}`);

  return {
    adminAllows: (type, channel) => admin.isOn(type, channel),
    ownerWants,
    isEnabled(gameId, type, channel) {
      const control = NOTIFICATION_CONTROLS[type];
      if (control.scope === "none") return true;
      if (!admin.isOn(type, channel)) return false;
      return control.scope === "admin" || ownerWants(gameId, type, channel);
    },
  };
}

/** Upsert the owner's cells for one game. Cells not passed are left as they were (mask, never overwrite). */
export async function saveOwnerNotificationSettings(
  db: Db,
  gameId: string,
  cells: readonly { type: NotificationType; channel: Channel; enabled: boolean }[],
): Promise<void> {
  for (const cell of cells) {
    await db
      .insert(gameNotificationSettings)
      .values({ gameId, notificationType: cell.type, channel: cell.channel, enabled: cell.enabled })
      .onConflictDoUpdate({
        target: [gameNotificationSettings.gameId, gameNotificationSettings.notificationType, gameNotificationSettings.channel],
        set: { enabled: cell.enabled, updatedAt: sql`(unixepoch() * 1000)` },
      });
  }
}

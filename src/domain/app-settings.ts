import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { appSettings } from "../db/schema.js";

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

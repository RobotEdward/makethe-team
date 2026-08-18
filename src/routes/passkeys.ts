import { getAuthenticatorName } from "@better-auth/passkey";
import { asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { PASSKEYS_PATH } from "../auth/paths.js";
import { requirePlayer, pageNav } from "../auth/session.js";
import { getDb } from "../db/client.js";
import { passkey } from "../db/schema.js";
import type { AppEnv } from "../env.js";
import { renderPasskeysPage } from "../views/passkeys.js";

export const passkeys = new Hono<AppEnv>();

/**
 * Manage this player's passkeys.
 *
 * `requirePlayer` rather than `requireSession`: this page hangs off the
 * dashboard, and someone whose session has no linked Player belongs on the
 * 403 page with its exits, exactly as `/app` does — not on a page inviting
 * them to add a credential to an identity the app cannot place.
 *
 * **TR-18 applies here in full.** The middleware establishes *who* is asking
 * and stops there; it does not say which passkeys the caller may see. So the
 * query below is scoped by `session.user.id` — read off the resolved session,
 * never off the URL, a query parameter or a form field. There is no id in this
 * route's path for exactly that reason: an endpoint shaped
 * `/app/passkeys/:userId` would need an ownership check to be safe, and the
 * safest ownership check is not having an id to check. Adding one later means
 * loading the row, comparing it to `session.user.id`, and answering 404 rather
 * than 403 so an id cannot be probed for existence.
 *
 * Registration itself is not here: it is Better Auth's
 * `POST /api/auth/passkey/verify-registration`, which enforces the session
 * itself (`registration.requireSession: true` in `src/auth/factory.ts`). This
 * page's guard is therefore the second lock and not the only one — posting to
 * that endpoint by hand with no cookie gets a 401 whatever this page does.
 */
passkeys.get(PASSKEYS_PATH, requirePlayer, async (c) => {
  const session = c.get("session")!;

  const rows = await getDb(c.env.DB)
    .select({ name: passkey.name, aaguid: passkey.aaguid })
    .from(passkey)
    .where(eq(passkey.userId, session.user.id))
    .orderBy(asc(passkey.createdAt));

  return c.html(renderPasskeysPage({ labels: rows.map(labelFor), nav: pageNav(c, "account") }));
});

/**
 * What to call a passkey in the list.
 *
 * `getAuthenticatorName` is the plugin's own best-effort AAGUID lookup
 * ("Google Password Manager", "iCloud Keychain", …). It returns `undefined`
 * for the all-zero AAGUID that privacy-preserving platforms report — Apple's
 * default — which is most of them, hence the plain fallback. Nothing else off
 * the row is shown: a credential id is a stable cross-site-ish identifier and
 * the public key is noise to a human.
 */
function labelFor(row: { name: string | null; aaguid: string | null }): string {
  return row.name?.trim() || getAuthenticatorName(row.aaguid ?? undefined) || "Passkey";
}

import { asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Context } from "hono";
import { wrongOrigin } from "../auth/origin.js";
import {
  ADMIN_ALLOWLIST_ADD_PATH,
  ADMIN_ALLOWLIST_PATH,
  ADMIN_ALLOWLIST_REMOVE_PATH,
} from "../auth/paths.js";
import { requireSession } from "../auth/session.js";
import { foldAsciiCase } from "../auth/sign-in-gate.js";
import { getDb, type Db } from "../db/client.js";
import { signupAllowlist, user } from "../db/schema.js";
import { isPlausibleEmail } from "../domain/join-squad.js";
import type { AppEnv } from "../env.js";
import { renderAdminAllowlistPage } from "../views/admin-allowlist.js";

export const admin = new Hono<AppEnv>();

/**
 * The operator's allow-list screen (M16).
 *
 * `requireSession` rather than `requirePlayer`: admin-ness hangs off the auth
 * identity (`user.is_admin`), not the domain Player, and an operator whose
 * account never joined a squad must still reach this screen.
 *
 * **TR-18 applies.** The middleware establishes *who*; whether that person is
 * an admin is re-asked by every handler below via `loadAdminDb`, and the
 * refusal is a 404 — to anyone without the bit, this URL does not exist, the
 * same answer the router itself gives for a path that really doesn't.
 */

/**
 * The entitlement check all three handlers share: the caller's own `user` row,
 * read fresh, with `is_admin` set — or null. Read per request rather than off
 * the session object: Better Auth's session user was shaped when the session
 * was minted and does not carry our app-owned column, so going back to the row
 * is not a redundancy, it is the only place the bit exists.
 */
async function loadAdminDb(c: Context<AppEnv>): Promise<Db | null> {
  const session = c.get("session")!;
  const db = getDb(c.env.DB);
  const [row] = await db
    .select({ isAdmin: user.isAdmin })
    .from(user)
    .where(eq(user.id, session.user.id))
    .limit(1);
  return row?.isAdmin ? db : null;
}

/** The secret's entries, folded and de-blanked exactly as the gate reads them. */
function secretEntries(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return raw
    .split(",")
    .map(foldAsciiCase)
    .filter((entry) => entry !== "");
}

async function renderPage(c: Context<AppEnv>, db: Db, error?: string, status: 200 | 422 = 200) {
  const rows = await db
    .select({ email: signupAllowlist.email })
    .from(signupAllowlist)
    .orderBy(asc(signupAllowlist.createdAt), asc(signupAllowlist.email));
  return c.html(
    renderAdminAllowlistPage({
      secretEntries: secretEntries(c.env.SIGNIN_ALLOWLIST),
      tableEntries: rows.map((r) => r.email),
      error,
    }),
    status,
  );
}

admin.get(ADMIN_ALLOWLIST_PATH, requireSession, async (c) => {
  const db = await loadAdminDb(c);
  if (db === null) return c.text("Not found", 404);
  return renderPage(c, db);
});

admin.post(ADMIN_ALLOWLIST_ADD_PATH, requireSession, async (c) => {
  if (wrongOrigin(c)) return c.text("Forbidden", 403);
  const db = await loadAdminDb(c);
  if (db === null) return c.text("Not found", 404);

  const form = await c.req.formData();
  const email = foldAsciiCase(String(form.get("email") ?? ""));
  if (!isPlausibleEmail(email)) {
    return renderPage(c, db, "That doesn't look like an email address.", 422);
  }

  // Folded on insert so the gate's folded-equality lookup is exact, and
  // idempotent so re-submitting the form is a no-op rather than a 500.
  await db.insert(signupAllowlist).values({ email }).onConflictDoNothing();
  return c.redirect(ADMIN_ALLOWLIST_PATH, 303);
});

admin.post(ADMIN_ALLOWLIST_REMOVE_PATH, requireSession, async (c) => {
  if (wrongOrigin(c)) return c.text("Forbidden", 403);
  const db = await loadAdminDb(c);
  if (db === null) return c.text("Not found", 404);

  const email = foldAsciiCase(String((await c.req.formData()).get("email") ?? ""));
  // Deleting an address that is not there is the same end state as deleting
  // one that is; no 404 here — the resource this screen is about is the list.
  await db.delete(signupAllowlist).where(eq(signupAllowlist.email, email));
  return c.redirect(ADMIN_ALLOWLIST_PATH, 303);
});

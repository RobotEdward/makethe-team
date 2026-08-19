import { asc, desc, eq, gt } from "drizzle-orm";
import { Hono } from "hono";
import type { Context } from "hono";
import { wrongOrigin } from "../auth/origin.js";
import {
  ADMIN_ALLOWLIST_ADD_PATH,
  ADMIN_ALLOWLIST_PATH,
  ADMIN_ALLOWLIST_REMOVE_PATH,
  ADMIN_DELIVERY_PATH,
  ADMIN_PATH,
  ADMIN_SIGNIN_CHECK_PATH,
  ADMIN_SIGNIN_DOCTOR_PATH,
} from "../auth/paths.js";
import { requireSession, pageNav } from "../auth/session.js";
import { explainSignIn, foldAsciiCase, isSignInPermitted } from "../auth/sign-in-gate.js";
import { getDb, type Db } from "../db/client.js";
import { emailQuota, notificationLog, signinRefusals, signupAllowlist, user, verification } from "../db/schema.js";
import { isPlausibleEmail } from "../domain/join-squad.js";
import type { AppEnv } from "../env.js";
import { dayKey } from "../notify/quota.js";
import { parseMaxEmailsPerDay } from "../notify/factory.js";
import { renderAdminAllowlistPage } from "../views/admin-allowlist.js";
import { renderAdminDeliveryPage } from "../views/admin-delivery.js";
import { renderAdminIndexPage } from "../views/admin-index.js";
import { renderAdminSigninDoctorPage } from "../views/admin-signin-doctor.js";

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
      nav: pageNav(c, "admin"),
      secretEntries: secretEntries(c.env.SIGNIN_ALLOWLIST),
      tableEntries: rows.map((r) => r.email),
      error,
    }),
    status,
  );
}

admin.get(ADMIN_PATH, requireSession, async (c) => {
  const db = await loadAdminDb(c);
  if (db === null) return c.text("Not found", 404);
  return c.html(renderAdminIndexPage({ nav: pageNav(c, "admin") }));
});

/** The doctor's data, shared by its GET and the check POST's re-render. */
async function loadRefusals(db: Db) {
  const rows = await db
    .select({ email: signinRefusals.email, createdAt: signinRefusals.createdAt })
    .from(signinRefusals)
    .orderBy(desc(signinRefusals.createdAt), desc(signinRefusals.id))
    .limit(REFUSALS_SHOWN);
  return rows.map((r) => ({ email: r.email, at: r.createdAt }));
}

/** The table keeps up to 100 rows (`REFUSAL_ROWS_KEPT`); the page shows 10. */
const REFUSALS_SHOWN = 10;

/**
 * Live magic-link requests, parsed out of Better Auth's `verification` rows.
 *
 * The plugin writes one row per request *before* the sign-in gate runs, with
 * the address inside a JSON `value` — so this is the only place a *permitted*
 * request's address is visible at all. Rows whose `value` carries no email
 * (other verification uses share the table) are skipped, not errors. Each
 * address is annotated with the gate's answer *now*: the row does not record
 * what the gate said at the time, and pretending otherwise would mislead the
 * operator whenever the allow list changed in between.
 */
async function loadAttempts(c: Context<AppEnv>, db: Db) {
  const now = new Date(Date.now());
  const rows = await db
    .select({ value: verification.value, createdAt: verification.createdAt })
    .from(verification)
    .where(gt(verification.expiresAt, now))
    .orderBy(desc(verification.createdAt), desc(verification.id))
    .limit(50);

  const attempts: { email: string; at: Date; permitted: boolean }[] = [];
  for (const row of rows) {
    if (attempts.length >= REFUSALS_SHOWN) break;
    let email: unknown;
    try {
      email = (JSON.parse(row.value) as { email?: unknown }).email;
    } catch {
      continue;
    }
    if (typeof email !== "string" || email === "") continue;
    attempts.push({
      email,
      at: row.createdAt,
      permitted: await isSignInPermitted(db, c.env.SIGNIN_ALLOWLIST, email),
    });
  }
  return attempts;
}

admin.get(ADMIN_SIGNIN_DOCTOR_PATH, requireSession, async (c) => {
  const db = await loadAdminDb(c);
  if (db === null) return c.text("Not found", 404);
  return c.html(
    renderAdminSigninDoctorPage({
      nav: pageNav(c, "admin"),
      refusals: await loadRefusals(db),
      attempts: await loadAttempts(c, db),
    }),
  );
});

admin.post(ADMIN_SIGNIN_CHECK_PATH, requireSession, async (c) => {
  if (wrongOrigin(c)) return c.text("Forbidden", 403);
  const db = await loadAdminDb(c);
  if (db === null) return c.text("Not found", 404);

  const email = foldAsciiCase(String((await c.req.formData()).get("email") ?? ""));
  if (!isPlausibleEmail(email)) {
    return c.html(
      renderAdminSigninDoctorPage({
        nav: pageNav(c, "admin"),
        refusals: await loadRefusals(db),
        attempts: await loadAttempts(c, db),
        error: "That doesn't look like an email address.",
      }),
      422,
    );
  }

  // Rendered straight off the POST rather than redirected with the address
  // in a query string — see ADMIN_PATH's doc comment in paths.ts.
  const doors = await explainSignIn(db, c.env.SIGNIN_ALLOWLIST, email);
  return c.html(
    renderAdminSigninDoctorPage({
      nav: pageNav(c, "admin"),
      verdict: { email, doors },
      refusals: await loadRefusals(db),
      attempts: await loadAttempts(c, db),
    }),
  );
});

admin.get(ADMIN_DELIVERY_PATH, requireSession, async (c) => {
  const db = await loadAdminDb(c);
  if (db === null) return c.text("Not found", 404);

  // The one wall-clock read at this edge (the lint rule bans bare
  // `new Date()` downstream); `dayKey` is the quota's own key function, so
  // this page reads the same row `QuotaNotifier` writes.
  const now = new Date(Date.now());
  const [quotaRow] = await db
    .select({ sentCount: emailQuota.sentCount })
    .from(emailQuota)
    .where(eq(emailQuota.day, dayKey(now)))
    .limit(1);

  const rows = await db
    .select({
      notificationType: notificationLog.notificationType,
      channel: notificationLog.channel,
      status: notificationLog.status,
      error: notificationLog.error,
      createdAt: notificationLog.createdAt,
    })
    .from(notificationLog)
    .orderBy(desc(notificationLog.createdAt), desc(notificationLog.id))
    .limit(DELIVERY_ROWS_SHOWN);

  return c.html(
    renderAdminDeliveryPage({
      nav: pageNav(c, "admin"),
      sentToday: quotaRow?.sentCount ?? 0,
      ceiling: parseMaxEmailsPerDay(c.env.MAX_EMAILS_PER_DAY),
      notifierName: c.env.NOTIFIER,
      rows,
    }),
  );
});

const DELIVERY_ROWS_SHOWN = 20;

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

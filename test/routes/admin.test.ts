import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import {
  ADMIN_ALLOWLIST_ADD_PATH,
  ADMIN_ALLOWLIST_PATH,
  ADMIN_ALLOWLIST_REMOVE_PATH,
  ADMIN_DELIVERY_PATH,
  ADMIN_PATH,
  ADMIN_SIGNIN_CHECK_PATH,
  ADMIN_SIGNIN_DOCTOR_PATH,
  ADMIN_SIGNUP_MODE_PATH,
  SIGN_IN_PATH,
} from "../../src/auth/paths.js";
import { recordSignInRefusal } from "../../src/auth/sign-in-gate.js";
import { getDb } from "../../src/db/client.js";
import { isOpenSignups, setOpenSignups } from "../../src/domain/app-settings.js";
import { notificationLog, signupAllowlist, user } from "../../src/db/schema.js";
import { insertPlayer, resetDatabase } from "../support/factories.js";
import { ALLOWED, ORIGIN, bindings, signIn } from "../support/sign-in.js";

const db = getDb(env.DB);

/** Sign in as the allowlisted test address, optionally holding the admin bit. */
async function signInAs({ admin }: { admin: boolean }) {
  const { cookie } = await signIn();
  if (admin) {
    await db.update(user).set({ isAdmin: true }).where(eq(user.email, ALLOWED));
  }
  return cookie;
}

function get(cookie: string) {
  return new Request(`${ORIGIN}${ADMIN_ALLOWLIST_PATH}`, { headers: { cookie } });
}

function post(path: string, cookie: string, email: string, origin: string = ORIGIN) {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded", origin },
    body: new URLSearchParams({ email }),
  });
}

describe("the admin allow-list screen", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("redirects an anonymous visitor to sign-in", async () => {
    const response = await createApp().fetch(new Request(`${ORIGIN}${ADMIN_ALLOWLIST_PATH}`), bindings());
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(SIGN_IN_PATH);
  });

  it("answers 404, not 403, to a signed-in non-admin — on the page and both posts", async () => {
    const cookie = await signInAs({ admin: false });
    const app = createApp();
    for (const request of [
      get(cookie),
      post(ADMIN_ALLOWLIST_ADD_PATH, cookie, "friend@example.com"),
      post(ADMIN_ALLOWLIST_REMOVE_PATH, cookie, "friend@example.com"),
    ]) {
      const response = await app.fetch(request, bindings());
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("Not found");
    }
  });

  it("shows an admin the secret's entries read-only and the table's entries with remove buttons", async () => {
    const cookie = await signInAs({ admin: true });
    await db.insert(signupAllowlist).values({ email: "friend@example.com" });

    const response = await createApp().fetch(get(cookie), bindings());
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(ALLOWED); // from the SIGNIN_ALLOWLIST secret
    expect(html).toContain("from server config");
    expect(html).toContain("friend@example.com");
    // One remove form: the secret entry must not grow a button it cannot honour.
    expect(html.match(/action="[^"]*\/remove"/g)).toHaveLength(1);
  });

  it("adds an address folded, idempotently, and redirects back to the list", async () => {
    const cookie = await signInAs({ admin: true });
    const app = createApp();

    for (let i = 0; i < 2; i++) {
      const response = await app.fetch(post(ADMIN_ALLOWLIST_ADD_PATH, cookie, "New.Friend@Example.COM"), bindings());
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe(ADMIN_ALLOWLIST_PATH);
    }

    const rows = await db.select().from(signupAllowlist);
    expect(rows.map((r) => r.email)).toEqual(["new.friend@example.com"]);
  });

  it("re-renders at 422 with the message when the address is implausible", async () => {
    const cookie = await signInAs({ admin: true });
    const response = await createApp().fetch(post(ADMIN_ALLOWLIST_ADD_PATH, cookie, "not-an-email"), bindings());
    expect(response.status).toBe(422);
    expect(await response.text()).toContain("That doesn&#39;t look like an email address.");
    expect(await db.select().from(signupAllowlist)).toHaveLength(0);
  });

  it("removes an address and redirects back", async () => {
    const cookie = await signInAs({ admin: true });
    await db.insert(signupAllowlist).values({ email: "friend@example.com" });

    const response = await createApp().fetch(
      post(ADMIN_ALLOWLIST_REMOVE_PATH, cookie, "friend@example.com"),
      bindings(),
    );
    expect(response.status).toBe(303);
    expect(await db.select().from(signupAllowlist)).toHaveLength(0);
  });

  it("refuses a cross-origin post before touching the list", async () => {
    const cookie = await signInAs({ admin: true });
    await db.insert(signupAllowlist).values({ email: "friend@example.com" });

    const response = await createApp().fetch(
      post(ADMIN_ALLOWLIST_REMOVE_PATH, cookie, "friend@example.com", "https://evil.test"),
      bindings(),
    );
    expect(response.status).toBe(403);
    expect(await db.select().from(signupAllowlist)).toHaveLength(1);
  });
});

/** A post to the open-sign-ups switch, which carries `open` rather than `email`. */
function postMode(cookie: string, open: string, origin: string = ORIGIN) {
  return new Request(`${ORIGIN}${ADMIN_SIGNUP_MODE_PATH}`, {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded", origin },
    body: new URLSearchParams({ open }),
  });
}

describe("the open-sign-ups switch (M30)", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("answers 404, not 403, to a signed-in non-admin", async () => {
    const cookie = await signInAs({ admin: false });
    const response = await createApp().fetch(postMode(cookie, "on"), bindings());
    expect(response.status).toBe(404);
    expect(await isOpenSignups(db)).toBe(false);
  });

  it("refuses a cross-origin post before touching the setting", async () => {
    const cookie = await signInAs({ admin: true });
    const response = await createApp().fetch(postMode(cookie, "on", "https://evil.test"), bindings());
    expect(response.status).toBe(403);
    expect(await isOpenSignups(db)).toBe(false);
  });

  it("turns the switch on and back off, redirecting to the list each time", async () => {
    const cookie = await signInAs({ admin: true });
    const app = createApp();

    const opened = await app.fetch(postMode(cookie, "on"), bindings());
    expect(opened.status).toBe(303);
    expect(opened.headers.get("location")).toBe(ADMIN_ALLOWLIST_PATH);
    expect(await isOpenSignups(db)).toBe(true);

    const closed = await app.fetch(postMode(cookie, "off"), bindings());
    expect(closed.status).toBe(303);
    expect(await isOpenSignups(db)).toBe(false);
  });

  it("sets the state the form asked for rather than flipping the current one", async () => {
    // A stale page resubmitted must not toggle: it asks for the state its own
    // button offered, and asking for a state already set is a no-op.
    const cookie = await signInAs({ admin: true });
    const app = createApp();
    await app.fetch(postMode(cookie, "on"), bindings());
    await app.fetch(postMode(cookie, "on"), bindings());
    expect(await isOpenSignups(db)).toBe(true);
  });

  it("treats a value it does not recognise as off", async () => {
    const cookie = await signInAs({ admin: true });
    const app = createApp();
    await app.fetch(postMode(cookie, "on"), bindings());
    await app.fetch(postMode(cookie, "yes"), bindings());
    expect(await isOpenSignups(db)).toBe(false);
  });

  it("shows the allow-list page in each state, with the button offering the other", async () => {
    const cookie = await signInAs({ admin: true });
    const app = createApp();

    const restricted = await (await app.fetch(get(cookie), bindings())).text();
    expect(restricted).toContain("Allow list only.");
    expect(restricted).toContain("Open sign ups to everyone");

    await setOpenSignups(db, true);
    const open = await (await app.fetch(get(cookie), bindings())).text();
    expect(open).toContain("Open to everyone.");
    expect(open).toContain("Restrict to the allow list");
    expect(open).toContain("not in effect");
  });

  it("makes the sign-in doctor report a stranger as able to sign in", async () => {
    // The route, the gate and the doctor's own union, in one pass: the doctor
    // recomputes "permitted" from the doors it is handed, so a door the gate
    // honours and the doctor omits would show up here as a contradiction.
    const cookie = await signInAs({ admin: true });
    const app = createApp();
    await app.fetch(postMode(cookie, "on"), bindings());

    const response = await app.fetch(post(ADMIN_SIGNIN_CHECK_PATH, cookie, "stranger@example.com"), bindings());
    const html = await response.text();
    expect(html).toContain("Can sign in.");
    expect(html).toContain("Open sign ups (allow list not in effect)");
  });
});

describe("the admin index and diagnostic pages (M17)", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("answers 404 to a signed-in non-admin on all four new endpoints", async () => {
    const cookie = await signInAs({ admin: false });
    const app = createApp();
    for (const request of [
      new Request(`${ORIGIN}${ADMIN_PATH}`, { headers: { cookie } }),
      new Request(`${ORIGIN}${ADMIN_SIGNIN_DOCTOR_PATH}`, { headers: { cookie } }),
      new Request(`${ORIGIN}${ADMIN_DELIVERY_PATH}`, { headers: { cookie } }),
      post(ADMIN_SIGNIN_CHECK_PATH, cookie, "anyone@example.com"),
    ]) {
      const response = await app.fetch(request, bindings());
      expect(response.status).toBe(404);
    }
  });

  it("shows an admin the index with all three tools linked", async () => {
    const cookie = await signInAs({ admin: true });
    const response = await createApp().fetch(
      new Request(`${ORIGIN}${ADMIN_PATH}`, { headers: { cookie } }),
      bindings(),
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(`href="${ADMIN_ALLOWLIST_PATH}"`);
    expect(html).toContain(`href="${ADMIN_SIGNIN_DOCTOR_PATH}"`);
    expect(html).toContain(`href="${ADMIN_DELIVERY_PATH}"`);
  });

  it("lists refused attempts newest first, capped at ten, addresses escaped", async () => {
    const cookie = await signInAs({ admin: true });
    const base = Date.parse("2026-08-19T09:00:00Z");
    for (let i = 0; i < 12; i++) {
      await recordSignInRefusal(db, `refused${i}@example.com`, new Date(base + i * 60_000));
    }
    await recordSignInRefusal(db, `<img src=x>@example.com`, new Date(base + 13 * 60_000));

    const response = await createApp().fetch(
      new Request(`${ORIGIN}${ADMIN_SIGNIN_DOCTOR_PATH}`, { headers: { cookie } }),
      bindings(),
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    // Newest first, exactly ten of the thirteen: the hostile one plus 11..3.
    expect(html).toContain("&lt;img src=x&gt;@example.com");
    expect(html).not.toContain("<img src=x>");
    expect(html).toContain("refused11@example.com");
    expect(html).toContain("refused3@example.com");
    expect(html).not.toContain("refused2@example.com");
    // Order pinned with both presences asserted above, so neither indexOf
    // can be a vacuous -1.
    expect(html.indexOf("refused11@example.com")).toBeGreaterThan(-1);
    expect(html.indexOf("refused11@example.com")).toBeLessThan(html.indexOf("refused3@example.com"));
  });

  it("answers a doctor check with every door's verdict", async () => {
    const cookie = await signInAs({ admin: true });
    await db.insert(signupAllowlist).values({ email: "friend@example.com" });
    const app = createApp();

    const listed = await app.fetch(post(ADMIN_SIGNIN_CHECK_PATH, cookie, "Friend@Example.COM"), bindings());
    expect(listed.status).toBe(200);
    const listedHtml = await listed.text();
    expect(listedHtml).toContain("friend@example.com");
    expect(listedHtml).toContain("Can sign in.");
    expect(listedHtml.match(/"door-open"/g)).toHaveLength(1); // the table door only

    const stranger = await app.fetch(post(ADMIN_SIGNIN_CHECK_PATH, cookie, "stranger@example.com"), bindings());
    const strangerHtml = await stranger.text();
    expect(strangerHtml).toContain("Cannot sign in");
    // Four doors since M30 added the open-sign-ups one.
    expect(strangerHtml.match(/"door-shut"/g)).toHaveLength(4);
  });

  it("re-renders the doctor at 422 for an implausible address", async () => {
    const cookie = await signInAs({ admin: true });
    const response = await createApp().fetch(post(ADMIN_SIGNIN_CHECK_PATH, cookie, "not an email"), bindings());
    expect(response.status).toBe(422);
    expect(await response.text()).toContain("That doesn&#39;t look like an email address.");
  });

  it("refuses a cross-origin doctor check", async () => {
    const cookie = await signInAs({ admin: true });
    const response = await createApp().fetch(
      post(ADMIN_SIGNIN_CHECK_PATH, cookie, "friend@example.com", "https://evil.example"),
      bindings(),
    );
    expect(response.status).toBe(403);
  });

  it("shows pending link requests from the verification table with the gate's current answer", async () => {
    const cookie = await signInAs({ admin: true });
    // signIn() consumed its own link, so issue a fresh pending one for the
    // permitted address alongside the refused stranger's.
    const app = createApp();
    for (const email of [ALLOWED, "stranger@example.com"]) {
      await app.fetch(
        new Request(`${ORIGIN}/api/auth/sign-in/magic-link`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: ORIGIN },
          body: JSON.stringify({ email }),
        }),
        bindings(),
      );
    }

    const response = await app.fetch(
      new Request(`${ORIGIN}${ADMIN_SIGNIN_DOCTOR_PATH}`, { headers: { cookie } }),
      bindings(),
    );
    const html = await response.text();
    expect(html).toContain("stranger@example.com");
    expect(html).toContain("would be refused");
    expect(html).toContain("would be sent a link");
  });

  it("shows the delivery page with today's quota count and recent notification rows", async () => {
    const cookie = await signInAs({ admin: true });
    // signIn() sent one magic-link email through the real notifier factory,
    // so today's quota row already reads 1.
    const playerId = await insertPlayer(db, { email: "member@example.com" });
    await db.insert(notificationLog).values({
      id: crypto.randomUUID(),
      dedupeKey: crypto.randomUUID(),
      notificationType: "n1",
      playerId,
      channel: "email",
      status: "failed",
      error: "provider said no <script>",
      createdAt: new Date("2026-08-19T08:00:00Z"),
    });

    const response = await createApp().fetch(
      new Request(`${ORIGIN}${ADMIN_DELIVERY_PATH}`, { headers: { cookie } }),
      bindings(),
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Sent today (UTC): 1 of");
    expect(html).toContain("failed");
    expect(html).toContain("provider said no &lt;script&gt;");
  });
});

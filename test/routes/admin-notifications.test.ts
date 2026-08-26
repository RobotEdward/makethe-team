import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { ADMIN_NOTIFICATIONS_PATH, ADMIN_NOTIFICATIONS_SET_PATH, SIGN_IN_PATH } from "../../src/auth/paths.js";
import { getDb } from "../../src/db/client.js";
import { user } from "../../src/db/schema.js";
import { loadAdminNotificationSwitches } from "../../src/domain/app-settings.js";
import { resetDatabase } from "../support/factories.js";
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
  return new Request(`${ORIGIN}${ADMIN_NOTIFICATIONS_PATH}`, { headers: { cookie } });
}

function post(
  cookie: string,
  body: Record<string, string>,
  origin: string = ORIGIN,
) {
  return new Request(`${ORIGIN}${ADMIN_NOTIFICATIONS_SET_PATH}`, {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded", origin },
    body: new URLSearchParams(body),
  });
}

describe("the admin notifications screen", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("redirects an anonymous visitor to sign-in", async () => {
    const response = await createApp().fetch(new Request(`${ORIGIN}${ADMIN_NOTIFICATIONS_PATH}`), bindings());
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(SIGN_IN_PATH);
  });

  it("answers 404, not 403, to a signed-in non-admin", async () => {
    const cookie = await signInAs({ admin: false });
    const response = await createApp().fetch(get(cookie), bindings());
    expect(response.status).toBe(404);
  });

  it("renders three bands: owner-controllable, administrator-only, never switchable", async () => {
    const cookie = await signInAs({ admin: true });
    const response = await createApp().fetch(get(cookie), bindings());
    expect(response.status).toBe(200);
    const html = await response.text();

    expect(html).toContain("Owners can also switch these off per game");
    expect(html).toContain("Administrator only");
    expect(html).toContain("Never switched off");
    for (const t of ["n2", "n3", "n5", "n8"]) {
      expect(html).toMatch(new RegExp(`data-notification="${t}"[^>]*>[\\s\\S]*?No control`));
    }
    expect(html).not.toContain('name="type" value="n5"');
  });

  it("renders a dash for n11's email", async () => {
    const cookie = await signInAs({ admin: true });
    const response = await createApp().fetch(get(cookie), bindings());
    const html = await response.text();

    // n11 (group-chat nudge) has no email leg at all; the row must not offer
    // a form for a channel that does not exist.
    expect(html).not.toContain('name="type" value="n11"><input type="hidden" name="channel" value="email"');
  });

  it("turns a channel off and back on", async () => {
    const cookie = await signInAs({ admin: true });
    const app = createApp();

    let response = await app.fetch(post(cookie, { type: "n9", channel: "email" }), bindings());
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(ADMIN_NOTIFICATIONS_PATH);
    expect((await loadAdminNotificationSwitches(db)).isOn("n9", "email")).toBe(false);

    response = await app.fetch(post(cookie, { type: "n9", channel: "email", on: "on" }), bindings());
    expect(response.status).toBe(303);
    expect((await loadAdminNotificationSwitches(db)).isOn("n9", "email")).toBe(true);
  });

  it("refuses an unknown type or channel with a 404", async () => {
    const cookie = await signInAs({ admin: true });
    const app = createApp();

    let response = await app.fetch(post(cookie, { type: "n99", channel: "email" }), bindings());
    expect(response.status).toBe(404);

    response = await app.fetch(post(cookie, { type: "n9", channel: "sms" }), bindings());
    expect(response.status).toBe(404);
  });

  it("refuses a cross-origin post", async () => {
    const cookie = await signInAs({ admin: true });
    const response = await createApp().fetch(
      post(cookie, { type: "n9", channel: "email" }, "https://evil.test"),
      bindings(),
    );
    expect(response.status).toBe(403);
  });
});

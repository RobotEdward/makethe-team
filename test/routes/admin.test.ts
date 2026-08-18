import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import {
  ADMIN_ALLOWLIST_ADD_PATH,
  ADMIN_ALLOWLIST_PATH,
  ADMIN_ALLOWLIST_REMOVE_PATH,
  SIGN_IN_PATH,
} from "../../src/auth/paths.js";
import { getDb } from "../../src/db/client.js";
import { signupAllowlist, user } from "../../src/db/schema.js";
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

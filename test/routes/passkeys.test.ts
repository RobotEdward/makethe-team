import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { PASSKEYS_PATH, SIGN_IN_PATH } from "../../src/auth/session.js";
import { getDb } from "../../src/db/client.js";
import { passkey, players, user as userTable } from "../../src/db/schema.js";
import { PASSKEY_REGISTER_JS } from "../../src/views/scripts.js";
import { FIXTURE_STYLES_CSS } from "../../src/views/styles.js";
import { resetDatabase } from "../support/factories.js";
import { ORIGIN, bindings, signIn } from "../support/sign-in.js";

/**
 * `/app/passkeys` — the only page in the app whose reason to exist is an
 * enhancement, and therefore the one that has to be most careful about what
 * it does when the enhancement is unavailable.
 */

beforeEach(async () => {
  await resetDatabase();
});

/** A passkey row for `userId`, with a name that identifies it in the page. */
async function givePasskey(userId: string, name: string): Promise<void> {
  await getDb(env.DB).insert(passkey).values({
    id: crypto.randomUUID(),
    userId,
    name,
    publicKey: "not-a-real-key",
    credentialID: crypto.randomUUID(),
    counter: 0,
    deviceType: "singleDevice",
    backedUp: true,
    createdAt: new Date("2030-01-01T00:00:00Z"),
  });
}

async function get(cookie?: string) {
  return createApp().fetch(
    new Request(`${ORIGIN}${PASSKEYS_PATH}`, { headers: cookie ? { cookie } : {} }),
    bindings(),
  );
}

describe("GET /app/passkeys", () => {
  it("sends an anonymous visitor to sign in rather than offering to add a passkey", async () => {
    const response = await get();

    // The whole shape of the feature in one assertion: you sign in *first*,
    // by email, and only then add a passkey. A page that let a stranger start
    // a registration would be a passkey-first path, and a lost authenticator
    // would then be a lost account.
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(SIGN_IN_PATH);
    expect(await response.text()).not.toContain("<script");
  });

  it("gives a session with no linked Player the 403 page and its exits", async () => {
    const { cookie } = await signIn();
    await getDb(env.DB).delete(players);

    const response = await get(cookie);
    const body = await response.text();

    expect(response.status).toBe(403);
    expect(body).toMatch(/We can't find your player/);
    // And no script on the refusal: the enhancement is not offered to someone
    // who cannot use the account it would attach to.
    expect(body).not.toContain("<script");
  });

  it("serves a signed-in player the page, with the add button hidden until script runs", async () => {
    const { cookie } = await signIn();

    const response = await get(cookie);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toMatch(/You haven't added a passkey yet/);
    // Present, hidden, and revealed only by the enumerated script.
    expect(body).toMatch(/<div class="passkey" id="passkey-add" hidden>/);
    expect(body).toContain(`<script>${PASSKEY_REGISTER_JS}</script>`);
    // Signed-in data: never cached anywhere but this browser.
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("ends in one back link, wearing the class §2.5 names", async () => {
    // The link was already here; the class was not, so the 1.5rem that keeps
    // it off the block above it never applied. `.back-link` is declared in
    // FIXTURE_STYLES_CSS, so the page has to carry that block for the class
    // to mean anything — a class with no rule behind it fails silently.
    const { cookie } = await signIn();
    const body = await (await get(cookie)).text();

    expect(body).toContain(`<p class="back-link">`);
    expect(body.match(/class="back-link"/g)).toHaveLength(1);
    expect(body).toContain(FIXTURE_STYLES_CSS);
  });

  it("lists this identity's passkeys and nobody else's (TR-18)", async () => {
    const { cookie } = await signIn();
    const db = getDb(env.DB);
    const [mine] = await db.select().from(userTable);

    await db.insert(userTable).values({
      id: crypto.randomUUID(),
      name: "Someone Else",
      email: "someone@example.com",
      emailVerified: true,
      createdAt: new Date("2030-01-01T00:00:00Z"),
      updatedAt: new Date("2030-01-01T00:00:00Z"),
    });
    const [, theirs] = await db.select().from(userTable);

    await givePasskey(mine!.id, "Laptop of mine");
    await givePasskey(theirs!.id, "Phone of theirs");

    const body = await (await get(cookie)).text();

    // The guard establishes *who*; it says nothing about which rows may be
    // read. The handler's own `where userId = session.user.id` is what does,
    // and this is the mutation that would survive if it were dropped.
    expect(body).toContain("Laptop of mine");
    expect(body).not.toContain("Phone of theirs");
  });

  it("escapes a passkey name rather than rendering it", async () => {
    const { cookie } = await signIn();
    const [mine] = await getDb(env.DB).select().from(userTable);
    // A name is attacker-controlled: `verify-registration` takes one from the
    // request body, so this string can genuinely reach this page.
    await givePasskey(mine!.id, `<img src=x onerror=alert(1)>`);

    const body = await (await get(cookie)).text();

    expect(body).not.toContain("<img");
    expect(body).toContain("&lt;img");
  });
});

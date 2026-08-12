import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { AUTH_API_PREFIX } from "../../src/auth/paths.js";
import { getDb } from "../../src/db/client.js";
import { passkey as passkeyTable, session as sessionTable, user as userTable } from "../../src/db/schema.js";
import { resetDatabase } from "../support/factories.js";
import { ORIGIN, bindings, signIn } from "../support/sign-in.js";
import {
  buildRegistration,
  challengeCookieFrom,
  generateCredential,
  signAssertion,
} from "../support/webauthn.js";

/**
 * The passkey plugin, at the paths it actually publishes.
 *
 * Every path asserted below was read out of `@better-auth/passkey`'s own
 * bundle (`node_modules/@better-auth/passkey/dist/index.mjs`, the
 * `createAuthEndpoint("/passkey/…")` calls) rather than guessed from the
 * documentation — the same method Task 5 used for magic link, which is what
 * caught that `/magic-link/verify` answers with JSON rather than a redirect
 * when `callbackURL` is absent. These tests exist so that a Better Auth
 * upgrade that moves or renames an endpoint breaks here, loudly, instead of
 * in a browser where the only symptom is a button that does nothing.
 */
const PASSKEY_PREFIX = `${AUTH_API_PREFIX}/passkey`;

describe("the passkey plugin", () => {
  it("is mounted, at the endpoint paths the plugin itself declares", async () => {
    await resetDatabase();
    const app = createApp();

    // Anonymous: authentication options are public by design (a passkey is
    // discoverable, so there is no user to know about yet).
    const options = await app.fetch(
      new Request(`${ORIGIN}${PASSKEY_PREFIX}/generate-authenticate-options`),
      bindings(),
    );

    expect(options.status).toBe(200);
    const body = (await options.json()) as { challenge?: string; rpId?: string };
    expect(typeof body.challenge).toBe("string");
    // The relying party is this deployment, resolved from `BETTER_AUTH_URL`.
    expect(body.rpId).toBe(new URL(ORIGIN).hostname);
  });

  it("refuses to start a registration without a session (401, not a 404)", async () => {
    await resetDatabase();

    const response = await createApp().fetch(
      new Request(`${ORIGIN}${PASSKEY_PREFIX}/generate-register-options`),
      bindings(),
    );

    // 401 and not 404 is the whole point: the endpoint exists and is refusing.
    // A 404 here would mean the plugin was never configured and the test above
    // was passing for the wrong reason.
    expect(response.status).toBe(401);
  });

  it("refuses to finish a registration without a session", async () => {
    await resetDatabase();

    const response = await createApp().fetch(
      new Request(`${ORIGIN}${PASSKEY_PREFIX}/verify-registration`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({ response: {} }),
      }),
      bindings(),
    );

    expect(response.status).toBe(401);
  });

  it("issues registration options to a signed-in person", async () => {
    await resetDatabase();
    const { cookie } = await signIn();

    const response = await createApp().fetch(
      new Request(`${ORIGIN}${PASSKEY_PREFIX}/generate-register-options`, {
        headers: { cookie },
      }),
      bindings(),
    );

    expect(response.status).toBe(200);
    const options = (await response.json()) as {
      challenge?: string;
      rp?: { id?: string; name?: string };
      user?: { id?: string };
    };
    expect(typeof options.challenge).toBe("string");
    expect(options.rp?.id).toBe(new URL(ORIGIN).hostname);
    // A human-readable relying-party name, not the bare hostname: this is the
    // text the operating system's passkey prompt puts in front of a player.
    expect(options.rp?.name).toBe("Make The Team");
    expect(options.user?.id).toBeTruthy();
  });

  it("stores passkeys in a table this database actually has", async () => {
    // Migration 0006 adds `passkey`. Without it every registration would fail
    // at the last step, after the player had already used their authenticator.
    const result = await env.DB.prepare(
      "select name from sqlite_master where type = 'table' and name = 'passkey'",
    ).all();

    expect(result.results).toHaveLength(1);
  });

  /**
   * The step between the two tests above, which nothing executed until a live
   * iOS registration failed and the suite could neither convict the server nor
   * clear it. `generate-register-options` was covered, the 401 on an anonymous
   * `verify-registration` was covered, and the write in between — the one that
   * actually persists a passkey — was not.
   *
   * Driven through `createApp()` and the real plugin, with a real P-256
   * attestation (`fmt: "none"`, the format every platform authenticator
   * actually sends), so a Better Auth upgrade that changes the accepted body
   * shape breaks here rather than in somebody's browser.
   */
  it("completes a registration and persists the passkey", async () => {
    await resetDatabase();
    const app = createApp();
    const { cookie } = await signIn();

    const optionsResponse = await app.fetch(
      new Request(`${ORIGIN}${PASSKEY_PREFIX}/generate-register-options`, {
        headers: { cookie },
      }),
      bindings(),
    );
    expect(optionsResponse.status).toBe(200);
    const options = (await optionsResponse.json()) as { challenge: string; rp: { id: string } };

    // The browser carries both: the session that authorises adding a passkey
    // at all (`registration.requireSession`), and the signed challenge cookie
    // the options call just set.
    const registration = await buildRegistration({
      rpId: options.rp.id,
      challenge: options.challenge,
      clientDataOrigin: ORIGIN,
    });

    const response = await app.fetch(
      new Request(`${ORIGIN}${PASSKEY_PREFIX}/verify-registration`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: ORIGIN,
          cookie: `${cookie}; ${challengeCookieFrom(optionsResponse)}`,
        },
        body: JSON.stringify({ response: registration.response }),
      }),
      bindings(),
    );

    expect(response.status).toBe(200);

    const stored = await getDb(env.DB).select().from(passkeyTable);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.credentialID).toBe(registration.credentialId);
  });
});

describe("the origin pin (src/auth/factory.ts's `origin: new URL(env.BETTER_AUTH_URL).origin`)", () => {
  /**
   * M5 Task 8 review, Important-1: every other guard in this task is
   * mutation-covered, and this line was not. It is the one line that decides
   * whether a WebAuthn assertion *signed for a different site* can mint a
   * session here — everything else (a hostile `Origin` *header*, or a missing
   * one) is refused earlier, by Better Auth's own trusted-origin check
   * (403 `INVALID_ORIGIN` / `MISSING_OR_NULL_ORIGIN`), before the plugin is
   * ever reached. The pin is what is left once that header is exactly right,
   * which is the situation an attacker who can get a victim to complete a
   * real WebAuthn ceremony on `evil.example` — a same-origin request to
   * *this* deployment, carrying an assertion signed for the other one — is
   * actually in.
   *
   * `test/support/webauthn.ts` builds the real ceremony: a P-256 keypair, a
   * hand-rolled COSE public key stored the way `verifyPasskeyRegistration`
   * itself would have stored it, and a DER-encoded signature over
   * `authenticatorData ‖ SHA-256(clientDataJSON)` — the exact bytes
   * `verifyAuthenticationResponse` recomputes and checks. Nothing here forges
   * a session directly; the only privileged actions are the two writes any
   * real registration ceremony would also have made (a `user` row and a
   * `passkey` row), so the property under test is the plugin's own
   * verification, not a shortcut around it.
   */
  async function seedCredential() {
    const db = getDb(env.DB);
    const userId = crypto.randomUUID();
    const now = new Date("2030-01-01T00:00:00Z");
    await db.insert(userTable).values({
      id: userId,
      name: "Ada",
      email: "ada@example.com",
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });

    const credential = await generateCredential();
    const credentialId = crypto.randomUUID();
    await db.insert(passkeyTable).values({
      id: crypto.randomUUID(),
      userId,
      publicKey: credential.publicKeyBase64,
      credentialID: credentialId,
      counter: 0,
      deviceType: "singleDevice",
      backedUp: false,
      createdAt: now,
    });

    return { userId, credentialId, privateKey: credential.privateKey };
  }

  async function requestChallenge(app: ReturnType<typeof createApp>) {
    const response = await app.fetch(
      new Request(`${ORIGIN}${AUTH_API_PREFIX}/passkey/generate-authenticate-options`),
      bindings(),
    );
    const body = (await response.json()) as { challenge: string; rpId: string };
    return { challenge: body.challenge, rpId: body.rpId, cookie: challengeCookieFrom(response) };
  }

  it("mints a session for an assertion genuinely signed for this deployment's origin", async () => {
    await resetDatabase();
    const app = createApp();
    const { credentialId, privateKey } = await seedCredential();
    const { challenge, rpId, cookie } = await requestChallenge(app);

    const assertion = await signAssertion({
      credentialId,
      privateKey,
      rpId,
      challenge,
      clientDataOrigin: ORIGIN,
    });

    const response = await app.fetch(
      new Request(`${ORIGIN}${AUTH_API_PREFIX}/passkey/verify-authentication`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN, cookie },
        body: JSON.stringify({ response: assertion }),
      }),
      bindings(),
    );

    // Control: the ceremony itself is real, so a genuine assertion succeeds
    // and actually mints a session — proof the refusal below is a refusal,
    // not the machinery failing to produce a valid request at all.
    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie().length).toBeGreaterThan(0);
    expect(await getDb(env.DB).select().from(sessionTable)).toHaveLength(1);
  });

  it("refuses an assertion signed for a foreign origin, even with a same-origin request", async () => {
    await resetDatabase();
    const app = createApp();
    const { credentialId, privateKey } = await seedCredential();
    const { challenge, rpId, cookie } = await requestChallenge(app);

    const assertion = await signAssertion({
      credentialId,
      privateKey,
      rpId,
      challenge,
      // The HTTP `Origin` header below is this deployment's own trusted
      // origin — Better Auth's trusted-origin check has nothing to refuse.
      // Only the WebAuthn signature says this assertion was made for a
      // different site, which is exactly what `expectedOrigin` — set from
      // the pin, not from `ctx.headers` — is there to catch.
      clientDataOrigin: "https://evil.example",
    });

    const response = await app.fetch(
      new Request(`${ORIGIN}${AUTH_API_PREFIX}/passkey/verify-authentication`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN, cookie },
        body: JSON.stringify({ response: assertion }),
      }),
      bindings(),
    );

    expect(response.status).toBe(400);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(await getDb(env.DB).select().from(sessionTable)).toHaveLength(0);
  });
});

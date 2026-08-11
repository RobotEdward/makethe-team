import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { AUTH_API_PREFIX } from "../../src/auth/paths.js";
import { resetDatabase } from "../support/factories.js";
import { ORIGIN, bindings, signIn } from "../support/sign-in.js";

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
});

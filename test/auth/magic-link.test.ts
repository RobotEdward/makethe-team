import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createAuth, isSignInAllowlisted } from "../../src/auth/factory.js";
import { getDb } from "../../src/db/client.js";
import type { Message, Notifier, SendResult } from "../../src/notify/notifier.js";
import { resetDatabase } from "../support/factories.js";

const BASE_URL = "http://localhost:8787";
const NOW = new Date("2026-08-11T09:00:00Z");

/**
 * Records what it was asked to send and reports success.
 *
 * The suite asserts against `sent` directly rather than against "no email
 * arrived": the repo-wide `outboundService` in `vitest.config.ts` already
 * makes a real send impossible, so an absent email proves nothing about
 * whether the gate ran. Only "the notifier was never called" does.
 */
class RecordingNotifier implements Notifier {
  readonly sent: Message[] = [];
  send(messages: readonly Message[]): Promise<SendResult[]> {
    this.sent.push(...messages);
    return Promise.resolve(messages.map((): SendResult => ({ ok: true, providerMessageId: null })));
  }
}

function bindings(allowlist: string | undefined) {
  return { ...env, BETTER_AUTH_URL: BASE_URL, SIGNIN_ALLOWLIST: allowlist as string };
}

async function requestMagicLink(email: string, allowlist: string | undefined) {
  const notifier = new RecordingNotifier();
  const auth = createAuth(bindings(allowlist), getDb(env.DB), NOW, notifier);
  const response = await auth.handler(
    new Request(`${BASE_URL}/api/auth/sign-in/magic-link`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE_URL },
      body: JSON.stringify({ email }),
    }),
  );
  return { notifier, response };
}

/**
 * Everything a caller of the sign-in endpoint can observe, flattened so two
 * responses can be compared as one value.
 *
 * Deliberately more than the body: an enumeration oracle does not care which
 * channel leaks the difference, so the status line, every header (sorted, so
 * ordering is not mistaken for a difference), the `Set-Cookie` list — which
 * `Headers.get` would collapse — and whether the response redirects are all
 * folded in alongside the bytes.
 */
async function observable(response: Response) {
  return {
    status: response.status,
    statusText: response.statusText,
    redirected: response.redirected,
    type: response.type,
    setCookie: response.headers.getSetCookie(),
    headers: [...response.headers].sort(([a], [b]) => a.localeCompare(b)),
    body: await response.text(),
  };
}

describe("magic link issuance", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("sends a sign-in link through our Notifier for an allowlisted address", async () => {
    const { notifier, response } = await requestMagicLink(
      "someone@example.com",
      "someone@example.com,other@example.com",
    );

    expect(response.status).toBe(200);
    expect(notifier.sent).toHaveLength(1);

    const message = notifier.sent[0]!;
    expect(message.channel).toBe("email");
    expect(message.to).toBe("someone@example.com");
    expect(message.subject).toBe("Your sign-in link");

    // A working link, in both renditions, pointing at this deployment's own
    // verify endpoint.
    const match = /https?:\/\/[^\s"]*magic-link\/verify\?[^\s"]*/.exec(message.text);
    expect(match).not.toBeNull();
    const url = new URL(match![0]);
    expect(url.origin).toBe(BASE_URL);
    expect(url.pathname).toBe("/api/auth/magic-link/verify");
    expect(url.searchParams.get("token")).toBeTruthy();
    expect(message.html).toContain("magic-link/verify");
    expect(message.html).toContain(url.searchParams.get("token")!);
  });

  it("sends nothing at all for an address that is not on the allowlist", async () => {
    const { notifier } = await requestMagicLink("stranger@example.com", "someone@example.com");

    expect(notifier.sent).toEqual([]);
  });

  it("answers a non-allowlisted address identically to an allowlisted one", async () => {
    const allowed = await requestMagicLink("someone@example.com", "someone@example.com");
    const refused = await requestMagicLink("stranger@example.com", "someone@example.com");

    expect(await observable(refused.response)).toEqual(await observable(allowed.response));
    expect(allowed.notifier.sent).toHaveLength(1);
    expect(refused.notifier.sent).toEqual([]);
  });

  it("ignores surrounding whitespace and ASCII case in the allowlist", async () => {
    const allowlist = "  Someone@Example.com ,\n other@example.com  ";

    const exact = await requestMagicLink("someone@example.com", allowlist);
    expect(exact.notifier.sent).toHaveLength(1);

    const shouted = await requestMagicLink("SOMEONE@EXAMPLE.COM", allowlist);
    expect(shouted.notifier.sent).toHaveLength(1);

    const second = await requestMagicLink("other@example.com", allowlist);
    expect(second.notifier.sent).toHaveLength(1);

    const stranger = await requestMagicLink("someone.else@example.com", allowlist);
    expect(stranger.notifier.sent).toEqual([]);
  });

  it("fails closed when the allowlist is empty, blank or unset", async () => {
    for (const allowlist of ["", "   ", ",", " , ,, ", undefined]) {
      const { notifier, response } = await requestMagicLink("someone@example.com", allowlist);
      expect(notifier.sent, `allowlist ${JSON.stringify(allowlist)} must send nothing`).toEqual([]);
      expect(response.status).toBe(200);
    }
  });

  it("answers identically even when the notifier itself blows up", async () => {
    // The oracle does not have to come from the gate. If a send failure
    // escaped as a 500, an allowlisted address would answer differently from
    // a refused one on any day the provider was misconfigured.
    const exploding: Notifier = {
      send: () => Promise.reject(new Error("provider is on fire")),
    };
    const auth = createAuth(bindings("someone@example.com"), getDb(env.DB), NOW, exploding);
    const broken = await auth.handler(
      new Request(`${BASE_URL}/api/auth/sign-in/magic-link`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE_URL },
        body: JSON.stringify({ email: "someone@example.com" }),
      }),
    );
    const refused = await requestMagicLink("stranger@example.com", "someone@example.com");

    expect(await observable(broken)).toEqual(await observable(refused.response));
  });
});

/**
 * The gate on its own. The endpoint tests above are the ones that matter, but
 * a few inputs cannot be driven through the endpoint at all — Better Auth's
 * body schema rejects a blank address with a 400 long before the gate is
 * reached — and the degenerate "empty entry matches empty address" case is
 * exactly the parser bug that would open the list up.
 */
describe("isSignInAllowlisted", () => {
  it("never matches a blank address, whatever the list contains", () => {
    expect(isSignInAllowlisted("someone@example.com,,", "")).toBe(false);
    expect(isSignInAllowlisted("someone@example.com,,", "   ")).toBe(false);
    expect(isSignInAllowlisted(",,,", "")).toBe(false);
  });

  it("matches only whole entries, never a prefix or substring", () => {
    expect(isSignInAllowlisted("someone@example.com", "someone@example.com.evil.test")).toBe(false);
    expect(isSignInAllowlisted("someone@example.com", "one@example.com")).toBe(false);
  });

  it("folds ASCII case only, so a non-ASCII confusable cannot match", () => {
    // Matches `normaliseEmail` in link-player.ts: a full-Unicode fold would
    // let U+212A KELVIN SIGN collapse onto `k`.
    expect(isSignInAllowlisted("k@example.com", "K@example.com")).toBe(false);
    expect(isSignInAllowlisted("K@example.com", "k@example.com")).toBe(true);
  });
});

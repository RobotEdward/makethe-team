import { describe, expect, it } from "vitest";
import {
  assertVapidKeysMatch,
  base64UrlDecode,
  base64UrlEncode,
  importVapidKeys,
  vapidHeaders,
} from "../../src/notify/web-push.js";

/**
 * Generated per test rather than pinned to a fixture, and verified against
 * the public key rather than compared to a stored string. A hardcoded
 * expected JWT would prove only that the implementation still agrees with
 * itself — and ECDSA signatures are randomised, so it could not even do that.
 *
 * The narrowing below mirrors `web-push.ts`'s own `generateEphemeralKeyPair`
 * / `exportRawPublicKey`: `generateKey` is typed `CryptoKey | CryptoKeyPair`
 * and `exportKey` is typed `ArrayBuffer | JsonWebKey` because one signature
 * covers every algorithm and format, so a real check that throws replaces
 * what would otherwise be a cast past the union.
 */
async function freshKeys(): Promise<{ publicKey: string; privateKey: string }> {
  const generated = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  if (!("privateKey" in generated)) {
    throw new Error("expected an ECDSA key pair from generateKey");
  }

  const exportedRaw = await crypto.subtle.exportKey("raw", generated.publicKey);
  if (!(exportedRaw instanceof ArrayBuffer)) {
    throw new Error('exportKey("raw") did not return raw bytes');
  }

  const jwk = await crypto.subtle.exportKey("jwk", generated.privateKey);
  if (jwk instanceof ArrayBuffer || typeof jwk.d !== "string") {
    throw new Error('exportKey("jwk") did not return a private key with "d"');
  }

  return { publicKey: base64UrlEncode(new Uint8Array(exportedRaw)), privateKey: jwk.d };
}

/** Splits the `Authorization` header into its three VAPID fields, failing loudly if any is missing. */
function splitAuthorization(headers: Record<string, string>): { scheme: string; token: string; key: string } {
  const authorization = headers.Authorization;
  if (authorization === undefined) {
    throw new Error("vapidHeaders did not set an Authorization header");
  }
  const [scheme, token, key] = authorization.split(/[ ,]+/);
  if (scheme === undefined || token === undefined || key === undefined) {
    throw new Error(`Authorization header is not "vapid t=..., k=...": ${authorization}`);
  }
  return { scheme, token, key };
}

describe("VAPID", () => {
  it("signs a JWT the push service can verify with the public key", async () => {
    const material = await freshKeys();
    const keys = await importVapidKeys(material.publicKey, material.privateKey, "mailto:ops@makethe.team");

    const headers = await vapidHeaders("https://fcm.googleapis.com/fcm/send/abc", keys, new Date("2026-08-17T12:00:00Z"));
    const { scheme, token, key } = splitAuthorization(headers);

    expect(scheme).toBe("vapid");
    expect(token.startsWith("t=")).toBe(true);
    expect(key).toBe(`k=${material.publicKey}`);

    const [header, payload, signature] = token.slice(2).split(".");
    if (header === undefined || payload === undefined || signature === undefined) {
      throw new Error(`token is not "header.payload.signature": ${token}`);
    }
    const verified = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      await crypto.subtle.importKey("raw", base64UrlDecode(material.publicKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]),
      base64UrlDecode(signature),
      new TextEncoder().encode(`${header}.${payload}`),
    );
    expect(verified).toBe(true);
  });

  it("scopes the token to the push service's origin and expires it", async () => {
    // `aud` is the endpoint's *origin*, not the full URL. Sending the whole
    // endpoint leaks the subscription id to anyone who sees the header, and
    // some services reject it outright.
    const material = await freshKeys();
    const keys = await importVapidKeys(material.publicKey, material.privateKey, "mailto:ops@makethe.team");
    const now = new Date("2026-08-17T12:00:00Z");

    const headers = await vapidHeaders("https://fcm.googleapis.com/fcm/send/abc", keys, now);
    const { token } = splitAuthorization(headers);
    const claims = token.slice(2).split(".")[1];
    if (claims === undefined) {
      throw new Error(`token is not "header.payload.signature": ${token}`);
    }
    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(claims))) as {
      aud: string;
      sub: string;
      exp: number;
    };

    expect(payload.aud).toBe("https://fcm.googleapis.com");
    expect(payload.sub).toBe("mailto:ops@makethe.team");
    // Twelve hours. Some services reject anything beyond 24.
    expect(payload.exp).toBe(Math.floor(now.getTime() / 1000) + 12 * 60 * 60);
  });

  it("throws when the public and private keys are not a pair", async () => {
    // The guard from spec §10.3. Rotating one binding and forgetting the
    // other produces a 403 on every send, forever, with no local symptom at
    // all — the same class of failure `requireBinding` exists to prevent.
    //
    // The mismatched pair is assembled from two *separately valid* imports
    // rather than one JWK built with a's x/y and b's d, because this
    // runtime's EC JWK import validates that d and x/y agree and throws
    // `DataError: Invalid EC key in JSON Web Key` before `assertVapidKeysMatch`
    // ever runs — an even blunter guard than the one under test, and not one
    // every WebCrypto implementation performs (importVapidKeys's own doc
    // comment is written for the implementations that don't). Building the
    // mismatch this way instead exercises `assertVapidKeysMatch` itself,
    // which is the guard this codebase actually depends on.
    const a = await freshKeys();
    const b = await freshKeys();
    const keysA = await importVapidKeys(a.publicKey, a.privateKey, "mailto:ops@makethe.team");
    const keysB = await importVapidKeys(b.publicKey, b.privateKey, "mailto:ops@makethe.team");
    const mismatched = { publicKey: keysA.publicKey, signingKey: keysB.signingKey, subject: keysA.subject };

    await expect(assertVapidKeysMatch(mismatched)).rejects.toThrow(/do not match/i);
  });
});

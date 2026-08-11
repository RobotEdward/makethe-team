import { describe, expect, it } from "vitest";
import {
  responseTokenExpiry,
  signResponseToken,
  verifyResponseToken,
} from "../../src/domain/token.js";

const SECRET = "test-secret-not-used-anywhere-real";
const OTHER_SECRET = "a-different-secret-entirely";
const NOW = new Date("2026-08-12T09:00:00Z");

/** Standard base64 alphabet in base64url form (same order token.ts's own
 * `btoa`-based encoder produces, with `+`/`/` replaced by `-`/`_`). Index in
 * this string is the character's 6-bit value. */
const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function decodeBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Flips one bit in the first byte of a base64url-encoded value and
 * re-encodes — always a genuinely different, still-canonical string,
 * unlike toggling the trailing character (see the "rejects a tampered
 * signature" test). */
function flipFirstByteBase64Url(value: string): string {
  const bytes = decodeBase64Url(value);
  bytes[0] = (bytes[0] ?? 0) ^ 0x01;
  return encodeBase64Url(bytes);
}

function payload(overrides: Partial<Parameters<typeof signResponseToken>[0]> = {}) {
  return {
    playerId: "player-edward",
    fixtureId: "fixture-thursday",
    expiresAt: new Date("2026-08-14T18:00:00Z").getTime(),
    ...overrides,
  };
}

describe("round trip", () => {
  it("verifies a token it just signed", async () => {
    const token = await signResponseToken(payload(), SECRET);
    const result = await verifyResponseToken(token, SECRET, NOW);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.playerId).toBe("player-edward");
      expect(result.payload.fixtureId).toBe("fixture-thursday");
    }
  });

  it("produces a URL-safe token", async () => {
    const token = await signResponseToken(payload(), SECRET);
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(encodeURIComponent(token)).toBe(token);
  });

  it("is deterministic for the same payload and secret", async () => {
    expect(await signResponseToken(payload(), SECRET)).toBe(await signResponseToken(payload(), SECRET));
  });

  it("differs for a different player", async () => {
    const a = await signResponseToken(payload(), SECRET);
    const b = await signResponseToken(payload({ playerId: "player-sam" }), SECRET);
    expect(a).not.toBe(b);
  });
});

describe("rejection", () => {
  it("rejects an expired token (BR-24)", async () => {
    const token = await signResponseToken(payload({ expiresAt: NOW.getTime() - 1 }), SECRET);
    const result = await verifyResponseToken(token, SECRET, NOW);

    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  it("accepts a token expiring exactly now", async () => {
    const token = await signResponseToken(payload({ expiresAt: NOW.getTime() }), SECRET);
    expect((await verifyResponseToken(token, SECRET, NOW)).ok).toBe(true);
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await signResponseToken(payload(), OTHER_SECRET);
    expect(await verifyResponseToken(token, SECRET, NOW)).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("rejects a tampered payload", async () => {
    const token = await signResponseToken(payload(), SECRET);
    const [body, signature] = token.split(".");
    const forged = btoa(JSON.stringify(payload({ playerId: "player-impostor" })))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

    expect(await verifyResponseToken(`${forged}.${signature}`, SECRET, NOW))
      .toEqual({ ok: false, reason: "bad-signature" });
    expect(body).not.toBe(forged);
  });

  it("rejects a tampered signature", async () => {
    const token = await signResponseToken(payload(), SECRET);
    const [body, signature] = token.split(".");
    // Flip a bit in the *first* byte, not the last character of the
    // string. The last base64url character of a 32-byte signature carries
    // unused low-order padding bits (see the canonicality tests below), so
    // toggling between two characters there can land on two encodings of
    // the *same* bytes — a no-op tamper that would make this test flaky
    // rather than a reliable check. The first byte has no such ambiguity:
    // every distinct value there is a genuinely different signature.
    const flipped = flipFirstByteBase64Url(signature ?? "");

    expect(await verifyResponseToken(`${body}.${flipped}`, SECRET, NOW))
      .toEqual({ ok: false, reason: "bad-signature" });
  });

  it.each([
    ["", "empty"],
    ["not-a-token", "no separator"],
    [".", "empty halves"],
    ["abc.", "empty signature"],
    [".abc", "empty body"],
    ["a.b.c", "too many parts"],
    ["!!!.!!!", "invalid base64url"],
  ])("rejects %s (%s) as malformed", async (token) => {
    const result = await verifyResponseToken(token, SECRET, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("malformed");
  });

  it("rejects a validly-signed token whose payload is the wrong shape", async () => {
    // Signed with the real secret, so the signature passes — the shape check
    // is what must catch it.
    const body = btoa(JSON.stringify({ nonsense: true }))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const key = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
    );
    const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
    let binary = "";
    for (const b of sig) binary += String.fromCharCode(b);
    const encoded = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

    const result = await verifyResponseToken(`${body}.${encoded}`, SECRET, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("malformed");
  });
});

describe("cross-fixture safety", () => {
  it("a token for one fixture does not verify as another", async () => {
    const token = await signResponseToken(payload({ fixtureId: "fixture-a" }), SECRET);
    const result = await verifyResponseToken(token, SECRET, NOW);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.payload.fixtureId).not.toBe("fixture-b");
  });
});

describe("hardening (review round 1)", () => {
  it("rejects rather than accepts when `now` is invalid (fail closed, not open)", async () => {
    const token = await signResponseToken(payload({ expiresAt: NOW.getTime() - 1 }), SECRET);
    const result = await verifyResponseToken(token, SECRET, new Date(NaN));
    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  it.each([null, undefined, 42, {}])("rejects a non-string token (%p) as malformed", async (bad) => {
    const result = await verifyResponseToken(bad as unknown as string, SECRET, NOW);
    expect(result).toEqual({ ok: false, reason: "malformed" });
  });

  it("signing with an empty secret throws loudly", async () => {
    await expect(signResponseToken(payload(), "")).rejects.toThrow();
  });

  it("verifying with an empty secret returns malformed rather than throwing", async () => {
    const token = await signResponseToken(payload(), SECRET);
    const result = await verifyResponseToken(token, "", NOW);
    expect(result).toEqual({ ok: false, reason: "malformed" });
  });
});

describe("canonicality (review round 2): base64url malleability closed", () => {
  it("a genuinely valid token still round-trips", async () => {
    const token = await signResponseToken(payload(), SECRET);
    const result = await verifyResponseToken(token, SECRET, NOW);
    expect(result.ok).toBe(true);
  });

  it("rejects all three non-canonical variants of a valid signature's final character", async () => {
    const token = await signResponseToken(payload(), SECRET);
    const [body, signature] = token.split(".");
    expect(signature).toBeDefined();
    const sig = signature as string;
    const lastChar = sig.at(-1) as string;
    const prefix = sig.slice(0, -1);

    // A 32-byte HMAC's base64url encoding has 2 trailing bits of padding on
    // its final character: the last character's 6-bit value therefore has
    // only 4 significant high-order bits, so it and 3 other characters
    // (same top 4 bits, differing low 2 bits) all decode to the identical
    // 32 bytes. Only one of that group of 4 is the canonical string
    // `signResponseToken` actually produces; the other three must now be
    // rejected outright, before any signature comparison happens.
    const canonicalIndex = BASE64URL_ALPHABET.indexOf(lastChar);
    expect(canonicalIndex).toBeGreaterThanOrEqual(0);
    const groupBase = canonicalIndex - (canonicalIndex % 4);
    const equivalentChars = [0, 1, 2, 3].map((offset) => BASE64URL_ALPHABET[groupBase + offset] as string);
    const nonCanonicalChars = equivalentChars.filter((c) => c !== lastChar);
    expect(nonCanonicalChars).toHaveLength(3);

    for (const variant of nonCanonicalChars) {
      const variantToken = `${body}.${prefix}${variant}`;
      // Sanity check: this variant really is a different string that
      // decodes to the same bytes as the canonical signature, not a no-op.
      expect(variantToken).not.toBe(token);

      const result = await verifyResponseToken(variantToken, SECRET, NOW);
      expect(result).toEqual({ ok: false, reason: "malformed" });
    }
  });

  it("rejects a non-canonical payload encoding the same way", async () => {
    const token = await signResponseToken(payload(), SECRET);
    const [body, signature] = token.split(".");
    expect(body).toBeDefined();
    const b = body as string;
    const lastChar = b.at(-1) as string;
    const canonicalIndex = BASE64URL_ALPHABET.indexOf(lastChar);
    const groupBase = canonicalIndex - (canonicalIndex % 4);
    const variantChar = [0, 1, 2, 3]
      .map((offset) => BASE64URL_ALPHABET[groupBase + offset] as string)
      .find((c) => c !== lastChar) as string;

    // A tampered payload with a non-canonical encoding must be rejected on
    // shape before the (now-mismatched) signature is even considered —
    // still "malformed", the same reason a canonicality failure on the
    // signature half produces. The attached signature doesn't need to
    // match: decode canonicality is checked before either half is compared
    // against the other, so an otherwise-valid signature string is enough
    // to isolate what's under test here.
    const variantBody = b.slice(0, -1) + variantChar;
    expect(variantBody).not.toBe(b);
    const result = await verifyResponseToken(`${variantBody}.${signature}`, SECRET, NOW);
    expect(result).toEqual({ ok: false, reason: "malformed" });
  });
});

describe("responseTokenExpiry", () => {
  it("is 24 hours after kickoff (BR-24)", () => {
    const expiry = responseTokenExpiry(new Date("2026-08-13T18:00:00Z"));
    expect(expiry.toISOString()).toBe("2026-08-14T18:00:00.000Z");
  });
});

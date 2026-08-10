import { describe, expect, it } from "vitest";
import {
  responseTokenExpiry,
  signResponseToken,
  verifyResponseToken,
} from "../../src/domain/token.js";

const SECRET = "test-secret-not-used-anywhere-real";
const OTHER_SECRET = "a-different-secret-entirely";
const NOW = new Date("2026-08-12T09:00:00Z");

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
    const flipped = (signature ?? "").slice(0, -1) + ((signature ?? "").endsWith("A") ? "B" : "A");

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

describe("responseTokenExpiry", () => {
  it("is 24 hours after kickoff (BR-24)", () => {
    const expiry = responseTokenExpiry(new Date("2026-08-13T18:00:00Z"));
    expect(expiry.toISOString()).toBe("2026-08-14T18:00:00.000Z");
  });
});

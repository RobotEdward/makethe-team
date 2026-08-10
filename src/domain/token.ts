const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

/** 24 hours, per BR-24. */
const TOKEN_LIFETIME_AFTER_KICKOFF_MS = 86_400_000;

export interface ResponseTokenPayload {
  playerId: string;
  fixtureId: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

export type TokenVerification =
  | { ok: true; payload: ResponseTokenPayload }
  | { ok: false; reason: "malformed" | "bad-signature" | "expired" };

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): Uint8Array | null {
  if (value.length === 0 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    ENCODER.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

/**
 * A response token is `<base64url(payload)>.<base64url(hmac)>`, scoped to
 * exactly one player and one fixture (BR-24). It is opaque to the recipient
 * but not encrypted — it carries no secret, only two identifiers and an expiry,
 * and the signature is what makes it unforgeable.
 */
export async function signResponseToken(payload: ResponseTokenPayload, secret: string): Promise<string> {
  // Signing with no secret is a programming error (misconfigured binding),
  // never a runtime/user condition — throw loudly rather than silently
  // producing an unverifiable token.
  if (secret.length === 0) {
    throw new Error("signResponseToken: secret must not be empty (RESPONSE_TOKEN_SECRET unset?)");
  }
  const body = base64UrlEncode(ENCODER.encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), ENCODER.encode(body));
  return `${body}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/**
 * Verify and decode a response token (TR-14).
 *
 * Order matters: the signature is checked before the payload is parsed, so no
 * attacker-controlled bytes are ever interpreted as structure. Comparison uses
 * `crypto.subtle.timingSafeEqual`, a workerd built-in, rather than `===` — a
 * short-circuiting comparison leaks how many leading bytes were correct, which
 * is enough to forge a signature one byte at a time.
 */
export async function verifyResponseToken(
  token: string,
  secret: string,
  now: Date,
): Promise<TokenVerification> {
  // A non-string token can arrive from an untyped boundary (e.g. a Hono path
  // param under a runtime shape that disagrees with its declared type).
  // Fail closed with the same "malformed" a caller already handles, rather
  // than letting `.split` throw a raw TypeError into the route.
  if (typeof token !== "string") return { ok: false, reason: "malformed" };

  // An empty secret means the binding is unset (new env, rotation typo,
  // forgotten `wrangler secret put`). Unlike signing, this must not throw:
  // it reaches this function on the hot path for every incoming response
  // link, and the route's job is to render the normal "this link isn't
  // working" page, not 500. Every token is unverifiable either way, so
  // "malformed" is honest — there is nothing more specific to say about it.
  if (secret.length === 0) return { ok: false, reason: "malformed" };

  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, reason: "malformed" };

  const [body, signature] = parts;
  if (body === undefined || signature === undefined) return { ok: false, reason: "malformed" };

  const provided = base64UrlDecode(signature);
  const bodyBytes = base64UrlDecode(body);
  if (!provided || !bodyBytes) return { ok: false, reason: "malformed" };

  const expected = new Uint8Array(
    await crypto.subtle.sign("HMAC", await hmacKey(secret), ENCODER.encode(body)),
  );
  // Length is constant for HMAC-SHA256, so this comparison leaks nothing an
  // attacker does not already know, and timingSafeEqual requires equal lengths.
  if (provided.byteLength !== expected.byteLength) return { ok: false, reason: "bad-signature" };
  if (!crypto.subtle.timingSafeEqual(provided, expected)) return { ok: false, reason: "bad-signature" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(DECODER.decode(bodyBytes));
  } catch {
    return { ok: false, reason: "malformed" };
  }

  if (!isPayload(parsed)) return { ok: false, reason: "malformed" };
  // Inverted so an invalid `now` (e.g. `new Date(NaN)`) fails closed: any
  // comparison against NaN is false, so writing this as `now > expiresAt`
  // would fall through to acceptance for a caller mistake. `!(now <= expiresAt)`
  // rejects unless the token is affirmatively still valid.
  if (!(now.getTime() <= parsed.expiresAt)) return { ok: false, reason: "expired" };

  return { ok: true, payload: parsed };
}

function isPayload(value: unknown): value is ResponseTokenPayload {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate["playerId"] === "string" &&
    typeof candidate["fixtureId"] === "string" &&
    typeof candidate["expiresAt"] === "number" &&
    Number.isFinite(candidate["expiresAt"])
  );
}

/** A token stops working 24 hours after its fixture kicks off (BR-24). */
export function responseTokenExpiry(kicksOffAt: Date): Date {
  return new Date(kicksOffAt.getTime() + TOKEN_LIFETIME_AFTER_KICKOFF_MS);
}

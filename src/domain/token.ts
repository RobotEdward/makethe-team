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

/**
 * A cancellation token is scoped to one owner, one fixture, and the single
 * act of cancelling (a deliberate, recorded amendment to TR-17 — see the
 * milestone plan). It carries no session; the signature and the discriminator
 * baked into it are the entire trust boundary.
 */
export interface CancelTokenPayload {
  ownerPlayerId: string;
  fixtureId: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

/**
 * A leave token is scoped to one player and one **Game** — not one fixture,
 * which is the whole reason it exists. The welcome email (N-6) is sent when
 * somebody joins a squad, and at that moment no fixture may exist to scope a
 * response token to, which is why N-6 has carried no leave link at all.
 *
 * Signed with `RESPONSE_TOKEN_SECRET` rather than a secret of its own. The
 * separation of `CANCEL_TOKEN_SECRET` exists because a leaked response key
 * must not be able to call a fixture off for a whole squad; that argument
 * does not extend to leaving, because a response token already opens the
 * leave page today. The `kind` discriminator, which is inside the signed
 * bytes, is what stops one being presented as the other.
 */
export interface LeaveTokenPayload {
  gameId: string;
  playerId: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

export type TokenVerification<Payload> =
  | { ok: true; payload: Payload }
  | { ok: false; reason: "malformed" | "bad-signature" | "expired" };

/**
 * The value embedded inside every signed payload that ties a token to the
 * single purpose it was minted for. It is part of the signed bytes, not a
 * field checked only after the signature passes — a token minted as one kind
 * fails to verify as the other at the discriminator check, immediately after
 * the signature and before any type-specific shape is even considered. A
 * response token replayed at a cancel-token verifier therefore cannot reach
 * "successfully parsed as a cancel token" by any path: either the shared
 * secrets differ (bad-signature) or, even where the same secret is reused for
 * both purposes, the embedded `kind` does not match (malformed).
 */
type TokenKind = "response" | "cancel" | "leave";

/**
 * The env binding each token kind's secret is expected to live under, used
 * only to make the "secret unset" error actionable — not a claim about how
 * the binding is actually wired (that is Task 7's decision for `cancel`).
 */
const SECRET_BINDING_NAME: Record<TokenKind, string> = {
  response: "RESPONSE_TOKEN_SECRET",
  cancel: "CANCEL_TOKEN_SECRET",
  leave: "RESPONSE_TOKEN_SECRET",
};

/**
 * Whether `secret` is actually usable to sign or verify with.
 *
 * `secret` is declared `string` throughout this module (per `Bindings` in
 * `src/env.ts`), but an unset Worker secret binding arrives at runtime as
 * `undefined` regardless of that declared type — TypeScript's type is a
 * compile-time promise the platform does not keep. A bare
 * `secret.length === 0` check dereferences `.length` on that `undefined`
 * before ever comparing it, throwing a bare `TypeError` from inside
 * `verifyToken` (which must never throw — see below) and, in `signToken`,
 * replacing the by-name error operators depend on with an unattributable one.
 * Checking the runtime type first, and only then the length, makes absent,
 * wrong-type and empty secrets all take the identical fail-closed path.
 */
function isUsableSecret(secret: unknown): secret is string {
  return typeof secret === "string" && secret.length > 0;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Decodes base64url, rejecting anything that is not the *canonical*
 * encoding of its own decoded bytes.
 *
 * Base64 is not injective at the trailing character: the last character of
 * a 3-byte group can carry unused low-order padding bits that the decoder
 * discards, so several distinct strings decode to the same bytes (for a
 * 32-byte HMAC, the final character has 4 significant bits inside a 6-bit
 * character — 4 encodings decode identically). Left unchecked, that means a
 * signature — a value that may later be used as a key — has more than one
 * valid string form, and comparing decoded bytes with `timingSafeEqual`
 * cannot see the difference. Re-encoding the decoded bytes and requiring
 * the result to equal the input closes that: only the one canonical string
 * decodes successfully, so every value this module hands back has exactly
 * one valid encoding. Applied uniformly to both the payload and the
 * signature, since both share the property.
 *
 * This check happens here, inside decode — before either verifier ever
 * computes or compares a signature — so a non-canonical input is rejected on
 * its own shape and never becomes a second timing oracle layered on top of
 * the signature comparison.
 */
function base64UrlDecode(value: string): Uint8Array | null {
  if (value.length === 0 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    if (base64UrlEncode(bytes) !== value) return null;
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
 * Signs `<base64url(payload)>.<base64url(hmac)>` for a payload carrying its
 * `kind` discriminator. Shared by every token type in this module (response
 * and cancel tokens today) so there is exactly one signing routine to keep
 * correct, rather than one hand-maintained copy per token type quietly
 * drifting apart.
 *
 * `kind` is spread in *after* `payload`, not before: if the caller's payload
 * object happened to carry its own `kind` property (a widened type, a DB
 * row, a spread of a larger record), the discriminator baked into the signed
 * bytes must still be the one this function was told to sign for — never
 * whatever the caller's object happened to contain. The discriminator is the
 * only thing standing between the two token types; it must not be
 * overridable by construction.
 */
async function signToken<Payload extends object>(kind: TokenKind, payload: Payload, secret: string): Promise<string> {
  // Signing with no usable secret is a programming error (misconfigured
  // binding), never a runtime/user condition — throw loudly rather than
  // silently producing an unverifiable token. `secret` is typed `string`
  // (see `Bindings` in src/env.ts), but an *unset* binding arrives at
  // runtime as `undefined` regardless of that declared type — the same gap
  // `src/env.ts`'s own `RESEND_API_KEY` comment documents — so this checks
  // the actual runtime value rather than trusting the type. Absent, wrong
  // type and empty are all the same failure and must all throw the same
  // named error.
  if (!isUsableSecret(secret)) {
    throw new Error(`${SECRET_BINDING_NAME[kind]} must not be empty (secret unset?)`);
  }
  const body = base64UrlEncode(ENCODER.encode(JSON.stringify({ ...payload, kind })));
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), ENCODER.encode(body));
  return `${body}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/**
 * Verifies `<base64url(payload)>.<base64url(hmac)>` against the expected
 * `kind` and an `isPayload` type guard for the rest of the shape, then
 * enforces expiry. Order matters throughout: the signature is checked before
 * the payload is parsed, so no attacker-controlled bytes are ever interpreted
 * as structure; the discriminator is checked before the shape guard, so a
 * token minted for a different purpose is rejected on the property that
 * makes it a different purpose, not merely on which fields happen to be
 * present. Comparison uses `crypto.subtle.timingSafeEqual`, a workerd
 * built-in, rather than `===` — a short-circuiting comparison leaks how many
 * leading bytes were correct, which is enough to forge a signature one byte
 * at a time.
 */
async function verifyToken<Payload extends { expiresAt: number }>(
  kind: TokenKind,
  token: string,
  secret: string,
  now: Date,
  isPayload: (value: unknown) => value is Payload,
): Promise<TokenVerification<Payload>> {
  // A non-string token can arrive from an untyped boundary (e.g. a Hono path
  // param under a runtime shape that disagrees with its declared type).
  // Fail closed with the same "malformed" a caller already handles, rather
  // than letting `.split` throw a raw TypeError into the route.
  if (typeof token !== "string") return { ok: false, reason: "malformed" };

  // An unusable secret means the binding is unset (new env, rotation typo,
  // forgotten `wrangler secret put`) — which, like `signToken` above, arrives
  // at runtime as `undefined` rather than the empty string the declared
  // `string` type promises, so this checks the runtime value, not the type.
  // Unlike signing, this must not throw: it reaches this function on the hot
  // path for every incoming link, and the route's job is to render the
  // normal "this link isn't working" page, not 500. Every token is
  // unverifiable either way, so "malformed" is honest — there is nothing
  // more specific to say about it.
  if (!isUsableSecret(secret)) return { ok: false, reason: "malformed" };

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

  if (typeof parsed !== "object" || parsed === null) return { ok: false, reason: "malformed" };
  const candidate = parsed as Record<string, unknown>;

  // The discriminator lives inside the signed bytes, so a token minted for
  // the other purpose cannot reach this point by presenting a different
  // shape at the door — it is rejected here, on the one property that
  // encodes what the token was signed *for*, before any purpose-specific
  // field is even inspected.
  if (candidate["kind"] !== kind) return { ok: false, reason: "malformed" };

  if (!isPayload(candidate)) return { ok: false, reason: "malformed" };

  // Inverted so an invalid `now` (e.g. `new Date(NaN)`) fails closed: any
  // comparison against NaN is false, so writing this as `now > expiresAt`
  // would fall through to acceptance for a caller mistake. `!(now <= expiresAt)`
  // rejects unless the token is affirmatively still valid.
  if (!(now.getTime() <= candidate.expiresAt)) return { ok: false, reason: "expired" };

  // Strip the discriminator before handing the payload back: it is part of
  // the signed bytes, not part of the public shape callers were promised.
  // Cast back to an unnarrowed record for the deletion — `isPayload` above
  // narrowed `candidate` to `Payload`, whose type has no `kind` property to
  // index once narrowed.
  const rest = { ...candidate } as Record<string, unknown>;
  delete rest["kind"];
  return { ok: true, payload: rest as Payload };
}

/**
 * A response token is `<base64url(payload)>.<base64url(hmac)>`, scoped to
 * exactly one player and one fixture (BR-24). It is opaque to the recipient
 * but not encrypted — it carries no secret, only two identifiers and an expiry,
 * and the signature is what makes it unforgeable.
 */
export async function signResponseToken(payload: ResponseTokenPayload, secret: string): Promise<string> {
  return signToken("response", payload, secret);
}

/** Verify and decode a response token (TR-14). See {@link verifyToken}. */
export async function verifyResponseToken(
  token: string,
  secret: string,
  now: Date,
): Promise<TokenVerification<ResponseTokenPayload>> {
  return verifyToken("response", token, secret, now, isResponsePayload);
}

function isResponsePayload(value: unknown): value is ResponseTokenPayload {
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

/**
 * A cancel token, scoped to exactly one owner and one fixture and to the
 * single act of cancelling. It is a deliberate, narrower amendment to TR-17
 * (see the milestone plan): sessions remain required for every other owner
 * action, but there is no session mechanism yet, and J5 promises the owner
 * attention email a one-tap cancel link.
 */
export async function signCancelToken(payload: CancelTokenPayload, secret: string): Promise<string> {
  return signToken("cancel", payload, secret);
}

/** Verify and decode a cancel token. See {@link verifyToken}. */
export async function verifyCancelToken(
  token: string,
  secret: string,
  now: Date,
): Promise<TokenVerification<CancelTokenPayload>> {
  return verifyToken("cancel", token, secret, now, isCancelPayload);
}

function isCancelPayload(value: unknown): value is CancelTokenPayload {
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate["ownerPlayerId"] === "string" &&
    typeof candidate["fixtureId"] === "string" &&
    typeof candidate["expiresAt"] === "number" &&
    Number.isFinite(candidate["expiresAt"])
  );
}

/**
 * A cancel token expires at kickoff, not 24 hours after it like a response
 * token: cancelling a game that has already started is meaningless, and a
 * shorter life is a strictly smaller forgery window for a token that
 * destroys a game.
 */
export function cancelTokenExpiry(kicksOffAt: Date): Date {
  return new Date(kicksOffAt.getTime());
}

function isLeavePayload(value: unknown): value is LeaveTokenPayload {
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate["gameId"] === "string" &&
    typeof candidate["playerId"] === "string" &&
    typeof candidate["expiresAt"] === "number" &&
    Number.isFinite(candidate["expiresAt"])
  );
}

/** Ninety days, per the design's §2.2. */
const LEAVE_TOKEN_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * A leave link stops working ninety days after it was minted.
 *
 * Not tied to a kickoff, because leaving is not about a fixture. Long enough
 * that somebody unsubscribing three weeks after they stopped playing is not
 * told their link is broken — the most annoying possible failure of an
 * unsubscribe link — and short enough to bound a forwarded email.
 */
export function leaveTokenExpiry(now: Date): Date {
  return new Date(now.getTime() + LEAVE_TOKEN_LIFETIME_MS);
}

export async function signLeaveToken(payload: LeaveTokenPayload, secret: string): Promise<string> {
  return signToken("leave", payload, secret);
}

/**
 * When a leave token was minted, derived from the only time it carries.
 *
 * Every leave token in existence gets its `expiresAt` from
 * {@link leaveTokenExpiry}, which is `mintedAt + LEAVE_TOKEN_LIFETIME_MS` —
 * so subtracting the same constant recovers the instant it was signed,
 * without a second field, a second secret, or a stored record of the token.
 *
 * The one caller is `/leave/:token`, which refuses a token minted before the
 * player's current spell in the squad began (`memberships.joined_at`). That
 * is what stops a leave link from being a repeatable eviction: a copy of an
 * old email would otherwise push the same player out again every time they
 * rejoined, for the whole ninety days. Deriving the mint time here, beside
 * the definition of the lifetime, keeps the arithmetic in one place — a
 * route doing it for itself would be a lifetime constant maintained twice.
 */
export function leaveTokenMintedAt(payload: LeaveTokenPayload): Date {
  return new Date(payload.expiresAt - LEAVE_TOKEN_LIFETIME_MS);
}

/** Verify and decode a leave token. See {@link verifyToken}. */
export async function verifyLeaveToken(
  token: string,
  secret: string,
  now: Date,
): Promise<TokenVerification<LeaveTokenPayload>> {
  return verifyToken("leave", token, secret, now, isLeavePayload);
}

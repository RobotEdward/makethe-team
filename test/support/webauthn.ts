/**
 * The minimum WebAuthn machinery needed to build one genuine authentication
 * assertion inside workerd, without a browser and without
 * `@simplewebauthn/browser` (unreachable here — it is not `@better-auth/passkey`'s
 * dependency, and this project has no bundler step to fetch it through).
 *
 * This exists for exactly one test:
 * `test/auth/passkey.test.ts`'s proof that `src/auth/factory.ts`'s `origin`
 * pin is load-bearing (M5 Task 8 review, Important-1). The review proved the
 * pin matters by executing a real `verifyAuthenticationResponse` ceremony —
 * WebCrypto P-256, a hand-built COSE public key, a DER-encoded signature —
 * against the actual plugin, and this module is that same ceremony, kept
 * around so the assertion the pin refuses is a real one and not a stub that
 * would pass no matter what `expectedOrigin` the plugin computed.
 *
 * Every format choice below is read out of the installed
 * `@simplewebauthn/server` and `@better-auth/passkey` bundles, not assumed:
 *
 * - the public key stored in the `passkey` table is a CBOR-encoded COSE key,
 *   standard-base64 (`decodeCredentialPublicKey` → `isoCBOR.decodeFirst`,
 *   and `verifyPasskeyRegistration`'s own `base64.encode(credential.publicKey)`);
 * - the signature the browser would send is DER (ASN.1 `SEQUENCE{INTEGER,
 *   INTEGER}`), unwrapped to raw `r‖s` internally by `unwrapEC2Signature`
 *   before it ever reaches WebCrypto's `verify`, which only accepts raw
 *   IEEE P1363 signatures;
 * - `authenticatorData` is `rpIdHash(32) ‖ flags(1) ‖ counter(4)`, no
 *   extensions, and needs only the user-present flag set — `requireUserVerification`
 *   is `false` in both endpoints this project configures.
 */

/** Base64url, no padding — the encoding every WebAuthn JSON field uses. */
function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Standard (padded) base64 — how `@better-auth/utils/base64` stores `publicKey`. */
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}

/**
 * A DER `INTEGER`, minimally encoded: no unnecessary leading zero bytes, but
 * one prepended if the high bit would otherwise make a positive number read
 * as negative. This is the one property `unwrapEC2Signature`'s
 * `toNormalizedBytes` has to be able to undo.
 */
function derInteger(bytes: Uint8Array): Uint8Array {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start++;
  let trimmed: Uint8Array = bytes.slice(start);
  if ((trimmed[0]! & 0x80) !== 0) trimmed = concat(new Uint8Array([0]), trimmed);
  return concat(new Uint8Array([0x02, trimmed.length]), trimmed);
}

/** DER `SEQUENCE{ INTEGER r, INTEGER s }` from WebCrypto's raw `r‖s` ECDSA output. */
function derSignature(rawSignature: Uint8Array): Uint8Array {
  const r = derInteger(rawSignature.slice(0, 32));
  const s = derInteger(rawSignature.slice(32, 64));
  const body = concat(r, s);
  // Always short-form: r and s are each at most 33 bytes DER-encoded, so the
  // body never approaches the 128-byte threshold where DER length encoding
  // would need a second form.
  return concat(new Uint8Array([0x30, body.length]), body);
}

/**
 * A CBOR-encoded COSE EC2 key: `{1: 2 (kty=EC2), 3: -7 (alg=ES256), -1: 1
 * (crv=P-256), -2: x, -3: y}`. Hand-built rather than pulled from a CBOR
 * library because this project has none — the five pairs are fixed and small
 * enough to write out as literal bytes, per the COSE key registry
 * (RFC 9053 §7.1).
 */
function coseP256PublicKey(x: Uint8Array, y: Uint8Array): Uint8Array {
  return concat(
    new Uint8Array([0xa5]), // map(5)
    new Uint8Array([0x01, 0x02]), // 1 (kty) : 2 (EC2)
    new Uint8Array([0x03, 0x26]), // 3 (alg) : -7 (ES256)
    new Uint8Array([0x20, 0x01]), // -1 (crv) : 1 (P-256)
    new Uint8Array([0x21, 0x58, 0x20]), // -2 (x) : bstr(32)
    x,
    new Uint8Array([0x22, 0x58, 0x20]), // -3 (y) : bstr(32)
    y,
  );
}

export interface WebauthnCredential {
  /** Standard base64 — what belongs in the `passkey.publicKey` column. */
  publicKeyBase64: string;
  privateKey: CryptoKey;
}

/** A fresh P-256 keypair, COSE-encoded the way this deployment's `passkey` table stores it. */
export async function generateCredential(): Promise<WebauthnCredential> {
  // Asserted rather than inferred: `generateKey`'s overloads resolve to
  // `CryptoKey | CryptoKeyPair` for some algorithm-parameter shapes, but
  // `{ name: "ECDSA" }` always produces a pair — there is no ECDSA algorithm
  // that yields a single symmetric key.
  const { publicKey, privateKey } = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  // The workers-types signature for `exportKey` is untyped over `format`
  // (`Promise<ArrayBuffer | JsonWebKey>` for every format string), so "raw"
  // producing an `ArrayBuffer` is asserted rather than inferred.
  const raw = new Uint8Array((await crypto.subtle.exportKey("raw", publicKey)) as ArrayBuffer);
  // Uncompressed SEC1 point: 0x04 ‖ X(32) ‖ Y(32).
  const x = raw.slice(1, 33);
  const y = raw.slice(33, 65);
  return { publicKeyBase64: toBase64(coseP256PublicKey(x, y)), privateKey };
}

/**
 * A CBOR byte string header for `length` bytes. Only the three shortest forms
 * exist because the one caller (`buildAttestationObject`) encodes an
 * `authData` that is always 148 bytes for this project's fixed shape — but
 * the 16-bit form is written out anyway so a future extension or a longer
 * credential id does not silently produce a malformed header.
 */
function cborByteStringHeader(length: number): Uint8Array {
  if (length < 24) return new Uint8Array([0x40 | length]);
  if (length < 0x100) return new Uint8Array([0x58, length]);
  return new Uint8Array([0x59, (length >> 8) & 0xff, length & 0xff]);
}

/** A CBOR definite-length text string. Every key below is pure ASCII. */
function cborText(value: string): Uint8Array {
  const bytes = new TextEncoder().encode(value);
  // All four keys used here ("fmt", "none", "attStmt", "authData") are under
  // 24 bytes, which is the only form this needs.
  return concat(new Uint8Array([0x60 | bytes.length]), bytes);
}

/**
 * The `attestationObject` a browser hands back from `navigator.credentials.create()`:
 * CBOR `{"fmt": "none", "attStmt": {}, "authData": <bytes>}`.
 *
 * **`fmt: "none"` is the realistic choice, not a shortcut.** It is what every
 * platform authenticator this project will ever meet actually sends — Touch
 * ID, Windows Hello and iCloud Keychain all produce `none`, because
 * `@better-auth/passkey` requests no attestation (`attestationType` is left
 * at SimpleWebAuthn's `"none"` default) and an authenticator must not
 * volunteer more than was asked for. So the empty `attStmt` here is the
 * production path, and `verifyRegistrationResponse` runs its full
 * `none`-format verifier over it rather than a bypass.
 */
function buildAttestationObject(authData: Uint8Array): Uint8Array {
  return concat(
    new Uint8Array([0xa3]), // map(3)
    cborText("fmt"),
    cborText("none"),
    cborText("attStmt"),
    new Uint8Array([0xa0]), // map(0) — `none` carries no statement.
    cborText("authData"),
    cborByteStringHeader(authData.length),
    authData,
  );
}

export interface RegistrationCeremony {
  /** The credential JSON, exactly as `credential.toJSON()` would serialise it. */
  response: {
    id: string;
    rawId: string;
    type: "public-key";
    response: { clientDataJSON: string; attestationObject: string; transports: string[] };
    clientExtensionResults: Record<string, never>;
    authenticatorAttachment: string;
  };
  /** Base64url credential id, which is how the `passkey` table stores it. */
  credentialId: string;
  privateKey: CryptoKey;
}

/**
 * Builds one genuine WebAuthn *registration* response — the ceremony
 * `signAssertion` is the other half of.
 *
 * This exists because `verify-registration` had no end-to-end test at all:
 * the suite proved the endpoint refuses an anonymous caller (401) and that
 * `generate-register-options` issues options, and then stopped, so the step
 * in between — the one that actually writes the `passkey` row — was never
 * executed by anything. A live iOS registration failure could not be blamed
 * on, or cleared of, the server without this.
 *
 * The `authData` layout here is the *attested* form, which is longer than the
 * one `signAssertion` builds: `rpIdHash(32) ‖ flags(1) ‖ counter(4) ‖
 * aaguid(16) ‖ credentialIdLength(2, big-endian) ‖ credentialId ‖
 * cosePublicKey`. The `AT` flag (`0x40`) is what tells the verifier that the
 * attested-credential-data tail is present; omitting it makes the verifier
 * ignore everything after the counter and fail with no credential.
 *
 * The AAGUID is all zeroes, which is what a platform authenticator that
 * declines to identify its make and model sends — again the ordinary case
 * for passkeys, not a degenerate one.
 */
export async function buildRegistration(options: {
  rpId: string;
  challenge: string;
  clientDataOrigin: string;
}): Promise<RegistrationCeremony> {
  const { publicKey, privateKey } = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey("raw", publicKey)) as ArrayBuffer);
  const cosePublicKey = coseP256PublicKey(raw.slice(1, 33), raw.slice(33, 65));

  const credentialIdBytes = crypto.getRandomValues(new Uint8Array(16));
  const credentialId = toBase64Url(credentialIdBytes);

  const clientDataJSON = new TextEncoder().encode(
    JSON.stringify({
      type: "webauthn.create",
      challenge: options.challenge,
      origin: options.clientDataOrigin,
      crossOrigin: false,
    }),
  );

  const rpIdHash = await sha256(new TextEncoder().encode(options.rpId));
  // UP (0x01) | UV (0x04) | AT (0x40). User-verification is not *required* by
  // either endpoint this project configures, but a real platform
  // authenticator sets it, so the bytes under test are the realistic ones.
  const flags = new Uint8Array([0x45]);
  const counterBytes = new Uint8Array(4);
  const credentialIdLength = new Uint8Array(2);
  new DataView(credentialIdLength.buffer).setUint16(0, credentialIdBytes.length, false);

  const authData = concat(
    rpIdHash,
    flags,
    counterBytes,
    new Uint8Array(16), // AAGUID: all zeroes.
    credentialIdLength,
    credentialIdBytes,
    cosePublicKey,
  );

  return {
    credentialId,
    privateKey,
    response: {
      id: credentialId,
      rawId: credentialId,
      type: "public-key",
      response: {
        clientDataJSON: toBase64Url(clientDataJSON),
        attestationObject: toBase64Url(buildAttestationObject(authData)),
        transports: ["internal"],
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    },
  };
}

/**
 * Builds one signed WebAuthn authentication assertion body, exactly the
 * shape `verifyAuthenticationResponse` (`@simplewebauthn/server`) requires:
 * `id === rawId`, `type: "public-key"`, and a `response` carrying
 * base64url `clientDataJSON` / `authenticatorData` / `signature`.
 *
 * `clientDataOrigin` is the one value this whole module exists to vary — it
 * is what ends up as `clientDataJSON.origin`, which is what
 * `src/auth/factory.ts`'s `origin` pin is checked against.
 */
export async function signAssertion(options: {
  credentialId: string;
  privateKey: CryptoKey;
  rpId: string;
  challenge: string;
  clientDataOrigin: string;
  counter?: number;
}): Promise<{
  id: string;
  rawId: string;
  type: "public-key";
  response: { clientDataJSON: string; authenticatorData: string; signature: string };
}> {
  const counter = options.counter ?? 0;

  const clientDataJSON = new TextEncoder().encode(
    JSON.stringify({
      type: "webauthn.get",
      challenge: options.challenge,
      origin: options.clientDataOrigin,
      crossOrigin: false,
    }),
  );

  const rpIdHash = await sha256(new TextEncoder().encode(options.rpId));
  const flags = new Uint8Array([0x01]); // user-present only; UV is not required here.
  const counterBytes = new Uint8Array(4);
  new DataView(counterBytes.buffer).setUint32(0, counter, false);
  const authenticatorData = concat(rpIdHash, flags, counterBytes);

  const clientDataHash = await sha256(clientDataJSON);
  const signatureInput = concat(authenticatorData, clientDataHash);
  const rawSignature = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, options.privateKey, signatureInput),
  );

  return {
    id: options.credentialId,
    rawId: options.credentialId,
    type: "public-key",
    response: {
      clientDataJSON: toBase64Url(clientDataJSON),
      authenticatorData: toBase64Url(authenticatorData),
      signature: toBase64Url(derSignature(rawSignature)),
    },
  };
}

/** The signed challenge cookie a browser would carry from options to verification. */
export function challengeCookieFrom(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0]!)
    .join("; ");
}

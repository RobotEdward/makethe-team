/**
 * Web push payload encryption, from the two RFCs, on Web Crypto alone
 * (M14, spec §14).
 *
 * Hand-written because the standard `web-push` package does not run on
 * Workers — it needs Node's `createECDH` and `createCipheriv`, which
 * `nodejs_compat` does not cover — and because the Workers-targeted
 * alternatives are young, low-traffic packages that would sit on the path
 * handling every player's subscription secrets, in a project with six
 * runtime dependencies. Everything needed is native: ECDH P-256
 * `deriveBits`, HKDF `deriveBits`, AES-GCM `encrypt`.
 *
 * # Read this before changing anything below
 *
 * Every mistake available here fails **silently and remotely**. A wrong
 * `info` string, the two HKDF stages transposed, a missing padding
 * delimiter: each produces a well-formed request that some other company's
 * server rejects, and nothing on this side can tell you why. There is no
 * error to catch, no log line, no local symptom — just a push that never
 * arrives on someone's phone. That is why
 * `test/notify/web-push-encrypt.test.ts` uses RFC 8291 §5's published
 * vectors and not a fixture this code generated: a fixture we produced
 * ourselves would agree with any of those bugs.
 *
 * If you change this file and that test goes red, do not adjust the test.
 * RFC 8291 Appendix A lists the intermediates (ecdh_secret, PRK_key, IKM,
 * PRK, CEK, NONCE); log them in order and the first one that diverges from
 * the RFC names the line that is wrong.
 *
 * The two-stage key derivation is the part that looks redundant and is not:
 *   1. ECDH gives a shared secret, which is combined with the subscription's
 *      `auth` secret through HKDF to produce the input keying material. The
 *      `auth` secret is what makes the result specific to *this
 *      subscription* rather than to anyone who intercepted the public keys.
 *   2. That IKM plus the per-message random salt produces the content
 *      encryption key and the nonce.
 *
 * Two references, and they are not interchangeable: RFC 8291 defines the key
 * derivation (the stage-one `info` and the ECDH), RFC 8188 defines the
 * `aes128gcm` content encoding (the header framing, the stage-two `info`
 * strings and the padding delimiter).
 */

/**
 * What a push service is obliged to accept: RFC 8030 §7.2 puts the floor at
 * 4096 octets **of request body**, not of plaintext. That distinction is the
 * whole reason the arithmetic below exists — measure the wrong one and a
 * payload passes the check here and is rejected on someone else's server,
 * which is precisely the failure this module is built to make impossible.
 *
 * It is a property of the services, not of this code: nothing here breaks at
 * 4097 bytes, the request simply comes back rejected. The check is a local
 * failure standing in for a remote one.
 */
const MAX_BODY_BYTES = 4096;

/**
 * The `rs` field of the aes128gcm header (RFC 8188 §2.1). One record; we
 * never send more, which is what makes the single `0x02` delimiter below
 * correct.
 */
const RECORD_SIZE = 4096;

const SALT_BYTES = 16;
/** The `auth` secret is fixed at 16 bytes by RFC 8291 §3.2. */
const AUTH_SECRET_BYTES = 16;
const P256_PUBLIC_KEY_BYTES = 65;
/** The `rs` field: a big-endian uint32. */
const RECORD_SIZE_FIELD_BYTES = 4;
/** The `idlen` field: a single byte giving the key id's length. */
const KEY_ID_LENGTH_FIELD_BYTES = 1;
/** The `0x02` last-record marker, encrypted along with the payload. */
const PADDING_DELIMITER_BYTES = 1;
/** AES-GCM's authentication tag, appended to the ciphertext by `encrypt`. */
const GCM_TAG_BYTES = 16;

/**
 * The aes128gcm header, whose size is fixed for web push because the key id
 * is always an uncompressed P-256 point:
 *
 *     16 salt + 4 record size + 1 key id length + 65 key id = 86
 */
const HEADER_BYTES =
  SALT_BYTES + RECORD_SIZE_FIELD_BYTES + KEY_ID_LENGTH_FIELD_BYTES + P256_PUBLIC_KEY_BYTES;

/**
 * Everything the encoding adds to the plaintext: the 86-byte header, the
 * one-byte padding delimiter that is encrypted with the payload, and
 * AES-GCM's 16-byte tag. 103 bytes, and none of it varies — there is exactly
 * one record and exactly one key id length.
 */
const OVERHEAD_BYTES = HEADER_BYTES + PADDING_DELIMITER_BYTES + GCM_TAG_BYTES;

/**
 * The largest plaintext that still fits a conforming service's 4096-octet
 * body: 4096 − 103 = 3993. Check the arithmetic against `OVERHEAD_BYTES`
 * above rather than trusting this number; `web-push-encrypt.test.ts` asserts
 * both sides of the boundary and the resulting body size, so a mistake in
 * either constant is caught locally instead of by a stranger's server.
 */
const MAX_PAYLOAD_BYTES = MAX_BODY_BYTES - OVERHEAD_BYTES;

export interface PushSubscriptionKeys {
  endpoint: string;
  /** The device's public key, base64url, uncompressed P-256 point. */
  p256dh: string;
  /** The shared auth secret, base64url, 16 bytes. */
  auth: string;
}

export interface EncryptOptions {
  /**
   * Injected only by the RFC vector test. Random in production — a reused
   * salt with the same keys reuses the AES-GCM nonce, which is the one
   * catastrophic misuse of that cipher.
   */
  salt?: Uint8Array;
  /**
   * Injected only by the RFC vector test. Freshly generated otherwise: the
   * sender keypair here is per-message and ephemeral, and is *not* the VAPID
   * identity keypair, which is long-lived and used for signing rather than
   * for ECDH. Confusing the two is a real hazard because both are P-256.
   */
  localKeys?: CryptoKeyPair;
}

/**
 * Decodes unpadded base64url — the encoding every field of a
 * `PushSubscription` arrives in.
 */
export function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  // `atob` rejects an unpadded string, and subscription fields are always
  // unpadded, so the `=` tail is restored here rather than assumed.
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Encodes to unpadded base64url. The `=` padding is stripped because the
 * push protocol's own fields never carry it; leaving it on would make our
 * output differ from the RFC's stated result for identical bytes.
 */
export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * One HKDF extract-and-expand, returning `length` bytes.
 *
 * Web Crypto's HKDF does both phases in a single `deriveBits`, which is why
 * the RFC's separately-named PRK values do not appear here as variables.
 * They still exist inside this call, and Appendix A lists them, so if you
 * are bisecting a wrong result this is the boundary at which to compare.
 */
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8);
  return new Uint8Array(bits);
}

const utf8 = (text: string) => new TextEncoder().encode(text);

/**
 * The NUL byte that terminates both HKDF `info` strings. The trailing zero
 * is *part of the string* per RFC 8291 §3.4 and RFC 8188 §2.2, not a
 * separator this code adds for tidiness. Omit it and every derived key is
 * wrong, with no local symptom whatsoever.
 */
const NUL = new Uint8Array([0]);

/** The ECDH parameters as the *runtime* wants them — see `ecdhWith`. */
interface EcdhDeriveBitsParams {
  name: "ECDH";
  public: CryptoKey;
}

/**
 * The `{ name: "ECDH", public }` argument to `deriveBits`, cast across a
 * mismatch between workerd and its own type definitions.
 *
 * `@cloudflare/workers-types` declares this field as `$public` (its generator
 * prefixes names that clash with TypeScript's reserved words), while workerd
 * itself reads `public`, as every other Web Crypto implementation does and as
 * the WebCrypto spec says. Writing `$public` would typecheck and then derive
 * from nothing. So the object is built with the name the runtime needs, typed
 * by the local interface above rather than by `any`, and re-typed only at
 * this boundary. If a future version of the types drops the `$`, delete this
 * function and inline the object literal again.
 *
 * The RFC vector test is what proves the runtime spelling is the right one:
 * a wrong field name here cannot reproduce the published ciphertext.
 */
function ecdhWith(publicKey: CryptoKey): SubtleCryptoDeriveKeyAlgorithm {
  const params: EcdhDeriveBitsParams = { name: "ECDH", public: publicKey };
  return params as unknown as SubtleCryptoDeriveKeyAlgorithm;
}

/**
 * The 65 raw bytes of a P-256 public key: the uncompressed point that goes
 * in the aes128gcm header and into the stage-one `info` string.
 *
 * `exportKey` is typed `ArrayBuffer | JsonWebKey` across all its formats, so
 * the `"raw"` case has to be narrowed. The length is asserted here rather
 * than trusted because it is the one property of this value the rest of the
 * function depends on — the header's key-id length byte is derived from it,
 * and a short key would produce a header a receiver silently misparses.
 */
async function exportRawPublicKey(publicKey: CryptoKey): Promise<Uint8Array> {
  const exported = await crypto.subtle.exportKey("raw", publicKey);
  if (!(exported instanceof ArrayBuffer)) {
    throw new Error('exportKey("raw") did not return raw bytes');
  }
  const bytes = new Uint8Array(exported);
  if (bytes.length !== P256_PUBLIC_KEY_BYTES) {
    throw new Error(`expected a ${P256_PUBLIC_KEY_BYTES}-byte P-256 public key, got ${bytes.length}`);
  }
  return bytes;
}

/**
 * A fresh P-256 keypair for one message.
 *
 * `true` for extractable: the public half has to be exported to go in the
 * aes128gcm header, and a keypair is extractable as a unit. The private half
 * never leaves this module.
 *
 * The narrowing is not ceremony. `generateKey` is typed
 * `CryptoKey | CryptoKeyPair` because one signature covers both symmetric
 * and asymmetric algorithms; ECDH always yields a pair, and checking rather
 * than casting means a change of algorithm here fails loudly instead of at a
 * property access on `undefined`.
 */
async function generateEphemeralKeyPair(): Promise<CryptoKeyPair> {
  const generated = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ]);
  if (!("privateKey" in generated)) {
    throw new Error("expected an ECDH key pair from generateKey");
  }
  return generated;
}

/**
 * Encrypts `payload` for one subscription, returning a complete `aes128gcm`
 * body ready to POST to the endpoint.
 *
 * The returned bytes are the entire request body: no further framing, no
 * base64. The caller supplies `Content-Encoding: aes128gcm` and the VAPID
 * `Authorization` header.
 */
export async function encryptPayload(
  subscription: PushSubscriptionKeys,
  payload: string,
  options: EncryptOptions = {},
): Promise<Uint8Array> {
  const plaintext = utf8(payload);
  // Measured against the *plaintext* limit, which already has the encoding's
  // 103 bytes of overhead subtracted from the 4096-octet body every service
  // must accept (see `MAX_PAYLOAD_BYTES`). Bytes, not characters — one emoji
  // in a squad name is four of these.
  if (plaintext.length > MAX_PAYLOAD_BYTES) {
    throw new Error(
      `push payload too large: ${plaintext.length} bytes of plaintext, limit ${MAX_PAYLOAD_BYTES} ` +
        `(${MAX_BODY_BYTES}-byte body less ${OVERHEAD_BYTES} bytes of header, padding and tag)`,
    );
  }

  const receiverPublicRaw = base64UrlDecode(subscription.p256dh);
  const authSecret = base64UrlDecode(subscription.auth);

  // These two lengths are the module's only unchecked inputs, and they fail
  // in opposite ways. A wrong-length `p256dh` at least throws inside
  // `importKey` below, if opaquely. A wrong-length `auth` throws *nowhere*:
  // it is used at exactly one place, as the HKDF salt, and HKDF accepts a
  // salt of any length including zero — so a truncated or padded secret
  // derives a plausible key, encrypts without complaint, and produces a
  // well-formed body the device cannot decrypt. That is the undiagnosable
  // remote failure this whole file is written to prevent, arriving through
  // the one input with nothing downstream to catch it. Two checks turn it
  // into a named local error.
  //
  // The route that stores these values validates them too (Task 10), which
  // does not make this redundant: that route cannot protect rows already
  // stored, and this function is the last place that knows what these bytes
  // have to be.
  if (receiverPublicRaw.length !== P256_PUBLIC_KEY_BYTES) {
    throw new Error(
      `subscription p256dh must be ${P256_PUBLIC_KEY_BYTES} bytes, got ${receiverPublicRaw.length}`,
    );
  }
  if (authSecret.length !== AUTH_SECRET_BYTES) {
    throw new Error(`subscription auth must be ${AUTH_SECRET_BYTES} bytes, got ${authSecret.length}`);
  }

  const salt = options.salt ?? crypto.getRandomValues(new Uint8Array(SALT_BYTES));

  const localKeys = options.localKeys ?? (await generateEphemeralKeyPair());

  const receiverPublic = await crypto.subtle.importKey(
    "raw",
    receiverPublicRaw,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    // No usages: a public ECDH key derives nothing by itself, it is only
    // ever the `public` argument to someone else's deriveBits.
    [],
  );
  const senderPublicRaw = await exportRawPublicKey(localKeys.publicKey);

  const sharedSecret = new Uint8Array(
    await crypto.subtle.deriveBits(ecdhWith(receiverPublic), localKeys.privateKey, 256),
  );

  // Stage one (RFC 8291 §3.3). The `auth` secret is the salt and the ECDH
  // output is the keying material — that way round, and swapping them is
  // undetectable here. The info string's two public keys go **receiver
  // first, then sender**; transposing them yields a perfectly valid key that
  // the device cannot reproduce.
  const ikm = await hkdf(
    authSecret,
    sharedSecret,
    concat(utf8("WebPush: info"), NUL, receiverPublicRaw, senderPublicRaw),
    32,
  );

  // Stage two (RFC 8188 §2.2). Note the reversal against stage one: here the
  // per-message salt is the salt and stage one's output is the keying
  // material. Both info strings are NUL-terminated (see `NUL`).
  const contentKey = await hkdf(salt, ikm, concat(utf8("Content-Encoding: aes128gcm"), NUL), 16);
  const nonce = await hkdf(salt, ikm, concat(utf8("Content-Encoding: nonce"), NUL), 12);

  const key = await crypto.subtle.importKey("raw", contentKey, "AES-GCM", false, ["encrypt"]);
  // 0x02 is the padding delimiter marking the last record. 0x01 would say
  // "more records follow" and the receiver would wait for one that never
  // comes — a payload that decrypts correctly and is still never displayed.
  const padded = concat(plaintext, new Uint8Array([0x02]));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, key, padded),
  );

  // aes128gcm framing (RFC 8188 §2.1): salt(16) ‖ record size(4, big-endian)
  // ‖ key id length(1) ‖ key id ‖ ciphertext. The receiver reads the salt and
  // the sender's public key out of this header, because there is nowhere
  // else they could come from — the "key id" is, for web push specifically,
  // the sender's ephemeral public key.
  const recordSize = new Uint8Array(RECORD_SIZE_FIELD_BYTES);
  // `false` = big-endian, which is what the RFC's network byte order means.
  new DataView(recordSize.buffer).setUint32(0, RECORD_SIZE, false);

  return concat(salt, recordSize, new Uint8Array([senderPublicRaw.length]), senderPublicRaw, ciphertext);
}

/**
 * How long a VAPID JWT is valid for, per `vapidHeaders`'s `exp` claim.
 * Twelve hours: comfortably inside every push service's ceiling (RFC 8292
 * doesn't set one, but some services reject anything beyond 24) and short
 * enough that a leaked header stops being useful well within the day.
 */
const VAPID_TOKEN_LIFETIME_SECONDS = 12 * 60 * 60;

export interface VapidKeys {
  /** base64url, uncompressed P-256 point. Public by design — it ships to every browser. */
  publicKey: string;
  signingKey: CryptoKey;
  /** The `mailto:` a push service contacts about abuse. */
  subject: string;
}

/**
 * Imports the configured VAPID pair.
 *
 * `privateKey` is the JWK `d` parameter, base64url — the form
 * `scripts/generate-vapid-keys.mjs` prints. The `x` and `y` are recovered
 * from the public key rather than from `d`, because that is the only public
 * half this function has: nothing here can derive a point from a scalar.
 *
 * Whether that makes a mismatched pair fail here or later is not something
 * to rely on either way. Workerd's own JWK import happens to check that `d`
 * and `x`/`y` agree and throws a `DataError` first — but the WebCrypto spec
 * does not require that check, other implementations skip it, and this
 * function must not be the place a config error is *supposed* to surface:
 * that guarantee belongs to `assertVapidKeysMatch`, called once at startup,
 * whose sign-then-verify check works regardless of what any given runtime's
 * importer bothers to validate.
 */
export async function importVapidKeys(publicKey: string, privateKey: string, subject: string): Promise<VapidKeys> {
  const raw = base64UrlDecode(publicKey);
  if (raw.length !== P256_PUBLIC_KEY_BYTES || raw[0] !== 0x04) {
    throw new Error(
      `VAPID_PUBLIC_KEY is not an uncompressed P-256 point (${P256_PUBLIC_KEY_BYTES} bytes starting 0x04)`,
    );
  }

  const signingKey = await crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      d: privateKey,
      x: base64UrlEncode(raw.slice(1, 33)),
      y: base64UrlEncode(raw.slice(33, 65)),
      ext: false,
    },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );

  return { publicKey, signingKey, subject };
}

/**
 * Proves the configured public and private keys are actually a pair, by
 * signing a fixed message and verifying it with the public key (spec §10.3).
 *
 * Not by deriving the public key from the private one: Web Crypto offers no
 * such operation, and importing a JWK whose `d` disagrees with its `x`/`y`
 * is *not* reliably rejected. Sign-then-verify is the check that actually
 * discriminates.
 *
 * Worth the two operations at startup because the failure it catches —
 * rotating one binding and forgetting the other — produces a 403 from every
 * push service forever, and produces no local symptom whatsoever.
 */
export async function assertVapidKeysMatch(keys: VapidKeys): Promise<void> {
  const probe = utf8("vapid-key-consistency-probe");
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.signingKey, probe);
  const verifier = await crypto.subtle.importKey(
    "raw",
    base64UrlDecode(keys.publicKey),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );

  if (!(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, verifier, signature, probe))) {
    throw new Error(
      "VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY do not match — every push would be refused with 403. " +
        "Both come from one run of scripts/generate-vapid-keys.mjs; set them together or not at all.",
    );
  }
}

/**
 * The `Authorization` header for one push (RFC 8292).
 *
 * `now` is a parameter rather than `new Date()`, matching `createNotifier`,
 * so a test can place the expiry anywhere without touching the clock.
 */
export async function vapidHeaders(endpoint: string, keys: VapidKeys, now: Date): Promise<Record<string, string>> {
  const header = base64UrlEncode(utf8(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = base64UrlEncode(
    utf8(
      JSON.stringify({
        // The endpoint's origin, never the full URL: the path identifies the
        // subscription, and some services reject a full-URL audience anyway.
        aud: new URL(endpoint).origin,
        exp: Math.floor(now.getTime() / 1000) + VAPID_TOKEN_LIFETIME_SECONDS,
        sub: keys.subject,
      }),
    ),
  );

  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    keys.signingKey,
    utf8(`${header}.${claims}`),
  );

  return {
    Authorization: `vapid t=${header}.${claims}.${base64UrlEncode(new Uint8Array(signature))}, k=${keys.publicKey}`,
    "Content-Encoding": "aes128gcm",
  };
}

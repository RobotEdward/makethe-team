/**
 * Generates the VAPID keypair, once, and prints it once.
 *
 * Writes nothing to disk deliberately. `wrangler secret put` is write-only —
 * a Cloudflare secret cannot be read back — so the copy you keep now is the
 * only copy that will ever exist.
 */
import { webcrypto as crypto } from "node:crypto";

const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
const b64url = (bytes) => Buffer.from(bytes).toString("base64url");

console.log(`
VAPID_PUBLIC_KEY  ${b64url(raw)}
VAPID_PRIVATE_KEY ${jwk.d}

  Put the public key in wrangler.jsonc's "vars" — it is public by design and
  ships to every browser that subscribes.

  Put the private key in your long-term secret store FIRST, then:
      echo -n "<private key>" | npx wrangler secret put VAPID_PRIVATE_KEY

  ── Read this before you close the terminal ────────────────────────────────
  This key cannot be recovered. Cloudflare secrets are write-only, and the
  public half is baked into every device subscription at the moment the
  browser creates it. If you lose the private key:

    * every existing subscription becomes permanently undeliverable (403),
    * nothing can be done from this side, at any price,
    * recovery is: generate a new pair, delete every push_subscriptions row,
      and wait for each player to opt in again by hand, on their own phone.

  Unlike RESEND_API_KEY or the token secrets, you cannot fix this alone.
  ───────────────────────────────────────────────────────────────────────────
`);

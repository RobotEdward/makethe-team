import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Context } from "hono";
import { ACCOUNT_PATH, PUSH_SUBSCRIBE_PATH, PUSH_TEST_PATH, PUSH_UNSUBSCRIBE_PATH } from "../auth/paths.js";
import { getDb } from "../db/client.js";
import type { Db } from "../db/client.js";
import { players, pushSubscriptions } from "../db/schema.js";
import { verifyResponseToken } from "../domain/token.js";
import type { AppEnv, Bindings } from "../env.js";
import { vapidKeys } from "../notify/factory.js";
import { sendTestPush } from "../notify/push-notifier.js";
import { base64UrlDecode } from "../notify/web-push.js";

export const push = new Hono<AppEnv>();

/**
 * This deployment's own origin, as every other state-changing POST in the
 * app compares it (`src/routes/account.ts`, `dashboard.ts`, `games.ts`,
 * `signin.ts`, `join.ts` each carry their own copy of the same helper).
 */
function originOf(env: Bindings): string {
  return new URL(env.BETTER_AUTH_URL).origin;
}

/** RFC 8291 §3.2: an uncompressed P-256 point is always this many bytes. */
const P256_PUBLIC_KEY_BYTES = 65;
/** The byte an uncompressed point's leading octet must be. */
const P256_UNCOMPRESSED_PREFIX = 0x04;
/** RFC 8291 §3.2: the shared auth secret is fixed at 16 bytes. */
const AUTH_SECRET_BYTES = 16;

/**
 * `user_agent` exists only so a player can tell "this phone" from "the
 * tablet" apart in a list (spec §9.1) — a caption, not a record of the
 * client's real UA string, so there is no reason to store more of it than a
 * caption ever needs and no reason to trust a client to keep it short.
 */
const MAX_USER_AGENT_LENGTH = 200;

/**
 * The friendly name a player types at subscribe time ("Ed's phone") exists
 * for exactly the same one purpose as `user_agent` above — telling rows
 * apart in a list — so it gets the same treatment: truncated at the door,
 * never trusted to be short, and blank collapses to null so the list's
 * fallback caption logic has one shape of absence to handle, not two.
 */
const MAX_DEVICE_NAME_LENGTH = 60;

function deviceNameFrom(body: Record<string, unknown>): string | null {
  const raw = body["name"];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().slice(0, MAX_DEVICE_NAME_LENGTH).trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * The two proofs `PUSH_SUBSCRIBE_PATH` and `PUSH_UNSUBSCRIBE_PATH` accept, and
 * the widening this route exists to record (spec §4).
 *
 * A signed-in player is `c.get("player")`, resolved by `sessionMiddleware`
 * for every request under `AUTHENTICATED_PREFIX` (this route's mount).
 * Absent that, a `token` field in the request body is checked against
 * `verifyResponseToken` — the same signature a fixture link already carries.
 * A response token already authorises setting that player's availability;
 * treating it as sufficient to register or remove a device is consistent
 * with that, and is the only way most players — who never sign in — ever
 * reach this feature at all.
 *
 * **The player id returned here is the only one either handler ever uses.**
 * It is never read from the request body: a body-supplied player id would
 * let anyone subscribe, or unsubscribe, on anyone else's behalf, which is a
 * different and much worse thing than the accepted risk of a forwarded
 * token (a friend who registers their own phone against the token's player
 * — the exposure spec §4 names and accepts).
 *
 * Returns `null` when neither proof holds, which both handlers turn into a
 * 404 — this project's established "access denied is a 404, not a 403" rule
 * (`test/routes/access.test.ts`), so a stranger probing this route learns
 * nothing about whether a token or a session would have worked.
 */
async function resolvePlayerId(c: Context<AppEnv>, body: Record<string, unknown>): Promise<string | null> {
  const sessionPlayer = c.get("player");
  if (sessionPlayer) return sessionPlayer.id;

  const token = body["token"];
  if (typeof token !== "string" || token.length === 0) return null;

  const now = new Date(Date.now());
  const verification = await verifyResponseToken(token, c.env.RESPONSE_TOKEN_SECRET, now);
  return verification.ok ? verification.payload.playerId : null;
}

/**
 * True once `erasePlayer` has run for this id, or the id names nobody at all.
 *
 * Checked before registering a device. Erasure deletes sessions
 * (`src/domain/erase-player.ts`), so the session half of `resolvePlayerId`
 * cannot hand back an erased player's id — but it cannot revoke a *response
 * token* already sitting in someone's inbox, and that is the other half. An
 * old link, opened after the person it named has been erased, would
 * otherwise register a brand-new `push_subscriptions` row against a player
 * id nobody should be able to reach any more — the exact residual data
 * erasure exists to prevent, reintroduced through the one credential it
 * cannot revoke. No send path would ever notify what this refusal prevents
 * (nothing sends to an erased player), so what is at stake is residual data
 * outliving the person who asked to be forgotten, not a woken phone.
 */
async function isErasedPlayer(db: Db, playerId: string): Promise<boolean> {
  const [row] = await db.select({ erasedAt: players.erasedAt }).from(players).where(eq(players.id, playerId));
  return row === undefined || row.erasedAt !== null;
}

interface SubscriptionKeys {
  p256dh: string;
  auth: string;
}

interface SubscriptionInput {
  endpoint: string;
  keys: SubscriptionKeys;
}

function isSubscriptionInput(value: unknown): value is SubscriptionInput {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate["endpoint"] !== "string") return false;
  const keys = candidate["keys"];
  if (typeof keys !== "object" || keys === null) return false;
  const keyCandidate = keys as Record<string, unknown>;
  return typeof keyCandidate["p256dh"] === "string" && typeof keyCandidate["auth"] === "string";
}

/**
 * `endpoint` must be an absolute `https:` URL — it is handed straight to
 * `fetch` at send time (`src/notify/web-push.ts`), and a relative or
 * non-`https:` value would either throw there or, worse, resolve against
 * something this Worker did not intend to call.
 */
function isValidEndpoint(endpoint: string): boolean {
  try {
    return new URL(endpoint).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * `p256dh` and `auth` go straight into ECDH and HKDF (`encryptPayload` in
 * `src/notify/web-push.ts`), which guards both lengths and throws — but only
 * at send time, hours later, inside a cron sweep, for a row that could have
 * been rejected here at the door. `base64UrlDecode` never throws on its own
 * (unpadded input is padded before `atob`), but `atob` still throws on a
 * string outside the base64 alphabet, so this is wrapped rather than trusted
 * to return.
 */
function decodedKeysAreValid(keys: SubscriptionKeys): boolean {
  let p256dh: Uint8Array;
  let auth: Uint8Array;
  try {
    p256dh = base64UrlDecode(keys.p256dh);
    auth = base64UrlDecode(keys.auth);
  } catch {
    return false;
  }
  if (p256dh.length !== P256_PUBLIC_KEY_BYTES || p256dh[0] !== P256_UNCOMPRESSED_PREFIX) return false;
  if (auth.length !== AUTH_SECRET_BYTES) return false;
  return true;
}

/**
 * Register a device (spec §4, §9.1, §11 state 4).
 *
 * **Upsert on `endpoint`** (UNIQUE): a device that re-subscribes — the
 * browser's own retry, or a player tapping the permission button twice —
 * produces the identical endpoint, and this must leave exactly one row
 * behind. Two would mean two notifications for every event, forever, with
 * nothing in the product to reveal it (spec §9.1, §9.3's neighbouring
 * warning about dedupe keys is the same shape of bug).
 *
 * **The origin check mirrors every other state-changing POST in this app**
 * (`POST /app/delete`, `POST /app`, `POST /g/new`, …) rather than being
 * exempt the way `POST /r/:token` is. Not exploitable via the session path
 * today — Better Auth's cookie is `sameSite: "lax"`, so a cross-site POST
 * carries no cookie regardless — but `c.req.json()` ignores `Content-Type`,
 * so without this check a cross-site `<form enctype="text/plain">` could
 * still reach the handler with a parseable body and a token lifted from the
 * victim's own inbox link (e.g. pasted into a page an attacker controls),
 * registering an attacker-controlled endpoint against that player's
 * notifications. Both callers this route actually has — the account page's
 * script and the fixture page's script — always send `Origin`, so the check
 * costs nothing on the paths that matter.
 */
push.post(PUSH_SUBSCRIBE_PATH, async (c) => {
  const origin = c.req.header("origin");
  if (origin !== undefined && origin !== originOf(c.env)) {
    return c.text("Forbidden", 403);
  }

  let parsed: unknown;
  try {
    parsed = await c.req.json();
  } catch {
    return c.text("Bad Request: expected a JSON body", 400);
  }
  if (typeof parsed !== "object" || parsed === null) {
    return c.text("Bad Request: expected a JSON object", 400);
  }
  const body = parsed as Record<string, unknown>;

  const playerId = await resolvePlayerId(c, body);
  if (!playerId) return c.text("Not found", 404);

  const db = getDb(c.env.DB);
  // See `isErasedPlayer`: a response token survives the session it was
  // minted alongside, so this is the one path erasure's session delete does
  // not already close.
  if (await isErasedPlayer(db, playerId)) return c.text("Not found", 404);

  const subscription = body["subscription"];
  if (!isSubscriptionInput(subscription)) {
    return c.text('Bad Request: "subscription" must carry an endpoint and keys.p256dh/auth', 400);
  }
  if (!isValidEndpoint(subscription.endpoint)) {
    return c.text('Bad Request: "endpoint" must be an absolute https: URL', 400);
  }
  if (!decodedKeysAreValid(subscription.keys)) {
    return c.text('Bad Request: "keys" are not the right shape', 400);
  }

  const userAgent = (c.req.header("user-agent") ?? "").slice(0, MAX_USER_AGENT_LENGTH) || null;
  const name = deviceNameFrom(body);

  await db
    .insert(pushSubscriptions)
    .values({
      id: crypto.randomUUID(),
      playerId,
      endpoint: subscription.endpoint,
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
      userAgent,
      name,
    })
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      // `id` and `createdAt` are deliberately absent: a re-subscribe updates
      // the existing row's keys and owner in place rather than minting a
      // second one, which is the entire point of upserting on `endpoint`.
      //
      // `playerId` moving on conflict — transferring ownership of an
      // existing row rather than refusing the second subscribe — is safe
      // because of *why* two subscribes can ever collide on the same
      // endpoint: the endpoint is a high-entropy URL minted by the push
      // service for one specific browser subscription, never chosen or
      // guessed by a caller, so a genuine collision only happens when the
      // same physical browser subscription re-registers (a token holder's
      // device re-subscribing after they later sign in is the one case that
      // does this on purpose). There is no way for a second, unrelated
      // caller to produce the same endpoint and hijack someone else's row.
      set: { playerId, p256dh: subscription.keys.p256dh, auth: subscription.keys.auth, userAgent, name },
    });

  return c.body(null, 204);
});

/**
 * Send a test notification to one of the caller's own devices (the device
 * list's per-row Test button).
 *
 * **Session only** — no token branch, unlike both siblings. The form lives
 * on the session-gated device list and carries an endpoint; accepting a
 * token here would let anyone holding a forwarded response link buzz the
 * player's devices on demand, an annoyance primitive neither sibling
 * offers (subscribe registers the *caller's* browser; unsubscribe needs an
 * endpoint the token holder can only know for a device they registered).
 *
 * The outcome rides back to `/app/account` as a `test=` query value rather
 * than a re-render: a plain form POST that re-rendered would leave the
 * player on a POST result they cannot refresh, and this route follows its
 * unsubscribe sibling's 303-to-the-page shape. The value is one of two
 * fixed words this route chooses — never caller text — so the page reads
 * it as an enum, not as content.
 *
 * A deployment whose `PUSH_NOTIFIER` is not `"webpush"` has no pair to
 * sign with and nothing real to deliver, so the answer is honestly
 * `failed` rather than a pretend success.
 */
push.post(PUSH_TEST_PATH, async (c) => {
  const origin = c.req.header("origin");
  if (origin !== undefined && origin !== originOf(c.env)) {
    return c.text("Forbidden", 403);
  }

  const player = c.get("player");
  if (!player) return c.text("Not found", 404);

  const body = (await c.req.parseBody()) as Record<string, unknown>;
  const endpoint = body["endpoint"];
  if (typeof endpoint !== "string" || endpoint.length === 0) {
    return c.text('Bad Request: "endpoint" is required', 400);
  }

  let delivered = false;
  if (c.env.PUSH_NOTIFIER === "webpush") {
    delivered = await sendTestPush(
      getDb(c.env.DB),
      vapidKeys(c.env),
      fetch,
      new Date(Date.now()),
      player.id,
      endpoint,
      {
        title: "Make The Team",
        body: "Test notification — this device is set up correctly.",
        url: new URL(ACCOUNT_PATH, originOf(c.env)).toString(),
      },
    );
  }

  return c.redirect(`${ACCOUNT_PATH}?test=${delivered ? "sent" : "failed"}`, 303);
});

/**
 * Remove a device (spec §4, §11). The counterweight to the subscribe
 * widening: `/app/account` lists every registered device (Task 12) so a
 * player can revoke one they did not register themselves.
 *
 * That list is server-rendered and must work with no JavaScript at all (spec
 * §11's closing paragraph), so the primary, load-bearing shape is a plain
 * `<form>`'s `application/x-www-form-urlencoded` body, read with
 * `parseBody` — unlike `PUSH_SUBSCRIBE_PATH`, which requires JSON because a
 * subscribe request can only ever be built by script (only script can
 * produce a `PushSubscription` to send). A JSON body is also accepted, for a
 * hypothetical future script-driven remove — nothing in this product sends
 * one today — read with `c.req.json()` on exactly the same two fields
 * (`endpoint`, `token`).
 *
 * Scoped by `playerId` as well as `endpoint` in the `DELETE`'s `WHERE`, not
 * merely by `endpoint` alone: an endpoint that exists but belongs to someone
 * else is left untouched and this still answers the same way, so the
 * response cannot be used to probe whether a given endpoint is registered to
 * another player.
 *
 * **The plain-form caller gets a `303` to `ACCOUNT_PATH`, not a bare `204`**
 * (M14 Task 12 review, Finding 3). A `204` leaves an ordinary
 * `<form method="post">` submission exactly where it was, per HTML's own
 * form-submission rules — no reload, no navigation — so with scripting off a
 * player who clicks Remove sees the same row still sitting there and no sign
 * anything happened, even though the delete really did run. A `303` back to
 * the page that rendered the form re-fetches the device list from the
 * database it actually changed, which is the only way this is observably
 * "the row is gone" rather than "the row is gone, but only the server knows
 * it." **`Content-Type`, not the caller's proof (session vs. token),
 * decides which body-reading branch runs and which response shape comes
 * back** — a JSON caller gets the bare `204` every other route in this file
 * answers with, on the assumption that a script posting JSON reads the
 * response itself and has no "current page" to leave stale.
 *
 * **Accepting a token here as well as a session is safe only because an
 * endpoint value is never disclosed to a token-authenticated caller.** A
 * token proves the caller was already trusted to register *some* device
 * against this player — but removal is keyed on the exact endpoint string,
 * and endpoints are high-entropy push-service URLs a caller has no way to
 * guess. The only place the product ever shows one is the device list on
 * `/app/account` (Task 12), which is session-gated — so a forwarded-token
 * holder can only ever unsubscribe the endpoint they themselves registered
 * (the one their own browser handed back after subscribing), never a device
 * registered by someone else. **If any future page ever renders or returns
 * an endpoint to a token-authenticated caller, this route becomes a
 * silent-disable primitive for anyone holding that token** — that
 * dependency must be re-checked before such a page is built.
 */
push.post(PUSH_UNSUBSCRIBE_PATH, async (c) => {
  const origin = c.req.header("origin");
  if (origin !== undefined && origin !== originOf(c.env)) {
    return c.text("Forbidden", 403);
  }

  // See this handler's doc comment: `Content-Type` decides both how the body
  // is read and which response shape comes back on success.
  const contentType = c.req.header("content-type") ?? "";
  const isFormPost =
    contentType.startsWith("application/x-www-form-urlencoded") || contentType.startsWith("multipart/form-data");

  let body: Record<string, unknown>;
  if (isFormPost) {
    body = (await c.req.parseBody()) as Record<string, unknown>;
  } else {
    let parsed: unknown;
    try {
      parsed = await c.req.json();
    } catch {
      parsed = {};
    }
    body = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  }

  const playerId = await resolvePlayerId(c, body);
  if (!playerId) return c.text("Not found", 404);

  const endpoint = body["endpoint"];
  if (typeof endpoint !== "string" || endpoint.length === 0) {
    return c.text('Bad Request: "endpoint" is required', 400);
  }

  const db = getDb(c.env.DB);
  await db
    .delete(pushSubscriptions)
    .where(and(eq(pushSubscriptions.endpoint, endpoint), eq(pushSubscriptions.playerId, playerId)));

  return isFormPost ? c.redirect(ACCOUNT_PATH, 303) : c.body(null, 204);
});

import { SELF, env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { ACCOUNT_PATH, PUSH_SUBSCRIBE_PATH, PUSH_UNSUBSCRIBE_PATH } from "../../src/auth/paths.js";
import { getDb } from "../../src/db/client.js";
import { players, pushSubscriptions } from "../../src/db/schema.js";
import { signResponseToken } from "../../src/domain/token.js";
import { base64UrlEncode } from "../../src/notify/web-push.js";
import { insertFixture, insertGame, insertMembership, insertPlayer, insertSubscription, resetDatabase } from "../support/factories.js";
import { kickoffIn } from "../support/clock.js";
import {
  PUSH_BUTTON_ID,
  PUSH_KEY_ATTRIBUTE,
  PUSH_PROBLEM_ID,
  PUSH_SUBSCRIBE_JS,
  PUSH_TOKEN_ATTRIBUTE,
} from "../../src/views/scripts.js";
import { ALLOWED, ORIGIN, signIn } from "../support/sign-in.js";

const db = getDb(env.DB);

function url(path: string): string {
  return `${ORIGIN}${path}`;
}

/** The Player the sign-in journey created for `ALLOWED`. */
async function viewerId(): Promise<string> {
  const [player] = await db.select().from(players).where(eq(players.email, ALLOWED));
  expect(player, "signing in must have created a Player").toBeDefined();
  return player!.id;
}

/**
 * A structurally valid `p256dh`/`auth` pair — a real uncompressed P-256
 * point and a 16-byte auth secret, both base64url — the same shape
 * `test/support/factories.ts`'s `insertSubscription` generates for a row
 * `PushNotifier` can actually encrypt against. Built independently here
 * rather than imported: this suite is exercising the HTTP boundary that
 * validates exactly this shape, so its fixture has to be real, not merely
 * schema-shaped.
 */
async function generateSampleSubscription(): Promise<{ endpoint: string; keys: { p256dh: string; auth: string } }> {
  const generated = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  if (!("publicKey" in generated)) throw new Error("expected an ECDH key pair from generateKey");
  const raw = await crypto.subtle.exportKey("raw", generated.publicKey);
  if (!(raw instanceof ArrayBuffer)) throw new Error('exportKey("raw") did not return raw bytes');

  return {
    endpoint: `https://push.example.com/${crypto.randomUUID()}`,
    keys: {
      p256dh: base64UrlEncode(new Uint8Array(raw)),
      auth: base64UrlEncode(crypto.getRandomValues(new Uint8Array(16))),
    },
  };
}

async function seedFixtureWithToken(): Promise<{ token: string; playerId: string }> {
  const gameId = await insertGame(db);
  const playerId = await insertPlayer(db);
  await insertMembership(db, gameId, playerId);
  const kicksOffAt = kickoffIn(9);
  const fixtureId = await insertFixture(db, gameId, { kicksOffAt });
  const token = await signResponseToken(
    { playerId, fixtureId, expiresAt: kicksOffAt.getTime() + 86_400_000 },
    env.RESPONSE_TOKEN_SECRET,
  );
  return { token, playerId };
}

async function postSubscription(subscription: unknown, cookie: string) {
  return SELF.fetch(url(PUSH_SUBSCRIBE_PATH), {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ subscription }),
  });
}

/**
 * Runs the real, shipped `PUSH_SUBSCRIBE_JS` — not a hand-built stand-in for
 * it — against a minimally faked browser, and captures the exact `fetch`
 * call it makes to `PUSH_SUBSCRIBE_PATH` (M14 Task 12 review, Finding 1).
 *
 * This is the boundary test the review asked for: `test/routes/push.test.ts`
 * used to build `{ subscription }` payloads by hand, and the script's own
 * `{ endpoint, keys }` body — which the route 400s on — was never checked
 * against the route it is actually posted to. Running the script's own text
 * closes that gap structurally: a future edit to `PUSH_SUBSCRIBE_JS` that
 * reshapes the body again fails *this* test, not just a hand-authored one
 * that could silently drift alongside it.
 *
 * Only `document`, `navigator`, `window`, `Notification`, `fetch` and `atob`
 * are faked — every name the script's own module comment lists as what it
 * touches — via `new Function(...)`, which evaluates the block with these as
 * local parameters rather than real globals (this test runs inside
 * workerd/miniflare, which has none of `document`/`window`/`Notification`
 * to begin with). The permission is pre-`"granted"` and
 * `pushManager.subscribe` resolves to a canned subscription whose `toJSON()`
 * is exactly what a real `PushSubscription` returns, so the only thing left
 * for the script to decide is the shape of the body it builds and posts.
 */
async function captureSubscribeFetch(
  vapidKey: string,
  token: string | undefined,
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
): Promise<{ url: string; init: RequestInit }> {
  const attributes: Record<string, string> = { [PUSH_KEY_ATTRIBUTE]: vapidKey };
  if (token !== undefined) attributes[PUSH_TOKEN_ATTRIBUTE] = token;

  let clickHandler: (() => void) | null = null;
  const button = {
    hidden: true,
    disabled: false,
    getAttribute: (name: string) => attributes[name] ?? null,
    addEventListener: (type: string, handler: () => void) => {
      if (type === "click") clickHandler = handler;
    },
  };
  const problem = { hidden: true, textContent: "" };
  const elements: Record<string, unknown> = {
    [PUSH_BUTTON_ID]: button,
    [PUSH_PROBLEM_ID]: problem,
  };
  const document = { getElementById: (id: string) => elements[id] ?? null };
  const navigator = {
    serviceWorker: {
      ready: Promise.resolve({
        pushManager: { subscribe: async () => ({ toJSON: () => subscription }) },
      }),
    },
  };
  const window = { PushManager: function PushManager() {} };
  const Notification = Object.assign(function Notification() {}, {
    permission: "default",
    requestPermission: async () => "granted",
  });

  let resolveCaptured!: (value: { url: string; init: RequestInit }) => void;
  const captured = new Promise<{ url: string; init: RequestInit }>((resolve) => {
    resolveCaptured = resolve;
  });
  const fetchStub = async (fetchUrl: string, init: RequestInit) => {
    resolveCaptured({ url: fetchUrl, init });
    return { ok: true };
  };

  // Running the shipped script text under controlled fakes is the whole
  // point of this helper — see its own doc comment.
  new Function("document", "navigator", "window", "Notification", "fetch", "atob", PUSH_SUBSCRIBE_JS)(
    document,
    navigator,
    window,
    Notification,
    fetchStub,
    globalThis.atob,
  );

  if (!clickHandler) throw new Error("PUSH_SUBSCRIBE_JS did not attach a click handler to the button");
  (clickHandler as () => void)();

  return captured;
}

beforeEach(resetDatabase);

describe("POST /app/push/subscribe", () => {
  it("registers a device for a signed-in player", async () => {
    const { cookie } = await signIn();
    const sampleSubscription = await generateSampleSubscription();

    const response = await postSubscription(sampleSubscription, cookie);
    expect(response.status).toBe(204);

    const me = await viewerId();
    const rows = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.playerId, me));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.endpoint).toBe(sampleSubscription.endpoint);
    expect(rows[0]?.p256dh).toBe(sampleSubscription.keys.p256dh);
    expect(rows[0]?.auth).toBe(sampleSubscription.keys.auth);
  });

  it("registers a device for a player holding a valid response token", async () => {
    // The deliberate widening in spec §4. Most players never sign in; a
    // feature only they can reach is a feature nobody uses. The token
    // already authorises setting this player's availability.
    const { token, playerId } = await seedFixtureWithToken();
    const sampleSubscription = await generateSampleSubscription();

    const response = await SELF.fetch(url(PUSH_SUBSCRIBE_PATH), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, subscription: sampleSubscription }),
    });

    expect(response.status).toBe(204);

    const [row] = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, sampleSubscription.endpoint));
    // The player id comes from the token, never from the request body — the
    // body carried no player id at all, so this is the only place it could
    // have come from.
    expect(row?.playerId).toBe(playerId);
  });

  it("refuses to register a device for an erased player, even with an otherwise-valid token", async () => {
    // Erasure deletes sessions, but a response token already sitting in
    // someone's inbox outlives it — the one credential erasure cannot
    // revoke. Without this check, opening that old link after the player it
    // named has been erased would create a brand-new subscription row
    // against an id nobody should be able to reach any more.
    const { token, playerId } = await seedFixtureWithToken();
    await db.update(players).set({ erasedAt: new Date("2026-08-17T09:00:00Z") }).where(eq(players.id, playerId));
    const sampleSubscription = await generateSampleSubscription();

    const response = await SELF.fetch(url(PUSH_SUBSCRIBE_PATH), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, subscription: sampleSubscription }),
    });

    expect(response.status).toBe(404);
    expect(await db.select().from(pushSubscriptions)).toHaveLength(0);
  });

  it("refuses a request with neither a session nor a valid token", async () => {
    const sampleSubscription = await generateSampleSubscription();

    const response = await SELF.fetch(url(PUSH_SUBSCRIBE_PATH), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subscription: sampleSubscription }),
    });

    expect(response.status).toBe(404);
    expect(await db.select().from(pushSubscriptions)).toHaveLength(0);
  });

  it("does not let a request supply its own player id", async () => {
    // The access rule's other half: taking the id from the body, rather than
    // from whichever proof was presented, would let anyone subscribe on
    // anyone's behalf.
    const { token, playerId } = await seedFixtureWithToken();
    const stranger = await insertPlayer(db);
    const sampleSubscription = await generateSampleSubscription();

    const response = await SELF.fetch(url(PUSH_SUBSCRIBE_PATH), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, playerId: stranger, subscription: sampleSubscription }),
    });

    expect(response.status).toBe(204);
    const [row] = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, sampleSubscription.endpoint));
    expect(row?.playerId).toBe(playerId);
    expect(row?.playerId).not.toBe(stranger);
  });

  it("is idempotent for the same device", async () => {
    // A device that re-subscribes produces the same endpoint. Two rows would
    // mean two notifications for one event, forever.
    const { cookie } = await signIn();
    const sampleSubscription = await generateSampleSubscription();

    const first = await postSubscription(sampleSubscription, cookie);
    const second = await postSubscription(sampleSubscription, cookie);

    expect(first.status).toBe(204);
    expect(second.status).toBe(204);
    expect(await db.select().from(pushSubscriptions)).toHaveLength(1);
  });

  it("refuses a subscription whose keys are not the right shape", async () => {
    // These strings go straight into ECDH. A p256dh that is not a 65-byte
    // uncompressed point throws inside the encryptor at send time — a sweep,
    // hours later, for a request that could have been rejected here.
    const { cookie } = await signIn();
    const sampleSubscription = await generateSampleSubscription();

    const response = await postSubscription(
      { ...sampleSubscription, keys: { p256dh: "nope", auth: "nope" } },
      cookie,
    );

    expect(response.status).toBe(400);
    expect(await db.select().from(pushSubscriptions)).toHaveLength(0);
  });

  it("refuses an endpoint that is not an absolute https: URL", async () => {
    const { cookie } = await signIn();
    const sampleSubscription = await generateSampleSubscription();

    const response = await postSubscription({ ...sampleSubscription, endpoint: "http://push.example.com/x" }, cookie);

    expect(response.status).toBe(400);
    expect(await db.select().from(pushSubscriptions)).toHaveLength(0);
  });

  it("truncates a long user-agent rather than storing it whole", async () => {
    const { cookie } = await signIn();
    const sampleSubscription = await generateSampleSubscription();
    const longUserAgent = "A".repeat(500);

    const response = await SELF.fetch(url(PUSH_SUBSCRIBE_PATH), {
      method: "POST",
      headers: { "content-type": "application/json", cookie, "user-agent": longUserAgent },
      body: JSON.stringify({ subscription: sampleSubscription }),
    });
    expect(response.status).toBe(204);

    const [row] = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, sampleSubscription.endpoint));
    // Pinned to the exact cap (`MAX_USER_AGENT_LENGTH` in src/routes/push.ts),
    // not merely "shorter than the input" — a looser assertion would still
    // pass for any truncation at all, including one that had silently drifted
    // to some other length.
    expect(row?.userAgent).toHaveLength(200);
    expect(row!.userAgent!).toBe(longUserAgent.slice(0, 200));
  });

  it("refuses a cross-origin post", async () => {
    const { cookie } = await signIn();
    const sampleSubscription = await generateSampleSubscription();

    const response = await SELF.fetch(url(PUSH_SUBSCRIBE_PATH), {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: "https://evil.example" },
      body: JSON.stringify({ subscription: sampleSubscription }),
    });

    expect(response.status).toBe(403);
    expect(await db.select().from(pushSubscriptions)).toHaveLength(0);
  });
});

describe("PUSH_SUBSCRIBE_JS's actual wire format (M14 Task 12 review, Finding 1)", () => {
  it("posts a body the real route accepts, for a signed-in visitor with no token", async () => {
    const { cookie } = await signIn();
    const sampleSubscription = await generateSampleSubscription();

    const { url: fetchUrl, init } = await captureSubscribeFetch(
      env.VAPID_PUBLIC_KEY,
      undefined,
      sampleSubscription,
    );
    expect(fetchUrl).toBe(PUSH_SUBSCRIBE_PATH);
    expect(init.method).toBe("POST");

    const response = await SELF.fetch(url(PUSH_SUBSCRIBE_PATH), {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: init.body as string,
    });

    expect(response.status).toBe(204);
    const me = await viewerId();
    const rows = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.playerId, me));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.endpoint).toBe(sampleSubscription.endpoint);
  });

  it("posts a body the real route accepts, with a token, for the response-confirmation offer's signed-out visitor (Finding 2)", async () => {
    const { token, playerId } = await seedFixtureWithToken();
    const sampleSubscription = await generateSampleSubscription();

    const { init } = await captureSubscribeFetch(env.VAPID_PUBLIC_KEY, token, sampleSubscription);

    const response = await SELF.fetch(url(PUSH_SUBSCRIBE_PATH), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: init.body as string,
    });

    expect(response.status).toBe(204);
    const rows = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.playerId, playerId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.endpoint).toBe(sampleSubscription.endpoint);
  });
});

describe("POST /app/push/unsubscribe", () => {
  it("removes only the caller's own device, and sends the browser back to the account page (M14 Task 12 review, Finding 3)", async () => {
    // `redirect: "manual"` so this inspects the 303 itself rather than
    // following it — a plain 204 here would leave a no-JS <form> submission
    // on the same page with the still-listed row, per HTML's own
    // form-submission rules (see the doc comment on this route).
    const { cookie } = await signIn();
    const me = await viewerId();
    const stranger = await insertPlayer(db);

    const mine = await insertSubscription(db, me, "https://push.example.com/mine");
    const theirs = await insertSubscription(db, stranger, "https://push.example.com/theirs");

    const response = await SELF.fetch(url(PUSH_UNSUBSCRIBE_PATH), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      body: new URLSearchParams({ endpoint: "https://push.example.com/mine" }),
      redirect: "manual",
    });

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(ACCOUNT_PATH);
    const remaining = await db.select().from(pushSubscriptions);
    expect(remaining.map((row) => row.id)).toEqual([theirs]);
    expect(remaining.map((row) => row.id)).not.toContain(mine);
  });

  it("is a no-op, not an error, for an endpoint registered to somebody else, and still redirects", async () => {
    const { cookie } = await signIn();
    const stranger = await insertPlayer(db);
    const theirs = await insertSubscription(db, stranger, "https://push.example.com/theirs");

    const response = await SELF.fetch(url(PUSH_UNSUBSCRIBE_PATH), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      body: new URLSearchParams({ endpoint: "https://push.example.com/theirs" }),
      redirect: "manual",
    });

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(ACCOUNT_PATH);
    const remaining = await db.select().from(pushSubscriptions);
    expect(remaining.map((row) => row.id)).toEqual([theirs]);
  });

  it("refuses a request with neither a session nor a valid token", async () => {
    const response = await SELF.fetch(url(PUSH_UNSUBSCRIBE_PATH), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ endpoint: "https://push.example.com/mine" }),
    });

    expect(response.status).toBe(404);
  });

  it("removes a device for a player holding a valid response token, and no other player's", async () => {
    // The symmetric half of the subscribe widening: a device registered via a
    // forwarded token must be removable by whoever is holding that same
    // token, not only by someone who has since signed in — safe because an
    // endpoint is never disclosed to a token-authenticated caller in the
    // first place (see the doc comment on PUSH_UNSUBSCRIBE_PATH).
    const { token, playerId } = await seedFixtureWithToken();
    const stranger = await insertPlayer(db);

    const mine = await insertSubscription(db, playerId, "https://push.example.com/mine");
    const theirs = await insertSubscription(db, stranger, "https://push.example.com/theirs");

    const response = await SELF.fetch(url(PUSH_UNSUBSCRIBE_PATH), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token, endpoint: "https://push.example.com/mine" }),
      redirect: "manual",
    });

    expect(response.status).toBe(303);
    const remaining = await db.select().from(pushSubscriptions);
    expect(remaining.map((row) => row.id)).toEqual([theirs]);
    expect(remaining.map((row) => row.id)).not.toContain(mine);
  });

  it("refuses a cross-origin post", async () => {
    const { cookie } = await signIn();
    const me = await viewerId();
    await insertSubscription(db, me, "https://push.example.com/mine");

    const response = await SELF.fetch(url(PUSH_UNSUBSCRIBE_PATH), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie, origin: "https://evil.example" },
      body: new URLSearchParams({ endpoint: "https://push.example.com/mine" }),
    });

    expect(response.status).toBe(403);
    expect(await db.select().from(pushSubscriptions)).toHaveLength(1);
  });

  it("accepts a JSON body too, and keeps a bare 204 for it (M14 Task 12 review, Finding 3)", async () => {
    // No script in this product sends this shape today — the account page's
    // Remove button is a plain `<form>` — but the Content-Type gate itself
    // needs a real, reachable branch to prove: a regression that redirects
    // *every* caller (form or not) would fail here.
    const { cookie } = await signIn();
    const me = await viewerId();
    const mine = await insertSubscription(db, me, "https://push.example.com/mine");

    const response = await SELF.fetch(url(PUSH_UNSUBSCRIBE_PATH), {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ endpoint: "https://push.example.com/mine" }),
      redirect: "manual",
    });

    expect(response.status).toBe(204);
    const remaining = await db.select().from(pushSubscriptions);
    expect(remaining.map((row) => row.id)).not.toContain(mine);
  });
});

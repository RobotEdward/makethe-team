import { SELF, env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { PUSH_SUBSCRIBE_PATH, PUSH_UNSUBSCRIBE_PATH } from "../../src/auth/paths.js";
import { getDb } from "../../src/db/client.js";
import { players, pushSubscriptions } from "../../src/db/schema.js";
import { signResponseToken } from "../../src/domain/token.js";
import { base64UrlEncode } from "../../src/notify/web-push.js";
import { insertFixture, insertGame, insertMembership, insertPlayer, insertSubscription, resetDatabase } from "../support/factories.js";
import { kickoffIn } from "../support/clock.js";
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

describe("POST /app/push/unsubscribe", () => {
  it("removes only the caller's own device", async () => {
    const { cookie } = await signIn();
    const me = await viewerId();
    const stranger = await insertPlayer(db);

    const mine = await insertSubscription(db, me, "https://push.example.com/mine");
    const theirs = await insertSubscription(db, stranger, "https://push.example.com/theirs");

    const response = await SELF.fetch(url(PUSH_UNSUBSCRIBE_PATH), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      body: new URLSearchParams({ endpoint: "https://push.example.com/mine" }),
    });

    expect(response.status).toBe(204);
    const remaining = await db.select().from(pushSubscriptions);
    expect(remaining.map((row) => row.id)).toEqual([theirs]);
    expect(remaining.map((row) => row.id)).not.toContain(mine);
  });

  it("is a no-op, not an error, for an endpoint registered to somebody else", async () => {
    const { cookie } = await signIn();
    const stranger = await insertPlayer(db);
    const theirs = await insertSubscription(db, stranger, "https://push.example.com/theirs");

    const response = await SELF.fetch(url(PUSH_UNSUBSCRIBE_PATH), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      body: new URLSearchParams({ endpoint: "https://push.example.com/theirs" }),
    });

    expect(response.status).toBe(204);
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
    });

    expect(response.status).toBe(204);
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
});

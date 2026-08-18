import { env } from "cloudflare:test";
import { getDb, type Db } from "../../src/db/client.js";
import { fixtures, games, memberships, players, pushSubscriptions, responses } from "../../src/db/schema.js";
import type { EmailMessage, Message } from "../../src/notify/notifier.js";
import { base64UrlEncode } from "../../src/notify/web-push.js";
import { kickoffIn, NOW } from "./clock.js";

/**
 * Shared builders for database fixtures used by the tests.
 *
 * Each test file used to carry its own near-identical game builder, which meant
 * a schema change was three edits and the three copies had already begun to
 * drift. Everything the tests need to vary goes through `overrides`.
 */

export type GameInsert = typeof games.$inferInsert;

/** A plausible, complete game row: Thursdays at 19:00 in Oxford. */
export function gameRow(overrides: Partial<GameInsert> = {}): GameInsert {
  return {
    id: crypto.randomUUID(),
    name: "Thursday 7-a-side",
    venueName: "Oxford Sports Park",
    timezone: "Europe/London",
    recurrenceRule: "FREQ=WEEKLY;INTERVAL=1;BYDAY=TH",
    recurrenceStartDate: "2026-08-13",
    kickoffTime: "19:00",
    durationMinutes: 60,
    minPlayers: 10,
    maxPlayers: 14,
    inviteToken: crypto.randomUUID(),
    ...overrides,
  };
}

/** Insert a game and return its id. */
export async function insertGame(db: Db, overrides: Partial<GameInsert> = {}): Promise<string> {
  const row = gameRow(overrides);
  await db.insert(games).values(row);
  return row.id;
}

/**
 * Deletes `notification_log` then `fixtures`, retrying the pair if the
 * `fixtures` delete hits a foreign-key violation.
 *
 * Several routes hand a notification send to `ctx.waitUntil()` deliberately
 * (`notifyPromotedPlayer` in `src/routes/respond.ts` is the one every
 * `POST /leave/:token` test exercises, via the promotion it can trigger for
 * the next waitlisted player) — so a previous test's `SELF.fetch()`
 * resolving does not guarantee that background `notification_log` write has
 * already landed. `cloudflare:test` has no public way to drain a
 * service-bound fetch's `waitUntil` queue: `waitOnExecutionContext` only
 * works on a manually created `ExecutionContext` (see `test/index.test.ts`,
 * which uses it for the `scheduled` handler precisely because that path
 * *doesn't* go through `SELF.fetch()`).
 *
 * Without this retry, a straggling insert can land in the gap between this
 * function's own `DELETE FROM notification_log` and `DELETE FROM fixtures`
 * below, re-populating a row that references a fixture this call is about
 * to delete — nondeterministically, since it depends on exactly how many
 * ticks the background send needed to reach its own write. A second pass
 * absorbs it: the straggler is a one-off write from an already-completed
 * request, not a sustained source, so `notification_log` is empty again by
 * the retry.
 */
async function deleteNotificationLogAndFixtures(): Promise<void> {
  const MAX_ATTEMPTS = 5;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await env.DB.exec("DELETE FROM notification_log");
    try {
      await env.DB.exec("DELETE FROM fixtures");
      return;
    } catch (error) {
      if (attempt === MAX_ATTEMPTS) throw error;
    }
  }
}

/**
 * Empty every table a test might have written, in foreign-key-safe order.
 * Call from `beforeEach` so tests never inherit another test's rows.
 */
export async function resetDatabase(): Promise<void> {
  await env.DB.exec("DELETE FROM audit_log");
  await env.DB.exec("DELETE FROM email_quota");
  await env.DB.exec("DELETE FROM push_subscriptions");
  await env.DB.exec("DELETE FROM responses");
  await env.DB.exec("DELETE FROM memberships");
  await deleteNotificationLogAndFixtures();
  await env.DB.exec("DELETE FROM games");
  await env.DB.exec("DELETE FROM players");
  // Better Auth tables (M5). Children before parent: session, account and
  // passkey all hold a FK to user.id (ON DELETE cascade would make this
  // order optional, but delete explicitly rather than relying on it — this
  // project has already been bitten once by a `resetDatabase` that omitted a
  // table and leant on an implicit cascade to cover the gap).
  await env.DB.exec("DELETE FROM session");
  await env.DB.exec("DELETE FROM account");
  await env.DB.exec("DELETE FROM passkey");
  await env.DB.exec("DELETE FROM verification");
  await env.DB.exec("DELETE FROM user");
}

/** The Drizzle handle bound to the test D1 database. */
export function testDb(): Db {
  return getDb(env.DB);
}

/**
 * Narrows a captured `Message` to `EmailMessage` for the many suites that
 * only ever exercise the email channel (M14 split `Message` into a
 * discriminated union, so a test asserting `message.subject` on the plain
 * union no longer compiles without first proving `channel === "email"`).
 *
 * Throws rather than returning `undefined | EmailMessage`, because every
 * caller of this immediately dereferences `.subject`/`.html`/`.text` — a
 * push slipping in here is a bug in the test's setup, and should fail loudly
 * at the point it was captured rather than as a confusing `undefined` later.
 */
export function requireEmailMessage(message: Message): EmailMessage {
  if (message.channel !== "email") {
    throw new Error(`expected an email message, got channel "${message.channel}"`);
  }
  return message;
}

export type PlayerInsert = typeof players.$inferInsert;

/** A plausible player row. Pass `email: null, isGuest: true` for a guest. */
export function playerRow(overrides: Partial<PlayerInsert> = {}): PlayerInsert {
  return {
    id: crypto.randomUUID(),
    name: "Edward Charles",
    email: `player-${crypto.randomUUID()}@example.com`,
    ...overrides,
  };
}

export async function insertPlayer(db: Db, overrides: Partial<PlayerInsert> = {}): Promise<string> {
  const row = playerRow(overrides);
  await db.insert(players).values(row);
  return row.id;
}

/** Put a player in a squad. Defaults to an active ordinary member. */
export async function insertMembership(
  db: Db,
  gameId: string,
  playerId: string,
  overrides: Partial<typeof memberships.$inferInsert> = {},
): Promise<string> {
  const id = crypto.randomUUID();
  // `joinedAt` is pinned to the suite's own `NOW` rather than left to the
  // column's default (the wall clock at insert). `/leave/:token` compares a
  // token's mint time against this column, and a test that mints its token at
  // `NOW` would otherwise be racing the few milliseconds between the two — the
  // same class of clock-relative fragility `clock.ts` exists to remove.
  await db.insert(memberships).values({ id, gameId, playerId, joinedAt: NOW, ...overrides });
  return id;
}

export async function insertFixture(
  db: Db,
  gameId: string,
  overrides: Partial<typeof fixtures.$inferInsert> = {},
): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(fixtures).values({
    id,
    gameId,
    kicksOffAt: kickoffIn(24 * 7),
    minPlayers: 10,
    maxPlayers: 14,
    prefersEvenNumbers: true,
    shortWarningOffsetHours: 12,
    durationMinutes: 60,
    ...overrides,
  });
  return id;
}

/**
 * A structurally valid `p256dh`/`auth` pair: a real uncompressed P-256 point
 * and a 16-byte auth secret, both base64url. `encryptPayload` (web-push.ts)
 * checks both lengths before it will touch a subscription, so junk of the
 * right length is not enough — `insertSubscription` needs a row
 * `PushNotifier` can actually encrypt against, not just one that satisfies
 * the schema.
 */
async function generatePushKeys(): Promise<{ p256dh: string; auth: string }> {
  const generated = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ]);
  if (!("publicKey" in generated)) {
    throw new Error("expected an ECDH key pair from generateKey");
  }
  const raw = await crypto.subtle.exportKey("raw", generated.publicKey);
  if (!(raw instanceof ArrayBuffer)) {
    throw new Error('exportKey("raw") did not return raw bytes');
  }
  return {
    p256dh: base64UrlEncode(new Uint8Array(raw)),
    auth: base64UrlEncode(crypto.getRandomValues(new Uint8Array(16))),
  };
}

export type PushSubscriptionInsert = typeof pushSubscriptions.$inferInsert;

/** Register one of a player's devices for push. Returns the subscription id. */
export async function insertSubscription(
  db: Db,
  playerId: string,
  endpoint: string,
  overrides: Partial<PushSubscriptionInsert> = {},
): Promise<string> {
  const id = crypto.randomUUID();
  const generatedKeys = await generatePushKeys();
  await db.insert(pushSubscriptions).values({
    id,
    playerId,
    endpoint,
    p256dh: generatedKeys.p256dh,
    auth: generatedKeys.auth,
    ...overrides,
  });
  return id;
}

export async function insertResponse(
  db: Db,
  fixtureId: string,
  playerId: string,
  overrides: Partial<typeof responses.$inferInsert> = {},
): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(responses).values({ id, fixtureId, playerId, source: "system", ...overrides });
  return id;
}

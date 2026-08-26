import { env } from "cloudflare:test";
import { getDb, type Db } from "../../src/db/client.js";
import {
  fixtureResultClaims,
  fixtures,
  gameNotificationSettings,
  games,
  inviteTiers,
  memberships,
  players,
  pushSubscriptions,
  responses,
} from "../../src/db/schema.js";
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
 * One owner switch (M37). `type` and `channel` are plain strings so a test
 * can write a value this build does not recognise — the stored-lookups case.
 */
export async function insertNotificationSetting(
  db: Db,
  gameId: string,
  type: string,
  channel: string,
  enabled: boolean,
): Promise<void> {
  await db
    .insert(gameNotificationSettings)
    .values({ gameId, notificationType: type, channel, enabled })
    .onConflictDoUpdate({
      target: [gameNotificationSettings.gameId, gameNotificationSettings.notificationType, gameNotificationSettings.channel],
      set: { enabled },
    });
}

/**
 * Every table a test might have written, in foreign-key-safe order (children
 * before parents).
 */
const RESET_TABLES = [
  // A leaked `open_signups` row would open the sign-in gate for every
  // subsequent test, turning refusal assertions green for the wrong reason.
  "app_settings",
  "signup_allowlist",
  "signin_refusals",
  "audit_log",
  "notification_log",
  "email_quota",
  "push_subscriptions",
  "fixture_results",
  "fixture_result_claims",
  "responses",
  "memberships",
  "invite_tiers",
  "fixtures",
  "game_notification_settings",
  "games",
  "players",
  // Better Auth tables (M5). Children before parent: session, account and
  // passkey all hold a FK to user.id (ON DELETE cascade would make this
  // order optional, but delete explicitly rather than relying on it — this
  // project has already been bitten once by a `resetDatabase` that omitted a
  // table and leant on an implicit cascade to cover the gap).
  "session",
  "account",
  "passkey",
  "verification",
  "user",
] as const;

/** Matches the message D1/SQLite reports for a foreign-key violation, however the error object wraps it. */
function isForeignKeyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("FOREIGN KEY constraint failed") || message.includes("SQLITE_CONSTRAINT_FOREIGNKEY");
}

/**
 * Empty every table a test might have written. Call from `beforeEach` so
 * tests never inherit another test's rows.
 *
 * Several routes hand a notification send to `ctx.waitUntil()`
 * (`notifyPromotedPlayer` in `src/routes/respond.ts` is the one every
 * `POST /leave/:token` test exercises, via the promotion it can trigger for
 * the next waitlisted player), and `cloudflare:test` has no public way to
 * drain a service-bound fetch's `waitUntil` queue for a test that used
 * `SELF.fetch()` (`waitOnExecutionContext` only works on a manually created
 * `ExecutionContext` — see `test/index.test.ts`, which needs it precisely
 * because the `scheduled` handler path there does *not* go through
 * `SELF.fetch()`). A previous test's background write can therefore still
 * be in flight when the next test's `beforeEach` runs, and can re-populate
 * an already-cleared table (`notification_log`, most often, but also
 * `audit_log` via a ceiling-deferral row) with a row that references a
 * table this function has not reached yet — `fixtures` or `players` —
 * tripping that later `DELETE` on a foreign-key violation.
 *
 * `env.DB.batch()` was tried here first, on the theory that its implicit
 * transaction closes the race outright: every statement in a batch commits
 * atomically, so no externally-issued write can land between any two of
 * them. It does close *that* race — but it also makes `resetDatabase`
 * itself faster, which pulls every following test's own request forward in
 * wall-clock time relative to the previous test's still-in-flight
 * background task. That shift turned up a second, unrelated instance of the
 * same underlying problem: `test/routes/delete-account.test.ts`'s spy on
 * `ConsoleNotifier.prototype.send` started intermittently capturing a
 * *previous* test's stray promotion email, because the narrower gap gave
 * the straggler's `send()` call a better chance of firing while the next
 * test's spy was installed. `batch()` fixes the specific failure mode this
 * function was first bitten by; it does not fix the general one, and
 * changing this function's timing is exactly the kind of change that can
 * make the general one worse elsewhere. So: the retry from before, kept,
 * narrowed to only ever swallow a genuine foreign-key violation (anything
 * else rethrows immediately — this must never mask an unrelated schema or
 * data bug), logged on every retry so a future flake here is traceable to
 * this comment rather than a fresh investigation, and covering every table
 * in one bounded loop rather than one hand-picked pair — the straggler can
 * land against `players` or `audit_log` exactly as it can against
 * `fixtures`, and retrying the whole sequence is what actually protects all
 * of them at once.
 */
export async function resetDatabase(): Promise<void> {
  const MAX_ATTEMPTS = 5;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      for (const table of RESET_TABLES) {
        await env.DB.exec(`DELETE FROM ${table}`);
      }
      return;
    } catch (error) {
      if (!isForeignKeyError(error) || attempt === MAX_ATTEMPTS) throw error;
      console.warn(
        `resetDatabase: retrying after a foreign-key violation, likely a straggling ctx.waitUntil() write from a previous test (attempt ${attempt}/${MAX_ATTEMPTS}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
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

/** One rung of a Game's invite order. Position defaults to 1. */
export async function insertInviteTier(
  db: Db,
  gameId: string,
  overrides: Partial<typeof inviteTiers.$inferInsert> = {},
): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(inviteTiers).values({ id, gameId, name: "Tier", position: 1, ...overrides });
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

export async function insertResultClaim(
  db: Db,
  fixtureId: string,
  playerId: string,
  overrides: Partial<typeof fixtureResultClaims.$inferInsert> = {},
): Promise<string> {
  const id = crypto.randomUUID();
  // `filedAt` is pinned rather than left to the caller's wall clock: the last
  // tie-break in `deriveResult` compares these instants, and a suite whose
  // claims all land in the same millisecond cannot test it.
  await db.insert(fixtureResultClaims).values({
    id,
    fixtureId,
    playerId,
    outcome: "a",
    filedAt: NOW,
    ...overrides,
  });
  return id;
}

import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } from "../domain/audit.js";
import { INITIAL_LIFECYCLE, LIFECYCLES } from "../domain/lifecycle.js";
import { NOTIFICATION_STATUSES, NOTIFICATION_TYPES } from "../notify/dedupe-key.js";
import {
  INITIAL_RESPONSE_STATUS,
  RESPONSE_SOURCES,
  RESPONSE_STATUSES,
} from "../domain/response-status.js";

const nowMs = sql`(unixepoch() * 1000)`;

export const players = sqliteTable(
  "players",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    // Nullable: guests have no contact details (§2.8, BR-32).
    email: text("email"),
    isGuest: integer("is_guest", { mode: "boolean" }).notNull().default(false),
    // Nullable link to Better Auth's own user table, populated on first sign-in (TR-30).
    authUserId: text("auth_user_id"),
    notificationChannel: text("notification_channel", { enum: ["email"] }).notNull().default("email"),
    emailVerifiedAt: integer("email_verified_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
  },
  (t) => [uniqueIndex("players_email_unique").on(t.email).where(sql`${t.email} is not null`)],
);

export const games = sqliteTable("games", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  venueName: text("venue_name").notNull(),
  venueAddress: text("venue_address"),
  venueUrl: text("venue_url"),
  // IANA identifier, e.g. Europe/London (TR-5).
  timezone: text("timezone").notNull(),
  // RRULE string; only FREQ=WEEKLY is accepted (§2.3).
  recurrenceRule: text("recurrence_rule").notNull(),
  // Local YYYY-MM-DD anchor. Required to make INTERVAL>1 well-defined.
  recurrenceStartDate: text("recurrence_start_date").notNull(),
  // Local HH:MM.
  kickoffTime: text("kickoff_time").notNull(),
  durationMinutes: integer("duration_minutes").notNull(),
  minPlayers: integer("min_players").notNull(),
  maxPlayers: integer("max_players").notNull(),
  prefersEvenNumbers: integer("prefers_even_numbers", { mode: "boolean" }).notNull().default(true),
  reminderDaysBefore: integer("reminder_days_before").notNull().default(1),
  reminderLocalTime: text("reminder_local_time").notNull().default("09:00"),
  shortWarningOffsetHours: integer("short_warning_offset_hours").notNull().default(12),
  inviteToken: text("invite_token").notNull(),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
}, (t) => [uniqueIndex("games_invite_token_unique").on(t.inviteToken)]);

export const memberships = sqliteTable(
  "memberships",
  {
    id: text("id").primaryKey(),
    gameId: text("game_id").notNull().references(() => games.id),
    playerId: text("player_id").notNull().references(() => players.id),
    role: text("role", { enum: ["player", "owner"] }).notNull().default("player"),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    joinedAt: integer("joined_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
    leftAt: integer("left_at", { mode: "timestamp_ms" }),
  },
  (t) => [uniqueIndex("memberships_game_player_unique").on(t.gameId, t.playerId)],
);

export const fixtures = sqliteTable(
  "fixtures",
  {
    id: text("id").primaryKey(),
    gameId: text("game_id").notNull().references(() => games.id),
    kicksOffAt: integer("kicks_off_at", { mode: "timestamp_ms" }).notNull(),
    // Stored lifecycle only. short/confirmed/uneven are derived (BR-12).
    lifecycle: text("lifecycle", { enum: LIFECYCLES }).notNull().default(INITIAL_LIFECYCLE),
    // Copied from the game at materialisation so edits never rewrite history (§2.8).
    minPlayers: integer("min_players").notNull(),
    maxPlayers: integer("max_players").notNull(),
    prefersEvenNumbers: integer("prefers_even_numbers", { mode: "boolean" }).notNull(),
    shortWarningOffsetHours: integer("short_warning_offset_hours").notNull(),
    durationMinutes: integer("duration_minutes").notNull(),
    // Cache, written only inside the Durable Object critical section from M2 (TR-10).
    inCount: integer("in_count").notNull().default(0),
    waitlistCount: integer("waitlist_count").notNull().default(0),
    venueOverride: text("venue_override"),
    notes: text("notes"),
    cancelledAt: integer("cancelled_at", { mode: "timestamp_ms" }),
    cancellationReason: text("cancellation_reason"),
    openedAt: integer("opened_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
  },
  (t) => [
    uniqueIndex("fixtures_game_kickoff_unique").on(t.gameId, t.kicksOffAt),
    index("fixtures_lifecycle_kickoff_idx").on(t.lifecycle, t.kicksOffAt),
  ],
);

export const responses = sqliteTable(
  "responses",
  {
    id: text("id").primaryKey(),
    fixtureId: text("fixture_id").notNull().references(() => fixtures.id),
    playerId: text("player_id").notNull().references(() => players.id),
    status: text("status", { enum: RESPONSE_STATUSES }).notNull().default(INITIAL_RESPONSE_STATUS),
    // Null unless waitlisted. Ordering is strictly by when the player joined
    // the waitlist (BR-6) — no priority, no reordering.
    waitlistPosition: integer("waitlist_position"),
    // Null while pending: the player has not answered yet, and silence is not
    // consent (§1.4).
    respondedAt: integer("responded_at", { mode: "timestamp_ms" }),
    // Null when the player set it themselves; the owner's id for an override (BR-27).
    setByPlayerId: text("set_by_player_id").references(() => players.id),
    source: text("source", { enum: RESPONSE_SOURCES }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
  },
  (t) => [
    uniqueIndex("responses_fixture_player_unique").on(t.fixtureId, t.playerId),
    index("responses_fixture_status_idx").on(t.fixtureId, t.status),
    index("responses_player_idx").on(t.playerId),
  ],
);

export const notificationLog = sqliteTable(
  "notification_log",
  {
    id: text("id").primaryKey(),
    // The entire idempotency guarantee (§2.8). See src/notify/dedupe-key.ts.
    dedupeKey: text("dedupe_key").notNull(),
    notificationType: text("notification_type", { enum: NOTIFICATION_TYPES }).notNull(),
    // Nullable: N-6 (welcome) is not fixture-scoped (§2.8).
    fixtureId: text("fixture_id").references(() => fixtures.id),
    playerId: text("player_id").notNull().references(() => players.id),
    channel: text("channel", { enum: ["email"] }).notNull().default("email"),
    status: text("status", { enum: NOTIFICATION_STATUSES }).notNull().default("queued"),
    providerMessageId: text("provider_message_id"),
    sentAt: integer("sent_at", { mode: "timestamp_ms" }),
    error: text("error"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
  },
  (t) => [uniqueIndex("notification_log_dedupe_key_unique").on(t.dedupeKey)],
);

export const emailQuota = sqliteTable("email_quota", {
  // UTC date, YYYY-MM-DD (§2.8).
  day: text("day").primaryKey(),
  sentCount: integer("sent_count").notNull().default(0),
});

export const auditLog = sqliteTable(
  "audit_log",
  {
    id: text("id").primaryKey(),
    // Nullable: cron and other system actions have no actor (BR-27, §2.8).
    actorPlayerId: text("actor_player_id").references(() => players.id),
    // Polymorphic reference; not a foreign key (the entity table varies).
    entityType: text("entity_type", { enum: AUDIT_ENTITY_TYPES }).notNull(),
    entityId: text("entity_id").notNull(),
    action: text("action", { enum: AUDIT_ACTIONS }).notNull(),
    beforeJson: text("before_json"),
    afterJson: text("after_json"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
  },
  (t) => [
    index("audit_log_entity_idx").on(t.entityType, t.entityId),
    index("audit_log_created_at_idx").on(t.createdAt),
  ],
);

// ---------------------------------------------------------------------------
// Better Auth tables (M5). Third-party-defined: table and column names below
// are copied verbatim from `getAuthTables({})` in `@better-auth/core/db`
// (better-auth@1.6.26), not invented, because the library's Drizzle adapter
// resolves both by exact string — the JS property key it looks up is the
// camelCase `fieldName` from that schema, and `drizzleAdapter()` reads the
// table object off `db._.fullSchema[modelName]`, i.e. by the export's name.
// Do NOT rename these to match the project's own vocabulary, and do not
// rename "user" here to "player" — that's Better Auth's own model name and
// is exempt from the project's vocabulary rule (see plan). Nothing in
// hand-written project code should say "user"; `players.auth_user_id` (above)
// is the only link between the two (TR-30, Task 2).
//
// One deliberate omission: the upstream `account` model also defines an
// optional `password` field (used only by its email/password credential
// provider). This project forbids a password field anywhere in the
// codebase (TR-16) and never configures that provider — only magic link and
// passkey, neither of which touches `account.password`. Leaving the column
// out is safe *and* self-checking: if any future plugin config ever tried to
// read or write it, the adapter throws `BetterAuthError` immediately
// ("field does not exist") rather than silently reintroducing a password
// column.
//
// `verification.createdAt`/`updatedAt` are declared NOT NULL here, matching
// `getAuthTables({}).verification` upstream (`required: true` for both).
// An earlier pass of this schema left them nullable by mistake; there was no
// deliberate reason to diverge, so they were corrected to match upstream
// rather than documented as an intentional exception.
// ---------------------------------------------------------------------------

export const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("emailVerified", { mode: "boolean" }).notNull(),
  image: text("image"),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp_ms" }).notNull(),
});

export const session = sqliteTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: integer("expiresAt", { mode: "timestamp_ms" }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updatedAt", { mode: "timestamp_ms" }).notNull(),
    ipAddress: text("ipAddress"),
    userAgent: text("userAgent"),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (t) => [index("session_userId_idx").on(t.userId)],
);

export const account = sqliteTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("accountId").notNull(),
    providerId: text("providerId").notNull(),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("accessToken"),
    refreshToken: text("refreshToken"),
    idToken: text("idToken"),
    accessTokenExpiresAt: integer("accessTokenExpiresAt", { mode: "timestamp_ms" }),
    refreshTokenExpiresAt: integer("refreshTokenExpiresAt", { mode: "timestamp_ms" }),
    scope: text("scope"),
    // No `password` column — see block comment above (TR-16).
    createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updatedAt", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("account_userId_idx").on(t.userId)],
);

export const verification = sqliteTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: integer("expiresAt", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updatedAt", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("verification_identifier_idx").on(t.identifier)],
);

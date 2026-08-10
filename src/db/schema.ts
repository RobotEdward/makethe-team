import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { INITIAL_LIFECYCLE, LIFECYCLES } from "../domain/lifecycle.js";
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

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
    notificationChannel: text("notification_channel", { enum: ["email", "push"] })
      .notNull()
      .default("email"),
    emailVerifiedAt: integer("email_verified_at", { mode: "timestamp_ms" }),
    /**
     * When the one-time contextual push offer was shown (M14, spec §11). Stamped
     * on display, never cleared: the offer is made once in the product's
     * lifetime, and `/app/account` is the permanent route back for anyone who
     * dismissed it.
     */
    pushOfferedAt: integer("push_offered_at", { mode: "timestamp_ms" }),
    /**
     * When a requested erasure becomes due (§2.1). Set by `POST /app/delete`,
     * cleared by `POST /app/delete/cancel`, and read by the hourly sweep.
     *
     * Deliberately *kept* after erasure rather than cleared, so the row records
     * what was promised as well as what happened.
     */
    erasesAt: integer("erases_at", { mode: "timestamp_ms" }),
    /**
     * When this player was erased (§3). Non-null means the row is no longer a
     * person: `name` is the placeholder, and `email`, `auth_user_id` and
     * `email_verified_at` are all null.
     *
     * This column, not a name comparison, is what every renderer branches on.
     */
    erasedAt: integer("erased_at", { mode: "timestamp_ms" }),
    /**
     * When the sweep first got past `erasePlayer`'s pre-check and began
     * *writing* — the first membership removal, the Better Auth deletes, the
     * anonymising batch (§3).
     *
     * Erasure is not one atomic unit (D1 has no interactive transaction
     * spanning Durable Object calls and several `db.batch()`es), so it can
     * stop half-done: a late `blocked`, a D1 error, a subrequest budget. In
     * that state `erased_at` is still null, so without this column the row is
     * indistinguishable from an untouched pending request — and the product
     * would go on telling the player "nothing has changed, you're still in
     * your squads" while other people had already been promoted into the
     * places they had lost, and would let them "cancel" into an account that
     * is out of its squads with no erasure left to finish it.
     *
     * Kept, never cleared: what it records is that irreversible work happened.
     */
    erasureStartedAt: integer("erasure_started_at", { mode: "timestamp_ms" }),
    /**
     * When the erasure last entered the blocked state — the player is the last
     * active organiser of a game, so it cannot run (§6).
     *
     * A *separate* column from `erasure_started_at`, and deliberately so: the
     * two say different things and cancel treats them oppositely. A blocked
     * erasure has usually written nothing, and its owner must still be able to
     * cancel; a started one has, and must not. Conflating them would either
     * strand a blocked player with no way out or let a half-erased one cancel.
     *
     * Its job is to make the `player.erasure_blocked` audit row a record of a
     * *transition* rather than one row per hourly retry, forever. Cleared when
     * a later run gets past the pre-check, so a second block after a handover
     * and a re-block is recorded again.
     */
    erasureBlockedAt: integer("erasure_blocked_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
  },
  (t) => [
    uniqueIndex("players_email_unique").on(t.email).where(sql`${t.email} is not null`),
    // Partial, like the one above: most players never sign in and this column
    // stays null. It is what stops two concurrent first sign-ins by one
    // identity minting two Players — nothing else can, since D1 has no
    // interactive transactions (migration 0005, TR-30).
    uniqueIndex("players_auth_user_id_unique")
      .on(t.authUserId)
      .where(sql`${t.authUserId} is not null`),
  ],
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
  // M8. Whether players may see who else is playing (BR-33). Default on:
  // the fixture page has listed the squad since M2, so defaulting off would
  // silently remove a capability players already have.
  squadVisibleToPlayers: integer("squad_visible_to_players", { mode: "boolean" })
    .notNull()
    .default(true),
  /**
   * What this game calls its two sides (BR-35, M9). Game-level, not
   * per-fixture: a game that plays Bibs against Skins plays it every week, and
   * a per-fixture override is a field nobody would use twice.
   */
  teamAName: text("team_a_name").notNull().default("Team A"),
  teamBName: text("team_b_name").notNull().default("Team B"),
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
    /**
     * When the teams were last announced (BR-35, M9), or null if never.
     *
     * Publishing sets it and **nothing ever clears it**, so it answers exactly
     * one question — "has an announcement ever gone out?" — and keeps
     * answering it after the pick moves on. Whether the announcement is still
     * *current* is the separate question `teamsSavedAt` answers; an earlier
     * version of this milestone overloaded this one column with both, which
     * left a re-saved pick indistinguishable from one nobody had ever
     * published.
     */
    teamsPublishedAt: integer("teams_published_at", { mode: "timestamp_ms" }),
    /**
     * When the pick was last saved (BR-35, M9), or null if never.
     *
     * Set on every save, including one that changes nothing: the save route
     * cannot tell a re-save from a real change without comparing every row,
     * and a pick wrongly believed to be still-announced is the failure that
     * matters. `teamsSavedAt > teamsPublishedAt` is therefore the durable form
     * of "the organiser has changed the teams and not told anyone".
     */
    teamsSavedAt: integer("teams_saved_at", { mode: "timestamp_ms" }),
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
    /**
     * Which side this player is on for this fixture (BR-35, M9). Null until an
     * organiser picks teams.
     *
     * On `responses` rather than a table of its own because this row already
     * *is* the (fixture, player) pair an assignment hangs off — guests
     * included, since `addGuest` writes one — and an assignment should die
     * with the response it belongs to.
     *
     * **Deliberately not cleared when a player leaves.** A row whose `team` is
     * set but whose `status` is no longer `in` is the only signal that the
     * published teams no longer match the squad (spec §3.1). Clearing it here,
     * or in `withdrawMember`, deletes that signal.
     *
     * The one thing that does clear it is the organiser's next save, which
     * nulls `team` on every row that is not currently `in` — the deliberate
     * re-pick acknowledging the churn. Nothing else can: the picker never
     * renders a departed player, so no submitted form ever names them.
     */
    team: text("team", { enum: ["a", "b"] }),
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
    channel: text("channel", { enum: ["email", "push"] }).notNull().default("email"),
    status: text("status", { enum: NOTIFICATION_STATUSES }).notNull().default("queued"),
    providerMessageId: text("provider_message_id"),
    sentAt: integer("sent_at", { mode: "timestamp_ms" }),
    error: text("error"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
  },
  (t) => [uniqueIndex("notification_log_dedupe_key_unique").on(t.dedupeKey)],
);

/**
 * One registered device (M14, spec §9.1). A player may have several.
 *
 * `endpoint` is unique because a device that re-subscribes produces the same
 * endpoint URL, so registration is an upsert. Without the constraint a player
 * who taps the button twice gets every notification twice and nothing here
 * would reveal it.
 *
 * `p256dh` and `auth` are the device's public key and the shared secret that
 * the payload encryption in `src/notify/web-push.ts` needs. They are not
 * credentials for this system — they are useless without the endpoint — but
 * they are per-device secrets and are deleted with the player (§12).
 */
export const pushSubscriptions = sqliteTable(
  "push_subscriptions",
  {
    id: text("id").primaryKey(),
    playerId: text("player_id").notNull().references(() => players.id),
    endpoint: text("endpoint").notNull(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    /** Only so a player can tell one device from another in a list. */
    userAgent: text("user_agent"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
    lastSuccessAt: integer("last_success_at", { mode: "timestamp_ms" }),
    lastFailureAt: integer("last_failure_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    uniqueIndex("push_subscriptions_endpoint_unique").on(t.endpoint),
    index("push_subscriptions_player_idx").on(t.playerId),
  ],
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

/**
 * `@better-auth/passkey`'s own table (M5 Task 8).
 *
 * Third-party-defined in exactly the sense the block comment above describes:
 * every column name and nullability below is copied from the plugin's
 * `schema` object in `@better-auth/passkey@1.6.26`
 * (`node_modules/@better-auth/passkey/dist/index.mjs`, `//#region src/schema.ts`),
 * whose model name is the singular `passkey` — so this export must keep that
 * exact name, because `drizzleAdapter()` resolves the table off
 * `db._.fullSchema["passkey"]`. The two `index: true` fields upstream
 * (`userId`, `credentialID`) become the two indexes below.
 *
 * `credentialID` is **not** unique here, matching upstream: the plugin looks a
 * credential up with a plain `findOne` and de-duplication is WebAuthn's job
 * (the browser refuses to register a credential already in
 * `excludeCredentials`). Adding a uniqueness constraint the library does not
 * expect would turn a benign duplicate into a 500.
 *
 * No password column, and nothing here is a shared secret: `publicKey` is a
 * public key. The private half never leaves the authenticator, which is the
 * whole reason this is a safe thing to store (TR-16).
 */
export const passkey = sqliteTable(
  "passkey",
  {
    id: text("id").primaryKey(),
    name: text("name"),
    publicKey: text("publicKey").notNull(),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    credentialID: text("credentialID").notNull(),
    counter: integer("counter").notNull(),
    deviceType: text("deviceType").notNull(),
    backedUp: integer("backedUp", { mode: "boolean" }).notNull(),
    transports: text("transports"),
    createdAt: integer("createdAt", { mode: "timestamp_ms" }),
    aaguid: text("aaguid"),
  },
  (t) => [
    index("passkey_userId_idx").on(t.userId),
    index("passkey_credentialID_idx").on(t.credentialID),
  ],
);

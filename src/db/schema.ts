import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } from "../domain/audit.js";
import { INITIAL_LIFECYCLE, LIFECYCLES } from "../domain/lifecycle.js";
import { INITIAL_PICKER_MODE, PICKER_MODES } from "../domain/picker.js";
import { RESULT_OUTCOMES } from "../domain/result.js";
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
     * When the player dismissed the dashboard's "Get set up" onboarding card
     * (M19). Stamped by `POST /app/onboarding/dismiss`, never cleared: like
     * `pushOfferedAt`, the card is a one-time nudge and `/app/account` and
     * `/app/passkeys` remain the permanent routes to everything it linked to.
     */
    onboardingDismissedAt: integer("onboarding_dismissed_at", { mode: "timestamp_ms" }),
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
    /**
     * The last time this player loaded a page carrying their session (M33).
     *
     * Stamped by `POST /app/presence`, which every session-bearing page pings
     * once per tab, and only when the stored value is over an hour old — so a
     * player who lives in the app costs one write an hour, not one per page.
     *
     * Null for the many players who never sign in at all: most of this product
     * is reachable from a mailed link, and a squad full of nulls here is the
     * normal state, not a fault. The organiser's squad list reads this
     * *together with* the player's own newest answer in that game, because
     * answering from a link is being seen and does not touch this column.
     */
    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }),
    /**
     * The last such page load that was running as an installed app (M33).
     *
     * Non-null means "we have seen this person in the installed app"; null
     * means we never have, which is not the same as "not installed" — a
     * player who installed it and has not opened it since the column existed
     * reads as null. **An uninstall is never observed at all**: nothing tells
     * a server that an app was removed, so this stamp only ever goes forwards
     * and the squad list says "not installed" about an absence of evidence.
     */
    lastStandaloneAt: integer("last_standalone_at", { mode: "timestamp_ms" }),
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
  /**
   * How long after full time the "how did it go?" prompt (N-12) may first go
   * out. Zero — the default — is the pre-M26 behaviour: the first sweep run
   * after the whistle. `RESULT_NUDGE_WINDOW_MS` still bounds how late it may
   * be sent, measured from this offset rather than from full time.
   */
  resultPromptOffsetHours: integer("result_prompt_offset_hours").notNull().default(0),
  /**
   * M34, BR-39. Whether this Game asks its squad in priority order rather than
   * all at once. Off by default, so every Game that existed before this
   * milestone behaves exactly as it did.
   *
   * Read live from `games`, never snapshotted onto `fixtures`: a switch is
   * not history, so an owner's toggle must apply to fixtures that already
   * exist, not just ones materialised after the change.
   */
  gatedInvitesEnabled: integer("gated_invites_enabled", { mode: "boolean" }).notNull().default(false),
  /**
   * How many hours before kickoff the fallback release starts (BR-44), or null
   * for never.
   *
   * Nullable rather than a sentinel integer: "never" is a real choice an owner
   * makes — release only on a decline — and a magic 0 or -1 is the kind of
   * value a later reader mistakes for "at kickoff".
   */
  gatedFallbackHoursBefore: integer("gated_fallback_hours_before"),
  inviteToken: text("invite_token").notNull(),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
}, (t) => [uniqueIndex("games_invite_token_unique").on(t.inviteToken)]);

/**
 * Per-game notification switches, one row per (game, type, channel) (M37).
 *
 * **No row means on.** The owner form upserts a row for every cell it
 * renders, so a missing row means the game predates M37 or the type is newer
 * than the game's last save — both must behave as the product did before.
 *
 * `notification_type` and `channel` are bare `text NOT NULL` with no CHECK, so
 * a row can hold a string this build has never heard of. Readers drop such
 * rows rather than index `NOTIFICATION_CONTROLS` with them — the failure
 * class `test/stored-lookups.test.ts` exists for.
 *
 * Deliberately not `text(..., { enum })`: the enum is a type-level claim, and
 * the reader must be written as though it is not there.
 */
export const gameNotificationSettings = sqliteTable(
  "game_notification_settings",
  {
    gameId: text("game_id")
      .notNull()
      .references(() => games.id, { onDelete: "cascade" }),
    notificationType: text("notification_type").notNull(),
    channel: text("channel").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
  },
  (table) => [primaryKey({ columns: [table.gameId, table.notificationType, table.channel] })],
);

/**
 * One rung of a Game's invite order (BR-38, M34).
 *
 * **The index on (game_id, position) is deliberately not unique.** Reordering
 * rewrites every row's position in one `db.batch()`, and SQLite checks a unique
 * index per statement — a batch that swaps positions 1 and 2 would fail on its
 * first statement, with no way to defer the check. Order is therefore
 * `ORDER BY position, created_at`, and a duplicated position is a display-order
 * tie rather than a write that cannot happen.
 *
 * There is no row for the implicit final tier. It is every active member with a
 * null `memberships.invite_tier_id`, which is what makes a player who joins
 * next week reachable that same day with no owner action.
 */
export const inviteTiers = sqliteTable(
  "invite_tiers",
  {
    id: text("id").primaryKey(),
    gameId: text("game_id").notNull().references(() => games.id),
    name: text("name").notNull(),
    position: integer("position").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
  },
  (t) => [index("invite_tiers_game_position_idx").on(t.gameId, t.position)],
);

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
    /**
     * The player's own auto-decline switch (M28) and its expiry. Non-null
     * `mutedAt` means the switch is on; `mutedUntil` null beside it means
     * indefinitely. `src/domain/mute.ts` holds the predicate that reads them
     * and the reasoning for why the pair is shaped this way.
     *
     * On `memberships` rather than `players` because a mute is about one
     * squad, and because "apply to all my games" is a snapshot of the
     * memberships held at that moment, not a standing preference that would
     * also silence a Game joined later.
     */
    mutedAt: integer("muted_at", { mode: "timestamp_ms" }),
    mutedUntil: integer("muted_until", { mode: "timestamp_ms" }),
    /**
     * Which rung of the Game's invite order this member sits on (BR-38), or
     * null for the implicit final tier.
     *
     * On `memberships` rather than a join table because
     * `UNIQUE (game_id, player_id)` one line down already enforces "one tier
     * per player per Game" for free. Deleting a tier nulls this column,
     * dropping its members to the implicit tier rather than orphaning them.
     *
     * SQLite cannot cheaply express "the referenced tier belongs to *this*
     * Game". The write path scopes every tier lookup by `game_id`, and
     * `test/routes/invite-order.test.ts` pins it.
     */
    inviteTierId: text("invite_tier_id").references(() => inviteTiers.id),
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
    /**
     * Who besides the organiser may pick this fixture's teams (M29).
     *
     * `src/domain/picker.ts` holds the three modes and every predicate that
     * reads them, including why a `delegate` row with no `teamPickerPlayerId`
     * is read as `organiser` rather than trusted.
     */
    pickerMode: text("picker_mode", { enum: PICKER_MODES }).notNull().default(INITIAL_PICKER_MODE),
    /**
     * The delegate, when `pickerMode` is `delegate`; null in the other two
     * modes.
     *
     * **Not cleared when the delegate leaves the squad.** Entitlement re-reads
     * their membership on every request, so a departed delegate stops passing
     * the moment they are removed, without a sweep over every future fixture
     * to chase the pointer. The organiser's page renders the name through the
     * same active-membership join, so the control shows nobody rather than a
     * ghost.
     */
    teamPickerPlayerId: text("team_picker_player_id").references(() => players.id),
    /**
     * When the current delegation was made, or null in the other two modes.
     *
     * Exists for the N-13 dedupe key. Keyed on the fixture and the delegate
     * alone, an organiser who delegated to Ali, changed their mind, and
     * delegated back to Ali would send nothing the second time and Ali would
     * never learn the job was theirs again. Also what the organiser's page
     * shows as "handed over on ...".
     */
    teamPickerSetAt: integer("team_picker_set_at", { mode: "timestamp_ms" }),
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
    /**
     * When this player was invited to this fixture (BR-41, M34), or null if
     * they have not been. Null forever, and never read, for an ungated Game.
     *
     * **Nothing ever clears it.** Releasing a tier is one-way, and this column
     * is the durable record of what has gone out — which is what lets the
     * release rule be derived from current state with no event log, and what
     * makes a second reconcile a no-op.
     */
    invitedAt: integer("invited_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
  },
  (t) => [
    uniqueIndex("responses_fixture_player_unique").on(t.fixtureId, t.playerId),
    index("responses_fixture_status_idx").on(t.fixtureId, t.status),
    index("responses_player_idx").on(t.playerId),
  ],
);

/**
 * One player's claim about what happened in a played fixture (BR-37, M25).
 *
 * **One row per (fixture, player), and that is the whole voting model.** There
 * is no separate table of candidate results and no table of votes: a candidate
 * *is* a `GROUP BY` over these rows, so a candidate with nobody behind it
 * cannot exist and there is no id for a vote to dangle from. Agreeing with
 * somebody copies their values into your own row; changing your mind updates
 * it in place.
 *
 * The unique index is what makes "one player, one endorsement" a property of
 * the database rather than a rule every write path has to remember — the same
 * move `responses_fixture_player_unique` makes one table up.
 *
 * **The flip history lives in `audit_log`**, which already carries
 * `before_json`/`after_json`. A `superseded_at` column here would put a filter
 * on every read that somebody eventually forgets.
 */
export const fixtureResultClaims = sqliteTable(
  "fixture_result_claims",
  {
    id: text("id").primaryKey(),
    fixtureId: text("fixture_id").notNull().references(() => fixtures.id),
    playerId: text("player_id").notNull().references(() => players.id),
    /**
     * Present on every claim, including a scored one, so the outcome tally is
     * a single `GROUP BY` rather than a `CASE` over two nullable integers.
     *
     * A stored value indexing a lookup, in a bare `text NOT NULL` with no
     * CHECK constraint — the same shape as `fixtures.lifecycle` and
     * `responses.team`, both of which have 500'd a page by arriving as a value
     * the TypeScript type said was impossible. Enumerated in
     * `test/stored-lookups.test.ts`.
     *
     * **Derived from the score whenever one is given** (`parseClaim` in
     * `src/domain/result.ts`), never taken from the form. A row saying
     * "3-2, draw" would count toward an outcome its own score contradicts,
     * and nothing in SQLite would catch it.
     */
    outcome: text("outcome", { enum: RESULT_OUTCOMES }).notNull(),
    /** Both null (outcome-only) or both set. Enforced by `parseClaim`. */
    scoreA: integer("score_a"),
    scoreB: integer("score_b"),
    /**
     * When this player took *this* position — moved forward when they change
     * it, not left at row birth.
     *
     * It exists to answer one question, the last tie-break in
     * `deriveResult`: how long has this candidate been standing? A player who
     * switched from 3-2 to 4-2 this morning has not been backing 4-2 since
     * Thursday, and `created_at` would say they had.
     */
    filedAt: integer("filed_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
  },
  (t) => [uniqueIndex("fixture_result_claims_fixture_player_unique").on(t.fixtureId, t.playerId)],
);

/**
 * The derived result of a fixture, materialised once at the instant it froze
 * (BR-37, M25).
 *
 * **This is a cache, and the design depends on that staying true.** Every page
 * and every refusal reads `deriveResult` over the claims; nothing reads this
 * table to decide anything. A sweep run that fails, or a deploy that never
 * runs one, costs a row the next run writes — not a fixture stuck in a wrong
 * state with nothing to notice it.
 *
 * It exists for exactly one reason: a purely derived result is a function
 * evaluated at read time, so changing the tie-break rule — or fixing a bug in
 * it — would silently rewrite last season's results underneath anything fitted
 * on them, with no row edited and no test failing.
 * `test/sweep/result-cache.test.ts` asserts a stored row still equals the
 * derivation, which is what makes "only a cache" true rather than aspirational.
 */
export const fixtureResults = sqliteTable("fixture_results", {
  fixtureId: text("fixture_id").primaryKey().references(() => fixtures.id),
  outcome: text("outcome", { enum: RESULT_OUTCOMES }).notNull(),
  /** Null means "outcome agreed, score not" — a legitimate, recordable state. */
  scoreA: integer("score_a"),
  scoreB: integer("score_b"),
  outcomeBackers: integer("outcome_backers").notNull(),
  marginBackers: integer("margin_backers").notNull(),
  voterCount: integer("voter_count").notNull(),
  /** The turnout denominator: the electorate's size at lock. */
  eligibleCount: integer("eligible_count").notNull(),
  distinctOutcomes: integer("distinct_outcomes").notNull(),
  distinctScores: integer("distinct_scores").notNull(),
  /** Whether the fixture had published teams for a roster join to reach. */
  rostered: integer("rostered", { mode: "boolean" }).notNull(),
  /**
   * `announcementOutstanding` inverted, evaluated at lock. Spec §12: this is
   * derivable forever from frozen rows, and is cached here only so that a
   * future change to that predicate cannot rewrite history.
   */
  teamsAccurate: integer("teams_accurate", { mode: "boolean" }).notNull(),
  lockedAt: integer("locked_at", { mode: "timestamp_ms" }).notNull(),
  materialisedAt: integer("materialised_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
});

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
 * they are per-device secrets. Every row for a player is deleted the moment
 * their erasure gets past its pre-check (`erasePlayer`,
 * `src/domain/erase-player.ts`) — first among the irreversible writes there,
 * ahead of anything that could fail, so a run that stops half-done still
 * cannot leave a live endpoint behind (§12).
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
    /**
     * A caption the player typed at subscribe time ("Ed's phone"). Null for
     * every device registered before this column existed — the list falls
     * back to `user_agent` for those, so the fallback must survive.
     */
    name: text("name"),
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

/**
 * Addresses allowed to request a sign-in link without holding an invite (M16).
 *
 * The union partner of the `SIGNIN_ALLOWLIST` secret, not its replacement:
 * the secret survives a database wipe and keeps the operator able to sign in;
 * this table holds everyone added from the admin screen. Emails are stored
 * already folded by `foldAsciiCase` (ASCII case only — see `sign-in-gate.ts`
 * for why not `toLowerCase()`), so lookups are plain equality.
 */
export const signupAllowlist = sqliteTable("signup_allowlist", {
  email: text("email").primaryKey(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
});

/**
 * Addresses the sign-in gate refused a magic link (M17): what the admin
 * sign-in doctor shows as "who knocked and was turned away". Written from the
 * refused branch of `sendMagicLink` only — a permitted request never lands
 * here. `email` is attacker-typed and unbounded in who can write it, so the
 * table is pruned to the newest `REFUSAL_ROWS_KEPT` on every insert (see
 * `recordSignInRefusal`) and every render of it escapes.
 */
export const signinRefusals = sqliteTable(
  "signin_refusals",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
  },
  (t) => [index("signin_refusals_created_idx").on(t.createdAt)],
);

export const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("emailVerified", { mode: "boolean" }).notNull(),
  image: text("image"),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp_ms" }).notNull(),
  // App-owned, not Better Auth's: never declared to the adapter, so Better
  // Auth's inserts omit it and the default keeps them valid. Snake_case
  // because only our own code reads it. Set manually via SQL (M16) — there is
  // deliberately no promote/demote UI, so a wiped database has no admin until
  // the operator flips this bit.
  isAdmin: integer("is_admin", { mode: "boolean" }).notNull().default(false),
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

/**
 * App-wide operator settings, as one key/value row each (M30).
 *
 * A key/value table rather than a one-row settings table with a column per
 * setting: adding the next operator switch is an insert, not a migration, and
 * a missing row is the natural "not configured" that every reader here has to
 * handle anyway.
 *
 * `value` is a bare `text NOT NULL` with no CHECK constraint, so — like every
 * other stored lookup in this schema — the string in a row is whatever was
 * written there, not what this build expects. Readers must treat an
 * unrecognised value as the safe default rather than indexing a table with it;
 * `isOpenSignups` in `src/domain/app-settings.ts` is the pattern.
 */
export const appSettings = sqliteTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
});

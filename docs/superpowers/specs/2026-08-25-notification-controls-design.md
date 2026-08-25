# Notification controls — design

**Milestone:** M37
**Date:** 25 August 2026
**Status:** approved design, implementation plan not yet written

## 1. What this is

Two levels of control over which notifications the product sends, on which channel.

A **game owner** gets a per-game switch for each automated notification that concerns their
game, separately for email and for push. An **administrator** gets one global switch per
notification and channel that applies to every game and that an owner cannot override.

The two combine as `effective = admin AND owner`. An owner whose channel has been switched off
by an administrator sees the control unchecked and disabled, with a sentence saying why and
saying that their own setting is kept.

### Why

Six per-game switches exist already, as named boolean columns on `games`
(`src/db/schema.ts:181-203`): `reminder_enabled`, `short_warning_enabled`, `group_nudge_enabled`,
`result_prompt_enabled`, `teams_published_email_enabled`, `team_picker_email_enabled`. They cover
under half the catalogue, none of them separates email from push, and every one of them is a
schema migration plus a hand-written form field (`src/views/game-form.ts:270-320`) plus a
parser entry (`src/domain/game-form.ts:74-79`) plus a bespoke read at one enforcement site.

There is no administrator layer at all. An operator who wants to stop one kind of message going
out across the whole site — because it is noisy, because it is burning the daily email ceiling,
or because it is wrong — has no way to do it short of a deploy.

## 2. Scope

The catalogue is `NOTIFICATION_TYPES` in `src/notify/dedupe-key.ts:15` — `n1`…`n13`. Each type
falls into exactly one of three groups.

### Owner-controllable (6)

Owner and administrator both have a say; `effective = admin AND owner`.

| Type | What it is | Channels |
|---|---|---|
| `n1` | Fixture reminder | email, push |
| `n4` | Fixture short or uneven — warns the owner | email, push |
| `n9` | Teams published | email, push |
| `n11` | Group-chat nudge | push only |
| `n12` | "How did it go?" | email, push |
| `n13` | Team pick handed over | email, push |

`n11` has no email leg and is not getting one. That was a deliberate choice with its reasoning
recorded at `src/sweep/group-nudge.ts:47` — an email saying "go and open WhatsApp" is noise next
to the N-1 the organiser already receives as a player, at the same instant. Reviewed and upheld
during this design.

### Administrator only (3)

No per-game setting; `effective = admin`.

| Type | Why there is no per-game setting |
|---|---|
| `n6` | Welcome / squad joined — fires on squad membership, not on a game |
| `n7` | Removed from a squad — fires on squad membership, not on a game |
| `n10` | Organiser broadcast — owner-initiated, and the owner already picks channels per send |

`n10` is different in kind from the other two: switching a channel off there removes that channel
from the broadcast form rather than suppressing an automated send. See §6.

### Never switchable (4)

Absent from the settings model **by construction**, so there is no control anywhere and no code
path that could disable them.

| Type | Why |
|---|---|
| `n2` | Promoted from the waitlist — a player moved into the team who is never told turns up to nothing, or does not turn up at all |
| `n3` | Fixture cancelled — the squad turns up to a game that is off |
| `n5` | Sign-in magic link — switching it off locks every player out of the product with no way back in |
| `n8` | Erasure scheduled — the confirmation of a data-erasure request |

They appear in the administrator's grid as a read-only third band with no controls, so that
"why can I not switch off the sign-in email?" is answered on the page rather than in the source.

## 3. Data model

### The catalogue becomes typed data

New module `src/notify/notification-controls.ts`:

```ts
export type ControlScope = "owner" | "admin" | "none";
export interface Control { scope: ControlScope; channels: Channel[] }
export const NOTIFICATION_CONTROLS: Record<NotificationType, Control> = { … };
```

A `Record` over the `NotificationType` union, not a partial map. Adding `n14` to
`NOTIFICATION_TYPES` is then a typecheck error until somebody says what it is — the same
discipline the `notification_type` column enum already buys.

`channels` lists only the legs that exist in code, so `n11` is `["push"]` and no email control is
ever rendered for a message that has no email version. `scope: "none"` types carry an empty
`channels` array and are never passed to the resolver.

### Per-game settings

```sql
create table game_notification_settings (
  game_id            text    not null references games(id) on delete cascade,
  notification_type  text    not null,
  channel            text    not null,
  enabled            integer not null,
  updated_at         integer not null,
  primary key (game_id, notification_type, channel)
);
```

**No row means the default, which is on.** The owner form upserts a row for every switch it
renders, so in practice a missing row means the game predates this milestone, or the notification
type is newer than the game's last save. Both must behave exactly as the product does today.

`notification_type` and `channel` are bare `text NOT NULL` with no CHECK constraint, so a row can
hold a string this build has never heard of. The reader **drops unrecognised rows** rather than
using them to index `NOTIFICATION_CONTROLS`. This is the failure class CLAUDE.md records as having
shipped six times in one milestone; both columns go into `test/stored-lookups.test.ts`.

### Administrator settings

Rows in the existing `app_settings` table under keys `notify.<type>.<channel>`, e.g.
`notify.n9.email`.

The reader lives in `src/domain/app-settings.ts` alongside `isOpenSignups`, and **points the
opposite way**: the exact string `"off"` means off, and everything else — a missing row, an
unrecognised value written by a later build — means **on**.

This inversion is deliberate and must carry a comment saying so. `isOpenSignups`
(`src/domain/app-settings.ts:26`) fails *closed* because it guards sign-in, where the safe
direction is "refuse". Here the safe direction is the opposite: a missing row means nobody has
ever touched the setting, and defaulting that to off would mean deploying the migration silently
stops every notification in the product. Two readers, one table, opposite safe directions, each
saying why.

## 4. Migration

One migration: create the table, backfill, drop the six columns. Dropping them in the same
migration is safe because the resolver replaces every read of them in the same release; the
backfilled rows carry the data forward, so nothing is lost by the drop.

The backfill is **not uniform**, and getting it wrong sends or silences real messages.

| Existing column | Backfills to (only where currently `false`) |
|---|---|
| `reminder_enabled` | `(n1, email)` **and** `(n1, push)` |
| `short_warning_enabled` | `(n4, email)` **and** `(n4, push)` |
| `result_prompt_enabled` | `(n12, email)` **and** `(n12, push)` |
| `group_nudge_enabled` | `(n11, push)` only |
| `teams_published_email_enabled` | `(n9, email)` only |
| `team_picker_email_enabled` | `(n13, email)` only |

The first three gate the whole notification today — the send path skips before either leg is
built — so they must carry across to both channels.

The last two are email-only in name **and in behaviour**: `n9`'s and `n13`'s push legs are
ungated right now (`src/notify/send-teams.ts:238`, `src/notify/send-picker-handover.ts:137`).
Backfilling those to both channels would silently switch off pushes that are being delivered
today, to owners who never asked for that. This is the single highest-risk line in the milestone
and it gets an explicit negative test (§7).

Rows are written only where the existing value is `false`; a game with everything on gets no rows
and resolves to on by absence.

## 5. The resolver

New module `src/notify/notification-settings.ts`:

```ts
loadNotificationSettings(db, gameIds: string[]): Promise<EffectiveSettings>
EffectiveSettings.isEnabled(gameId, type: NotificationType, channel: Channel): boolean
```

`loadNotificationSettings` performs **exactly two queries regardless of how many games are
passed** — one over `app_settings`, one over `game_notification_settings` filtered by
`inArray(gameIds)`. `isEnabled` does no I/O.

That shape is forced by the sweep. `src/sweep/open-and-remind.ts` walks every due fixture on
every hourly tick and currently reads `reminder_enabled` inline in its existing join
(`src/sweep/open-and-remind.ts:262`); a resolver that touched the database per fixture would be
an N+1 on the hottest path in the product.

Resolution:

- `scope: "owner"` — `admin AND owner`, each defaulting to on when absent
- `scope: "admin"` — `admin` alone
- `scope: "none"` — never asked; those send paths do not call the resolver at all
- a `channel` not listed in the type's `channels` — never asked. The send paths are written
  against the catalogue, so this cannot arise from correct code; there is no runtime branch for
  it, and no test can prove its absence at every future call site. Reviewers should treat a call
  site that asks about a channel its type does not declare as a defect.

### Why the check is at the send path, not in a notifier decorator

A `Notifier` decorator is the tempting shape — it is what `QuotaNotifier` does, and one choke
point is harder to forget than nine call sites. It does not work here, for two independent
reasons.

A `Message` carries only `to` and `dedupeKey` (`src/notify/notifier.ts`). It has no game id, so a
decorator could not resolve the setting even in principle.

And a decorator runs *after* `insertQueuedLogRows`. A message filtered there would leave a
`queued` row in `notification_log` that never sends and never retries — indistinguishable from
the crash-between-insert-and-send case that BR-19 deliberately leaves lost-not-duplicated. The
decision must happen before the row is reserved.

## 6. Enforcement sites

| Type | Gate today | Becomes |
|---|---|---|
| `n1` | `src/sweep/open-and-remind.ts:336` skips the fixture | email leg only if email on; push leg (`src/notify/reminder-messages.ts:101`) only if push on; skip the fixture only when both are off |
| `n4` | `src/sweep/attention.ts:206` skips the row | same split; push leg at `src/sweep/attention.ts:313` |
| `n9` | `src/routes/games.ts:2260` | same split; push leg at `src/notify/send-teams.ts:238` |
| `n11` | `src/sweep/group-nudge.ts:74` | unchanged in shape — one channel, one check |
| `n12` | `src/notify/send-result-nudge.ts:123` | see below |
| `n13` | `src/routes/games.ts:1985` | same split; push leg at `src/notify/send-picker-handover.ts:137` |
| `n6` | none | single admin check in `src/notify/send-welcome.ts` |
| `n7` | none | single admin check in `src/notify/send-removed.ts` |
| `n10` | none | see below |

### `n12` — a disabled channel is never used, including as a fallback

`n12` is push-preferred with email as fallback, one channel per player, and the reasoning for
that direction is at `src/notify/send-result-nudge.ts:79`: the daily send ceiling is email-only,
so spending it on the result prompt is the wrong trade.

The rule becomes: push if push is enabled **and** the player has a registered device; otherwise
email if email is enabled; otherwise nothing.

The trap is that last branch. Today "otherwise nothing" means *no usable email address and no
registered device*, and it increments a BR-32 counter whose whole purpose is to tell an operator
about genuinely unreachable players. A player who is perfectly reachable but whose owner switched
both channels off must **not** land in that counter, or the one signal that surfaces unreachable
players fills with noise. It needs a distinct outcome.

### `n10` — the administrator controls what the form offers

Switching `n10` email off removes the email option from the broadcast form. Both the form
renderer and the POST handler consult the administrator layer, and **the handler must refuse an
email broadcast even though the checkbox was never rendered**. Hiding a control is not
enforcement; TR-18's rule is that entitlement is re-asked per handler, and a refusal is a 404.

## 7. Testing

### Task zero — before any feature work

Three global invariants, each an enumerating test driven off `NOTIFICATION_CONTROLS` rather than
a hand-written list, so that adding a notification type fails the test until the work exists.

1. **Every owner-scoped cell is enforced.** For each `(type, channel)` with owner scope: seed a
   game with that one cell off, run the send path, assert nothing goes out on that channel *while
   the other channel still does*.
2. **The administrator layer masks, never overwrites.** For each cell: admin off means nothing
   sends whatever the owner's row says; and after an administrator toggles off and back on, the
   owner's stored row is byte-identical to what it was before.
3. **A disabled checkbox posts nothing, and that is not a choice.** Submit the owner form while
   the administrator has `n9` email off and the owner's stored value is `true`; assert the stored
   row is still `true` afterwards. Without this, an owner's first save silently writes `false`
   into every administrator-disabled cell, which surfaces as settings nobody chose the moment the
   administrator re-enables the channel.

### Defect-class guards, shipping in the same round

- `game_notification_settings.notification_type` and `.channel` added to
  `test/stored-lookups.test.ts`.
- The new CSS registered in `STYLE_BLOCKS` (`src/views/styles.ts`), which is what
  `src/security/csp.ts:143` hashes for `style-src` — an unregistered block is dropped by the
  browser in production with every test green.
- The channel-column rules style the same elements as the existing `.switch-row input` and
  `.switch-row label` rules through *different* selectors at equal specificity — the collision
  `test/views/style-cascade.test.ts` structurally cannot see. It needs its own test, in the shape
  `test/views/remove-member.test.ts` already uses.

### Migration fidelity

Its own test, and the assertion that matters is the negative one: a game with
`teams_published_email_enabled = false` ends up with `(n9, email)` off and `(n9, push)` **on**.

### Site-specific

- An `n12` player who is reachable but whose owner switched both channels off is not counted in
  the BR-32 unreachable counter.
- A POST to the broadcast handler asking for email while the administrator has `n10` email off is
  refused server-side.

### Rendered page

The owner form is captured and the PNG read **inside the task that changes it**. A six-row,
two-column matrix with a disabled cell and a per-row note is exactly what string assertions
cannot see: the design mockup's channel cells were misaligned by a `grid-row` span that stopped
holding as soon as a row carried a third child, and no string assertion would have caught it.
The fix is to wrap label-and-hint in a single grid child so the channel cells align regardless of
what else a row carries — to be confirmed against a capture, not by reasoning.

Both new screens are added to the browser suite, following the M34 precedent.

## 8. User interface

### Owner — the Notifications fieldset

Six rows by two channel columns, with a header row naming the channels. Per-notification timing
fields (days before, hours after full time) stay as they are, spanning the full row width.

A cell disabled by the administrator renders unchecked **and** disabled, with a note in the row:

> Email is switched off for everyone by the site administrator. Your own setting is kept and
> comes back if they turn it on again.

That sentence is load-bearing. Because the administrator layer masks rather than overwrites,
"unchecked" means two different things, and without the note an owner reasonably concludes their
own setting was wiped.

A channel a notification has no version of renders as a dash, not a disabled checkbox — there is
no control implying a message that does not exist.

### Administrator — the global grid

A new page in the admin section, alongside the existing allow-list and usage screens. Three
bands: the six owner-controllable types, the three administrator-only types, and the four
never-switchable types shown read-only with no controls at all.

## 9. Decisions taken, with their reasoning

| Decision | Why |
|---|---|
| Mask, not overwrite | Overwriting cannot distinguish "this owner wanted it off" from "the administrator turned it off", so re-enabling either silently re-sends mail owners had opted out of, or forces every owner to re-tick a box they never unticked |
| Administrator switch is global, never per-game | Matches the request and the existing `open_signups` precedent; a per-game administrator override would be a third level with no stated use |
| Normalised table, not more columns | Twelve-plus hand-named columns spread the matrix across three files and make every future type a migration; the administrator layer needs its own home regardless |
| Normalised table, not a JSON blob | A blob is a stored `text` with no CHECK parsed on the hot path — the exact `undefined`-indexing class that has 500'd pages six times |
| `n2`, `n3`, `n5`, `n8` absent by construction | A control that must never be used is better absent than present-and-disabled |
| `n11` stays push-only | Existing reasoning at `src/sweep/group-nudge.ts:47` reviewed and upheld |
| A new leg would default off | Not exercised — `n11`'s email leg was declined — but recorded: a genuinely new message defaulting to on mails every existing owner something they never asked for on deploy day |

## 10. Out of scope

- Player-level notification preferences. This milestone is owner and administrator only.
- Per-game administrator overrides.
- An email leg for `n11`.
- Any change to `n10`'s per-send channel picker beyond the administrator gate on what it offers.

# M6a — Game setup and invites

**Status:** design, approved 12 August 2026. Implementation plan to follow.

**Parent milestone:** M6 (§2.14, "Owner UI — create/edit game, manage squad,
overrides, guests, invite link and QR"). This document covers **J1 only**. J6 —
owner overrides, guests, squad removal (BR-3), promoting another Owner — is a
second sub-project with its own spec, and the reasoning for the split is in the
first section below.

**Done when:** a signed-in person with no seed data can create a game, share a
link, and have someone they have never met appear in the squad — with four
weeks of fixtures already materialised and the reminder sweep about to pick
them up.

---

## 1. Why M6 is two sub-projects

M6 as written in §2.14 contains four independent subsystems: the game form,
the invite and join flow, owner overrides on a fixture, and squad management.
The first two are J1 and compose into a single demonstrable outcome. The second
two are J6, and one of them — BR-3 removal — is substantial domain work rather
than UI: it writes `withdrawn` (a status nothing in the codebase currently
writes), it must run its own promotion pass because BR-3 operates outside
`setResponse`, and it must clear `memberships.active` or `cancelFixture`'s
entitlement check silently stops meaning what it says (see the row in
`docs/known-issues.md` and `src/domain/cancel-fixture.ts:92`).

Splitting on the J1/J6 seam gives each half a single coherent user outcome and
keeps the BR-3 hazards in a plan that can concentrate on them. J1 first, because
it is what makes "no seed data" true.

**Deliberately out of scope here, and belonging to J6:** removing a squad
member, promoting a member to Owner, owner overrides of a response, one-off
guests, and the BR-8 over-capacity override. `GET /g/:id` lists the squad
read-only, and the removal control arrives in the next sub-project.

---

## 2. Routes

New surface. Everything owner-facing sits under `/g/*`, which TR-34 already
names as session-required; the invite link is the one public addition.

| Route | Guard | Purpose |
|---|---|---|
| `GET /g/new` | `requirePlayer` | The create form |
| `POST /g/new` | `requirePlayer` | Creates Game + owner Membership + 4 weeks of fixtures |
| `GET /g/:id` | `requirePlayer` + owner check in handler | Game overview: settings, squad, invite link + QR, upcoming fixtures |
| `GET /g/:id/edit` | same | Edit form, Advanced section collapsed |
| `POST /g/:id/edit` | same | Saves; propagates to `scheduled` fixtures |
| `POST /g/:id/invite/rotate` | same | Mints a new `invite_token` |
| `GET /j/:token` | none | Public game summary + join form |
| `POST /j/:token` | none | Creates or reuses a Player, creates a Membership, sends N-6 |

`/g/*` is added to `AUTHENTICATED_PREFIX`'s mounts in `src/app.ts`, which brings
both `sessionMiddleware` and the `Cache-Control: private, no-store` header with
it. `/j/*` is mounted outside the session prefix and pays nothing for it, on the
same blast-radius reasoning documented on `sessionMiddleware`.

### 2.1 The owner check is in the handler, not the middleware

TR-18, and the comment block already written at `src/auth/session.ts:160-173`.
`requirePlayer` establishes *who* is asking and stops. Every `/g/:id` handler
must load the game's `memberships` row for `c.get("player")!.id` and confirm
`role = 'owner'` and `active = true` before doing anything else.

A failed check answers **404, not 403**, so a game id cannot be probed for
existence — the same reasoning `findActionableFixture` already applies on the
dashboard. During the trial every signed-in person is allowlisted and trusted,
which is exactly the condition under which this check looks unnecessary and is
most likely to be skipped; it is load-bearing the moment a second squad exists.

### 2.2 Client-side JavaScript

The floor, unchanged and permanent: **a player accepting or declining a fixture
through `/r/:token` works with JavaScript off.** That is design principle 1 and
it is not negotiable by anything in this document.

Above that floor, JS is allowed as progressive enhancement: small inline blocks
in `src/views/scripts.ts`, whose CSP hashes are computed from the source by
`src/security/csp.ts` rather than pasted. No framework, no bundler, no SPA. A
feature may be JS-only if it is convenience — but the page must render and the
underlying information must be reachable without it.

The first and only such feature here is **copy-invite**: a `readonly` input
holding the invite URL renders always and can be selected and copied by hand;
the script upgrades it with a copy button using `navigator.clipboard`. No
`fetch`, so it adds no `connect-src` surface.

---

## 3. Creating and editing a game

### 3.1 The form

`GET /g/new` asks for the eight things J1 names, on one screen:

- Name
- Venue name, venue address
- Day of week, and interval: every week / every 2 weeks
- Kickoff time (local), duration in minutes
- Minimum players, maximum players
- Prefers even numbers (checked by default, BR-28)

Everything else takes its schema default: `timezone` = `Europe/London`,
`reminder_days_before` = 1, `reminder_local_time` = `09:00`,
`short_warning_offset_hours` = 12, `venue_url` = null.

`GET /g/:id/edit` renders the same eight fields plus a collapsed `<details>`
**Advanced** block exposing timezone, venue URL, reminder days-before, reminder
local time, and the short-warning offset. Nothing in `games` is unreachable
through the UI; the ten fields a new organiser has no basis to answer are simply
not the first thing they see.

`recurrence_start_date` is not a form field. On create it is today's local date
in the game's timezone, which makes "every 2 weeks" well-defined from the
moment of creation (§2.8's note on why the anchor exists). On edit it is
preserved unless the day-of-week or interval changes, in which case it is
re-anchored to the current local date so the new pattern starts from now rather
than from a historical anchor that would put the fortnight on the wrong week.

### 3.2 Validation

One pure module, `src/domain/game-form.ts`. It takes the raw parsed body and
returns either a typed value object or a list of `{ field, message }` errors. It
touches no database and no clock beyond an injected `now`, so it can be
exhaustively tested directly, and it is shared by create and edit so the two
cannot drift.

On failure the form re-renders with the submitted values still in their fields
and the errors beside them, HTTP 422. Never a bare 400 — this is a form a human
is filling in.

Rules:

| Rule | Behaviour |
|---|---|
| Name, venue name | Required, trimmed, length-capped |
| `min_players`, `max_players` | Integers, `>= 1`, `min <= max` |
| `duration_minutes` | Integer, `> 0`, capped at a day |
| Kickoff time | Parsed by `parseLocalTime`, never hand-constructed |
| Interval | Exactly 1 or 2 |
| Day of week | One of the seven `BYDAY` codes |
| Timezone | `<select>` from `Intl.supportedValuesOf('timeZone')`, re-validated on submit |

`Intl.supportedValuesOf('timeZone')` was **verified available in workerd** on
12 August 2026 by a probe test under the real pool — it returns the full IANA
list including `Europe/London`. Two consequences: the `<select>` is several
hundred options and perhaps 10KB of markup, which is why it lives in the
collapsed Advanced block on the edit form and not on the create form at all;
and the submit-side check is a membership test against that same list, so the
form and the validator cannot disagree about which zones exist.

| `venue_url` | Optional; must parse as `http(s)` |
| `reminder_local_time` | `parseLocalTime`, as kickoff |
| `reminder_days_before` | Integer, 0–7 |
| `short_warning_offset_hours` | Integer, 1–168 |

Three of these close items currently tracked in `docs/known-issues.md`:

1. **`LocalParts` rollover.** The issue is reachable only by a caller building
   `LocalParts` without going through `parseLocalTime`. Routing every
   form-supplied time through `parseLocalTime` is what keeps it unreachable
   from the one surface that was about to make it reachable. The known-issues
   row is closed by this constraint, not by changing `src/domain/time/zone.ts`.
2. **Rejected timezones re-attempting `Intl.DateTimeFormat` construction.** A
   `<select>` populated from `Intl.supportedValuesOf('timeZone')` means a
   rejected zone is not submittable through the UI at all, so the uncached
   re-attempt cannot be reached at volume. The submit-side re-validation is
   against the same list, and is a single membership test rather than a
   construction attempt. The row is closed on the same "unreachable from the
   form" basis; the underlying negative-caching behaviour is unchanged and
   stays documented.
3. **Odd `max_players` with prefers-even** (spec Part 3, open item 6). A **soft
   warning, not a validation error**: the form accepts it and displays "a squad
   of 13 can never be even — every full fixture will show the uneven flag."
   BR-29 makes parity advisory, so blocking it at creation would be stricter
   than the rule it enforces.

### 3.3 Saving an edit: propagation to scheduled fixtures

§2.8 copies `min_players`, `max_players`, `prefers_even_numbers`,
`short_warning_offset_hours` and `duration_minutes` onto each fixture at
materialisation "so changing the Game later doesn't rewrite history". That is
unambiguous for a `played` fixture and wrong for a `scheduled` one four weeks
out: an owner correcting a kickoff time does not mean "from next month".

**The rule: an edit rewrites every `scheduled` fixture of that game, and never
touches an `open`, `played` or `cancelled` one.** The line is *has anyone been
told about this fixture yet* — `open` means the reminder has been sent (BR-11),
so its terms are already in someone's inbox and are now history in the sense
§2.8 means.

The edit page states the effect before the save, from a live count:

> This will update 4 scheduled fixtures. 1 open fixture is unchanged.

**Mechanism: delete and re-materialise.** Re-deriving kickoff instants moves
rows to new `kicks_off_at` values, which collides with
`UNIQUE (game_id, kicks_off_at)` if done as an in-place update. So the
`scheduled` set is deleted and re-materialised through the existing
`src/domain/materialise.ts` rather than growing a second implementation of
recurrence-to-fixtures. Constraints inherited from that module:

- Inserts chunk at `INSERT_CHUNK_SIZE` (8), per TR-38's bound-parameter limit.
- Materialisation is idempotent via the `(game_id, kicks_off_at)` unique index,
  which is what makes a chunked mid-way failure safe.
- The delete must be scoped to `lifecycle = 'scheduled'` **and** that game id.
  A `scheduled` fixture has no response rows and no `notification_log` rows
  (both are written at open), so nothing references the deleted ids. This is
  the property that makes delete-and-recreate safe here and would not hold for
  an `open` fixture — which is a second, independent reason those are excluded.

The whole edit is one D1 `batch()`: the `games` update, the delete, the chunked
inserts, and the `audit_log` row.

### 3.4 Audit

Every create, edit and invite-rotation writes an `audit_log` row via the
existing `src/db/audit.ts` / `src/domain/audit.ts`: `actor_player_id` is the
signed-in owner, `entity_type` is `game`, `before_json`/`after_json` carry the
changed fields. BR-27.

### 3.5 Creating

`POST /g/new` writes, in one operation: the `games` row with a fresh
`crypto.randomUUID()` `invite_token`; a `memberships` row for the creator with
`role = 'owner'`, `active = true`; four weeks of fixtures via
`materialiseGame`; and the audit row. Then 303 to `GET /g/:id`.

Materialising immediately, rather than leaving it to the next cron run, is what
makes J1's "no further action needed — fixtures generate themselves" true on the
page the owner actually lands on. A game whose fixture list is empty for up to
an hour reads as broken.

---

## 4. The invite link, the QR code, and joining

### 4.1 The link

`https://makethe.team/j/<invite_token>`, built from the `SITE_ORIGIN` constant
in `src/notify/delivery.ts` — the same constant every email link already uses.

The token is `crypto.randomUUID()`, unguessable, unique-indexed. Rotation
(`POST /g/:id/invite/rotate`) overwrites it and audit-logs the change; the
previous link then 404s, which is the escape hatch for a link that has left the
group it was shared with. There is no grace period and no dual-accept — a
rotation the owner performs deliberately should take effect immediately.

### 4.2 The QR code

Rendered **server-side as inline SVG in the page body**, not as an `<img>`.

This is a direct application of the `connect-src` post-mortem. The CSP's
`default-src 'none'` means there is no `img-src` directive, so an image of any
kind — including a `data:` URI — is refused by the browser, by exactly the
mechanism that left both passkey buttons broken for days while every
server-side test passed. Inline SVG is markup rather than a fetch, so it needs
no new directive and cannot regress in that way. Adding `img-src` to serve one
QR code would widen the policy for the whole site to solve a problem that has a
narrower answer.

**Dependency: `uqr`** (MIT, zero runtime dependencies, v0.1.3), which encodes a
string to a matrix we render as SVG rects. The alternative is hand-rolling
Reed–Solomon error correction and QR masking, roughly 400 lines we would own
permanently. Design principle 6 is "prefer the option with fewer moving parts",
and a zero-dependency encoder behind one function call is fewer moving parts
than a bespoke implementation of a spec none of us has read.

### 4.3 The public page

`GET /j/:token` renders, for an unauthenticated stranger:

- Game name, venue name and address
- Day, kickoff time, duration, in the game's timezone
- Min and max players
- Current squad size
- Squad members as **first name plus surname initial** — "Edward C."

BR-26 exactly: never an email address, never a full surname. The redaction is a
single shared helper so the rule has one implementation, and it is tested
against a name with no surname, a name with three parts, and a name that is a
single word.

Then the join form: name, email. Two fields, `method="post"`, no JavaScript.

A token that matches no game, or matches an inactive game, returns the bare 404
— not a page explaining that the link has been rotated, which would confirm the
token was once real.

### 4.4 Joining

`POST /j/:token` resolves to exactly one of four outcomes:

| Situation | Effect | Page |
|---|---|---|
| Email is new | Create Player, create active Membership, send N-6 | "You're in" |
| Email exists, no membership for this game | Reuse the Player, create Membership, send N-6 | "You're in" |
| Email exists, membership already active | No write, no email | "You're already in this squad" |
| Email exists, membership inactive (previously left) | Reactivate: `active = true`, `left_at = null`, new `joined_at`; send N-6 | "Welcome back" |

**One address is one person.** An email that already exists reuses the Player
row and the **stored name wins** — the name typed on the form is discarded. This
means joining a second squad can never rename you in the first, and there is no
unaudited path by which one squad's form input changes how you appear to
another. The cost is that a person who typo'd their own name on first join
cannot correct it here; that belongs to a profile-edit surface (M7's "manage own
contact details", §1.6).

A guest Player cannot collide: guests have `email IS NULL` by definition
(§2.8), and the lookup is by email.

**Spec amendment — the N-6 dedupe key.** §2.8 gives N-6 the key
`n6:<membership_id>` and states "rejoining sends again". Those two statements
contradict each other when a rejoin reuses the membership row, which is what the
`UNIQUE (game_id, player_id)` index forces. The key becomes
**`n6:<membership_id>:<joined_at>`**, and reactivation sets a fresh `joined_at`.
Once per membership, again on each rejoin — which is what the prose intends.
This amendment must be written back into §2.8's dedupe table.

### 4.5 This endpoint is unauthenticated and it both writes and sends

The same class as `POST /r/:token`, which is why that route has a WAF rule.
Controls, in order of load-bearing-ness:

1. **The N-6 send goes through the existing quota wrapper**, so it can never
   breach `MAX_EMAILS_PER_DAY` and a ceiling refusal writes the same
   `audit_log` row every other deferred send writes (`src/notify/ceiling-audit.ts`).
   This is the control that bounds the cost of abuse.
2. **The token is unguessable.** An attacker must first be given a link. This
   is real but narrow — the threat model is a link that leaked, not a scanner.
3. **Origin check** on the POST, mirroring the dashboard's and the sign-out
   form's: a browser always sends `Origin` on a cross-site form post, and a
   missing header is a non-browser client acting on its own behalf.
4. **Email normalised** — trimmed and lowercased — before the uniqueness
   lookup, so `Ed@x.com` and `ed@x.com` cannot produce two Players. Validated
   for shape; not verified for deliverability.
5. **A WAF rate-limit rule extended to `/j/*`**, documented in
   `docs/runbooks/cloudflare.md` alongside `respond-throttle` and applied by
   hand in the dashboard, as that one was. This is a supplement, not a control
   — TR-37 — and the four above must hold with it switched off.

**Accepted, and recorded rather than solved:** someone holding a leaked invite
link can add junk squad members, each costing one N-6 email up to the daily
ceiling. The owner's remedy is to rotate the link and remove the members — the
second half of which is J6's removal control, so until J6 ships the remedy is
rotation plus a manual database fix. This is acceptable during a trial whose
only games belong to the author; it should be re-read before the service is
offered more widely.

### 4.6 Membership creation is the same operation the join flow and the owner UI both need

`joinSquad` lives in `src/domain/join-squad.ts` and takes a game, a name and an
email, returning a discriminated result covering the four outcomes above. J6's
"add a squad member directly" and any future import both call it. The route is
a thin caller: parse, validate, delegate, render the outcome.

BR-2 falls out of this for free and must be stated explicitly because it looks
like a bug otherwise: **a player who joins after a fixture has opened is not in
that fixture.** `pending` response rows are written for the eligible set at the
moment a fixture opens (BR-1), and nothing back-fills them. The "You're in"
page therefore says which fixture is their first — the earliest `scheduled`
one — rather than implying they are in the next one.

---

## 5. Data model

**No migration.** Every column this sub-project writes already exists from M1
and M3: `games` including `invite_token` and its unique index, `memberships`
with `role`/`active`/`left_at`, and `n6` in `NOTIFICATION_TYPES`
(`src/notify/dedupe-key.ts`).

The one change to a shared module is the N-6 dedupe-key builder gaining the
`joined_at` component (§4.4).

---

## 6. Modules

New files, each with one purpose:

| File | Purpose |
|---|---|
| `src/domain/game-form.ts` | Pure parse-and-validate of the form body → typed game values or field errors |
| `src/domain/join-squad.ts` | The four-outcome membership operation |
| `src/domain/update-game.ts` | Save + scheduled-fixture propagation, one `batch()` |
| `src/domain/redact-name.ts` | BR-26's "Edward C.", one implementation |
| `src/views/qr.ts` | `uqr` matrix → inline SVG string |
| `src/routes/games.ts` | `/g/*` handlers |
| `src/routes/join.ts` | `/j/:token` handlers |
| `src/views/game-form.ts` | Create/edit form rendering, including error redisplay |
| `src/views/game-overview.ts` | `/g/:id` |
| `src/views/join.ts` | The public invite page and the four outcome pages |

Existing modules touched: `src/app.ts` (two route mounts, `/g/*` added to the
authenticated prefix), `src/views/scripts.ts` (the copy-invite block),
`src/notify/dedupe-key.ts` (N-6 key), `src/views/dashboard.ts` (a link to
create a game, and to any game the viewer owns).

---

## 7. Testing

TR-27 through TR-29 as usual: real D1 and Durable Object bindings, migrations
applied from the real files, routes driven through `SELF.fetch`.

Specific to this sub-project:

**The browser-boundary problem.** The `connect-src` post-mortem's generalisation
is the standing instruction: *ask what a passing test suite would look like if
the feature were entirely broken, and if the answer is "exactly like this", add
the assertion that would differ.* Three places here have that property:

1. **The join form's wiring.** A form posting to the wrong `action`, with the
   wrong `method`, or with field `name`s the handler does not read, fails
   identically to a working one under server-side testing — the handler is
   never called. The test extracts `action`, `method` and every input `name`
   from the rendered HTML and asserts they match what the handler parses.
2. **Every new page renders under the real CSP.** The nine-page sweep in
   `test/security/csp.test.ts` gains `/g/new`, `/g/:id`, `/g/:id/edit` and
   `/j/:token`. The QR page is the one that would have failed under an
   `<img>`-based implementation, which is the point.
3. **The copy-invite script** goes into `SCRIPT_BLOCKS`, so its hash is
   computed rather than pasted and `expectFetchTargetsAllowed` covers it
   automatically.

**Domain tests, no HTTP:** `game-form.ts` exhaustively over valid and invalid
inputs including the odd-max soft warning and every timezone edge; `join-squad.ts`
over all four outcomes plus the name-collision case; `redact-name.ts` over
single-word, three-part and empty names.

**Propagation tests:** an edit with `open`, `played`, `cancelled` and
`scheduled` fixtures present, asserting exactly the `scheduled` ones changed;
an edit that moves the kickoff to a time already occupied by another of that
game's fixtures, proving the unique index is not violated; an edit crossing a
DST boundary, since kickoffs are re-derived through `toUtc`.

**Entitlement tests, one per `/g/:id` route:** a signed-in player who is not a
member gets 404; a member who is not an owner gets 404; a former owner whose
membership is `active = false` gets 404. This is the check most likely to be
omitted and least likely to be noticed during a single-squad trial.

---

## 8. Known issues closed, and one opened

Closed by this sub-project, with the rows in `docs/known-issues.md` to be
updated on completion:

- `LocalParts` rollover — unreachable from the form (§3.2).
- Timezone negative-caching — unreachable from the form (§3.2).
- Odd `max_players` soft warning — implemented (§3.2).

**Not closed here, deliberately.** Two rows are tagged M6 in the known-issues
list but belong to neither half of it: the passkey scripts' error-swallowing
`.catch()` on `/app/passkeys`, and `verify-registration` returning 500 where
400 is correct. Both are auth-surface fixes with no relationship to J1 or J6.
They should be done in M6 as the list says — as a small separate change, not
smuggled into either sub-project's plan.

**Opened by this sub-project:** the leaked-invite-link abuse case in §4.5,
whose full remedy needs J6's member-removal control.

---

## 9. Open questions

None blocking. One to revisit at J6: whether an owner can leave their own
squad, and what happens to a game whose last owner leaves. It is a real
question and it belongs with the removal control, not here.

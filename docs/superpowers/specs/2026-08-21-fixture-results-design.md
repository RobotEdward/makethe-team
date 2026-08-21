# Recording the result (BR-37) — design

**Date:** 21 August 2026
**Status:** approved
**Milestone:** M25. The master spec's milestone table closes with "Score
recording and the funding page come after, as separate specs — as team picking
did, delivered as M9." This is score recording; the funding page remains
outstanding. Cited by its words rather than a section number, because the
numbers in that document move as it is amended.

## 1. What this is

After a fixture has been played, any player who was in it — and any organiser of
the game — can say what happened: a score, or just who won. Everybody else in
that electorate can agree with a claim, or file a different one. Forty-eight
hours after kickoff the most-backed claim locks and becomes the fixture's
result.

The master spec anticipated the data this produces (§308): "a `team` concept
attached to a fixture, and eventually a per-player rating". M9 built the first
half. This builds the fact a rating would be fitted to.

**Not in this:** per-player ratings, algorithmic team balancing, league tables,
goalscorers, assists, or any per-player statistic. This milestone records what
happened to the two sides and nothing about individuals.

## 2. The claim, and where it lives

One new table, `fixture_result_claims`, holding **one row per (fixture,
player)**:

| column | type | notes |
|---|---|---|
| `id` | text pk | |
| `fixture_id` | text → `fixtures.id` | |
| `player_id` | text → `players.id` | |
| `outcome` | text, not null | `'a'`, `'b'` or `'draw'` — present on every claim, including a scored one |
| `score_a` | integer, nullable | |
| `score_b` | integer, nullable | both null, or both set |
| `filed_at` | timestamp_ms, not null | when this player took *this* position; moved forward when they change it |
| `created_at` | timestamp_ms, not null | row birth |

`unique(fixture_id, player_id)`.

**A player's opinion is one row, and that is the whole point.** "One player, one
endorsement" is therefore a database constraint rather than a rule the write
path has to remember — the same move `responses_fixture_player_unique` already
makes for responses. Double-voting is not a bug that can be introduced here.

**A candidate result has no row of its own.** Candidates are
`GROUP BY outcome` and `GROUP BY (score_a, score_b)` over the claims. A
candidate *is* its backers, so a candidate with nobody behind it cannot exist,
there is no id for a vote to dangle from, and there is no orphan row to clean up
when the last backer changes their mind. A design with a `claims` table and a
`votes` table pointing at it was considered and rejected for exactly those three
failure modes.

**Changing your mind updates your row in place. The history lives in
`audit_log`.** That table already carries `before_json` and `after_json`, so a
flip is recorded where every other change of mind in this product is recorded.
The alternative — a `superseded_at` column and a partial unique index — would
put a filter on every read of this table that somebody eventually forgets, which
is a defect class this repository has logged more than once.

`filed_at` moves when the claim changes because it exists to answer one question:
how long has this position been held? A player who switches from "3–2" to "4–2"
has not been backing 4–2 since Thursday.

### 2.1 `outcome` is a stored lookup with nothing behind it

`text NOT NULL` with no CHECK constraint, indexing a lookup — the same shape as
`fixtures.lifecycle`, `responses.status` and `responses.team`, every one of
which has 500'd a page in this codebase by arriving as a value the TypeScript
type said was impossible. It is enumerated in `test/stored-lookups.test.ts` as
task zero, and every renderer reads the name first and branches on whether there
is one, as `renderPublishedTeamsSection` already does for `responses.team`.

### 2.2 A score and its outcome cannot disagree

When a score is submitted, `outcome` is **derived from it** and any submitted
outcome is ignored. A row saying "3–2, draw" is therefore not merely refused, it
is unconstructible: there is one function that builds a claim and it computes
the field. Nothing in SQLite would catch such a row, and under §3's two-level
tally it would be actively poisonous — a claim counting toward an outcome its
own score contradicts.

## 3. Deriving the result

`src/domain/result.ts`. Pure functions over claim rows: no database, no clock —
the deadline is a parameter, as `announcementOutstanding` takes its instants.

**The tally has two levels, and they answer different questions.**

1. **Outcome.** Group every claim by `outcome`. A claim of "Bibs 3–2 Skins"
   counts toward "Bibs won" exactly as an outcome-only claim of "Bibs won" does.
2. **Margin.** Among only the *scored* claims whose outcome is the winning one,
   group by `(score_a, score_b)`. This group may be empty, which is the
   legitimate and recordable state **"Bibs won, score not agreed"**.

Both levels use the same comparison, applied in order:

1. most backers;
2. then a claim backed by an **active organiser** of the game;
3. then the earliest `min(filed_at)` among its current backers;
4. then the lowest backer id, lexicographically.

**Step 4 is not in the original design and was added during implementation
(Task 3) because step 3 does not make the comparison total.** Two different
players' claims can tie on `filed_at` to the millisecond — each `POST
…/result` writes one claim stamped with its own `Date.now()`, so this needs
two separate requests landing in the same millisecond, not two players filing
in one request. Without a fourth step the comparator would fall through to
`Array.prototype.sort`'s handling of equal elements, whose answer depends on
the order candidates were built in — Map insertion order, tracing back to
database row order, which SQLite makes no promise about absent an `ORDER BY`.
`fixture_results` exists precisely so a later recomputation can never disagree
with what was cached at lock time (§5); a comparator that is not total would
make that guarantee false on exactly the claims most likely to produce a tie.
Backer ids are UUIDs and every candidate's backer set is disjoint from every
other's, so the lowest one is stable across evaluations and never a tie
between two genuinely different candidates.

**Why two levels rather than one tally over exact claims.** Consider five
voters: three say Bibs 3–2, two say Bibs won without a score. The squad is
unanimous that Bibs won; the margin is attested by three of five. A flat tally
records "Bibs 3–2, three backers" and throws the unanimity away. For the
ratings dataset this is backwards — the outcome is the signal a model fits, the
margin is a weight on it — and recording one confidence figure where there are
two loses the better of them.

**Why the organiser breaks ties before filing order.** Step 3 alone would reward
being quick over being right: a wrong early claim that picks up one friend beats
a correct later one. The organiser is the person who ran the fixture, already
has standing everywhere else in this product, and was given a vote in §6 partly
so that this step could exist. Where no organiser backed either tied claim,
step 3 is deterministic and needs no clock beyond the rows themselves.

## 4. The lock

```
deadline  = kicks_off_at + 48h
locked    ⇔ claims.length > 0 && now >= deadline
writable  ⇔ lifecycle === 'played' && !locked
```

Forty-eight hours from **kickoff**, not from full time. It is the rule as
stated, it needs no duration arithmetic, and a fixture's kickoff is the instant
everybody involved already knows.

**This one predicate delivers both halves of the agreed behaviour, with no
second state and no special case.**

- Before the deadline, claims exist and can be argued with.
- At the deadline, an existing claim set freezes.
- After the deadline with **nothing filed**, `claims.length > 0` is false, so
  the fixture stays writable. It reads "no result recorded" and the form is
  still there. The first late claim makes `locked` true on the very same
  evaluation — it stands alone, with no voting round, and the window never
  reopens.

A squad that forgot for two days does not lose the fixture from its history. A
squad that recorded something does not get it rewritten a week later.

`cancelled` never qualifies (BR-16: a cancelled fixture is terminal and is never
resurrected into another lifecycle), and neither does a fixture still `open` or
`scheduled` — there is nothing to have a result about.

## 5. `fixture_results` is a cache

A second table keyed by `fixture_id`, written once, holding the derived result
and the confidence signals as they stood when it froze:

| column | notes |
|---|---|
| `fixture_id` | text pk → `fixtures.id` |
| `outcome` | the locked outcome |
| `score_a`, `score_b` | nullable — null is "outcome agreed, score not" |
| `outcome_backers`, `margin_backers` | numerators of the two confidence figures |
| `voter_count` | claims filed |
| `eligible_count` | size of the electorate at lock — the turnout denominator |
| `distinct_outcomes`, `distinct_scores` | how contested it was — `distinct_outcomes` is the number of outcome candidates the tally produced; `distinct_scores` is the number of distinct scores summed **across every outcome candidate**, not only the winning one, so a fixture where "Bibs won 3–2" and "Skins won 2–1" both drew backers counts both margins toward this figure |
| `rostered` | whether the fixture had published teams to join against |
| `teams_accurate` | `announcementOutstanding` inverted — see §12 |
| `locked_at` | `max(deadline, earliest claim)` |
| `materialised_at` | when this row was written |

**The claims are canonical; this row is derived and recomputable, and the design
depends on that staying true.** Every page and every refusal reads the
derivation in §3, never this table. A sweep run that fails, or a deploy that
never runs one, costs an export row that the next run writes — not a fixture
stuck in a wrong state with nothing to notice it. A stored *state* would have
had that failure mode; a cache cannot.

**It exists for exactly one reason.** A purely derived result is a function
evaluated at read time, so changing the tie-break rule in eighteen months — or
fixing a bug in it — silently rewrites last season's results underneath anything
fitted on them, with no row edited and no test failing. Two exports taken a
month apart disagree and nothing explains why. Materialising the derivation at
the instant it freezes is what makes the history a record rather than a
recomputation.

`test/domain/result-cache.test.ts` asserts a materialised row still equals what
the derivation says. That test is what makes "it is only a cache" true rather
than aspirational.

## 6. Who may file

```
eligibleToFile(fixtureId, playerId) ⇔
     responses.status = 'in'  for (fixture, player)
  OR memberships.role = 'owner' AND memberships.active  for (game, player)
```

Anyone who was in it, plus any active organiser whether or not they played. The
organiser is who chases a missing result, and their vote is what §3's second
tie-break step reads.

Two properties come free rather than needing a check somebody could forget.
**Responses freeze at `played`**, so the electorate is fixed and cannot shift
under a vote in progress. **Guests fall out** because they have no account and
`requirePlayer` never admits them (BR-32) — they appear on rosters and can never
file.

`requirePlayer` establishes *who*; this is re-asked in every handler, and a
refusal is a **404, not a 403** (TR-18). That holds even for a squad member who
was `out` that week and can already see the page. Keeping one rule is worth more
than reasoning case by case about who already knows the fixture exists, which is
how the wrong branch eventually gets written.

## 7. Routes and refusals

### `GET /g/:id/f/:fixtureId`

Dispatches by role, exactly as `GET /g/:id` already does. An active owner gets
the existing owner fixture page, unchanged, with a result panel added. An active
squad member gets the new player fixture page (§8). Anyone else gets a 404.

### `POST /g/:id/f/:fixtureId/result`

Files, changes **and** agrees — all three are one submission and one handler,
because the form posts **values** (`outcome`, optional `score_a` / `score_b`),
never a candidate id. Agreeing with "Bibs 3–2" submits those values as your own
claim; the upsert on `(fixture_id, player_id)` does the rest.

**With no candidate id in the form there is nothing to forge.** A tampered
submission cannot move another player's vote, inflate a tally, or reference a
claim that does not exist. The worst it achieves is casting your own single vote
for a combination you invented — which is precisely what the "Something else
happened" form does openly.

### `POST /g/:id/f/:fixtureId/result/clear`

Deletes your own row. Without it a mis-tapped Agree can only be moved to another
candidate, never withdrawn, "I genuinely don't remember" cannot be expressed,
and the turnout figure §5 records is a lie.

All three POSTs take the existing `wrongOrigin(c)` → 403 origin check.

### Refusals

| condition | response |
|---|---|
| not an active member of the game | 404 |
| member, but neither `in` nor an active owner | 404 |
| fixture not `played` | 404 |
| `locked` (§4) | 422, the **role-correct** page re-rendered with the reason |
| score half-given, negative, non-integer, or above the cap | 422, the **role-correct** page re-rendered with the reason |

The lock refusal is a 422 rather than a 404 because it is not an entitlement
question: the person is entitled and the window shut. The 422s re-render the
page with a `problem`, the shape `renderDashboard(c, problem)` and the teams
publish refusal already use — the fix is on that page, so that is where the
answer goes.

**The re-render is role-correct, not merely "the page" (review fix during
implementation).** `/g/:id/f/:fixtureId` dispatches to two different pages
depending on whether the viewer owns the game (§7's `GET`), and a POST refusal
has to answer with whichever one the viewer is entitled to, not always the
player-shaped page — an owner tripping a refusal on their own fixture's URL
must see the organiser's page re-rendered, exactly as a plain `GET` from them
would. `src/routes/results.ts` re-checks the viewer's role at refusal time and
calls `renderOwnerFixture` or `renderPlayerFixture` accordingly.

Scores are integers `0`–`99`. The cap is arbitrary and exists so that a pasted
number cannot produce a row nothing can render sensibly.

## 8. The player fixture page

New view `src/views/player-fixture.ts`. **This is the first per-fixture URL a
player has ever had**; until now their only stable per-fixture link was
`/r/:token` from an email, and `/g/:id` shows only the *open* fixture, so the
published teams vanished from a player's view the moment
`retirePastFixtures` flipped the fixture to `played`.

It reuses rather than reimplements:

- `publishedTeamsFor` gates only on `teams_published_at` — there is no lifecycle
  condition in it — so it works unchanged on a played fixture.
- `renderPublishedTeamsSection` renders it, so BR-35 §5's rule that a player's
  own side is theirs holds here for free.
- the squad goes through `squadForViewer`, so BR-33 keeps governing who sees the
  other side's names.

Contents: kickoff and venue, the viewer's own status that week, the squad, the
teams, and the result panel. It carries the M24 freshness bar — a page whose
content is a live tally is the strongest case for it yet, and this makes six
pages rather than five.

**One copy change is required.** `renderPublishedTeamsSection` says "You're on
Bibs." A played fixture needs the past tense, or the page tells somebody they
are about to play a game that finished on Thursday.

The result panel has three states:

- **Writable** — each candidate with its backer count, the viewer's own marked,
  an Agree submit per candidate, a "Something else happened" form, and how long
  is left.
- **Locked** — the outcome and the margin with their two confidence figures.
  When the fixture was never rostered it says so: *"Teams weren't picked in the
  app for this fixture, so we don't know who played on which side."*
- **Nothing filed, deadline passed** — still writable, and says so.

Every control is a plain form: radios for the outcome, two number inputs for a
score, one submit per candidate. No `style` attributes — `style-src` is
hash-only with no `style-src-attr`, so an attribute is stripped in production
and passes every test. The panel's CSS is registered in `PAGE_STYLE_BLOCKS` or
it silently does not apply.

## 9. The other surfaces

- **`/g/:id`, both roles** — a "last result" line for the most recent played
  fixture, linking to its page.
- **Account history rows** — currently linking to the game; they link to the
  fixture and carry its result. This is where "what happened in March?" is
  answered. `selectEntitledFixtures` already filters `memberships.active`, so
  these rows cannot reach a fixture the viewer has lost standing in.
- **Dashboard** — one item per played fixture that is still writable and that
  the viewer has not filed on. The dashboard is a to-do list and this is a
  genuine to-do. It widens the lifecycle filter, which `listDashboardFixtures`
  supports by design: M11 moved that filter out to the caller *specifically* so
  that a caller could widen what it shows without widening what it may reach,
  and the three security conditions in `entitledTo` are untouched by this.

## 10. N-12 and the sweep step

A new step in the hourly sweep, after `retirePastFixtures` (which is what makes
a fixture `played`) and before the erasures, wrapped whole on the pattern the
attention step documents: one bad fixture must not take down the run.

It does two independent things.

**The nudge (N-12).** One "How did it go?" to the electorate minus guests,
linking to the fixture page. Dedupe-keyed per (fixture, player) so it goes
exactly once. New entry in `NOTIFICATION_TYPES`, and
`fixture.result_nudge_email_deferred` alongside the other ceiling-deferral
actions, because this competes with N-1 for TR-31's daily allowance and a
refusal deletes the `notification_log` row.

**Selection is bounded by a window — full time within the last twelve hours —
not by "fixtures this run retired".** Twelve hours because the sweep is hourly,
so a fixture gets twelve chances to be picked up before it falls out of the
window, and a run missed for any reason costs nobody their nudge. `retire.ts` documents this hazard from the other
direction: a cron backlog mailing people about games that finished days ago. A
first deploy selecting every played fixture ever would mail the entire user base
about last season. A window is self-limiting and needs no activation flag.

**The cache write (§5).** Selected separately — `played`, deadline passed, has
claims, no `fixture_results` row — and chunked through `INSERT_CHUNK_SIZE`. It
sends nothing, so a large first-run backlog is harmless.

## 11. Audit

`AUDIT_ENTITY_TYPES` already contains `fixture`, and actions are namespaced by
their entity, so this adds four values to `AUDIT_ACTIONS` and needs no
migration — Drizzle's `text({ enum })` emits no SQL CHECK on SQLite, as that
module's own comment records:

- `fixture.result_filed`
- `fixture.result_changed` — carries the before and after, and is therefore the
  flip history that lets §2 keep the claims table a simple one-row-per-player set
- `fixture.result_cleared`
- `fixture.result_locked` — written by the sweep with a **null** actor, like
  every other system action

## 12. Teams accuracy — discharging carry-forward note 2

`docs/known-issues.md` carry-forward note 2 asks that a result record whether its
fixture's teams were still accurate when it started, and says explicitly: decide
this when results are designed, not after a season of data has accumulated.

**It needs no column.** Every input to that judgement is frozen once the fixture
is `played`: the picker and publish routes both refuse a non-open fixture, and
responses lock under BR-15. `announcementOutstanding` is already a pure,
clock-free predicate over exactly those inputs, so the accuracy of a fixture's
teams is computable forever from rows we already have. §5's `teams_accurate` is
that predicate evaluated at lock and cached with everything else, not a fact
stored because it could not be derived.

**The whole of that rests on the freeze being real, which today is an inference
from reading three routes rather than an assertion.** So it becomes task zero:
an enumerating test that no write path mutates `responses.status`,
`responses.team`, `fixtures.teams_saved_at` or `fixtures.teams_published_at` on
a `played` fixture. This is `CLAUDE.md`'s first rule — a global invariant gets
its test before feature work starts, not after the fourth rediscovery.

The note is then closed in `docs/known-issues.md` with the reasoning above, so
that nobody re-opens it looking for the column it originally asked for.

## 13. Ratings and erasure — decided, not deferred

A future ratings model fitted on this data attaches a derived judgement about a
person to rows that survive erasure: `erasePlayer` deliberately keeps a played
fixture's participants, and `src/db/queries.ts` says so.

**Recorded as decided, not carried forward.** The judgement attaches to a row
whose name is a placeholder and whose email, `auth_user_id` and
`email_verified_at` are all null — a pseudonym, not a person — and the
anonymisation that makes that true is already in place and already tested to
leave zero rows behind that identify anyone. This is recorded in
`docs/known-issues.md` as a deliberate position with its reasoning, which is
what that file is for, so that the milestone which does fit a model finds the
question already answered rather than answering it in passing.

## 14. Testing

**Task zero, before any feature work — both are global invariants:**

1. **The freeze test** (§12). Nothing mutates a played fixture's
   `responses.status`, `responses.team`, `teams_saved_at` or
   `teams_published_at`.
2. **`test/stored-lookups.test.ts` gains `fixture_result_claims.outcome`** —
   `text NOT NULL`, no CHECK, indexing a lookup, which is the shape that has
   500'd a page in this codebase six times in one milestone.

**Domain.** The two-level tally; each tie-break step alone and in combination;
outcome-only and scored claims counting toward the same outcome; a scored claim
whose submitted outcome contradicts it. The lock predicate at the deadline
exactly, a millisecond either side, with zero claims after it, and the late
claim that locks on filing.

**Routes.** Every row of §7's refusal table; a forged `outcome`; a forged score;
CSRF; a replayed form (the upsert must be idempotent); clear.

**Consistency.** A materialised row still equals the derivation (§5).

**Notify.** Dedupe; guests excluded; the window bound; the ceiling-deferral
audit row. Any `fetch` stub here is an **ordinary function that checks its
receiver, never an arrow function** — the `Illegal invocation` failure that broke
every push from M14 until it was found in production `notification_log` reads
identically to a working call under an arrow stub.

**Views.** The new style block is in `PAGE_STYLE_BLOCKS`; the cascade-collision
test covers it, plus a dedicated test for any different-selector,
equal-specificity collision the enumerating test cannot see; the script
enumeration test is updated for `FRESHNESS_JS` on the new page.

**Browser.** The page captured at 390px and the PNG actually read — a tally with
a long team name and five candidates is exactly the row-shape-depends-on-content
case string assertions cannot see. Plus the whole flow with JavaScript off.

**Docs.** `screens.md` gains the new screen; `docs/guide/` gains a section on
recording a result; `docs/known-issues.md` closes carry-forward note 2 (§12) and
records §13.

## 15. Not in this

Per-player ratings, algorithmic balancing, league tables, goalscorers, any
per-player statistic, editing a locked result, an organiser override of the
vote, and results for cancelled fixtures.

## 16. Definition of done

1. A player who was `in` opens `/g/:id/f/:fixtureId` for a played fixture, sees
   who was on which side, and records "Bibs 3–2 Skins" with JavaScript off.
2. A second player opens the same page, taps Agree, and the count reads 2.
3. A third disagrees, files "Bibs 4–2", and both candidates are listed with
   their backers.
4. A player who was `out` that week can read the page and cannot file; a
   non-member gets a 404.
5. Forty-eight hours after kickoff the page shows the locked result with its two
   confidence figures, and every write is refused at 422.
6. A fixture with nothing filed after 48 hours still offers the form, and the
   first claim filed locks immediately.
7. A fixture whose teams were never picked records a result and says the sides
   were not rostered.
8. Everyone in the electorate is nudged once, and only once, after full time.
9. `fixture_results` agrees with the derivation for every locked fixture.
10. No write path can change a played fixture's responses or team columns.

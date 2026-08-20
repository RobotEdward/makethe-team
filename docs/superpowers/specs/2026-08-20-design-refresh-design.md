# Design refresh: warm palette, display type, seven IA fixes — design

**Date:** 20 August 2026
**Status:** approved
**Milestone:** M20. Implements the external design review ("Make The Team — IA
and screens", 20 Aug 2026), which proposed a full visual direction and eight
IA changes. Seven are in scope; the eighth is parked (§8).

## 1. What this is

Two phases in one milestone. **Phase A** replaces the visual system — palette,
type, shape — through the token block in `src/views/layout.ts` and the
component blocks in `src/views/styles.ts`, recolours the app icon to match,
and re-verifies every page visually. **Phase B** lands seven structural
changes from the review, ordered cheap to deep, each independently shippable.

The review's own constraint check holds and this spec re-asserts it: separate
organiser and player renderers stay separate; token pages still disclose no
push endpoints or device lists; the two-tap answer stays; the bare-count
rendering for squad-visibility-off games survives, restyled; anti-enumeration
copy is unchanged except where §7 names it.

**Not in this:** change #8 (squad above the join form — parked, §8); any new
route beyond what §7 lists; team-name default changes ("Reds"/"Blues" in the
mocks are sample data); copy rewrites beyond the sections named here; any
change to the token-page push offer.

## 2. Phase A — the visual system

### 2.1 Tokens (light)

The semantic token names in `STYLES` survive; only values change, plus three
additions for the success family, which today borrows `--accent`.

| Token | Value | Used for |
|---|---|---|
| `--bg` | `#efe3cd` | page ground |
| `--card` / `--card-raised` *(new)* | `#f5ead8` / `#f9f4ed` | cards, panels |
| `--fg` | `#201e1d` | ink |
| `--mut` | `#645c50` | secondary text |
| `--line` | `#dcd3c4` | borders, rules |
| `--accent` | `#c67139` | primary buttons, emphasis |
| `--accent-fg` | `#fff7f0` | text on accent |
| `--accent-mut` | `#ffe1d0` | pale accent grounds |
| `--link` *(new)* | `#8c491a` | anchors (hover `#b2622d`) |
| `--ok` / `--ok-bg` / `--ok-fg` *(new)* | `#8fa073` / `#e1eecc` / `#3d472b` | confirmed, success notices |
| `--warn` / `--warn-bg` | `#b2622d` on `#ffe1d0`; solid amber `#f6a06b` | waitlist, unsettled |
| `--danger` / `--danger-fg` | `#a4321f` / `#fbfaf8` (unchanged) | irreversible actions |
| `--field` *(new)* | `#ebddc5` | form fills |

The `--warn`/`--danger` semantic split from M10 survives untouched: `--ok` is
a third family, not a re-merge.

### 2.2 Tokens (dark)

Dark mode stays (decision Q2). A warm derivation, same semantics:

| Token | Value |
|---|---|
| `--bg` | `#221f1b` |
| `--card` / `--card-raised` | `#2b2721` / `#322d26` |
| `--fg` / `--mut` / `--line` | `#ede5d8` / `#a89e8f` / `#3a352d` |
| `--accent` / `--accent-fg` / `--accent-mut` | `#d98a55` / `#2a1608` / `#3a2818` |
| `--link` | `#e0a878` |
| `--ok` / `--ok-bg` / `--ok-fg` | `#a3b585` / `#2c3320` / `#cfe0b0` |
| `--warn` solid | `#f6a06b` on `#43301f` |
| `--danger` / `--danger-fg` | `#e8705a` / `#1a0d0a` (unchanged) |

Every pairing above is a starting point, adjusted during implementation until
it passes WCAG AA against its actual ground; the values that ship are whatever
passed, and the contrast check is part of the task, not a follow-up.

### 2.3 Type and shape

- **Display: Caprasimo, weight 400** — `h1`, `h2`, and the card-title role
  (fixture-card game names). Never body text, never controls.
- **Body: Figtree 400–700**, replacing Instrument Sans everywhere.
- Both served from Google Fonts as today — the `<link>` in `layout.ts` changes
  families; `FONT_ORIGINS` and the CSP need nothing.
- `--mono` stays IBM Plex Mono (the invite URL readout and admin timestamps);
  the review's JetBrains Mono is its own annotation face, not a product
  requirement.
- **Shape:** cards ~20px radius; buttons become full pills (`border-radius:
  999px`); primary actions on token pages are full-width.

### 2.4 Components

Restyled in place, same markup wherever possible:

- **Badges:** Confirmed = solid `--ok` with `--card-raised` text; Needs
  players / Open = `--ok-bg` pale with `--ok-fg` text; Not open yet / Played =
  neutral (`--field` ground, `--mut` text); Cancelled and over-capacity =
  `--accent-mut` peach with `--warn` text.
- **Capacity bar:** `--ok` fill on `--line` track; the over-capacity overflow
  segment renders in solid amber `#f6a06b`.
- **Chips** (squad roster): `--field` ground, pill; the viewer's own chip
  filled `--accent`.
- **Segmented In/Out control:** pill group on `--card-raised`; selected
  segment `--ok` (In) / neutral (Out).
- **Form fields:** `--field` fill, no border, focus ring in `--accent`.
- **Answer buttons:** primary `--accent` pill; secondary `--field` pill;
  waitlisted variant solid amber as the mocks show.

### 2.5 Icon, theme colour, manifest

The five-dots-tick mark in `src/views/icon.ts` is untouched geometrically (its
comments forbid tidying); colours swap to **terracotta ground `#c67139`, cream
dots `#f9f4ed`** (decision Q5). `THEME_COLOR` becomes `#c67139`, and the
manifest's `background_color` follows `--bg` (`#efe3cd`).
`scripts/build-icons.mjs` regenerates `icon-bytes.ts`.

### 2.6 Phase A verification

- `npm run guide:capture` regenerates all guide images; **every one is read**
  (working-notes rule 3), light and a spot-check of dark.
- `test/views/style-cascade.test.ts` re-runs against any reordered blocks;
  CSP hashes are derived, so they follow automatically.
- Existing string assertions on class names and copy are expected to survive;
  assertions on colour values (if any) update with the tokens.

## 3. Phase B — the seven changes

Ordered cheap to deep. B1–B5 are each shippable the day they're done.

### B1 · Reorder the organiser's game page (review #5)

`renderGameOverviewPage` reorders to: Coming up → Squad → Invite people →
Message everyone → back-link. No handler changes. The order-pinning test pairs
with presence assertions (the `indexOf -1` trap in the working notes).

### B2 · Fold the dashboard footer into the header (review #1)

The dashboard footer drops the `Your account` link and the passkey nudge
(the header's Account link and the onboarding card now carry both jobs);
`Delete my account and data · Privacy` stays. **The sign-out form moves off
the dashboard and lives on the account page only** (decision Q3) — the
account page already renders it, so this is a deletion, not a move.

### B3 · "Your squads" on the dashboard (review #7)

The `Games you own` section becomes **`Your squads`**: every active
membership, each game name a link to `/g/:id`, owned games marked
`· you own this`, `Set up a game` link kept. This gives a non-organiser a
route to their game page that exists even when no fixture is open (the gap
`screens.md` flagged). One membership query joins what the dashboard already
loads; section omitted entire — heading included — when the player has no
squads, matching the current owned-games behaviour.

### B4 · Broadcast receipt (review #6)

The send handler's 303 gains a flag: `?sent=<n>&via=email|push|both`, where
`n` is the recipient count it already computed. The game and fixture pages
read the flag **as an enum plus a bounded integer** — never echoed caller
text — and render a one-line `--ok-bg` notice: "Sent to 11 players by
email." / "…by push." / "…by email and push." An invalid or absent flag
renders nothing. This closes the known no-feedback gap without a delivery
report; push failures remain invisible (unchanged, still recorded in
`docs/known-issues.md` territory).

### B5 · Merge install + notifications into "This device" (review #2)

On `/app/account` only: `renderInstallSection` and `renderPushSection`
combine into one **This device** panel — heading, one intro sentence
("Add Make The Team to your home screen and turn on game notifications."),
install button/instructions, the name-this-device field and enable button,
then the device table. The hidden-until-script rules, the context-aware
button labels, and the reveal logic in `INSTALL_JS`/`PUSH_SUBSCRIBE_JS` all
survive; this is a composition change, not a behaviour change. **The
token-page push offer (`renderPushOffer`) is untouched** — the type split
that stops a device list existing there is load-bearing and stays.

### B6 · One sign-in failure page (review #3)

The four `/sign-in/complete` dead ends collapse to one page: heading
**"We can't sign you in"**, a per-case reason line, and `Back to Make The
Team`. The four reasons keep their distinct copy (email-in-use, duplicate
rows, guest entry, concurrent write). **The concurrent-write case keeps its
retry link** as its next step (decision Q4) — the one sanctioned deviation
from "only the reason line varies". These pages render only after a valid
magic link, so the anti-enumeration posture of `/sign-in` itself is
unaffected. The refused branch still must never throw or 500.

### B7 · The response page's single answer block (review #4)

The deepest change. `/r/:token` (and the dashboard card, through the same
imported copy) restructures so the viewer's state is said once:

- **Answer block:** one card carrying the headline ("Can you make it?" /
  "You're in." / "You're on the waitlist." / "You said you can't make it.")
  and the two buttons, tinted by state — neutral raised card unanswered,
  peach with amber primary when waitlisted, `--ok` tinting when in. The
  waitlist rank line ("Third in line…") lives inside the block.
  `aria-pressed` and both-buttons-persist behaviour unchanged.
- **Below it:** the fixture's own facts — status badge, capacity bar, count,
  over-capacity notice — no longer interleaved with the viewer's state.
- **Read-only states** (played, cancelled, not open yet, no longer on the
  squad) render the block with a sentence in place of buttons.
- The pre-tap full-warning stays adjacent to the buttons it warns about.
- The dashboard's fixture card adopts the same block in miniature, importing
  the copy from the response view exactly as it does today, so the two pages
  cannot disagree.

## 4. What does not change

Routes (except B4's query flag and B6's consolidation of an existing page's
states); the database; email templates' structure (they pick up palette only
if trivially shared — otherwise emails are out of scope); guards and
entitlement checks; `formatLocalDateTime` usage; the daily broadcast cap;
the push endpoint invariants; the passkey flow.

## 5. Testing

- Every Phase B task ships its class guard in the same round (working-notes
  rule 2) and its route tests alongside.
- `test/routes/signin.test.ts`'s sweep: B6 consolidates renderings of an
  existing route — the sweep entry updates rather than grows.
- New copy through `escapeHtml` everywhere, `href` and class attributes
  included; B4's notice is enum-driven, tested for the
  ignore-invalid-flag branch.
- `npm run guide:capture` after Phase A and after B5, B6, B7; the touched
  page is captured and read within each task.
- Full suite plus Playwright before each push, as always.

## 6. Rollout

Milestone worktree `../maketheteam-m20` (own `npm install`), merged
fast-forward to `main` per the working notes. Task order: A1–A4, then B1–B7.
Pushing `main` deploys production, so each merge is a complete, verified,
shippable slice — Phase A merges only after the full visual pass reads clean.

## 7. Route surface after M20

New: none. Changed renderings: `/app` (B2, B3), `/g/:id` organiser (B1, B4),
`/g/:id/f/:fixtureId` (B4), `/app/account` (B5), `/sign-in/complete` (B6),
`/r/:token` (B7). Every page: Phase A.

## 8. Parked: review change #8

"Put the squad above the form on the invite page" — the review itself calls
it "worth testing rather than asserting". Parked by maintainer decision,
20 Aug 2026; recorded in `docs/known-issues.md` so it isn't re-litigated as
an oversight. Revisit only with evidence (e.g. join-rate observation).

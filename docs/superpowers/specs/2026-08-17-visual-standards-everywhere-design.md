# M12 — Apply the visual and usability standards to every screen

> **Provenance.** This spec arrived from the Claude Design project
> "App usability review and redesign"
> (`143d827a-7472-4b79-a0d0-4a51b21ba7d1`), as `M11-visual-standards.md`
> plus its rendered companion `Visual Implementation Guide.dc.html`. The
> body below is that document, verbatim except for the renumbering.
>
> **Renumbered M11 → M12.** The source document was written before M11
> shipped and claims that number. In this repo M11 is the player account
> milestone (`2026-08-16-player-account-design.md`, merged at `26174f8`).
> This work is M12. Note that the source's own work list names
> `views/account.ts` and `views/squad-member.ts` — files M11 created — so
> the document is in fact *later* than the milestone whose number it
> borrowed.
>
> **Verified against the tree at `26174f8`** before adoption. Every claim
> checked out: `fixture.lifecycle` is printed raw at `game-overview.ts:96`;
> `ul.owned-games` (`dashboard.ts:150`) has no CSS rule anywhere;
> `.fixture-card h2` does carry `text-align: center`; `.read-only` is used
> for read-out values in `account.ts:106-107` and `squad-member.ts:46-57`;
> `centred: true` appears in exactly the ten terminal places §2.1
> enumerates. Every test file cited in §5 exists.

M10 landed the standards on four files: `src/views/layout.ts` (tokens, left-align
default, `.button.danger`), `src/views/fixture.ts` (answer-in-the-control, chips),
`src/views/owner-fixture.ts` (`.segment`), `src/views/cancel.ts` (destructive page
shape). **M12 applies the same standards to the twelve views that M10 did not
touch.** No new features. No schema or route changes. No copy rewrites beyond the
specific lines named below.

---

## 0. Hard constraints — read before writing any CSS

These are properties of this codebase, not preferences. Violating any of them
ships a page whose CSS silently vanishes in production.

1. **Every `<style>` block must be a member of `PAGE_STYLE_BLOCKS`** in
   `src/views/styles.ts`. `src/security/csp.ts` hashes exactly `STYLE_BLOCKS`
   (`STYLES` + `PAGE_STYLE_BLOCKS`) for `style-src`. A block defined outside that
   array is dropped by the browser and no fetch-level test will fail.
2. **Never write an inline CSS literal at a `layout()` call site.** New CSS is a
   named export in `styles.ts`, added to `PAGE_STYLE_BLOCKS`.
3. **Shared primitives go in `STYLES` (`layout.ts`); everything page-specific goes
   in `styles.ts`.** Do not widen `STYLES` for something two pages use — pass two
   blocks instead, as `dashboard.ts` already does.
4. **`STYLES` renders on the public holding page and on error pages.** Its comments
   and content must stay free of file paths, page names, and operational words —
   `test/routes/access.test.ts` asserts their absence. Put explanatory comments in
   `styles.ts` instead.
5. **No new `pageScripts`.** Every page must be completely usable with JavaScript
   off (TR-4, TR-15). The only sanctioned scripts are the passkey enhancements and
   `COPY_INVITE_JS`; anything new must be a progressive enhancement over markup
   that already works, and must ship `hidden`.
6. **Every interpolation goes through `escapeHtml`** — including `href` values,
   matching the existing pattern.
7. **Do not widen `ul.squad > li` back to `.squad li`.** The player's fixture page
   wraps chips in a `div.squad`; a bare descendant selector reaches `li.chip` and
   beats `.chip` on specificity. This regressed once already.
8. **`--danger` and `--accent` must never appear as two filled buttons on the same
   screen.** Their relative luminances are close enough that a deuteranope reads
   the label, not the colour. This separation is what makes `.button.danger` safe.

---

## 1. Tokens — the meanings, which are now enforced

Defined in `STYLES` (`src/views/layout.ts`). Do not add new colours; if a page
seems to need one, it is using the wrong token.

| Token | Means | Allowed on |
|---|---|---|
| `--accent` | **settled, you are in** | confirmed status, `chosen-in`, `.seg.on`, `chip-in`, primary submit, links |
| `--warn` / `--warn-bg` | **unsettled: waiting, short, advisory** | waitlist rank and chips, `chosen-waiting`, `.nudge`, `.problem`, short/cancelled badges |
| `--danger` | **irreversible** | call off, remove, leave, erase — filled `.button.danger` and destructive links only |
| `--mut` | out, no reply, inert, support text | `.seg.out`, neutral chips, `p` |
| `--line` | hairlines, tracks, neutral chip fill | borders, `.segment` track |

Type: `--t-title` 2rem, `--t-lead` 1.25rem, `--t-body` 1rem, `--t-support`
0.875rem. **Four sizes, no others.** `--mono` for counts, ranks and the invite URL
only.

Spacing: existing rem rhythm — 0.4 / 0.6 / 0.75 / 1.1 / 1.5 / 2rem. Radii: 0.5
(inputs), 0.6 (notices), 0.65 (buttons), 0.7 (segment), 0.75rem (cards), 999px
(pills). Tap targets: 52px for `.button`, 44px minimum for anything else
(`.segment .seg`, `.teams .sides label`).

---

## 2. Layout rules that now apply to every page

1. **Left-aligned by default.** `centred: true` is only for a page that is a single
   statement with nothing to scan: the holding page, `link-problem`, the terminal
   cancellation pages, and the terminal sign-in pages. Everything else must not
   pass it. **Fix: remove `.fixture-card h2 { text-align: center; }` from
   `DASHBOARD_STYLES_CSS`** — it is the last centred text in a scannable page and
   it contradicts §2.3.
2. **One primary action per screen.** `.button.primary` or `.button.danger`, never
   both, never two of either. Everything else is the outlined default.
3. **State lives in the control**, not only in a sentence above it — the
   `chosen-*` pattern from `FIXTURE_STYLES_CSS`. Apply it wherever a control both
   sets and reports a value.
4. **Consequences precede the action.** Any warning about what a submit will do
   goes above the button, in `.nudge` (advisory) or `.problem` (refusal).
5. **Every page behind a session gets one back link** at the end of the body,
   using the existing `.back-link` class (`FIXTURE_STYLES_CSS`), pointing one level
   up: fixture → game, member → game, game → dashboard, account → dashboard.
6. **A heading must have something under it.** `h2` at `--t-lead` with a 2rem top
   margin is heavy; a page that is five `h2`s and one line each (`account.ts`) reads
   as a stack of dividers. Group related pairs under one heading.
7. **Long lists of people are chips or rows, never both patterns on one page.**
   Scanning → chips (`SQUAD_STYLES_CSS`). Acting on individuals → `ul.squad > li`
   rows with the controls behind `.member-actions`.

---

## 3. New CSS to add

Four blocks/rules. Each is a named export in `src/views/styles.ts`, added to
`PAGE_STYLE_BLOCKS`. Keep the existing file's commenting standard — say why, not
what.

### 3.1 `.capacity` — add to `FIXTURE_STYLES_CSS`

The headcount as a bar plus one line, replacing the standalone `.spots` sentence.
"0 spots left" reads as bad news to someone who is already in; a full bar reads as
a full squad. Keep the `.spots` text as the bar's label, so nothing is lost with
CSS off.

```css
.capacity { margin-top: 0.6rem; }
.capacity .track { height: 6px; border-radius: 3px; background: var(--line); overflow: hidden; }
.capacity .fill { display: block; height: 100%; background: var(--accent); }
.capacity .fill.short { background: var(--warn); }
.capacity .spots { margin-top: 0.35rem; font-size: var(--t-support); color: var(--mut); }
.capacity .count { font-family: var(--mono); }
```

Renderer: extend `renderStatusLine` in `src/views/fixture.ts` (already shared with
the dashboard, so both pages get it from one change). Width is `inCount / maxPlayers`
clamped to 100%; `.short` when `inCount < minPlayers`. Wording: `10 of 10 in ·
2 waiting`, and never a bare "0 spots left".

### 3.2 `.switch-row` — add to `FORM_CSS`

A bare checkbox with its label *underneath* is ambiguous about which label belongs
to which box, and is a 13px system-blue target in an otherwise green app. Applies
to `prefersEvenNumbers` and squad visibility in `src/views/game-form.ts`.

```css
.switch-row { display: grid; grid-template-columns: 1fr auto; align-items: center;
  gap: 0.25rem 1rem; min-height: 52px; padding: 0.6rem 0; border-bottom: 1px solid var(--line); }
.switch-row label { font-weight: 600; }
.switch-row .hint { grid-column: 1; font-size: var(--t-support); color: var(--mut); }
.switch-row input { grid-column: 2; grid-row: 1 / span 2; width: 1.4rem; height: 1.4rem; accent-color: var(--accent); }
```

Markup: `<label for>` first, real `<input type="checkbox" id>` second, `.hint`
third. One sentence of hint per row, mandatory — squad visibility has no visible
effect for the organiser, so the hint is the only place its meaning exists.

### 3.3 `.danger-link` — add to `STYLES`

A destructive action that is a link, not a submit: "Remove" inside
`.member-actions`. It is currently `--accent`, i.e. it looks like navigation.

```css
.danger-link { color: var(--danger); font-weight: 600; }
```

Used on links only, never on a `.button` — the filled-button separation rule in §0.8
still holds.

### 3.4 `INVITE_CSS` — new export, for `src/views/game-overview.ts`

The invite block becomes one bordered card, and the QR moves inside a
`<details>` — it is only wanted when somebody is standing next to you, and today
it is a 240px graphic between the link and the squad on every visit.

```css
.card { margin: 1.1rem 0; padding: 1rem; border: 1px solid var(--line); border-radius: 0.75rem; }
.card h2 { margin: 0 0 0.6rem; font-size: var(--t-body); }
.card .actions { margin-top: 0.75rem; }
.qr-toggle { margin: 0; border: 0; padding: 0; }
.qr-toggle summary { font-weight: 600; font-size: var(--t-support); color: var(--mut); cursor: pointer; }
```

Reuse the existing `.qr` and `.invite-link` rules from `FORM_CSS` inside it —
`game-overview.ts` already passes `FORM_CSS`, so pass both blocks.

---

## 4. Screen-by-screen work list

Ordered by user cost. Each item names the file, the change, and the reason. Do not
change wording except where a line is quoted as a replacement.

### P1

**`src/views/game-overview.ts`** — the organiser's home, currently the least
finished page in the app.
- Wrap invite link + QR + rotate in one `.card` (§3.4); QR inside `<details class="qr-toggle"><summary>Show the QR code</summary>`.
- "Replace this link" stays a form, but move it under the same card and leave it as the outlined default — it is not the page's primary action.
- Squad rows: keep `.member-actions`; give the Remove link `class="danger-link"` (§3.3).
- **"Coming up" must stop using `ul.squad`.** It is a fixture list, not people; reusing the squad class means a future squad-row rule silently restyles fixtures. Use `.fixture-list`/`.fixture-card` from `DASHBOARD_STYLES_CSS` at its compact end, or a plain `ul.fixtures` with its own two rules in `INVITE_CSS`.
- Lifecycle is currently printed raw (`fixture.lifecycle`) — map it to the same words `renderStatusLine` uses. A player-facing page must not surface an internal enum value.
- Add the `.back-link` to the dashboard.

**`src/views/dashboard.ts` + `DASHBOARD_STYLES_CSS`**
- Remove the centred `h2` (§2.1).
- Adopt `.capacity` via `renderStatusLine` (§3.1) — this is the page where "0 spots left" appears three times in a column.
- "Games you own" `ul.owned-games` has no rules at all: give it the `ul.squad > li` row shape or reuse `.card`. Today it is a browser-default bulleted list, the only one in the app.

**`src/views/game-form.ts`** — apply `.switch-row` (§3.2) to both checkboxes.

### P2

**`src/views/join.ts`** — reorder the invite page: details, then **the form**, then
"Who's playing (14)" as social proof at the foot. Someone scanning a QR code in a
car park should not scroll past fourteen names to reach two fields. Render the
squad as chips (`SQUAD_STYLES_CSS`, neutral `.chip`), not `ul.squad` rows — nothing
on this page acts on a person. Keep `redactName` at the point of interpolation.

**`src/views/remove-member.ts`** — the destructive button is right; the escape is a
bare `<p><a>`. Give it the `.keep-link` treatment `cancel.ts` uses so the pair
reads as a matched set, and pass `CANCEL_STYLES_CSS`. Keep the wording ("No, leave
the squad as it is") — it is better than anything a rewrite would produce.

**`src/views/leave.ts`** — `otherGamesBody` renders a bare `<ul>` with a `.button`
inside each `<li>`: unstyled, full-width buttons, one per game. Use `ul class="squad"`
so the existing grid row shape applies, and add the `.back-link`. The
`confirmBody` organiser warning stays `.nudge`.

**`src/views/account.ts`** — five `h2`s with one line each. Merge "Your email
address" and "How you sign in" under one "Signing in" heading, and drop
`.read-only`'s dashed border for the email value: a dashed box means "you cannot
act on this here", which is right for the empty fixtures state and wrong for a
value you are reading out. Leave the `.fixture-card`s as they are (they are
correct already, and `.capacity` does not apply to a history row). Keep the
erasure `.nudge` exactly as it is.

**`src/views/squad-member.ts`** — same `.read-only` misuse for email and role; use
plain `<p>` with the label in `--mut` above the value.

### P3

**`src/views/signin.ts`** — correct already. Confirm the five `centred: true` states
are all genuinely terminal statements (they are) and leave them.

**`src/views/team-picker.ts`** — `.your-side` at `--t-lead`/`--accent` is right.
Check the two `.button.primary` submits are never rendered together ("Publish
teams" and "Save teams").

**`src/views/privacy.ts`, `src/views/delete-account.ts`, `src/views/passkeys.ts`** —
no visual work. `delete-account.ts` renders `.button.danger` and `.button.primary`
on the same page: **verify they are in mutually exclusive states** (§0.8). If any
state shows both, demote the "Keep my account" one to the outlined default.

---

## 5. Acceptance

- `npm test` green, including `test/security/csp.test.ts` — the block-enumeration
  check is what catches a `<style>` that would be dropped in production.
- `test/views/layout.test.ts`: add a case asserting no view passes `centred: true`
  except the enumerated terminal ones.
- Browser suite: `test/browser/layout.spec.ts` and the visual captures in
  `test/browser/catalogue.spec.ts` at 390px. Two failures the string assertions
  cannot see, both of which have happened before: a row whose shape depends on the
  length of the name in it, and a control that is invisible because its fill sits
  on top of its track.
- Re-capture `docs/guide/images/*` (`test/browser/guide-capture.spec.ts`) once the
  P1 screens change, or the guide shows the old UI.
- Manual, at 390px, light **and** dark: every screen has one primary action; no red
  and green filled button on the same screen; every session page has a back link;
  no centred body text outside the terminal pages.

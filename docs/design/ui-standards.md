# UI standards

The rules a new or changed screen is held to. Three kinds, in descending order of how hard
they are to break:

1. **Product constraints** — designs that undo these are rejected.
2. **Design rules** — how screens are built. Some are enforced by tests; the rest are enforced
   by review against this page.
3. **Review checklist** — what to look at before a UI change is called done.

The last section lists where the shipped app does not yet meet these rules, so nobody mistakes
an existing inconsistency for a precedent.

Current as of 23 September 2026 (after M66). The design rules come from the September design
review (`docs/history/2026-09-06-design-review/`), adopted here as standards; the constraints
and the enforced rules come from the M20 and M52 work that `screens.md` used to record.

## 1. Product constraints

- **The email button must not record the answer.** Mail scanners and link prefetchers follow
  links, so the tap in the email opens the response page and a second tap there saves. Since
  M65 the email carries one link, and changing an answer shortly after giving it asks first.
- **Anti-enumeration.** The sign-in success page never says whether an address exists; every
  personal-token failure and unhandled error shares one "This link isn't working" page; a dead
  invite link and any entitlement refusal answer the same 404, "We can't find that page" —
  never a 403.
- **Token pages never show push endpoints or device lists.** The signed-in account page is the
  only place a registered device appears.
- **Organiser and player views are separate renderers**, so organiser capability cannot leak
  into a player's page by accident. Restyle either; never merge them into one template with
  conditionals.
- **Squad visibility off means no names anywhere a player can see** — bare counts only, and no
  Standings. Organisers always see names. (The picker page is an open question — see
  [below](#where-the-app-does-not-meet-them-yet).)
- **Server-rendered core.** Every core flow works with scripting off. Script is sugar: copy
  buttons, QR disclosure, drag-and-drop picking, install prompt, push, passkeys, the update
  overlay and the freshness reload. Passkeys and push are JS-only by nature and degrade to
  nothing rather than to a broken control.
- **Email is a first-class surface.** The reminder, promotion, teams-are-up, short-of-players
  (the only route to calling a fixture off), cancellation and welcome emails carry the app's
  primary actions. Design them as screens.

## 2. Design rules

Rules marked **(tested)** fail a test when broken. The rest are held by review.

### Page shell

- Signed-in pages carry the site header and start directly beneath it — short pages do not
  float in the middle of the screen. **(tested, M52)**
- Token and public pages have **no header**: their visitors often hold no session, and a
  `Games` link that bounces to sign-in is worse than none. `/r/:token` shows it when the
  visitor happens to be signed in.
- No breadcrumbs. A page below a game or fixture ends in exactly one text back-link naming
  where it goes; top-level pages rely on the header.
- Long names wrap; they never push navigation or actions off-screen.

### Spacing and surfaces

- Use the 4 / 8 / 12 / 16 / 24 / 32px scale: 24–32px between tasks, 12–16px inside one,
  16–20px card padding.
- A card encloses a task; a rule separates rows in a list. No card inside a card.
- A reader should be able to name each task on a page without reading its form fields.

### Action hierarchy

- **Primary** (accent fill): the next committing action in the active task — one per task.
- **Neutral** (`--field` fill): reversible edits.
- **Text link**: navigation.
- **Danger**: irreversible actions only, and only on a confirmation page that spells out the
  consequence in prose. (Removing a guest is the one immediate destructive action.)
- Save, publish and message actions must not look interchangeable. Make the server consequence
  clear: "Save teams" is not "Publish teams".

### Form controls

- Native inputs, a visible label above each, and one field treatment: `--field` ground, 1px
  resting border, 0.75rem radius. A text input always has a resting border — beside a select
  a borderless input reads as disabled. **(tested, M52)**
- Visible focus on everything focusable; the whole label activates its control.
- Touch targets at least 44px; primary buttons and switch rows 52px.
- Result inputs and team choices should look like the rest of the app, not a separate kit.

### Status and colour

- **One selected state:** what the viewer chose is `--fg` fill; what they did not is `--field`.
  Accent means "the action to take", never "the thing you picked".

- **Words carry meaning; colour reinforces it.** Selected side, your own answer, a fixture's
  status and an unsaved draft are each distinguishable without colour.
- **Green is reserved for success and confirmation, amber for the waitlist and attention, red
  for irreversible actions.** Every status badge is enumerated with the family it may use,
  and "needs more players" may never look like "open". **(tested)**
- Team sides need their own identity, separate from status: a green side is not "correct" and
  an amber side is not a warning. (Not built yet — see below.)
- The viewer's own row in a table is **marked where it falls, never moved** to the top.
- An empty capacity track is a groove, not a bar that reads as full. **(tested)**
- Font sizes come only from `--t-title`, `--t-lead`, `--t-body`, `--t-support`. **(tested)**
- Text and surface pairs meet their contrast floors in both themes. **(tested, for the pairs
  listed in `test/views/contrast.test.ts`)**

### Disclosure

- Collapse secondary tools, never a decision the page is asking for.
- A closed disclosure shows a useful summary.
- Open it automatically for a validation error, a pending hand-over or an active exception.
- Values in a closed section survive validation and saving; keyboard and no-script use still
  work.

### Feedback

- Put a receipt beside the task that changed: "Draft saved. Nobody notified."
- Name the actual outcome and channel. Never claim delivery when a message is only queued, and
  never promise an email when that channel is switched off.
- Pages whose facts move while open carry the freshness bar ("Updated 3 minutes ago ·
  Refresh"). It is distinct from the update overlay, which is about a new deploy.

### Styling mechanics

See [Design system → How styling is wired](design-system.md#how-styling-is-wired-and-the-rules-the-code-enforces):
registered style blocks only, no `style=` attributes, cascade order is array order.

## 3. Review checklist

Before a UI change is done:

- [ ] **Look at the rendered page** in the task that changed it — capture it and read the PNG.
      String assertions cannot see an unstyled input or a control lost against its track.
- [ ] Check at 320, 390 and 768px, desktop, and 200% text zoom: no page-wide horizontal scroll,
      no clipped actions. Try a long name and a long team name.
- [ ] Check the busy, empty and error states — not only the happy path. For team picking:
      unassigned, partly assigned, saved, published, changed after publishing, over capacity,
      with a guest, with a delegated picker. For results: empty, proposed, disputed, already
      backed, withdrawn, locked, no agreed score.
- [ ] Check dark mode.
- [ ] If a guide screen changed, update its chapter in the same commit and run
      `npm run guide:capture` (it is not run by CI — see `docs/runbooks/browser-testing.md`).
- [ ] Update [Information architecture](information-architecture.md) if a page was added,
      removed, or changed who can reach it.

## Where the app does not meet them yet

Known departures, found on 23 September 2026. Fixing one is welcome; copying one is not.

**Defects**

1. **Accent text is below 4.5:1 in light mode** — `--accent` on `--bg` is 2.84:1, on
   `--accent-mut` 2.91:1. Used as normal-size text by `.your-side`, `.chip-in`,
   `.squad .status-in`, `.this-device`, `.door-open` and the `.button.expected` label. The
   contrast test floors that pair at 2.5 only. Dark mode passes.

2. **Squad visibility and the picker page — decision needed.** The picker page shows every
   name regardless of `Let players see who else is playing`: the "in" players to any picker
   since M29, and since M66 the whole roster to a named delegate. Picking sides needs names,
   so this may be intended, but it is not recorded as an exception anywhere.
3. **Sorting Standings in `See this as a player` drops the preview.** The sort link replaces
   the query string, so `?as=player` is lost and the organiser view comes back. Read from the
   markup, not reproduced.

**Inconsistencies**

4. **Nine text-input treatments** instead of one. `.result-score`, the notification timing
   inputs and `.invite-link` are borderless; `.signin` and `.invite-add` use a 2px border on
   `--bg`; the cancel textarea, device-name input and invite selects use a 1px border on
   `--bg` with smaller radii.
5. **Four warning boxes** that mean the same thing: `.nudge`, `.form-error`, `.problem` (the
   last two declared identically in two blocks) and `.usage-warning`.
6. **Compact buttons are redefined locally** at least five times with different paddings and
   weights (update overlay, onboarding, squad rows, team workspace, device rows).
7. **No shared card primitive.** About twenty card surfaces use four raised and four bordered
   radii and nearly as many paddings; the design-system radii are 999px, 1.25rem and 0.75rem,
   but nineteen distinct values exist.
8. **No team identity tokens.** Sides are drawn with the `--fg` / `--bg` inversion.
9. **Focus and touch-target gaps.** No custom focus style on plain links, the generic
   `summary`, checkboxes, `.invite-remove`, `.result-withdraw` and several invite inputs. No
   44px floor on `.invite-remove`, `.result-withdraw`, `.danger-link`, the generic summaries
   and the WhatsApp option checkboxes.
10. **No global `h3`.** Each component sets its own, and `.team-workspace h3` gets the browser
   default size.
11. **Hard-coded colours** outside the tokens: the update toast's shadow, the manifest's
    `background_color` (`#fbfaf8`, matching no surface), the app icon, the QR code, and the
    email templates' inline palette.
12. **The invite-order counter asks for IBM Plex Mono at weight 600**, which is not loaded.
13. **Stale CSS comments** describe a dashed `.read-only` border, an accent confirmed badge
    and an outlined default button, none of which exist any more.
14. **`.keep-link` lives in `CANCEL_STYLES_CSS`**, so three other confirmation pages load the
    whole cancel block for one rule.

**Data seen only in the guide's captures**

14. The fixture timeline shows every answer at the same minute because the guide's seed posts
    them within seconds. A capture artefact, not a product issue.

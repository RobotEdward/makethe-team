# The visual product guide — design

**Date:** 13 August 2026
**Status:** approved

## 1. What this is

`docs/guide/` — markdown chapters, each following one of the core journeys in
`docs/superpowers/specs/2026-08-10-make-the-team-design.md` §1.9, illustrated
with phone-width screenshots taken from a real browser. It renders on GitHub
with no build step.

It reuses the page catalogue built for the browser suite
(`docs/superpowers/specs/2026-08-13-browser-testing-design.md` §4). That is the
point of the catalogue: one list of the app's pages, with the console gate, the
visual capture and this guide as its three consumers, so a page cannot be
documented without being CSP-checked or checked without being documented.

## 2. Audience

Written **for a squad organiser**, in plain language, from the first draft.

Its first use is design review — reading the product back as a whole and
finding what is wrong with it. Its eventual use is onboarding. Writing for the
eventual reader costs nothing now and avoids a rewrite: design review works
perfectly well against a document written for users, and the reverse does not.

No jargon from the codebase. A reader meets "waitlist" and "organiser", which
are product words (§1.7 of the master spec); they never meet "BR-6", "fixture
lifecycle", or a route pattern.

## 3. Only what is built

Every sentence and every screenshot describes behaviour that exists in
production today. Nothing describes a plan.

This has one sharp consequence that must not be quietly softened. The master
spec's **J6 — Owner intervenes** describes an owner marking a player `in` on
their behalf and adding a one-off guest. **Neither exists** — both belong to
J6b, unbuilt as of this date. So chapter 05 covers roles, removal, editing a
game and rotating the invite link, and does not mention the others at all. It
does not say "coming soon"; a guide that documents intentions cannot be trusted
about anything else.

The same rule applies to the gaps in `docs/known-issues.md`: the guide does not
list them. It is a guide, not a status report.

## 4. Architecture: capture is scripted, prose is written

Two halves, deliberately separate.

**The generator** (`test/browser/guide-capture.spec.ts`, a `@guide`-tagged
Playwright project) builds the guide world, walks the shot list, writes PNGs to
`docs/guide/images/`, and emits `docs/guide/manifest.json`.

**The prose** (`docs/guide/*.md`) is ordinary markdown, committed, edited by
hand or by an agent working from the manifest.

Regenerating updates images and the manifest and never touches the words. If
the two were fused, every regeneration would overwrite the writing, and the
prose could never accumulate quality past whatever the last run produced. This
is the single most important property of the design.

### 4.1 The manifest

`manifest.json` is the agent's input and the tests' subject. Per shot:

```json
{
  "id": "game-overview-full",
  "chapter": "05-running-your-squad",
  "title": "The game overview",
  "route": "/g/:id",
  "image": "images/game-overview-full.png",
  "shows": "A squad of thirteen with the organiser marked, and five upcoming fixtures"
}
```

`shows` is written by hand in the shot list, not derived. It is what lets an
agent write accurate prose without loading every image.

No timestamps in the manifest: a captured-at field would change on every run
and make the file churn for no reason.

## 5. The guide world

Its own seed (`test/browser/guide-world.ts`), separate from `seedWorld`, and
built by driving the app's own surface rather than inserting rows — the same
reasoning as the browser suite: a hand-built world can be internally
inconsistent in ways a real one cannot, and this world is what a public
document then depicts.

Shape:

- One game, **max 10 players**, min 8, with a venue and a weekly recurrence.
- Twelve players join through `/j/:token`, each with an invented name and an
  `@example.test` address. With the organiser, who is a member of their own
  squad, that is a **squad of thirteen**.
- Responses are posted through minted response tokens until **ten are in, two
  are waitlisted, and one has answered "can't make it"** — thirteen answers,
  one per member, which is why the squad is thirteen and not twelve.
- One fixture is open; the rest are scheduled.

That one world illustrates a squad, a fixture filling up, the waitlist and a
dropout — most of what the product exists to do. Chapter 06 additionally needs
an owner cancel token, minted the same way.

**Nothing may resemble a real person.** Invented names, `@example.test`
addresses, no real venue tied to anyone, and never the author's address. This
is a public repository and the screenshots are permanent.

## 6. Chapters

```
docs/guide/
  README.md                      what Make The Team is, and the short version
  01-setting-up-a-game.md        J1     sign in, create a game
  02-inviting-your-squad.md      J1     invite link and QR, what a player sees
  03-answering-a-reminder.md     J2,J3  responding, filling up, the waitlist
  04-when-someone-drops-out.md   J4     changing an answer, leaving a game
  05-running-your-squad.md       J6*    roles, removal, editing, rotation
  06-calling-a-fixture-off.md    J5     the owner nudge, cancelling
  07-your-own-fixtures.md        J7     the dashboard, passkeys
  images/
  manifest.json
```

`README.md` is the entry point and links the chapters in order. Each chapter
opens with what the reader is trying to do, walks the screens in sequence, and
ends where the journey ends.

### 6.1 Catalogue additions

Chapters 04 and 06 need `/leave/:token` and `/cancel/:token`, both currently in
`NOT_CATALOGUED` because neither is reachable without a minted token. The guide
world mints both, so they move into the catalogue.

**This is a gain beyond the guide:** it puts two pages under the console and
CSP gate for the first time. Both are reached from an email by someone with no
session, which is exactly the population least able to report a broken page.

## 7. Images

Phone width (390px), one per shot, full page, `deviceScaleFactor: 1`.

Phone is how players actually use this, and it halves both the byte count and
the churn against capturing two widths. The organiser-facing pages are legible
at 390px — confirmed by the captures taken during the browser-testing work.

Optimised with Pillow, which is already present on the build machine, so this
adds no dependency. Expect roughly fifteen images at ~40KB each, under 600KB in
total.

**Written only when the bytes change.** The generator hashes each new capture
against the file on disk and skips identical ones, so a regeneration produces a
diff containing only what actually moved.

### 7.1 Churn that is accepted, not solved

Three shots show the invite URL, which contains a freshly generated token, so
they change on every regeneration.

This is deliberate. Masking the URL would put a grey box in the middle of the
page a reader most needs to understand. Pinning the ids means hand-building the
world in SQL instead of driving the app, which trades a real correctness
property for about 180KB. Neither is worth it. The images churn; the diff stays
readable because everything else does not.

Dates need no such handling: the app renders absolute dates through
`Intl.DateTimeFormat` with an explicit timezone and has no relative
"in 3 days" formatting anywhere, so a fixed seed renders identically over time.

## 8. Testing

The guide is a public artefact, so its failure modes are broken images and
statements that stopped being true. Three checks, each cheap:

1. **The capture run itself.** Every shot asserts its page loaded and that a
   named element is present before the screenshot — so a screen that has
   changed shape fails the run rather than silently producing a picture of an
   error page.
2. **No broken images.** Every image path referenced in `docs/guide/*.md`
   exists on disk.
3. **No orphans.** Every image in `docs/guide/images/` is referenced by some
   chapter, and every manifest entry has both. A renamed shot cannot leave a
   broken reference in a public document, and a deleted chapter cannot leave
   stale pictures behind.

Checks 2 and 3 are plain Node tests and run in the ordinary suite; they need no
browser. The capture run is `@guide`-tagged and excluded from CI for the same
reason `@capture` is — it writes files and asserts little.

**The guide's prose is not machine-checked.** Nothing verifies that a sentence
still describes the screen beside it. The mitigation is procedural and stated
here so it is not mistaken for an oversight: when a page's behaviour changes,
its chapter is updated in the same commit, and the capture is re-run.

## 9. Not in this spec

- Pixel diffing or visual regression assertions.
- Desktop-width captures.
- Documenting anything unbuilt, including all of J6b.
- A README for the repository itself. The repo has none, which is worth fixing,
  but it is a different document with a different audience — a developer, not
  an organiser — and folding it in would compromise both.
- Any change to the product. If the guide reveals that a screen is confusing —
  and it may, since reading a product back is what design review is for — that
  is a finding recorded in `docs/known-issues.md`, not a fix smuggled into this
  work.

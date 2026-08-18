# Make The Team — working notes for Claude

## Commands

```bash
npm test          # full suite, >120s — wait for it, never background it and end the turn
npx vitest run <path>   # scoped, ~9s
npx playwright test     # browser suite, ~5min
npm run guide:capture   # regenerates docs/guide/images/*
npm run lint && npx tsc --noEmit
```

Milestone work happens in a sibling worktree (`../maketheteam-<id>`), merged fast-forward to
`main`. **Pushing `main` deploys to production.** A worktree needs its own `npm install`; do not
add an `allowScripts` block to `package.json` to make it work.

## Failures this codebase makes silently

Each of these has shipped at least once. None is caught by a fetch-level test.

- **A `<style>` block not in `PAGE_STYLE_BLOCKS` is dropped by the browser.** `src/security/csp.ts`
  hashes exactly `STYLE_BLOCKS` for `style-src`. The CSS simply does not apply in production and
  every test passes. Adding a block and forgetting to register it is the classic.
- **`pageStyles` array order IS cascade order.** `layout()` joins them in order, so at equal
  specificity the later block wins. `SQUAD_STYLES_CSS` and `FORM_CSS` both declare `ul.squad > li`
  at (0,1,1) — flex versus grid — and the grid is intended. `test/views/style-cascade.test.ts`
  enumerates every collision; if it fails, reorder the array or list the collision with a reason.
  **It only sees two blocks declaring the *same* selector.** Two blocks styling one element through
  *different* selectors at equal specificity — `.keep-link` against `.button`, say — are invisible
  to it and still need their own test, as `test/views/remove-member.test.ts` has.
- **A `style="…"` attribute is stripped.** `style-src` is hash-only with no `style-src-attr`, and a
  hash cannot authorise an attribute. Use a declared class. Never add `'unsafe-inline'`
  or `'unsafe-hashes'`.
- **A stored value indexing a lookup table can be `undefined`.** `fixtures.lifecycle`,
  `responses.status` and `responses.team` are all `text NOT NULL` with **no CHECK constraint**, so
  the TypeScript type is a claim about the schema, not a guarantee about the rows. `escapeHtml(undefined)`
  throws and 500s the page. This shipped six times in one milestone.
  `test/stored-lookups.test.ts` enumerates every such lookup — add new ones there.
- **A backtick inside a CSS comment in `styles.ts` terminates the template literal.** `tsc` reports
  only a bare `TS1005`, at a confusing location.
- **A comment inside a style block ships to the browser as page content**, so quoting UI copy there
  can turn unrelated "this string is absent" tests red.
- **`toContain` on a generated numeric class family prefix-matches** — `.w-5` is satisfied by
  `.w-50`'s rule. Put the delimiter in the needle (`.w-5 {`).
- **An order-pinning test passes vacuously when a block is absent** — `indexOf` returns `-1`, and
  `-1 < anything`. Pair it with a presence assertion.
- **An injected builtin called as a method throws `Illegal invocation`.** A field holding the global
  `fetch` and called as `this.fetchImpl(...)` gets the instance as its receiver, which a Workers
  builtin refuses — the request never leaves the isolate. Every push of every type failed this way
  from M14 until it was found in production `notification_log`. **An arrow-function stub cannot
  catch it**: its `this` is lexical, so it reads a method call and a free call identically. Stub
  such a dependency with an ordinary function that checks its receiver, as
  `test/notify/push-notifier.test.ts` does. Detach before calling (`const send = this.fetchImpl`).

## Working on a milestone

Four rules, each earned the expensive way. Fuller version with the evidence in
`docs/superpowers/milestone-workflow.md`.

1. **Global invariants get a test before feature work starts**, not after the fourth rediscovery.
   If a spec states a rule that holds across pages, write the enumerating test as task zero.
2. **When a review names a defect *class*, the class guard ships in that same round.** Not "recorded
   as a follow-up". Patching one instance and parking the class is how the same crash reached
   production six times in one branch.
3. **Look at the rendered page inside the task that changed it.** String assertions cannot see an
   unstyled input, a control invisible against its track, or a row whose shape depends on its
   content. Capture the one page you touched and read the PNG.
4. **Do not put a detail in a brief you have not read from source.** Line numbers, sample assertions
   and remembered strings go stale between tasks; a wrong one costs a correction round-trip.
   "Find X in this file" is shorter and cannot be wrong.

## Process calibration

Most work here is the brainstorming skill's **bounded** path: short design in
chat, approval, implement — no spec file, no plan document, no subagent
fan-out. Classifying a task as **architectural** (spec doc + implementation
plan + subagent execution) requires the maintainer's explicit agreement to
that classification first — state what makes it architectural and wait.
Subagents pay off above roughly three independent workstreams; below that,
implement in the main context.

## Conventions

- Comments name the failure a rule prevents; they do not restate the code. A comment that overclaims
  is worse than none — several were rejected in review for describing effects that did not exist.
- Every interpolation goes through `escapeHtml`, including `href` and class attributes.
- All timezone conversion goes through `formatLocalDateTime` (TR-5).
- Guards establish *who*; entitlement is re-asked per handler, and a refusal is a 404, not a 403 (TR-18).
- `docs/known-issues.md` records deliberate non-fixes with their reasoning, so nobody re-litigates them.

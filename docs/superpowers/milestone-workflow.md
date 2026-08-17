# Milestone workflow — what M12 cost, and what to do differently

Written 17 August 2026, immediately after M12 (visual standards across twelve views) merged.
Kept because the milestone's cost was lopsided in a way worth not repeating, and because the
evidence is concrete rather than a matter of taste.

`CLAUDE.md` carries the short version. This file is the argument behind it.

---

## What happened

M12 ran as eleven tasks with a fresh subagent per task, a spec-and-quality review after each, and a
whole-branch review at the end. Roughly 26 agent dispatches. It shipped: the capacity bar, the
finished organiser page, switch rows, the reordered invite page, the read-out treatment, and the
audits — plus, incidentally, **six live 500-crashes and a horizontally-scrolling page that already
existed in `main` before the milestone started**, three of them on pages an earlier milestone had
already covered.

The distribution of effort was not proportionate to the distribution of work:

| | Share |
|---|---|
| The final three fix rounds | **~840k subagent tokens, over a third of the milestone** |
| What those rounds were fixing | Instances of a defect class identified and named at **task four** |

The ledger records, against task four:

> a CHECK constraint on `fixtures.lifecycle` would close this crash class at source rather than one
> call site at a time

We then fixed one call site and moved on. Five more instances survived nine tasks, eleven per-task
reviews, and a whole-branch review — including one three lines below the first fix, and one that
would have put the literal string `undefined` into an email to an entire squad.

## Where defects were actually caught

| Caught by | What | Could it have been an inner-loop test? |
|---|---|---|
| Whole-branch review, then a scoped re-review | six unguarded lookups → 500s on the dashboard, the organiser's fixture page, the account page, the player's fixture page | **Yes** — `test/stored-lookups.test.ts`, which we eventually wrote |
| A human opening a PNG | squad rows visibly broken; an unstyled guest input; a guide screenshot containing the wrong control entirely | **Partly** — a per-task capture-and-read |
| Four separate tasks, independently | `pageStyles` cascade order | **Yes** — `test/views/style-cascade.test.ts`, which we eventually wrote |

**The pattern: we built the right guards, in the wrong order.** Two of the three tests that would
have prevented the expensive rounds were written *by* those rounds. They were the output of the
discovery instead of the input to it.

## The four rules, and what each is worth

### 1. Global invariants get a test before feature work

If the spec states a rule that holds across pages — "every page behind a session has one back link",
"one primary action per screen", "these two blocks must be ordered this way" — the enumerating test
is task zero, not a per-page assertion written eleven times.

*Evidence:* the `ul.squad > li` cascade collision was discovered, diagnosed and fixed four separate
times on four pages, by four different agents, none of whom could see the others. Each wrote its own
ad-hoc order-pinning test. The fifth page was still wrong at the whole-branch review — and it was the
page the rule had originally been written for.

### 2. A named defect class gets its guard in the same round

When a finding is phrased as "this *shape* of thing is unsafe", the fix is an enumerating test, not
a patch to one site. Recording the class as a follow-up and patching the instance is the single most
expensive decision available.

*Evidence:* six instances of `STORED_VALUE[table]` with no fallback. Found at tasks 4, then the
whole-branch review, then twice more in a re-review that was explicitly told to *assume another
instance existed until it had looked*, then twice more again in the round after that. The final round
wrote `test/stored-lookups.test.ts`, which caught one of them while it was being written.

### 3. Look at the rendered page inside the task that changed it

String assertions cannot see an unstyled input, a control invisible because its fill sits on its
track, a row whose shape depends on its content, or a screenshot that captured the wrong element.

*Evidence:* M11 shipped three user-visible defects past a green 1404-test suite and eight clean
reviews; all three were found only by opening the images. M12 then did it again: 1524 green tests and
a clean whole-branch review, and the organiser's main working surface had a control stretched across
the wrong grid column. Task 11 separately found a guide screenshot that had silently captured a
photograph of the Replace button and shipped it captioned as the QR code — the locator resolved, a
bounding box came back, nothing failed.

Full Playwright is ~5 minutes and too slow per task. Capturing **one** page at 390px is seconds, and
the agent can read the PNG directly.

### 4. Briefs carry nothing unverified

*Evidence:* four dispatch briefs carried a wrong technical claim — a stale line number, a sample
assertion that could never match the markup it described, a cascade description that was simply
wrong. Each cost a correction round-trip. All four were details supplied *unnecessarily*; "find the
raw lifecycle interpolation in this file" would have been shorter and could not have been wrong.

The instruction that saved them — *verify my description rather than restate it; if I have it wrong,
write what is true and say so* — is worth keeping in every dispatch regardless. Implementers used it
to correct the controller four times and a reviewer twice, and were right every time.

## Two smaller economies

**Right-size review to risk.** Three tasks (the centred guard, the dashboard list, the switch rows)
were each one small change, each got a full implementer-plus-reviewer cycle, and all three came back
approved with no findings. Full subagent review earns its place on tasks touching shared code,
changing a type, or carrying a security property — which is exactly where it *did* earn it.

**Batch small same-shape work.** Those same three could have been one dispatch and a diff read by
the controller.

## What to keep

- **The ledger.** It survived a context compaction and was the only reason nothing was lost. Every
  ruling recorded with its reasoning and what it costs if wrong.
- **Adversarial review framing.** "Assume there is a third instance until you have looked" produced
  the best catch of the milestone. "Verify this claim rather than accept it" produced the second.
- **Implementers overruling the controller.** Six corrections, all correct. A brief should invite it.
- **One implementer at a time**, or genuinely isolated worktrees. Running two concurrently once
  nearly lost a half-finished crash fix to another agent's `git add -A`; it was caught by that
  agent's own diligence, not by design.

## Honest caveat

Not all of this was waste. Six live crashes and a page that scrolled sideways on a phone were real
discoveries, and finding them was the point. The estimate is that **roughly a third** of the effort
was avoidable — not most of it.

# `Cache-Control` on the Token Routes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The three token-bearing routes reached from an email answer with `Cache-Control: private, no-store`, and a test derived from the app's own route table stops a fourth ever shipping without it.

**Architecture:** Three middleware mounts in `src/app.ts`, identical in shape to the `/j/*` mount that already exists. The guard test enumerates `createApp().routes`, selects every registered path containing `:token`, and asserts the header on each — deriving the list rather than restating it, because a hand-written list is exactly how the current gap arose.

**Tech Stack:** TypeScript strict, Cloudflare Workers, Hono, Vitest with `@cloudflare/vitest-pool-workers`.

**Spec:** `docs/superpowers/specs/2026-08-14-token-route-cache-control-design.md`.

**This plan is deliberately one task.** The test and the mounts are a single TDD cycle — the test is written first and must fail — and the documentation corrections are consequences of the same change. There is no seam where a reviewer could accept one half and reject the other.

## Global Constraints

- The header string is exactly `private, no-store` — the same string the four existing mounts use (`AUTHENTICATED_PREFIX`, `GAMES_PREFIX`, `/j/*`). One caching vocabulary, not two.
- Middleware runs **after** the handler (`await next()` first), so the header applies to every outcome including invalid tokens, 404s and 403s. Do not reorder this.
- **Do not make the `AUTHENTICATED_PREFIX` mount global.** Its doc comment explains the blast-radius reasoning and that reasoning stays correct.
- **No change to `/j/*`**, which already carries the header.
- No caching headers anywhere else. The holding page and `robots.txt` are genuinely cacheable and keep today's behaviour — `test/routes/access.test.ts` has a test asserting the holding page carries no `Cache-Control`, and that test must still pass.
- Never bare `new Date()` — ESLint's `no-restricted-syntax` bans it. (Nothing here needs a clock.)
- Commit messages: lower-case conventional prefix, imperative, no trailing period on the subject.
- Never `git add -A`. Stage explicit paths only.
- Do not commit if `npm run lint` or `npm run typecheck` fails. Chain with `&&`, never `;`.
- Run long commands in the foreground with a raised tool timeout. `npm test` takes ~100s.

## File Structure

**Modified**
- `src/app.ts` — three new middleware mounts, and one stale clause corrected in an existing comment.
- `docs/known-issues.md` — close the row.

**Created**
- `test/routes/cache-control.test.ts` — the guard test. Its own file rather than an addition to `access.test.ts`: that file is about what an unauthenticated visitor may reach, and this is about a header applied across a class of routes. They fail for different reasons and should be findable separately.

---

### Task 1: The header, and the test that keeps it

**Spec:** §3, §4, §5.

**Files:**
- Create: `test/routes/cache-control.test.ts`
- Modify: `src/app.ts` (the mounts, and the comment at lines 28-33)
- Modify: `docs/known-issues.md`

**Interfaces:**
- Consumes: `createApp()` from `src/app.ts`, already exported.
- Produces: nothing other tasks depend on.

**What the route table looks like.** `createApp().routes` is an array of `{ method, path, handler }`. `test/routes/signin.test.ts`'s `pinRoutesToPages` already reads it the same way, so the shape is established. Middleware appears as entries with `method: "ALL"` and a path ending `/*`; real handlers appear with their verb. The token-bearing handler routes registered today are:

```
GET  /r/:token          POST /r/:token
GET  /leave/:token
GET  /cancel/:token     POST /cancel/:token
GET  /j/:token          POST /j/:token
```

- [ ] **Step 1: Write the failing guard test**

Create `test/routes/cache-control.test.ts`:

```ts
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";

/**
 * Every route that takes a `:token` is reached from an email by somebody with
 * no session, and each of them must answer `private, no-store`.
 *
 * **The route list is derived from the application, never restated here.**
 * That is the whole point of this file. The gap this test closes arose exactly
 * because a hand-maintained list drifted: `/j/*` was given the header in M6a
 * and its three neighbours were not, and nothing noticed for two milestones. A
 * test carrying its own list of token routes would pass forever while a fifth
 * route shipped bare.
 *
 * An invalid token is deliberate and sufficient. The middleware runs *after*
 * the handler, so the header is applied to whatever the handler produced —
 * `/r/`, `/leave/` and `/cancel/` render a link-problem page at 200 for a bad
 * token, and `/j/` answers 404. No fixture, no player and no valid token needs
 * to exist for this to be a real check.
 */
const TOKEN_ROUTES = createApp()
  .routes.filter((route) => route.path.includes(":token"))
  .map((route) => ({ method: route.method, path: route.path }));

describe("Cache-Control on token routes", () => {
  it("finds the token routes it is supposed to be guarding", () => {
    // A guard whose subject list has silently become empty passes every other
    // assertion in this file vacuously — `it.each([])` runs nothing and the
    // suite still goes green. This is the only assertion standing between that
    // and a false sense of coverage.
    //
    // A floor, deliberately, rather than an exact set: a new token route
    // should be picked up and checked automatically, not fail a test that has
    // nothing to say about it. The `it.each` below is what covers it.
    expect(TOKEN_ROUTES.length).toBeGreaterThanOrEqual(7);
    expect(new Set(TOKEN_ROUTES.map((r) => r.path))).toContain("/r/:token");
  });

  it.each(TOKEN_ROUTES)("$method $path answers private, no-store", async ({ method, path }) => {
    const url = `https://makethe.team${path.replace(":token", "not-a-real-token")}`;
    const response = await SELF.fetch(
      new Request(url, {
        method,
        ...(method === "POST"
          ? {
              body: new URLSearchParams({ intent: "in" }),
              headers: { "content-type": "application/x-www-form-urlencoded" },
            }
          : {}),
      }),
    );

    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/routes/cache-control.test.ts`

Expected: the first test passes (the routes exist), and the `/r/`, `/leave/` and `/cancel/` cases FAIL with `expected null to be "private, no-store"`. The two `/j/:token` cases should already PASS — that mount exists. **If a `/j/` case fails, stop and report it**: something is wrong beyond this plan's scope.

- [ ] **Step 3: Add the three mounts**

In `src/app.ts`, immediately after the existing `/j/*` mount, add three mounts. Each carries **its own** reason — do not write one shared comment for all three, because they are not the same argument:

```ts
  // The response page. Confidentiality *and* staleness: it renders full names
  // and every player's current answer, and that state changes on every tap, so
  // a cached copy is wrong almost immediately and can still be served.
  app.use("/r/*", async (c, next) => {
    await next();
    c.header("Cache-Control", "private, no-store");
  });

  // The leave page. Reached by the same population from the same emails, and
  // it names the Game. It performs no write today (BR-22's self-service leave
  // is M7), so the argument is weaker than its two neighbours' — but a visitor
  // with no session has no way to tell that a page they were served is stale.
  app.use("/leave/*", async (c, next) => {
    await next();
    c.header("Cache-Control", "private, no-store");
  });

  // The owner's cancellation link, and the strongest case of the three:
  // presenting it does not merely show a fixture, it calls the fixture off for
  // the entire squad. A shared cache holding a 200 for that URL is the worst
  // outcome on this list.
  app.use("/cancel/*", async (c, next) => {
    await next();
    c.header("Cache-Control", "private, no-store");
  });
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run test/routes/cache-control.test.ts`
Expected: PASS, every case.

- [ ] **Step 5: Prove the test can fail**

A gate never seen to fail is not known to work, and this project has been bitten by exactly that (see the `connect-src` post-mortem in `docs/known-issues.md`).

Temporarily delete the `/cancel/*` mount you just added. Re-run `npx vitest run test/routes/cache-control.test.ts` and confirm the two `/cancel/:token` cases fail and the others still pass. **Restore the mount** and re-run to confirm green.

Record in your report which mount you removed, the exact failure output, and confirmation that you restored it. Do not commit the deletion.

- [ ] **Step 6: Correct the stale comment**

`src/app.ts`'s `AUTHENTICATED_PREFIX` mount carries a comment reading, in part:

> the public holding page and `/r/:token`/`/leave/:token` are reached by
> everyone including logged-out strangers and must keep whatever caching
> behaviour they already have, so this must not become a global mount.

The scoping reasoning is still correct and must be kept — **this must not become a global mount.** The clause claiming those two routes keep their existing caching behaviour is now false, and leaving it would tell the next reader the omission was deliberate.

Amend that clause so it says the token routes carry the header via their own mounts below, each for its own reason, while the holding page and `robots.txt` genuinely keep theirs. Do not delete the paragraph and do not weaken the blast-radius argument.

- [ ] **Step 7: Run the full suite**

Run: `npm test && npm run lint && npm run typecheck`

Expected: clean. Watch specifically for `test/routes/access.test.ts`'s "carries no Cache-Control directive of its own" — that test is about the **holding page**, which this change must not touch. If it fails, a mount is too broad.

- [ ] **Step 8: Close the known-issues row**

In `docs/known-issues.md`, the row beginning **"No `Cache-Control` on `/r/:token` or `/leave/:token`."** — mark it closed in the style the file's other closed rows use (they strike through the original text or prepend a bold closure note; match whichever the neighbouring rows do).

The closure note must record three things: that it shipped today, that the fix is a per-route middleware mount rather than a global one, and that **`/cancel/:token` was found and fixed alongside the two the row named** — it was never in the row, and a future reader should know the sweep was wider than the issue.

- [ ] **Step 9: Commit**

```bash
git add src/app.ts test/routes/cache-control.test.ts docs/known-issues.md
git commit -m "fix: never cache a page reached by a token"
```

---

## Self-review

**Spec coverage.** §2 (why each route) → Step 3's three distinct comments. §3 (the change) → Step 3. §4 (the guard test, derived not restated, junk token, proved to fail) → Steps 1, 2, 5. §5 (documentation corrections) → Steps 6 and 8. §6 (not in this) → nothing implements it; Step 7 explicitly guards the holding-page case. §7 (definition of done) → Steps 4, 5, 6, 8.

**Placeholder scan.** No TBDs, no "add appropriate handling", every code step carries its code, and the one judgement call (the exact wording of the amended comment and the closure note) is bounded by what it must say rather than left open.

**Type consistency.** `createApp()` is already exported from `src/app.ts` and already read as `.routes` with `{ method, path }` by `test/routes/signin.test.ts`. The header string `private, no-store` is identical in the test's assertion and all three mounts.

**One thing this review changed.** The first draft had Step 1's anti-vacuity test assert the token-route set equalled exactly four paths. That would have failed even when a future route was added *correctly*, turning a guard into churn and training whoever hit it to edit the expectation without thinking. It is now a floor plus one spot check: enough to catch an empty list, which is the only way `it.each` can pass vacuously, while leaving the `it.each` free to pick up and check a new route automatically — which is what the spec actually asked for.

**Known soft spot.** Step 5 asks the implementer to delete a mount, watch the test fail, and restore it. Nothing enforces the restoration but the implementer's own final test run and the reviewer reading the diff. Step 7's full-suite run and the committed diff are the net.

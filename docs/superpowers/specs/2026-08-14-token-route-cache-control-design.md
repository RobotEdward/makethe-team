# `Cache-Control` on the token routes — design

**Date:** 14 August 2026
**Status:** approved

## 1. What this is

The three token-bearing routes reached from an email — `/r/:token`,
`/leave/:token` and `/cancel/:token` — carry no `Cache-Control` header at all.
This adds `private, no-store` to each, and a test that stops a fourth such
route ever shipping without it.

It closes the `known-issues.md` row triggered by "before real players are
added", which is the shortest remaining path to being able to invite a real
person.

## 2. Why each route needs it

They are not the same argument, and the code comments should not pretend they
are.

**`/r/:token` — confidentiality and staleness.** It renders **full names and
per-player response state**, and that state changes on every tap. A cached copy
is wrong almost immediately and can still be served. This is the row
`known-issues.md` calls "a real-name confidentiality-adjacent gap, not a
theoretical one".

**`/cancel/:token` — revocation, and the strongest case of the three.** That
link does not merely show a fixture; presenting it **calls the fixture off for
the entire squad**. A shared cache holding a `200` for it is the worst outcome
on this list. **It is not named in `known-issues.md`** — it was found by reading
`src/app.ts` while scoping this work, and is included because leaving the
strongest case open while fixing the two weaker ones would be indefensible.

**`/leave/:token` — consistency.** It names the Game and is reached by the same
population from the same emails. It performs no write today (BR-22's
self-service leave is M7), so the argument is weaker — but it is reached by
someone with no session who has no other way to tell that a page is stale.

## 3. The change

Three middleware mounts in `src/app.ts`, identical in shape to the `/j/*` mount
that already exists:

```ts
app.use("/r/*", async (c, next) => {
  await next();
  c.header("Cache-Control", "private, no-store");
});
```

and the same for `/leave/*` and `/cancel/*`, each with a comment giving **its
own** reason from §2 rather than a shared one.

`private, no-store` is the exact string the other four mounts already use
(`AUTHENTICATED_PREFIX`, `GAMES_PREFIX`, `/j/*`). One caching vocabulary, not
two.

The middleware runs **after** the handler (`await next()` first), so the header
is applied to every outcome — the rendered page, the link-problem page, a 404,
a 403 — which is what makes §4's test able to use a junk token.

## 4. The guard test

The part of this work that outlives the fix.

**It must derive the route list from the application, never restate it.** A
test carrying its own hand-written list of token routes passes forever while a
fifth route ships without a header — which is precisely how the current gap
arose: `/j/*` was given the header and the three neighbours were not.

```
enumerate createApp().routes
  → select every registered path containing ":token"
  → for each, issue a request with a deliberately invalid token
  → assert the response carries `Cache-Control: private, no-store`
```

A junk token suffices because the middleware runs after the handler regardless
of outcome: `/r/` and `/leave/` answer an invalid token with a rendered
link-problem page at `200`, `/cancel/` likewise, and `/j/`'s `404` passes
through the same middleware. **No seeding, no valid tokens, no fixtures** — the
test is fast and has no world to keep in step.

The test must fail if any single route's mount is removed. Prove that by
deleting one mount and watching it fail, rather than assuming.

## 5. Documentation corrections

**`src/app.ts:28-33`** currently reads, of the `AUTHENTICATED_PREFIX` mount:

> the public holding page and `/r/:token`/`/leave/:token` are reached by
> everyone including logged-out strangers and must keep whatever caching
> behaviour they already have, so this must not become a global mount.

The scoping reasoning stays true and must be kept — this must not become a
global mount. The clause about those two routes *keeping* their behaviour stops
being true the moment this ships, and leaving it would tell the next reader the
omission was deliberate. Amend that clause; do not delete the paragraph.

**`docs/known-issues.md`** — close the row, recording that `/cancel/:token` was
found and fixed alongside the two the row named.

## 6. Not in this

- **No change to `/j/*`**, which already carries the header.
- **No caching headers anywhere else.** The holding page and `robots.txt` are
  genuinely cacheable and keep today's behaviour deliberately.
- **No browser tier.** This is a response header; a server test proves it
  exactly, where a browser test would prove it vaguely.
- **Nothing else from the punchlist.** The two reconciliation items (the
  removal loop's partial-failure recovery and the ghost-fixture materialisation
  race) share a fix shape, are triggered by "before a second owner exists"
  rather than by real players, and get their own spec.
- **The two dashboard items** — enabling required reviewers on the `production`
  environment, and dropping the unused *Workers KV Storage → Edit* scope from
  the deploy token — are the author's to click and are not code.

## 7. Definition of done

1. `/r/:token`, `/leave/:token` and `/cancel/:token` each answer with
   `Cache-Control: private, no-store` on every outcome, including invalid
   tokens.
2. A test derived from the app's own registered routes asserts this for every
   token-bearing path, and has been seen to fail when a mount is removed.
3. `src/app.ts`'s stale comment is corrected and `known-issues.md`'s row is
   closed.

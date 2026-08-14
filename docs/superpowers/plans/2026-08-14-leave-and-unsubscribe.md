# Leave and Unsubscribe (BR-22) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A player can take themselves out of a squad from the link every reminder already carries, closing BR-22.

**Architecture:** A third token kind — game-scoped rather than fixture-scoped — so the welcome email can carry a leave link at all. `GET /leave/:token` confirms and writes nothing; `POST` performs the leave through the existing `removeMember`, which already does every part of the work. A signed-in visitor whose identity matches the token additionally sees their other squads.

**Tech Stack:** TypeScript strict, Cloudflare Workers, Hono, D1 + Drizzle, Durable Objects, Vitest with `@cloudflare/vitest-pool-workers`, Playwright against `wrangler dev`.

**Spec:** `docs/superpowers/specs/2026-08-14-leave-and-unsubscribe-design.md`. Read the section named in each task.

## Global Constraints

- **`GET /leave/:token` must write nothing.** Mail scanners and link-preview bots issue a `GET` on every URL in an incoming message; a `GET` that left the squad would unsubscribe people who never clicked. Every task touching that route preserves this, and Task 2 pins it with a test.
- **No new secret and no new binding.** The leave token is signed with `RESPONSE_TOKEN_SECRET` and distinguished by the `kind` discriminator already inside the signed bytes.
- **No new notification type.** §1.11's catalogue is closed. A self-leaver receives no email; the only mail this milestone can cause is N-2 to a player promoted off a waitlist.
- **404-shaped failures stay indistinguishable.** A bad, expired or wrong-kind token renders the same `renderLinkProblemPage()` at 200 that `/r/:token` uses, so an attacker learns nothing by trying one path against another.
- **Every control works with JavaScript off.** An unsubscribe that needs JavaScript is not an unsubscribe.
- `escapeHtml` every interpolated value. No `<script>` on any page this milestone adds.
- **Copy rule:** product words only — a player never reads "token", "membership", a rule number, or a route pattern.
- Never bare `new Date()` — ESLint's `no-restricted-syntax` bans it. Use `new Date(Date.now())` in routes; pass `now` into domain code.
- Commit messages: lower-case conventional prefix, imperative, no trailing period on the subject.
- **Never `git add -A`.** Stage explicit paths only.
- Do not commit if `npm run lint` or `npm run typecheck` fails. Chain with `&&`, never `;`.
- **Run every long command in the FOREGROUND with a raised tool timeout** — never backgrounded, never via a monitor. `npm test` ~100s, `npx playwright test` ~3.5min. Several implementers on recent milestones stalled indefinitely on backgrounded runs.
- **Test dates must be clock-relative.** Use `test/support/clock.ts`'s `NOW` and `kickoffIn(hours)` for anything a route will judge against the real clock. A fixed calendar date that a token is verified against took the suite down twice this week.

## File Structure

**Created**
- `src/views/leave.ts` — the confirmation page, its sole-organiser variant, its already-left variant, and the done page.
- `test/routes/leave-flow.test.ts` — the new route behaviour. (`test/routes/leave.test.ts` exists and covers today's placeholder page; it will be rewritten in Task 2 rather than left asserting the old copy.)

**Modified**
- `src/domain/token.ts` — `LeaveTokenPayload`, `"leave"` in `TokenKind` and `SECRET_BINDING_NAME`, `signLeaveToken`, `verifyLeaveToken`, `isLeavePayload`, `leaveTokenExpiry`.
- `src/routes/respond.ts` — `/leave/:token` becomes GET-confirm plus POST-act. (It lives here because `renderLeavePage` does today; moving it is out of scope.)
- `src/auth/paths.ts` — a path helper for the session-authenticated leave-another-game route.
- `src/routes/dashboard.ts` — that route.
- `src/sweep/open-and-remind.ts:478`, `src/notify/send-promotion.ts:123`, `src/notify/send-cancellation.ts:141`, `src/notify/send-welcome.ts` — mint leave tokens.
- `src/notify/templates/{reminder,promotion,cancellation,welcome}.ts` — copy, and N-6 gains the link.
- `docs/superpowers/specs/2026-08-10-make-the-team-design.md` — BR-22.
- `docs/known-issues.md`, `docs/guide/03-answering-a-reminder.md`, `docs/guide/04-when-someone-drops-out.md`, `test/browser/catalogue.ts`, `test/browser/journeys.spec.ts`.

---

### Task 1: The leave token

**Spec:** §2, §2.1, §2.2.

**Files:**
- Modify: `src/domain/token.ts`
- Test: `test/domain/token.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export interface LeaveTokenPayload { gameId: string; playerId: string; expiresAt: number }
  export async function signLeaveToken(payload: LeaveTokenPayload, secret: string): Promise<string>
  export async function verifyLeaveToken(token: string, secret: string, now: Date): Promise<TokenVerification<LeaveTokenPayload>>
  export function leaveTokenExpiry(now: Date): Date
  ```

`TokenKind` is `"response" | "cancel"` today and the discriminator is inside the signed bytes, checked immediately after the signature — so adding a third member is additive and every existing token keeps verifying.

- [ ] **Step 1: Write the failing tests**

Add to `test/domain/token.test.ts`, following that file's existing structure:

```ts
describe("leave tokens", () => {
  const SECRET = "leave-token-tests-only";

  it("round-trips a game-scoped payload", async () => {
    const expiresAt = leaveTokenExpiry(NOW).getTime();
    const token = await signLeaveToken({ gameId: "g-1", playerId: "p-1", expiresAt }, SECRET);

    const result = await verifyLeaveToken(token, SECRET, NOW);

    expect(result).toEqual({ ok: true, payload: { gameId: "g-1", playerId: "p-1", expiresAt } });
  });

  it("expires ninety days after minting", () => {
    const ninetyDays = 90 * 24 * 60 * 60 * 1000;
    expect(leaveTokenExpiry(NOW).getTime()).toBe(NOW.getTime() + ninetyDays);
  });

  it("rejects a token presented after its expiry", async () => {
    const token = await signLeaveToken(
      { gameId: "g-1", playerId: "p-1", expiresAt: NOW.getTime() - 1 },
      SECRET,
    );

    expect(await verifyLeaveToken(token, SECRET, NOW)).toEqual({ ok: false, reason: "expired" });
  });

  it("refuses a response token presented as a leave token", async () => {
    // The discriminator is inside the signed bytes, so this fails as
    // `malformed` at the kind check — not as a bad signature — even though
    // both kinds share RESPONSE_TOKEN_SECRET.
    const responseToken = await signResponseToken(
      { playerId: "p-1", fixtureId: "f-1", expiresAt: NOW.getTime() + 60_000 },
      SECRET,
    );

    expect(await verifyLeaveToken(responseToken, SECRET, NOW)).toEqual({ ok: false, reason: "malformed" });
  });

  it("refuses a leave token presented as a response token", async () => {
    const leaveToken = await signLeaveToken(
      { gameId: "g-1", playerId: "p-1", expiresAt: NOW.getTime() + 60_000 },
      SECRET,
    );

    expect(await verifyResponseToken(leaveToken, SECRET, NOW)).toEqual({ ok: false, reason: "malformed" });
  });

  it("refuses a leave token signed with a different secret", async () => {
    const token = await signLeaveToken(
      { gameId: "g-1", playerId: "p-1", expiresAt: NOW.getTime() + 60_000 },
      SECRET,
    );

    expect(await verifyLeaveToken(token, "a-different-secret", NOW)).toEqual({ ok: false, reason: "bad-signature" });
  });
});
```

Import `NOW` from `test/support/clock.js`. If that file's existing tests use their own fixed clock, use `NOW` for these regardless — a leave token's expiry is relative to minting, so a fixed date here would rot.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run test/domain/token.test.ts`
Expected: FAIL — `signLeaveToken` is not exported.

- [ ] **Step 3: Add the kind and the payload**

In `src/domain/token.ts`, extend the union and the binding map:

```ts
type TokenKind = "response" | "cancel" | "leave";

const SECRET_BINDING_NAME: Record<TokenKind, string> = {
  response: "RESPONSE_TOKEN_SECRET",
  cancel: "CANCEL_TOKEN_SECRET",
  leave: "RESPONSE_TOKEN_SECRET",
};
```

and add the payload beside the other two:

```ts
/**
 * A leave token is scoped to one player and one **Game** — not one fixture,
 * which is the whole reason it exists. The welcome email (N-6) is sent when
 * somebody joins a squad, and at that moment no fixture may exist to scope a
 * response token to, which is why N-6 has carried no leave link at all.
 *
 * Signed with `RESPONSE_TOKEN_SECRET` rather than a secret of its own. The
 * separation of `CANCEL_TOKEN_SECRET` exists because a leaked response key
 * must not be able to call a fixture off for a whole squad; that argument
 * does not extend to leaving, because a response token already opens the
 * leave page today. The `kind` discriminator, which is inside the signed
 * bytes, is what stops one being presented as the other.
 */
export interface LeaveTokenPayload {
  gameId: string;
  playerId: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}
```

- [ ] **Step 4: Add the guard, the expiry and the two functions**

Following the shape of `isCancelPayload` / `signCancelToken` / `verifyCancelToken` exactly:

```ts
function isLeavePayload(candidate: Record<string, unknown>): candidate is LeaveTokenPayload {
  return (
    typeof candidate["gameId"] === "string" &&
    typeof candidate["playerId"] === "string" &&
    typeof candidate["expiresAt"] === "number" &&
    Number.isFinite(candidate["expiresAt"])
  );
}

/** Ninety days, per the design's §2.2. */
const LEAVE_TOKEN_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * A leave link stops working ninety days after it was minted.
 *
 * Not tied to a kickoff, because leaving is not about a fixture. Long enough
 * that somebody unsubscribing three weeks after they stopped playing is not
 * told their link is broken — the most annoying possible failure of an
 * unsubscribe link — and short enough to bound a forwarded email.
 */
export function leaveTokenExpiry(now: Date): Date {
  return new Date(now.getTime() + LEAVE_TOKEN_LIFETIME_MS);
}

export async function signLeaveToken(payload: LeaveTokenPayload, secret: string): Promise<string> {
  return signToken("leave", payload, secret);
}

/** Verify and decode a leave token. See {@link verifyToken}. */
export async function verifyLeaveToken(
  token: string,
  secret: string,
  now: Date,
): Promise<TokenVerification<LeaveTokenPayload>> {
  return verifyToken("leave", token, secret, now, isLeavePayload);
}
```

- [ ] **Step 5: Run them and watch them pass**

Run: `npx vitest run test/domain/token.test.ts`
Expected: PASS.

- [ ] **Step 6: Full suite, lint, typecheck**

Run: `npm test && npm run lint && npm run typecheck`
Expected: clean. `SECRET_BINDING_NAME` is a `Record<TokenKind, string>`, so a missing entry is a typecheck error rather than a runtime surprise.

- [ ] **Step 7: Commit**

```bash
git add src/domain/token.ts test/domain/token.test.ts
git commit -m "feat(token): add a game-scoped leave token"
```

---

### Task 2: The confirmation page, which writes nothing

**Spec:** §3, §5, and the already-left half of §4.

**Files:**
- Create: `src/views/leave.ts`
- Rewrite: `test/routes/leave.test.ts`
- Modify: `src/routes/respond.ts`, `test/browser/catalogue.ts`

**Interfaces:**
- Consumes: `verifyLeaveToken`, `LeaveTokenPayload` (Task 1).
- Produces: `renderLeavePage(params: LeavePageParams): string` where
  ```ts
  interface LeavePageParams {
    token: string;
    gameName: string;
    /** "confirm" renders the button; the other two never do. */
    state: "confirm" | "sole-organiser" | "already-left";
    gameId: string;
    /** Task 4 fills this; absent means "no session, or not this player". */
    otherGames?: readonly { gameId: string; gameName: string }[];
  }
  ```
  Declare `otherGames` now so the view is written once.

The existing `renderLeavePage(gameName: string)` in `src/routes/respond.ts` is replaced by this and deleted from there.

- [ ] **Step 1: Write the failing route tests**

Rewrite `test/routes/leave.test.ts`. Keep its existing seeding helpers and its use of `test/support/clock.ts`; replace its assertions about the placeholder copy.

```ts
describe("GET /leave/:token", () => {
  it("offers to leave, naming the game", async () => {
    const { token, gameName } = await seedLeavable();

    const response = await SELF.fetch(`https://makethe.team/leave/${token}`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain(gameName);
    expect(body).toContain("Leave this game");
  });

  it("changes nothing at all", async () => {
    // The prefetcher guarantee. Mail scanners GET every URL in a message; if
    // this route wrote, they would unsubscribe people who never clicked.
    const { token, gameId, playerId } = await seedLeavable();

    await SELF.fetch(`https://makethe.team/leave/${token}`);

    const [membership] = await db.select().from(memberships)
      .where(and(eq(memberships.gameId, gameId), eq(memberships.playerId, playerId)));
    expect(membership?.active).toBe(true);
    expect(membership?.leftAt).toBeNull();
    expect(await db.select().from(auditLog)).toEqual([]);
  });

  it("tells a sole organiser why they cannot leave, and offers no button", async () => {
    const { token } = await seedLeavable({ role: "owner", otherOwners: 0 });

    const body = await (await SELF.fetch(`https://makethe.team/leave/${token}`)).text();

    expect(body).toContain("needs an organiser");
    expect(body).not.toContain("Leave this game");
  });

  it("offers the button to an organiser who is not the only one", async () => {
    const { token } = await seedLeavable({ role: "owner", otherOwners: 1 });

    const body = await (await SELF.fetch(`https://makethe.team/leave/${token}`)).text();

    expect(body).toContain("Leave this game");
  });

  it("says so when the player already left", async () => {
    const { token } = await seedLeavable({ alreadyLeft: true });

    const body = await (await SELF.fetch(`https://makethe.team/leave/${token}`)).text();

    expect(body).toContain("already out");
    expect(body).not.toContain("Leave this game");
  });

  it("shows the same link-problem page for a bad token as /r/ does", async () => {
    const body = await (await SELF.fetch("https://makethe.team/leave/not-a-real-token")).text();

    expect(body).toContain("link isn't working");
  });

  it("shows the link-problem page for a response token presented here", async () => {
    // Same secret, different kind. An attacker swapping paths learns nothing.
    const { responseToken } = await seedLeavable();

    const body = await (await SELF.fetch(`https://makethe.team/leave/${responseToken}`)).text();

    expect(body).toContain("link isn't working");
  });
});
```

Write `seedLeavable({ role?, otherOwners?, alreadyLeft? })` in that file from `test/support/factories.ts`, returning at least `{ token, responseToken, gameId, playerId, gameName }`. Mint the leave token with `signLeaveToken` and `env.RESPONSE_TOKEN_SECRET`.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run test/routes/leave.test.ts`
Expected: FAIL — the page still says leaving is not self-service.

- [ ] **Step 3: Write the view**

Create `src/views/leave.ts`. Model its structure on `src/views/cancel.ts`, which is the closest existing page — token-reached, no session, one destructive action behind a confirmation.

Requirements:
- `<h1>` names the game.
- `state: "confirm"` renders a short explanation of what leaving does — no more email about this game, and their place in any upcoming fixture is freed for someone else — and a single `<form method="post">` posting to `/leave/{token}` with one button reading exactly **Leave this game**.
- `state: "sole-organiser"` renders no form. It says the squad **needs an organiser** and that they can make someone else one first, with a link to `gamePath(gameId)`. It must not say "you can't leave" without saying what to do instead.
- `state: "already-left"` renders no form and says they are **already out** of this squad.
- No `<script>`. `pageStyles: [FORM_CSS]`.

- [ ] **Step 4: Rewrite the route**

In `src/routes/respond.ts`, replace the existing `GET /leave/:token` handler and delete the old private `renderLeavePage`. The new handler:

1. verifies with `verifyLeaveToken` and renders `renderLinkProblemPage()` at 200 on any failure, logging the reason as the old one did;
2. loads the game by `gameId` and the membership with `findMembershipInGame`;
3. renders `state: "already-left"` when the membership is missing or inactive;
4. renders `state: "sole-organiser"` when the member's role is `owner` and `countActiveOwners(db, gameId)` is 1;
5. otherwise renders `state: "confirm"`.

It performs no writes on any path.

- [ ] **Step 5: Add the catalogue entry**

In `test/browser/catalogue.ts`, add the page so it comes under the console-error and CSP gate:

```ts
  {
    id: "leave",
    title: "Leave a game",
    path: (world) => `/leave/${world.leaveToken}`,
    persona: "anonymous",
    note: "The confirmation a player reaches from the leave link in any email.",
  },
```

`World` has no `leaveToken` yet — add one in `test/browser/world.ts`, minted with `signLeaveToken` against the same `RESPONSE_SECRET` that file already uses for response tokens, for the joined member and the seeded game.

- [ ] **Step 6: Run everything**

Run: `npx vitest run test/routes/leave.test.ts` then `npm test && npm run lint && npm run typecheck`
then: `npx playwright test`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/views/leave.ts src/routes/respond.ts test/routes/leave.test.ts test/browser/catalogue.ts test/browser/world.ts
git commit -m "feat(leave): offer to leave a game, without acting on a GET"
```

---

### Task 3: Actually leaving

**Spec:** §4.

**Files:**
- Modify: `src/routes/respond.ts`
- Test: `test/routes/leave.test.ts`, `test/browser/journeys.spec.ts`

**Interfaces:**
- Consumes: `verifyLeaveToken` (Task 1); `renderLeavePage` (Task 2).
- Produces: `POST /leave/:token`.

`removeMember` already does the whole job. Its signature:

```ts
removeMember({ db, gameId, playerId, actorPlayerId, now, withdraw }): Promise<RemoveMemberResult>
```

where `withdraw` is `(fixtureId) => env.FIXTURE_CAPACITY.getByName(fixtureId).withdrawMember({ playerId, actorPlayerId, now })`, and `RemoveMemberResult` is one of `{ kind: "removed", membershipId, leftAt, promotions }`, `{ kind: "resumed", … }`, `{ kind: "refused", reason: "last-owner" }`, `{ kind: "not-a-member" }`. `src/routes/games.ts`'s squad-removal handler is the working example — copy its shape, including the `waitUntil` for promotions.

- [ ] **Step 1: Write the failing tests**

Add to `test/routes/leave.test.ts`:

```ts
describe("POST /leave/:token", () => {
  it("takes the player out of the squad", async () => {
    const { token, gameId, playerId } = await seedLeavable();

    const response = await SELF.fetch(new Request(`https://makethe.team/leave/${token}`, { method: "POST" }));

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("out of");
    const [membership] = await db.select().from(memberships)
      .where(and(eq(memberships.gameId, gameId), eq(memberships.playerId, playerId)));
    expect(membership?.active).toBe(false);
    expect(membership?.leftAt).not.toBeNull();
  });

  it("records the leaver as their own actor, so the trail reads as leaving", async () => {
    const { token, playerId } = await seedLeavable();

    await SELF.fetch(new Request(`https://makethe.team/leave/${token}`, { method: "POST" }));

    const [row] = await db.select().from(auditLog).where(eq(auditLog.action, "membership.removed"));
    expect(row?.actorPlayerId).toBe(playerId);
  });

  it("frees their place and promotes the longest-waiting player", async () => {
    const { token, waitlistedId, fixtureId } = await seedLeavableOnFullFixture();

    await SELF.fetch(new Request(`https://makethe.team/leave/${token}`, { method: "POST" }));

    const [promoted] = await db.select().from(responses)
      .where(and(eq(responses.fixtureId, fixtureId), eq(responses.playerId, waitlistedId)));
    expect(promoted?.status).toBe("in");
  });

  it("sends the leaver no email", async () => {
    // §1.11's catalogue is closed and N-7 tells someone something happened
    // *to* them. A self-leaver did it and is reading the confirmation.
    const { token, playerId } = await seedLeavable();

    await SELF.fetch(new Request(`https://makethe.team/leave/${token}`, { method: "POST" }));

    const rows = await db.select().from(notificationLog).where(eq(notificationLog.playerId, playerId));
    expect(rows).toEqual([]);
  });

  it("refuses a sole organiser and explains, without leaving them out", async () => {
    const { token, gameId, playerId } = await seedLeavable({ role: "owner", otherOwners: 0 });

    const response = await SELF.fetch(new Request(`https://makethe.team/leave/${token}`, { method: "POST" }));

    expect(response.status).toBe(422);
    expect(await response.text()).toContain("needs an organiser");
    const [membership] = await db.select().from(memberships)
      .where(and(eq(memberships.gameId, gameId), eq(memberships.playerId, playerId)));
    expect(membership?.active).toBe(true);
  });

  it("is safe to submit twice", async () => {
    const { token } = await seedLeavable();
    const url = `https://makethe.team/leave/${token}`;

    await SELF.fetch(new Request(url, { method: "POST" }));
    const second = await SELF.fetch(new Request(url, { method: "POST" }));

    expect(second.status).toBe(200);
    const rows = await db.select().from(auditLog).where(eq(auditLog.action, "membership.removed"));
    expect(rows.length).toBe(1);
  });

  it("shows the link-problem page for a bad token and writes nothing", async () => {
    const response = await SELF.fetch(
      new Request("https://makethe.team/leave/not-a-real-token", { method: "POST" }),
    );

    expect(await response.text()).toContain("link isn't working");
    expect(await db.select().from(auditLog)).toEqual([]);
  });
});
```

Write `seedLeavableOnFullFixture()` returning `{ token, waitlistedId, fixtureId }` — a game whose open fixture is at `max_players` with the leaver `in` and another member `waitlisted`, landed there through the real capacity path rather than a hand-written row.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run test/routes/leave.test.ts`
Expected: FAIL — 404 or 405, there is no POST handler.

- [ ] **Step 3: Add the handler**

In `src/routes/respond.ts`, after the GET. It verifies the token the same way, then:

```ts
  const result = await removeMember({
    db,
    gameId: payload.gameId,
    playerId: payload.playerId,
    // The leaver is their own actor. A `membership.removed` row whose actor
    // equals its subject reads unambiguously as "they left"; one where they
    // differ reads as "an organiser removed them". No new audit action needed.
    actorPlayerId: payload.playerId,
    now,
    withdraw: (fixtureId) =>
      c.env.FIXTURE_CAPACITY.getByName(fixtureId).withdrawMember({
        playerId: payload.playerId,
        actorPlayerId: payload.playerId,
        now: now.getTime(),
      }),
  });
```

Then: `not-a-member` renders the link-problem page (the token names a game they were never in — treat it as a broken link, and do not confirm or deny); `refused` re-renders the page at 422 in `state: "sole-organiser"`; `removed` and `resumed` both render the done page. Send the N-2s from `result.promotions` through `notifyPromotedPlayer` in `c.executionCtx.waitUntil`, exactly as `src/routes/games.ts` does. **Send no N-7.**

Add a `state: "done"` to `LeavePageParams` and render it: they are out of this squad, they will get no more email about it, and a line telling them an organiser can add them back if they change their mind.

**No `wrongOrigin` check on this route.** Every other state-changing POST in this app has one, and this route deliberately does not: the request arrives from a mail client, where `Origin` is frequently absent or the webmail's own domain, and refusing those would break the unsubscribe for exactly the population it exists for. The token is the entire authorisation, as it is on `POST /r/:token`, which has no origin check for the same reason. **State this in a comment on the handler** — its absence must read as a decision rather than an omission.

- [ ] **Step 4: Run them and watch them pass**

Run: `npx vitest run test/routes/leave.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the browser journey**

Add to `test/browser/journeys.spec.ts`, following its existing structure (`observe(page)`, `seedWorld(page, browser)`). **`seedWorld` leaves the page signed in — do not call `signIn` after it, which hangs rather than fails.**

Run this one in a `javaScriptEnabled: false` context, as that file's other degradation tests do. Navigate to `/leave/{world.leaveToken}`, assert the game name and the button are present, click **Leave this game**, and assert the done page. Then reload the same URL and assert it now says they are already out.

Assert `seen.violations()` and `seen.errors()` are empty.

- [ ] **Step 6: Full gate**

Run: `npm test && npm run lint && npm run typecheck`
then: `npx playwright test`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/routes/respond.ts src/views/leave.ts test/routes/leave.test.ts test/browser/journeys.spec.ts
git commit -m "feat(leave): let a player take themselves out of a squad"
```

---

### Task 4: Your other squads, for a signed-in visitor

**Spec:** §6.

**Files:**
- Modify: `src/views/leave.ts`, `src/routes/respond.ts`, `src/auth/paths.ts`, `src/routes/dashboard.ts`
- Test: `test/routes/leave.test.ts`, `test/routes/dashboard.test.ts`

**Interfaces:**
- Consumes: `LeavePageParams.otherGames` (declared in Task 2).
- Produces: `leaveOtherGamePath(gameId: string): string` → `/app/games/{gameId}/leave`, and its `POST` handler.

**The identity match is the whole security property of this task.** A leave token names one player and one game. The other-games list may only render when a session exists **and** its player id equals the token's `playerId`. Without that, a forwarded leave link shows one person somebody else's squads, and a leaked link becomes a multi-game capability — the line BR-25 draws.

- [ ] **Step 1: Write the failing tests**

Add to `test/routes/leave.test.ts`:

```ts
describe("the other-squads list", () => {
  it("is absent for a visitor with no session", async () => {
    const { token, otherGameName } = await seedLeavableWithAnotherGame();

    const body = await (await SELF.fetch(`https://makethe.team/leave/${token}`)).text();

    expect(body).not.toContain(otherGameName);
    expect(body).toContain("Sign in");
  });

  it("lists the player's other squads when they are signed in as themselves", async () => {
    const { token, otherGameName, cookie } = await seedLeavableWithAnotherGame({ signedIn: "self" });

    const body = await (await SELF.fetch(
      new Request(`https://makethe.team/leave/${token}`, { headers: { cookie } }),
    )).text();

    expect(body).toContain(otherGameName);
  });

  it("is absent when the session belongs to somebody else", async () => {
    // A forwarded link opened by a different signed-in person must not show
    // either party's squads.
    const { token, otherGameName, cookie } = await seedLeavableWithAnotherGame({ signedIn: "someone-else" });

    const body = await (await SELF.fetch(
      new Request(`https://makethe.team/leave/${token}`, { headers: { cookie } }),
    )).text();

    expect(body).not.toContain(otherGameName);
  });
});
```

This harness supports one real signed-in identity; follow the pattern already used in `test/routes/owner-fixture.test.ts` and vary which player the *token* names rather than the session. For the "someone-else" case, mint the leave token for a **different** player than the signed-in one.

Add to `test/routes/dashboard.test.ts`:

```ts
it("lets a signed-in player leave another game they are in", async () => {
  const { gameId } = await seedMembershipForViewer();

  const response = await appPost(`/app/games/${gameId}/leave`, {});

  expect(response.status).toBe(303);
  const [membership] = await db.select().from(memberships)
    .where(and(eq(memberships.gameId, gameId), eq(memberships.playerId, VIEWER_ID)));
  expect(membership?.active).toBe(false);
});

it("404s when the signed-in player is not in that game", async () => {
  const { gameId } = await seedGameWithoutViewer();

  expect((await appPost(`/app/games/${gameId}/leave`, {})).status).toBe(404);
});

it("refuses a sole organiser", async () => {
  const { gameId } = await seedViewerAsSoleOrganiser();

  expect((await appPost(`/app/games/${gameId}/leave`, {})).status).toBe(422);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run test/routes/leave.test.ts test/routes/dashboard.test.ts`
Expected: FAIL.

- [ ] **Step 3: Add the path helper and the session route**

In `src/auth/paths.ts`:

```ts
/**
 * Where a signed-in player leaves a game from their own account, as opposed
 * to from an emailed token. Under `DASHBOARD_PATH` so it sits behind the
 * session mount and its `private, no-store` header.
 */
export function leaveOtherGamePath(gameId: string): string {
  return `${DASHBOARD_PATH}/games/${gameId}/leave`;
}
```

In `src/routes/dashboard.ts`, a `POST` behind `requirePlayer` that checks `wrongOrigin` (this one **is** a same-origin form from our own page, unlike the token route), calls `removeMember` with the session player as both subject and actor, maps `not-a-member` to 404 and `refused` to 422, sends promotion N-2s through `waitUntil`, and redirects to `DASHBOARD_PATH` on success.

- [ ] **Step 4: Render the list**

In `src/routes/respond.ts`'s GET handler, resolve the session player if one exists. **Only when it exists and its id equals `payload.playerId`**, load their other active memberships — every game they are an active member of except `payload.gameId` — and pass them as `otherGames`.

`/leave/*` sits outside every session mount, so `c.get("player")` is not populated there. Resolve the session explicitly in the handler rather than adding a session mount to `/leave/*`: a mount would put the session middleware on a path reached by strangers, which is exactly the blast-radius argument `src/app.ts` makes for keeping it off `/r/`.

In `src/views/leave.ts`, render `otherGames` as a short list under a heading like "Your other squads", each with a form posting to `leaveOtherGamePath(gameId)`. When `otherGames` is `undefined`, render a sign-in link instead — worded as an offer, not an error.

- [ ] **Step 5: Run them and watch them pass**

Run: `npx vitest run test/routes/leave.test.ts test/routes/dashboard.test.ts`
Expected: PASS.

- [ ] **Step 6: Full gate**

Run: `npm test && npm run lint && npm run typecheck`
then: `npx playwright test`

- [ ] **Step 7: Commit**

```bash
git add src/views/leave.ts src/routes/respond.ts src/auth/paths.ts src/routes/dashboard.ts test/routes/leave.test.ts test/routes/dashboard.test.ts
git commit -m "feat(leave): offer a signed-in player their other squads"
```

---

### Task 5: The emails, the rule, and the guide

**Spec:** §7, §1, §8.

**Files:**
- Modify: `src/sweep/open-and-remind.ts:478`, `src/notify/send-promotion.ts:123`, `src/notify/send-cancellation.ts:141`, `src/notify/send-welcome.ts`
- Modify: `src/notify/templates/{reminder,promotion,cancellation,welcome}.ts`
- Modify: `docs/superpowers/specs/2026-08-10-make-the-team-design.md`, `docs/known-issues.md`, `docs/guide/03-answering-a-reminder.md`, `docs/guide/04-when-someone-drops-out.md`
- Test: the corresponding files under `test/notify/` and `test/sweep/`

**Interfaces:**
- Consumes: `signLeaveToken`, `leaveTokenExpiry` (Task 1).

Three call sites build `leaveUrl` as `${SITE_ORIGIN}/leave/${token}` from a **response** token. Each must mint a leave token instead. The welcome email has no `leaveUrl` at all and gains one.

- [ ] **Step 1: Write the failing tests**

In each of `test/sweep/open-and-remind.test.ts`, `test/notify/send-promotion.test.ts`, `test/notify/send-cancellation.test.ts`, add an assertion that the sent message's `leaveUrl` verifies as a **leave** token naming that game and player — not merely that it is a non-empty string:

```ts
it("carries a leave link scoped to the game, not the fixture", async () => {
  // ... existing seeding for this file ...
  const url = new URL(sent[0]!.leaveUrl);
  const token = url.pathname.split("/").pop()!;

  const verified = await verifyLeaveToken(token, env.RESPONSE_TOKEN_SECRET, NOW);

  expect(verified).toMatchObject({ ok: true, payload: { gameId, playerId } });
});
```

In `test/notify/send-welcome.test.ts`, assert the welcome message now carries a `leaveUrl` at all, verifying the same way. Adapt each to how that file captures sent messages.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run test/sweep/open-and-remind.test.ts test/notify/`
Expected: FAIL — the existing tokens verify as `response`, not `leave`, and welcome has no `leaveUrl`.

- [ ] **Step 3: Mint leave tokens**

At each of the three sites, replace the response token used for `leaveUrl` with:

```ts
const leaveToken = await signLeaveToken(
  { gameId, playerId, expiresAt: leaveTokenExpiry(now).getTime() },
  env.RESPONSE_TOKEN_SECRET,
);
```

**Keep the response token for `respondInUrl` and `respondOutUrl`** — those are fixture-scoped and must stay so. Only `leaveUrl` changes.

Add `leaveUrl` to the welcome email's payload and template.

- [ ] **Step 4: Change the copy**

In `src/notify/templates/reminder.ts` and `promotion.ts`, the link text is currently "See how to leave this Game". It becomes **"Leave this game"** — which will finally be true — in both the HTML and the plain-text alternative. Match the surrounding sentence so it still reads naturally.

Word the welcome email's line for someone who has just joined: they have just been added, and this is how to get out if they did not want to be.

Update each template's doc comment where it describes `leaveUrl` as pointing at a page that explains leaving is not self-service.

- [ ] **Step 5: Close BR-22**

In `docs/superpowers/specs/2026-08-10-make-the-team-design.md`, BR-22 currently states the rule and then a long amendment recording that it is unmet, that `/leave/:token` only renders an explanation, and that M7 must close it. Rewrite it to state the rule and that it is satisfied, naming this plan. **Keep the historical note that N-7 deliberately carries no link** — that reasoning is still live and still correct.

In `docs/known-issues.md`, close the BR-22 row in the style the file's other closed rows use.

- [ ] **Step 6: The guide**

`docs/guide/03-answering-a-reminder.md` describes the reminder email; `04-when-someone-drops-out.md` covers dropping out of one fixture. Add to chapter 04 a short section on leaving a game for good: what the link does, that a place in an upcoming game is freed for someone else, and that an organiser can add them back.

Read two existing chapters first and match their voice. No rule numbers, no route patterns.

Add a shot of the confirmation page to `test/browser/guide-shots.ts` in chapter 04, drive it in `test/browser/guide-world.ts` **through the page itself**, run `npm run guide:capture`, and **read the resulting PNG** — not clipped, legible at 390px, no name that could belong to a real person. Never write prose around a bad screenshot.

Beware: the guide world's counts and names are quoted verbatim in chapters 1, 3, 4 and 6. If capturing this would change that world's state, build a small separate game for the shot as `buildOverrideDemo` and `buildVisibilityDemo` already do, and say so in your report.

- [ ] **Step 7: Full gate**

Run: `npm test && npm run lint && npm run typecheck`
then: `npx playwright test`
Expected: all clean, including `guide-references.spec.ts`.

- [ ] **Step 8: Commit**

```bash
git add src/sweep/open-and-remind.ts src/notify docs/superpowers/specs/2026-08-10-make-the-team-design.md docs/known-issues.md docs/guide test/browser/guide-shots.ts test/browser/guide-world.ts test/notify test/sweep
git commit -m "feat(notify): carry a working leave link in every email"
```

---

## Self-review

**Spec coverage.** §1 (what it is) → Tasks 2–3. §2/§2.1/§2.2 (the token) → Task 1. §3 (GET confirms, POST acts) → Tasks 2 and 3, pinned by Task 2's "changes nothing at all". §4 (reuse `removeMember`, no N-7, already-left) → Task 3. §5 (sole organiser) → Task 2's page state and Task 3's 422. §6 (other games, identity match) → Task 4. §7 (emails) → Task 5. §8 (testing) → each task's tests plus Task 3's journey and Task 5's guide. §9 (not in this) → nothing implements it. §10 (done) → all five.

**Placeholder scan.** No TBDs. Every code step carries its code. The judgement calls that remain — each page's exact wording, each email's sentence — are bounded by what they must convey and by the copy rule.

**Type consistency.** `LeaveTokenPayload`'s three fields are spelled identically in Task 1's interface, Task 3's `removeMember` call and Task 5's assertions. `LeavePageParams.state` gains `"done"` in Task 3, declared alongside the three from Task 2. `leaveOtherGamePath` is used in Task 4's route and view only.

**One thing this review changed.** The first draft had Task 3's POST check `wrongOrigin` like every other state-changing route in the app. That is wrong here: the request comes from a mail client, where `Origin` is often absent or the webmail's own domain, so the check would break the unsubscribe for precisely the people it exists to serve. `POST /r/:token` already omits it for the same reason. The plan now requires a comment saying so, because an unexplained absence reads as an oversight and someone will "fix" it.

**Known soft spot.** Task 4 resolves a session on a route that sits outside every session mount. The plan says to resolve it explicitly in the handler rather than mounting the middleware on `/leave/*`, because a mount would put session resolution on a path strangers reach — but the implementer will have to find how to do that, and `src/auth/session.ts` is where to look. If it proves genuinely impossible without a mount, that is a real escalation rather than something to force.

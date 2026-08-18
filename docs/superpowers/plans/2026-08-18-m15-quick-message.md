# M15 — Quick message to players Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An organiser can send a short message to everyone in a game, or to a chosen slice of one fixture's squad, by email, by push, or both.

**Architecture:** A new notification type `n10` on the existing catalogue, sent by a new `src/notify/send-broadcast.ts` modelled beat-for-beat on `send-teams.ts` (insert-before-send, both channels, per-channel counts). Audience selection is a pure domain module with an enumerating test written before any feature work. Four new routes in their own file, one compose view, no new table and no player-visible archive.

**Tech Stack:** TypeScript, Hono, Drizzle + D1, Cloudflare Workers, Vitest, Playwright. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-18-quick-message-design.md`

## Global Constraints

Copied from `CLAUDE.md` and the spec. Every task's requirements implicitly include these.

- **Every interpolation goes through `escapeHtml`**, including `href` and class attributes. This milestone renders text a *person typed* for the first time, so this is the security story, not a style rule.
- **No `style="…"` attribute anywhere.** `style-src` is hash-only with no `style-src-attr`; a hash cannot authorise an attribute. Use a declared class. Never add `'unsafe-inline'` or `'unsafe-hashes'`. (Email templates are the exception — they are not served under the site's CSP and every existing template uses inline styles.)
- **A `<style>` block not in `PAGE_STYLE_BLOCKS`** (`src/views/styles.ts`) **is silently dropped in production** while every test passes. This plan adds no new block; it edits `FORM_CSS`, which is already enumerated.
- **`pageStyles` array order is cascade order.** `test/views/style-cascade.test.ts` only sees two blocks declaring the *same* selector; two blocks reaching one element by different selectors at equal specificity need their own test.
- **A stored value indexing a lookup table can be `undefined`.** `responses.status` is `text NOT NULL` with no CHECK constraint. Anything switching on it must have a total answer for an unrecognised value, and gets a row in `test/stored-lookups.test.ts`.
- **A backtick inside a CSS comment in `styles.ts` terminates the template literal**, reported only as a bare `TS1005`.
- **Comments name the failure a rule prevents**; they do not restate the code. A comment that overclaims is worse than none.
- **All timezone conversion goes through `formatLocalDateTime`** (TR-5).
- **Guards establish *who*; entitlement is re-asked per handler, and a refusal is a 404, not a 403** (TR-18).
- **Commands:** `npx vitest run <path>` (~9s scoped), `npm test` (full, >120s — never background it), `npm run lint && npx tsc --noEmit`, `npx playwright test` (~5min), `npm run guide:capture`.
- **Limits, verbatim:** subject ≤ 60 characters; message ≤ 500 characters; 3 broadcasts per game per UTC day; push title budget `TITLE_MAX_CHARS = 40` (`src/notify/push-copy.ts`).

## File Structure

**Create:**

| File | Responsibility |
|---|---|
| `src/domain/broadcast-audience.ts` | The audience union, the status mapping, the exclusion predicate. Pure. |
| `src/domain/broadcast-form.ts` | Parse and validate a submitted compose form. Pure. |
| `src/domain/broadcast-limit.ts` | The per-game daily cap and the UTC day boundary. Pure. |
| `src/db/broadcast-queries.ts` | The two recipient queries and the daily-count query. |
| `src/notify/templates/broadcast.ts` | The N-10 email. Pure (TR-20). |
| `src/notify/send-broadcast.ts` | Resolve, insert, send, apply. Both channels. |
| `src/views/broadcast.ts` | The compose page, both scopes. |
| `src/routes/broadcast.ts` | Four routes, ownership guard, rate limit, audit, `waitUntil` send. |

**Modify:** `src/notify/dedupe-key.ts` (`n10`, `broadcastKey`), `src/notify/push-copy.ts` (`PUSH_COPY.n10`), `src/domain/audit.ts` (two actions), `src/auth/paths.ts` (two path builders), `src/views/styles.ts` (`FORM_CSS` gains `textarea`), `src/views/game-overview.ts` and `src/views/owner-fixture.ts` (the button), `src/views/privacy.ts` (one disclosure), `src/app.ts` (mount), `test/stored-lookups.test.ts`, and the spec.

**Task order rationale:** Task 1 is the global invariant test (milestone workflow rule 1). Tasks 2–5 build the send path bottom-up, each independently testable. Tasks 6–9 build the request path. Tasks 10–13 are entry points, disclosure, the rendered-page check, and docs.

---

### Task 1: The audience module and its enumerating test

**This is task zero.** The invariant it pins — *no audience can ever select a guest, an unaddressable player, or a row whose status this build cannot name* — is otherwise rediscovered once per calling site.

**Files:**
- Create: `src/domain/broadcast-audience.ts`
- Test: `test/domain/broadcast-audience.test.ts`

**Interfaces:**
- Consumes: `ResponseStatus`, `RESPONSE_STATUSES` from `src/domain/response-status.js`.
- Produces: `BROADCAST_AUDIENCES`, `FIXTURE_AUDIENCES`, `DEFAULT_FIXTURE_AUDIENCE`, `AUDIENCE_LABELS`, `type BroadcastAudience`, `isBroadcastAudience(value: unknown): value is BroadcastAudience`, `audienceSelectsStatus(audience: BroadcastAudience, status: string): boolean`, `type BroadcastCandidate`, `isAddressable(candidate: BroadcastCandidate): boolean`.

- [ ] **Step 1: Write the failing test**

Create `test/domain/broadcast-audience.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  AUDIENCE_LABELS,
  BROADCAST_AUDIENCES,
  DEFAULT_FIXTURE_AUDIENCE,
  FIXTURE_AUDIENCES,
  audienceSelectsStatus,
  isAddressable,
  isBroadcastAudience,
  type BroadcastAudience,
} from "../../src/domain/broadcast-audience.js";
import { RESPONSE_STATUSES } from "../../src/domain/response-status.js";

/**
 * The whole point of this file (milestone workflow rule 1): every audience,
 * against every stored status including one this build cannot name, and
 * against every shape of unaddressable player — enumerated once, here, so no
 * calling site has to re-derive the rule.
 */
describe("broadcast audiences", () => {
  it("names every audience and gives each a label", () => {
    expect([...BROADCAST_AUDIENCES]).toEqual(["everyone", "playing", "waitlisted", "pending", "unavailable"]);
    for (const audience of BROADCAST_AUDIENCES) {
      expect(AUDIENCE_LABELS[audience].length).toBeGreaterThan(0);
    }
  });

  it("offers exactly the four fixture audiences, defaulting to playing", () => {
    expect([...FIXTURE_AUDIENCES]).toEqual(["playing", "waitlisted", "pending", "unavailable"]);
    expect(FIXTURE_AUDIENCES).not.toContain("everyone");
    expect(DEFAULT_FIXTURE_AUDIENCE).toBe("playing");
  });

  it("maps each fixture audience onto exactly the statuses the spec names", () => {
    const selected = (audience: BroadcastAudience): string[] =>
      RESPONSE_STATUSES.filter((status) => audienceSelectsStatus(audience, status));

    expect(selected("playing")).toEqual(["in"]);
    expect(selected("waitlisted")).toEqual(["waitlisted"]);
    expect(selected("pending")).toEqual(["pending"]);
    expect(selected("unavailable")).toEqual(["out", "withdrawn"]);
  });

  it("selects nobody by status for the game-scoped audience", () => {
    // `everyone` is resolved from memberships, never from response rows. A
    // truthy answer here would silently give a game-scoped send a second,
    // narrower recipient set depending on which query the caller happened to
    // use.
    for (const status of RESPONSE_STATUSES) {
      expect(audienceSelectsStatus("everyone", status)).toBe(false);
    }
  });

  it("excludes a stored status this build cannot name, from every audience", () => {
    // `responses.status` is text with no CHECK constraint, so a row can hold
    // anything. Excluded, not defaulted into a bucket: a message reaching
    // someone because their row was corrupt is worse than one not sent.
    for (const audience of BROADCAST_AUDIENCES) {
      expect(audienceSelectsStatus(audience, "cancelled")).toBe(false);
      expect(audienceSelectsStatus(audience, "")).toBe(false);
    }
  });

  it("every response status is claimed by exactly one fixture audience", () => {
    for (const status of RESPONSE_STATUSES) {
      const claiming = FIXTURE_AUDIENCES.filter((audience) => audienceSelectsStatus(audience, status));
      expect(claiming, `status ${status}`).toHaveLength(1);
    }
  });

  it("treats a player with an address or a device as addressable", () => {
    expect(isAddressable({ isGuest: false, email: "sam@example.com", hasDevice: false })).toBe(true);
    expect(isAddressable({ isGuest: false, email: null, hasDevice: true })).toBe(true);
  });

  it("excludes a guest however reachable they look", () => {
    // BR-32. A guest row can carry an email if an organiser typed one; it is
    // still not a person who agreed to hear from the product.
    expect(isAddressable({ isGuest: true, email: "guest@example.com", hasDevice: true })).toBe(false);
  });

  it("excludes a blank or whitespace-only address with no device", () => {
    // The `.trim()` is load-bearing: an email of " " is truthy, and letting it
    // through mints a queued row and a `no-recipient` result recorded as
    // failed forever (`applySendResult`).
    expect(isAddressable({ isGuest: false, email: null, hasDevice: false })).toBe(false);
    expect(isAddressable({ isGuest: false, email: "", hasDevice: false })).toBe(false);
    expect(isAddressable({ isGuest: false, email: "   ", hasDevice: false })).toBe(false);
  });

  it("recognises exactly the audience names, from unknown input", () => {
    expect(isBroadcastAudience("playing")).toBe(true);
    expect(isBroadcastAudience("Playing")).toBe(false);
    expect(isBroadcastAudience(undefined)).toBe(false);
    expect(isBroadcastAudience(7)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run test/domain/broadcast-audience.test.ts`
Expected: FAIL — cannot resolve `../../src/domain/broadcast-audience.js`.

- [ ] **Step 3: Write the module**

Create `src/domain/broadcast-audience.ts`:

```ts
import type { ResponseStatus } from "./response-status.js";

/**
 * Who an organiser's broadcast goes to (BR-36, spec §2).
 *
 * `everyone` is game-scoped and resolved from `memberships`; the other four
 * are fixture-scoped and resolved from `responses.status`. One union rather
 * than two because a single form, view and route serve both scopes, and a
 * split type would put a widening cast at every one of those boundaries.
 */
export const BROADCAST_AUDIENCES = ["everyone", "playing", "waitlisted", "pending", "unavailable"] as const;

export type BroadcastAudience = (typeof BROADCAST_AUDIENCES)[number];

/** The four offered on a fixture's compose page, in the order they render. */
export const FIXTURE_AUDIENCES = ["playing", "waitlisted", "pending", "unavailable"] as const;

export const DEFAULT_FIXTURE_AUDIENCE: BroadcastAudience = "playing";

/** What the radios say. One place, so the form and any later summary agree. */
export const AUDIENCE_LABELS: Record<BroadcastAudience, string> = {
  everyone: "Everyone in this squad",
  playing: "Playing",
  waitlisted: "On the waitlist",
  pending: "Not answered yet",
  unavailable: "Can't play",
};

/**
 * The mapping in the spec's §2 table, and the single place it is written.
 *
 * `status` is `string`, not `ResponseStatus`, deliberately: `responses.status`
 * is `text NOT NULL` with no CHECK constraint, so the TypeScript union is a
 * claim about the schema rather than a guarantee about the rows. An
 * unrecognised value is selected by **no** audience — excluded rather than
 * defaulted into one — because a message reaching someone on the strength of
 * a corrupt row is worse than a message not sent.
 *
 * `waitlisted` is its own audience rather than being folded into `playing`: a
 * waitlisted player has no slot, and "you're on Reds"-shaped messages must
 * not reach them. `out` and `withdrawn` pair up because the difference
 * between them is how the slot was released (BR-3), which matters to capacity
 * and to nothing an organiser writes.
 */
export function audienceSelectsStatus(audience: BroadcastAudience, status: string): boolean {
  switch (audience) {
    // Resolved from memberships, never from response rows.
    case "everyone":
      return false;
    case "playing":
      return status === "in";
    case "waitlisted":
      return status === "waitlisted";
    case "pending":
      return status === "pending";
    case "unavailable":
      return status === "out" || status === "withdrawn";
  }
}

/** Everything the exclusion rule needs to know about one candidate recipient. */
export interface BroadcastCandidate {
  isGuest: boolean;
  /** `players.email`, nullable in the schema — guests have none. */
  email: string | null;
  /** Whether this player has at least one row in `push_subscriptions`. */
  hasDevice: boolean;
}

/**
 * Whether there is any channel this player could actually be reached on
 * (spec §2.1).
 *
 * A guest is excluded whatever their row holds (BR-32): a guest is somebody an
 * organiser typed in, not somebody who agreed to hear from the product.
 *
 * The `.trim()` matches `send-teams.ts` and `send-welcome.ts` exactly, and is
 * load-bearing for the same reason: an email of `" "` is truthy, and letting
 * it through mints a `queued` row and a `no-recipient` result that
 * `applySendResult` records as `failed` forever.
 */
export function isAddressable(candidate: BroadcastCandidate): boolean {
  if (candidate.isGuest) return false;
  return (candidate.email ?? "").trim() !== "" || candidate.hasDevice;
}

/** Narrow unknown form input to an audience. */
export function isBroadcastAudience(value: unknown): value is BroadcastAudience {
  return typeof value === "string" && (BROADCAST_AUDIENCES as readonly string[]).includes(value);
}

/**
 * Present so a future `ResponseStatus` addition is a typecheck error here
 * rather than a status silently reaching no audience. Referenced by the
 * exhaustiveness case in this module's test.
 */
export type KnownStatus = ResponseStatus;
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run test/domain/broadcast-audience.test.ts`
Expected: PASS, 9 cases.

- [ ] **Step 5: Add the stored-lookup row**

Open `test/stored-lookups.test.ts`, read how existing entries are declared, and add one asserting `audienceSelectsStatus` is total over an unrecognised `responses.status` — following whatever shape that file already uses rather than inventing a second one.

- [ ] **Step 6: Run the lookup test and the typechecker**

Run: `npx vitest run test/stored-lookups.test.ts && npx tsc --noEmit && npm run lint`
Expected: PASS, clean.

- [ ] **Step 7: Commit**

```bash
git add src/domain/broadcast-audience.ts test/domain/broadcast-audience.test.ts test/stored-lookups.test.ts
git commit -m "feat: the broadcast audience rule, and the test that enumerates it"
```

---

### Task 2: The N-10 email template

**Files:**
- Create: `src/notify/templates/broadcast.ts`
- Test: `test/notify/templates/broadcast.test.ts`

**Interfaces:**
- Consumes: `escapeHtml` from `src/views/layout.js`.
- Produces: `BroadcastEmailPayload`, `BroadcastEmail`, `renderBroadcastEmail(payload: BroadcastEmailPayload): BroadcastEmail`.

Read `src/notify/templates/welcome.ts` in full first. This template copies its table shell, palette and preheader idiom exactly — for most players this is the same product's mail, and it should read like it.

- [ ] **Step 1: Write the failing test**

Create `test/notify/templates/broadcast.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { renderBroadcastEmail, type BroadcastEmailPayload } from "../../../src/notify/templates/broadcast.js";

const base: BroadcastEmailPayload = {
  playerName: "Sam",
  gameName: "Thursday 5-a-side",
  organiserName: "Jamie",
  subject: "Pitch has moved",
  message: "We're on the astro tonight.\n\nBring dark shirts.",
  whenLocal: "Thu 18 Feb, 7:30pm",
  venueName: "Riverside Park",
  leaveUrl: "https://makethe.team/leave/abc",
};

describe("the broadcast email (N-10)", () => {
  it("uses the organiser's subject verbatim", () => {
    expect(renderBroadcastEmail(base).subject).toBe("Pitch has moved");
  });

  it("says who sent it, in both parts", () => {
    const email = renderBroadcastEmail(base);
    expect(email.html).toContain("Jamie");
    expect(email.text).toContain("Jamie");
    expect(email.html).toContain("Thursday 5-a-side");
  });

  it("renders a blank line as a paragraph break and a single newline as a line break", () => {
    const email = renderBroadcastEmail(base);
    expect(email.html).toContain("We&#39;re on the astro tonight.");
    expect(email.html).toContain("Bring dark shirts.");
    const singleLine = renderBroadcastEmail({ ...base, message: "One\nTwo" });
    expect(singleLine.html).toContain("One<br>Two");
  });

  it("escapes everything a person typed", () => {
    // The first template in the catalogue rendering text a person typed. A
    // subject or a message reaching the HTML unescaped is a stored XSS in
    // whatever mail client renders it.
    const email = renderBroadcastEmail({
      ...base,
      subject: `<script>alert("s")</script>`,
      message: `<img src=x onerror=alert(1)> & "quotes"`,
    });
    expect(email.html).not.toContain("<script>");
    expect(email.html).not.toContain("<img src=x");
    expect(email.html).toContain("&lt;script&gt;");
    expect(email.html).toContain("&lt;img src=x");
  });

  it("does not autolink or interpret anything else in the message", () => {
    const email = renderBroadcastEmail({ ...base, message: "See https://example.com and **bold**" });
    expect(email.html).not.toContain("<a href=\"https://example.com\"");
    expect(email.html).not.toContain("<strong>");
    expect(email.html).toContain("**bold**");
  });

  it("carries the fixture's when and where when it has one", () => {
    const email = renderBroadcastEmail(base);
    expect(email.html).toContain("Thu 18 Feb, 7:30pm");
    expect(email.html).toContain("Riverside Park");
  });

  it("says nothing about a fixture for a game-scoped send", () => {
    // A game-scoped broadcast has no fixture. Rendering an empty date line is
    // how "Your first game is null" reaches an inbox (see welcome.ts).
    const email = renderBroadcastEmail({ ...base, whenLocal: null, venueName: null });
    expect(email.html).not.toContain("Riverside Park");
    expect(email.html).not.toContain("undefined");
    expect(email.html).not.toContain("null");
  });

  it("carries a working leave link (BR-22)", () => {
    expect(renderBroadcastEmail(base).html).toContain("https://makethe.team/leave/abc");
    expect(renderBroadcastEmail(base).text).toContain("https://makethe.team/leave/abc");
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run test/notify/templates/broadcast.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the template**

Create `src/notify/templates/broadcast.ts`. Copy the `<!doctype html>` table shell, the preheader `<div>`, the palette literals and the footer shape from `src/notify/templates/welcome.ts` — do not invent a second layout. The parts specific to this template:

```ts
import { escapeHtml } from "../../views/layout.js";

/**
 * Everything the organiser broadcast (N-10) needs. Pure (TR-20): no clock, no
 * bindings, no database. `whenLocal` arrives already formatted in the game's
 * timezone by the caller (TR-5), as in every other template here.
 *
 * The first template in the catalogue rendering text a *person* typed rather
 * than copy written in this repo. Everything from `subject` and `message` is
 * escaped and nothing in it is interpreted — no Markdown, no autolinking — so
 * that what an organiser sees in the textarea is what lands in the inbox, and
 * so that there is exactly one answer to "what can a message do to the HTML".
 */
export interface BroadcastEmailPayload {
  /** The player this copy is for. Shown only in a plain greeting. */
  playerName: string;
  gameName: string;
  /** Who sent it. There is no reply-to (spec §6), so the name is the whole attribution. */
  organiserName: string;
  /** The organiser's own subject line, used verbatim. */
  subject: string;
  /** The organiser's own words. Blank lines separate paragraphs; nothing else is interpreted. */
  message: string;
  /**
   * The fixture's kick-off, already formatted. `null` for a game-scoped
   * broadcast, which has no fixture — and the copy then says nothing about
   * one rather than rendering an empty line, which is how "Your first game is
   * null" reaches an inbox (see `welcome.ts`).
   */
  whenLocal: string | null;
  /** The fixture's venue. `null` alongside `whenLocal`, and for the same reason. */
  venueName: string | null;
  /** A working leave-game link (BR-22), scoped to the game. */
  leaveUrl: string;
}

export interface BroadcastEmail {
  subject: string;
  html: string;
  text: string;
}

/**
 * Turn the organiser's message into HTML paragraphs.
 *
 * Escaped **first**, then the newline handling is applied to the escaped
 * string — the other order would let an escape sequence be produced from
 * markup this function itself inserted. A blank line starts a paragraph; a
 * single newline is a `<br>`, because an organiser typing a list of three
 * things expects three lines.
 */
function paragraphs(message: string): string {
  return message
    .split(/\r?\n\s*\r?\n/)
    .map((block) => escapeHtml(block).replace(/\r?\n/g, "<br>"))
    .filter((block) => block.trim() !== "")
    .map(
      (block) =>
        `<p style="margin:0 0 16px; font-size:15px; line-height:1.5; color:#1c1b19;">${block}</p>`,
    )
    .join("\n");
}

export function renderBroadcastEmail(payload: BroadcastEmailPayload): BroadcastEmail {
  const { playerName, gameName, organiserName, subject, message, whenLocal, venueName, leaveUrl } = payload;

  // The organiser's own words, unprefixed. A product-added prefix would eat
  // the front of the subject line in every mail client's list view, which is
  // the one place the organiser's sixty characters have to work.
  const emailSubject = subject;

  const fixtureLine =
    whenLocal === null || venueName === null
      ? ""
      : `<p style="margin:0 0 16px; font-size:14px; line-height:1.5; color:#6b6862;">About ${escapeHtml(whenLocal)} at ${escapeHtml(venueName)}.</p>`;

  // …assemble `html` from welcome.ts's shell, with:
  //   greeting: `Hi ${escapeHtml(playerName)},`
  //   attribution: `${escapeHtml(organiserName)} sent this to the squad for ${escapeHtml(gameName)}.`
  //   fixtureLine, then paragraphs(message)
  //   footer: the leave link, `href="${escapeHtml(leaveUrl)}"`
  // and `text` as the same content, plain, with the same leave URL.

  return { subject: emailSubject, html, text };
}
```

Write out `html` and `text` in full — the comment block above is a map of what goes where, not something to leave in the file.

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run test/notify/templates/broadcast.test.ts`
Expected: PASS, 8 cases.

- [ ] **Step 5: Commit**

```bash
git add src/notify/templates/broadcast.ts test/notify/templates/broadcast.test.ts
git commit -m "feat: the N-10 broadcast email, escaping everything a person typed"
```

---

### Task 3: `n10` joins the catalogue

**Files:**
- Modify: `src/notify/dedupe-key.ts`, `src/notify/push-copy.ts`
- Test: `test/notify/dedupe-key.test.ts` (find the existing file), `test/notify/push-copy.test.ts`

**Interfaces:**
- Consumes: `BroadcastEmailPayload` (Task 2).
- Produces: `"n10"` in `NOTIFICATION_TYPES`, `broadcastKey(broadcastId: string, playerId: string): string`, `PUSH_COPY.n10`.

Both edits land in one task on purpose: adding `"n10"` to `NOTIFICATION_TYPES` without a `PUSH_COPY` entry breaks `test/notify/push-copy.test.ts`'s "covers every notification type" case, so they are not separately reviewable.

- [ ] **Step 1: Write the failing tests**

Add to `test/notify/dedupe-key.test.ts` (match the file's existing style):

```ts
describe("broadcastKey", () => {
  it("is unique per broadcast and per recipient", () => {
    expect(broadcastKey("b-1", "p-1")).toBe("n10:b-1:p-1");
    expect(broadcastKey("b-1", "p-2")).not.toBe(broadcastKey("b-1", "p-1"));
    expect(broadcastKey("b-2", "p-1")).not.toBe(broadcastKey("b-1", "p-1"));
  });
});
```

In `test/notify/push-copy.test.ts`, extend `sampleContext` with the two fields `PUSH_COPY.n10` reads — `subject: "Pitch has moved"` and `message: "We're on the astro tonight."` — and add:

```ts
it("keeps the broadcast title inside the tray budget however long the subject is", () => {
  const copy = PUSH_COPY.n10({ ...sampleContext, subject: "x".repeat(60) } as never);
  expect(copy.title.length).toBeLessThanOrEqual(40);
  expect(copy.title.endsWith("…")).toBe(true);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run test/notify/dedupe-key.test.ts test/notify/push-copy.test.ts`
Expected: FAIL — `broadcastKey` and `PUSH_COPY.n10` are not exported.

- [ ] **Step 3: Extend the catalogue**

In `src/notify/dedupe-key.ts`, add `"n10"` to `NOTIFICATION_TYPES` and:

```ts
/**
 * N-10 organiser broadcast: once per recipient per send (BR-36, M15).
 *
 * `broadcastId` is a UUID minted once per request and shared by every
 * recipient of that send. Not a timestamp, as N-2 and N-9 use: two broadcasts
 * a second apart are both genuinely new information, and `Date.now()` is
 * frozen between I/O inside one Worker invocation — so two sends within one
 * request would mint the same key and the unique index on `dedupe_key` would
 * silently drop the second, which for the one notification a person wrote by
 * hand is the worst available failure.
 */
export function broadcastKey(broadcastId: string, playerId: string): string {
  return `n10:${broadcastId}:${playerId}`;
}
```

In `src/notify/push-copy.ts`, add the builder and its `PUSH_COPY` entry (both the type literal and the object):

```ts
/**
 * What happened: the organiser's own subject, fitted to the tray. When and
 * where: their own first words, which is the only thing here the product did
 * not write and therefore the only thing worth showing.
 *
 * `tag` follows N-9's shape and is overridden by the caller with the real
 * broadcast id — two different broadcasts must never collapse into one another
 * in the tray, which is exactly what a game-name-based tag would do.
 */
function broadcast({ subject, message, gameName }: BroadcastEmailPayload): PushCopy {
  return {
    title: gameNameTitle("", subject, ""),
    body: message,
    tag: `n10:${gameName}:${subject}`,
  };
}
```

Note `gameNameTitle("", subject, "")` reuses the existing `fitName` budget arithmetic against `TITLE_MAX_CHARS`; do not add a second truncation helper.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run test/notify/ && npx tsc --noEmit`
Expected: PASS. If any other test enumerates `NOTIFICATION_TYPES`, it will now flag the addition — update it rather than working around it.

- [ ] **Step 5: Commit**

```bash
git add src/notify/dedupe-key.ts src/notify/push-copy.ts test/notify/
git commit -m "feat: n10 joins the notification catalogue, with its key and its tray copy"
```

---

### Task 4: The recipient and rate-limit queries

**Files:**
- Create: `src/db/broadcast-queries.ts`, `src/domain/broadcast-limit.ts`
- Modify: `src/domain/audit.ts`
- Test: `test/db/broadcast-queries.test.ts`, `test/domain/broadcast-limit.test.ts`

**Interfaces:**
- Consumes: `Db` from `src/db/client.js`; `players`, `memberships`, `responses`, `auditLog` from `src/db/schema.js`; `isAddressable` (Task 1).
- Produces: `BroadcastRecipient`, `listGameRecipients(db, gameId): Promise<BroadcastRecipient[]>`, `listFixtureRecipients(db, fixtureId): Promise<BroadcastRecipient[]>`, `countBroadcastsSince(db, gameId, since: Date): Promise<number>`, `MAX_BROADCASTS_PER_GAME_PER_DAY`, `utcDayStart(now: Date): Date`, and the audit actions `"game.broadcast_sent"` / `"game.broadcast_email_deferred"`.

Read an existing DB test (`test/db/` — pick one that builds a database) for how a test database is created and seeded, and follow it exactly.

- [ ] **Step 1: Write the failing tests**

`test/domain/broadcast-limit.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { MAX_BROADCASTS_PER_GAME_PER_DAY, utcDayStart } from "../../src/domain/broadcast-limit.js";

describe("the broadcast day", () => {
  it("caps a game at three sends a day", () => {
    expect(MAX_BROADCASTS_PER_GAME_PER_DAY).toBe(3);
  });

  it("starts the day at UTC midnight, matching the email quota's own day key", () => {
    expect(utcDayStart(new Date("2026-08-18T23:59:59.999Z")).toISOString()).toBe("2026-08-18T00:00:00.000Z");
    expect(utcDayStart(new Date("2026-08-19T00:00:00.000Z")).toISOString()).toBe("2026-08-19T00:00:00.000Z");
  });
});
```

`test/db/broadcast-queries.test.ts` — cases:

1. `listGameRecipients` returns every active member of the game, with `name`, `email`, `isGuest` and `hasDevice`, and returns nobody from a different game.
2. `listGameRecipients` omits a member whose `memberships.active` is false.
3. `listFixtureRecipients` returns one row per response row on that fixture, carrying the **raw** `status` string.
4. `listFixtureRecipients` sets `hasDevice` true for a player with a `push_subscriptions` row and false otherwise, and reports it once for a player with two devices.
5. `countBroadcastsSince` counts only `game.broadcast_sent` rows for that game at or after the boundary — not another game's, not another action, not yesterday's.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run test/domain/broadcast-limit.test.ts test/db/broadcast-queries.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write the modules**

`src/domain/broadcast-limit.ts`:

```ts
/**
 * How many broadcasts one game may send in a UTC day (BR-36, spec §7).
 *
 * This is the first path in the product that lets a *person* spend the global
 * daily email ceiling (`MAX_EMAILS_PER_DAY`, TR-31) on demand. Without a
 * per-game limit, one organiser with a 200-player squad starves every other
 * game's reminders for the rest of the day.
 *
 * Three is a starting number, not a law. It is here, alone, with its reasoning
 * attached, so raising it is one edit.
 */
export const MAX_BROADCASTS_PER_GAME_PER_DAY = 3;

/**
 * The UTC midnight the day containing `now` began at.
 *
 * UTC, matching `QuotaNotifier`'s own `dayKey` rather than the game's local
 * timezone: the resource being protected is the global daily email ceiling,
 * which resets on the UTC day, and a per-game local day would let a game in
 * UTC+13 spend against two of them.
 */
export function utcDayStart(now: Date): Date {
  return new Date(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`);
}
```

`src/db/broadcast-queries.ts` — three queries. Requirements the implementation must hold to:

- Both recipient queries **join** `players` (and `push_subscriptions`) rather than taking an `IN (...)` list of player ids. `MAX_PLAYERS_CEILING` allows 200 players and D1 binds at most 100 parameters (`src/db/chunk.ts`); `sendTeamsEmails` documents this same trap at length. The query's parameter count must not depend on squad size.
- `hasDevice` comes from a `selectDistinct`/left-join on `push_subscriptions`, so two devices produce one recipient row, not two.
- `status` is typed `string`, not `ResponseStatus` — deliberately, so the caller is forced through `audienceSelectsStatus`.

```ts
export interface BroadcastRecipient {
  playerId: string;
  name: string;
  /** Nullable in the schema — guests have none. */
  email: string | null;
  isGuest: boolean;
  /** At least one row in `push_subscriptions`. */
  hasDevice: boolean;
  /**
   * The raw `responses.status` for a fixture-scoped query, `null` for a
   * game-scoped one. Typed `string`, not `ResponseStatus`: the column has no
   * CHECK constraint (see `broadcast-audience.ts`), and widening it here is
   * what forces every caller through `audienceSelectsStatus`.
   */
  status: string | null;
}
```

In `src/domain/audit.ts`, add to `AUDIT_ACTIONS`, with the comment saying what each row is for:

```ts
  // M15 (BR-36). One row per broadcast an organiser sends, and the counter the
  // per-game daily cap is enforced from (`src/domain/broadcast-limit.ts`) —
  // there is no message table, so these rows are the only record that a send
  // happened. `after_json` carries the audience, the channels, the recipient
  // count, the fixture id, and the **subject only**: copying 500 characters of
  // somebody's prose into a second, longer-lived place is not what an audit
  // trail is for.
  "game.broadcast_sent",
  // The durable half of TR-31's warning for N-10, matching the
  // `*_email_deferred` family above. A ceiling refusal deletes its
  // `notification_log` row, so without this there is no evidence anyone was
  // ever owed the message.
  "game.broadcast_email_deferred",
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run test/domain/broadcast-limit.test.ts test/db/broadcast-queries.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/broadcast-queries.ts src/domain/broadcast-limit.ts src/domain/audit.ts test/db/broadcast-queries.test.ts test/domain/broadcast-limit.test.ts
git commit -m "feat: who a broadcast reaches, and how many a game gets a day"
```

---

### Task 5: The sender

**Files:**
- Create: `src/notify/send-broadcast.ts`
- Test: `test/notify/send-broadcast.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–4, plus `insertQueuedLogRows`, `applySendResult`, `markOrphanedRowsFailed`, `playersWithPushSubscriptions`, `SITE_ORIGIN` from `src/notify/delivery.js`; `signLeaveToken`, `leaveTokenExpiry`, `signResponseToken`, `responseTokenExpiry` from `src/domain/token.js`; `gamePath` from `src/auth/paths.js`; `formatLocalDateTime` from `src/domain/time/zone.js`.
- Produces: `BroadcastSendResult`, `SendBroadcastParams`, `sendBroadcast(params: SendBroadcastParams): Promise<BroadcastSendResult>`.

**Read `src/notify/send-teams.ts` in full before writing a line of this.** It is the same shape — one batch, many recipients, both channels — and every non-obvious decision in it (why the counts split by channel, why `markOrphanedRowsFailed` exists, why push subscriptions are fetched once) applies here unchanged.

```ts
export interface BroadcastSendResult {
  /** Email only, exactly as `TeamsSendResult.sent` is. */
  sent: number;
  failed: number;
  deferred: number;
  deferredPlayerIds: string[];
  pushSent: number;
  pushFailed: number;
  /** Selected by the audience but unaddressable (spec §2.1). Never a log row. */
  skipped: number;
}

export interface SendBroadcastParams {
  db: Db;
  /** Always the quota-wrapped notifier from `createNotifier`. */
  notifier: Notifier;
  /** Minted once per request; shared by every recipient of this send. */
  broadcastId: string;
  gameId: string;
  /** The fixture for a fixture-scoped send, `null` for a game-scoped one. */
  fixtureId: string | null;
  audience: BroadcastAudience;
  subject: string;
  message: string;
  organiserName: string;
  /** Whether each channel was asked for. A ceiling on what is attempted, never a promise. */
  channels: { email: boolean; push: boolean };
  now: Date;
  responseTokenSecret: string;
}

export async function sendBroadcast(params: SendBroadcastParams): Promise<BroadcastSendResult>;
```

Rules the implementation must hold to, each with a test below:

- Recipients come from `listGameRecipients` for `everyone` and `listFixtureRecipients` filtered by `audienceSelectsStatus` otherwise; then `isAddressable` filters, and everyone it drops increments `skipped`.
- `playersWithPushSubscriptions` is consulted once for the batch. A `PushMessage` is built only for a player it names **and** only when `channels.push`. An `EmailMessage` only for a player with a non-blank trimmed address **and** only when `channels.email`.
- The push `url`: for a fixture-scoped send whose `responseTokenExpiry(fixture.kicksOffAt)` is still ahead of `now`, a freshly signed `${SITE_ORIGIN}/r/${token}` — the same destination N-9 uses, which renders the fixture with no write. Otherwise `${SITE_ORIGIN}${gamePath(gameId)}`. Push subscriptions only exist for signed-in players, so the game page is always reachable for anyone holding one.
- The push `tag` is `n10:${broadcastId}` — set by the caller, overriding `PUSH_COPY.n10`'s own, so two different broadcasts never collapse in the tray.
- `notification_log.fixture_id` is `fixtureId` (already nullable — N-6 is the precedent).
- Order is insert → send → apply → `markOrphanedRowsFailed`, unchanged (BR-19, §2.4).
- Email and push counts never fold together.

- [ ] **Step 1: Write the failing test**

Create `test/notify/send-broadcast.test.ts`. Read `test/notify/send-teams.test.ts` first and reuse its fixtures and fake notifier rather than building a second set. Cases:

1. **Both channels.** A squad of three, all with addresses, two with devices → 3 email messages and 2 push messages, `sent: 3`, `pushSent: 2`.
2. **Email only.** `channels: { email: true, push: false }` → no `PushMessage` reaches the notifier even for a player with a device.
3. **Push only.** `channels: { email: false, push: true }` → no `EmailMessage`, and a player with an address but no device receives nothing and is **not** counted as `skipped` (they were addressable; the organiser chose a channel they lack).
4. **No device, both channels.** A player with an address and no device gets exactly one message, on email.
5. **Guest.** Excluded, counted in `skipped`, no `notification_log` row.
6. **Blank address, no device.** Same.
7. **Unrecognised status.** A response row with `status: "cancelled"` receives nothing under every audience.
8. **Audience.** With `audience: "waitlisted"`, only the waitlisted player is messaged; with `"unavailable"`, both the `out` and the `withdrawn` player are.
9. **`everyone`.** Reaches an active member with no response row at all for the fixture.
10. **Dedupe.** Every log row's `dedupe_key` starts `n10:<broadcastId>:`; a second call with a new `broadcastId` and identical text inserts a second set of rows.
11. **Ceiling.** A notifier returning `DAILY_CEILING_REASON` for the email leg gives `deferred: 1`, names the player in `deferredPlayerIds`, and leaves no `notification_log` row — while a push refusal lands in `pushFailed`, never in `deferred`.
12. **Push URL.** Fixture-scoped with a future kick-off → `/r/`; with a kick-off long past → the game path.
13. **Tag.** Two sends with different `broadcastId`s produce different `tag`s.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/notify/send-broadcast.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the sender**

Follow `send-teams.ts`'s structure exactly: resolve, build `pending`, `insertQueuedLogRows`, `notifier.send` inside a `try` whose `catch` marks the whole batch `failed` and splits the counts by channel, then the apply loop with its own `catch` calling `markOrphanedRowsFailed`.

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run test/notify/send-broadcast.test.ts && npx tsc --noEmit && npm run lint`
Expected: PASS, 13 cases, clean.

- [ ] **Step 5: Commit**

```bash
git add src/notify/send-broadcast.ts test/notify/send-broadcast.test.ts
git commit -m "feat: send one organiser broadcast on both channels"
```

---

### Task 6: The form parser

**Files:**
- Create: `src/domain/broadcast-form.ts`
- Test: `test/domain/broadcast-form.test.ts`

**Interfaces:**
- Consumes: `FieldError` from `src/domain/game-form.js` (read that file and reuse the exported type; do not declare a second one), `BroadcastAudience`, `isBroadcastAudience`, `DEFAULT_FIXTURE_AUDIENCE`.
- Produces: `MAX_SUBJECT_LENGTH`, `MAX_MESSAGE_LENGTH`, `BroadcastFormValues`, `BroadcastFormResult`, `parseBroadcastForm(body: Record<string, unknown>, scope: "game" | "fixture"): BroadcastFormResult`.

```ts
export const MAX_SUBJECT_LENGTH = 60;
export const MAX_MESSAGE_LENGTH = 500;

export interface BroadcastFormValues {
  subject: string;
  message: string;
  email: boolean;
  push: boolean;
  /** Always `"everyone"` for the game scope, whatever was submitted. */
  audience: BroadcastAudience;
}

export type BroadcastFormResult =
  | { ok: true; values: BroadcastFormValues }
  /** `values` is what was typed, so a refusal can re-render the form with it intact. */
  | { ok: false; values: BroadcastFormValues; errors: FieldError[] };
```

- [ ] **Step 1: Write the failing test**

Create `test/domain/broadcast-form.test.ts`. Cases:

1. A complete fixture submission parses, with `audience` as submitted.
2. A missing subject fails on `subject`; a 61-character subject fails; a 60-character one passes.
3. A missing message fails on `message`; a 501-character message fails; a 500-character one passes.
4. A whitespace-only subject or message fails — `"   "` is not a message.
5. Both checkboxes absent fails on `channels` with a message naming the problem. This is the case that must never pass: a submission that sends nothing while appearing to succeed.
6. One checkbox present passes, with the other `false`.
7. An unrecognised `audience` on the fixture scope fails on `audience` rather than defaulting.
8. An absent `audience` on the fixture scope defaults to `DEFAULT_FIXTURE_AUDIENCE`.
9. The game scope forces `audience` to `"everyone"` even when the body names `"playing"` — a game-scoped form has no audience control, so anything arriving in that field is forged.
10. A failing parse returns the typed subject and message in `values`.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/domain/broadcast-form.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the parser**

Model it on `parseGameForm` in `src/domain/game-form.ts` — same `errors` array, same `fail` helper, same `text()` trimming idiom. Read that file and reuse its helpers rather than writing new ones.

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run test/domain/broadcast-form.test.ts && npx tsc --noEmit`
Expected: PASS, 10 cases.

- [ ] **Step 5: Commit**

```bash
git add src/domain/broadcast-form.ts test/domain/broadcast-form.test.ts
git commit -m "feat: parse a compose form, and refuse one that would send nothing"
```

---

### Task 7: The compose page

**Files:**
- Create: `src/views/broadcast.ts`
- Modify: `src/views/styles.ts` (`FORM_CSS` only), `src/auth/paths.ts`
- Test: `test/views/broadcast.test.ts`

**Interfaces:**
- Consumes: `layout`, `escapeHtml` from `src/views/layout.js`; `FORM_CSS` from `src/views/styles.js`; the audience and form constants.
- Produces: `BroadcastPageParams`, `renderBroadcastPage(params: BroadcastPageParams): string`, and in `paths.ts`: `gameMessagePath(gameId: string): string` → `/g/<id>/message`, `fixtureMessagePath(gameId: string, fixtureId: string): string` → `/g/<id>/f/<fixtureId>/message`.

```ts
export interface BroadcastPageParams {
  gameId: string;
  gameName: string;
  /** Fixture-scoped only. Absent renders the game-scoped page. */
  fixture?: { id: string; whenLocal: string };
  /** Per-audience recipient counts, for the radio labels and the button. */
  counts: Record<BroadcastAudience, number>;
  /** What was typed, for re-rendering a refusal. Empty strings on a fresh GET. */
  values: BroadcastFormValues;
  /** Field errors from `parseBroadcastForm`, plus any route-level refusal. */
  errors?: readonly FieldError[];
  /** A whole-page refusal, e.g. the daily cap. Rendered above the form. */
  problem?: string;
}
```

**The `FORM_CSS` change:** `FORM_CSS` styles `.field input, .field select` and knows nothing about `textarea`. A textarea rendered inside a `.field` today is an unstyled browser default sitting among styled controls — exactly the failure string assertions cannot see. Add `textarea` to the three existing selectors (`.field input, .field select`, the `:focus-visible` rule, and `.field-invalid input, .field-invalid select`) and give it a `min-height` and `resize: vertical`. **No new style block** — `FORM_CSS` is already in `PAGE_STYLE_BLOCKS`, and its hash is derived from the constant, so the CSP follows automatically.

- [ ] **Step 1: Write the failing test**

Create `test/views/broadcast.test.ts`. Cases:

1. The fixture page renders four audience radios, named by `AUDIENCE_LABELS`, with `playing` checked by default and each carrying its count.
2. The game page renders **no** audience radios and says it goes to everyone.
3. Both channel checkboxes render, both checked by default.
4. The submit button names the count for the selected audience.
5. The form is `method="post"` with the right `action` for its scope.
6. A game name containing `<script>` is escaped, in the heading and in every place it appears.
7. A submitted subject and message survive a re-render with markup intact but escaped — `"</textarea><script>"` must not close the textarea.
8. `errors` render against their fields; `problem` renders above the form.
9. The page passes `FORM_CSS` in `pageStyles` and emits no `style=` attribute.
10. A back link to the fixture or game page.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/views/broadcast.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the view and the CSS change**

Use `.field` for subject and message, `.switch-row` for the two channel checkboxes (it already exists in `FORM_CSS` and is exactly this shape), and `.actions` for the submit. Add the two path builders to `paths.ts` with doc comments matching the ones already there.

- [ ] **Step 4: Run it, plus the cascade guard**

Run: `npx vitest run test/views/ && npx tsc --noEmit && npm run lint`
Expected: PASS, including `test/views/style-cascade.test.ts`. That test only sees two blocks declaring the *same* selector — this change adds `textarea` to selectors only `FORM_CSS` declares, so it should stay green. If it does not, reorder or list the collision with a reason as that file requires.

- [ ] **Step 5: Commit**

```bash
git add src/views/broadcast.ts src/views/styles.ts src/auth/paths.ts test/views/broadcast.test.ts
git commit -m "feat: the compose page, and a textarea that is not an unstyled default"
```

---

### Task 8: The two compose routes

**Files:**
- Create: `src/routes/broadcast.ts`
- Modify: `src/app.ts`
- Test: `test/routes/broadcast-get.test.ts`

**Interfaces:**
- Consumes: `requirePlayer` from `src/auth/session.js`, `getDb`, `findGameForOwner`, `getFixtureWithSquad`, the queries from Task 4, `renderBroadcastPage`.
- Produces: `export const broadcast = new Hono<AppEnv>()`, mounted in `createApp`.

Read `src/routes/account.ts` for the file's shape and `src/routes/games.ts`'s `GET /g/:id/f/:fixtureId` for how a fixture is loaded and checked against its game.

- [ ] **Step 1: Write the failing test**

Create `test/routes/broadcast-get.test.ts`. Cases:

1. `GET /g/:id/message` as the owner → 200, the game-scoped page, with the member count.
2. `GET /g/:id/f/:fixtureId/message` as the owner → 200, four audiences with correct counts for a seeded squad.
3. As a signed-in **player** of the game → **404** on both (TR-18: a refusal is a 404, not a 403).
4. As a signed-in stranger → 404 on both.
5. Signed out → whatever `requirePlayer` does elsewhere; assert the same behaviour the other authenticated routes' tests assert, not a guess.
6. A fixture id belonging to a **different** game → 404.
7. An unknown game id → 404.
8. Counts exclude guests and unaddressable players, so the page's number matches what a send would actually do.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/routes/broadcast-get.test.ts`
Expected: FAIL — route not mounted.

- [ ] **Step 3: Write the routes and mount them**

Both handlers: `findGameForOwner` → `notFound` on null; for the fixture scope load the fixture and check `fixture.gameId === game.id`; build `counts` by running the recipient query once and reducing it through `audienceSelectsStatus` + `isAddressable` — one query, five counts, not five queries. Mount in `src/app.ts` beside `gamesRoutes`; note `GAMES_PREFIX` already governs `/g/*` middleware, so the new routes inherit whatever that mount applies.

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run test/routes/broadcast-get.test.ts && npx tsc --noEmit`
Expected: PASS, 8 cases.

- [ ] **Step 5: Commit**

```bash
git add src/routes/broadcast.ts src/app.ts test/routes/broadcast-get.test.ts
git commit -m "feat: the compose routes, refusing a non-organiser with a 404"
```

---

### Task 9: The send routes

**Files:**
- Modify: `src/routes/broadcast.ts`
- Test: `test/routes/broadcast-post.test.ts`

**Interfaces:**
- Consumes: `parseBroadcastForm`, `MAX_BROADCASTS_PER_GAME_PER_DAY`, `utcDayStart`, `countBroadcastsSince`, `recordAudit`, `createNotifier`, `sendBroadcast`.
- Produces: `POST /g/:id/message` and `POST /g/:id/f/:fixtureId/message`.

Handler order, and each step's reason:

1. `findGameForOwner`, else 404. Entitlement is re-asked per handler (TR-18).
2. Load and check the fixture for the fixture scope, else 404.
3. `parseBroadcastForm`. On failure, re-render the compose page at **422** with `values` and `errors` — same page, same shape, reason on it, exactly as the delete-account route re-renders its own refusal.
4. `countBroadcastsSince(db, gameId, utcDayStart(now))`. At or over `MAX_BROADCASTS_PER_GAME_PER_DAY`, re-render at **422** with `problem` naming the cap and what was typed preserved.
5. Mint `broadcastId = crypto.randomUUID()`.
6. `recordAudit` the `game.broadcast_sent` row **before** handing the send to `waitUntil`. It is the rate-limit counter: written after, two concurrent submissions both count zero and both send.
7. `c.executionCtx.waitUntil(...)` the send, wrapped in a `catch` that logs — a rejected promise inside `waitUntil` resolves into nothing (`games.ts` says so twice).
8. Redirect to the fixture or game page.

`after_json` on the audit row: `{ audience, channels, recipientCount, fixtureId, subject }` — **not the message body** (spec §8).

- [ ] **Step 1: Write the failing test**

Create `test/routes/broadcast-post.test.ts`. Cases:

1. A valid fixture-scoped submission redirects, writes one `game.broadcast_sent` row, and produces `notification_log` rows with `n10:` keys for exactly the `in` players.
2. `after_json` carries the audience, channels, count, fixture id and subject — and **not** the message body.
3. A game-scoped submission writes a row whose `after_json.fixtureId` is `null`, and `notification_log.fixture_id` is null.
4. Neither channel checked → 422, the compose page, the typed subject and message still in the HTML, nothing sent, no audit row.
5. An over-long message → 422, nothing sent.
6. The fourth send in a UTC day → 422 with the cap named, nothing sent, no fourth audit row. The third succeeds.
7. Yesterday's audit rows do not count toward today's cap.
8. A non-organiser → 404, nothing sent, no audit row.
9. A fixture belonging to another game → 404.
10. The audit row is written even when the send later fails, because it is the counter.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/routes/broadcast-post.test.ts`
Expected: FAIL — no POST handler.

- [ ] **Step 3: Write the handlers**

- [ ] **Step 4: Run the whole route and notify suites**

Run: `npx vitest run test/routes/ test/notify/ && npx tsc --noEmit && npm run lint`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add src/routes/broadcast.ts test/routes/broadcast-post.test.ts
git commit -m "feat: send a broadcast, capped at three a game a day"
```

---

### Task 10: The buttons

**Files:**
- Modify: `src/views/owner-fixture.ts`, `src/views/game-overview.ts`
- Test: `test/views/owner-fixture.test.ts`, `test/views/game-overview.test.ts` (find the existing files)

- [ ] **Step 1: Write the failing tests**

Add to each view's existing test file:

- The organiser's fixture page renders a link to `fixtureMessagePath(gameId, fixtureId)` labelled "Message players".
- The game overview renders a link to `gameMessagePath(gameId)` labelled "Message everyone".
- Neither appears on the player-facing game page (`src/views/player-game.ts`) — assert against that view's own test file.
- The escaped `href` contains the game and fixture ids.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run test/views/owner-fixture.test.ts test/views/game-overview.test.ts`
Expected: FAIL — the link is absent.

- [ ] **Step 3: Add the links**

A `.button` inside the existing `.actions` group on each page, not a new group. Each page already has exactly one primary action (publish teams; the invite link) — the broadcast button is secondary, so it must not take `.button primary`.

- [ ] **Step 4: Run them and watch them pass**

Run: `npx vitest run test/views/ && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/views/owner-fixture.ts src/views/game-overview.ts test/views/
git commit -m "feat: a way in, from the fixture page and the game page"
```

---

### Task 11: The privacy disclosure

**Files:**
- Modify: `src/views/privacy.ts`
- Test: `test/views/privacy.test.ts` (find the existing file)

What changes for a player is not what is collected but **who can cause mail to arrive**: the product, and now their organiser. That is a disclosure (spec §9).

- [ ] **Step 1: Write the failing test**

Assert the privacy page says an organiser of a game you're in can send you a message by email and, if you have registered a device, by push. Match the assertion style the file already uses.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/views/privacy.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write the sentence**

Place it in the existing section about who sees what and what the product sends, beside the M14 push disclosure — not as a new section.

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run test/views/privacy.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/views/privacy.ts test/views/privacy.test.ts
git commit -m "docs: the privacy page says an organiser can message you"
```

---

### Task 12: Look at the rendered page

Milestone workflow rule 3: string assertions cannot see an unstyled textarea, a checkbox invisible against its track, or a row whose shape depends on its content. This task is not optional and its deliverable is *having read the PNG*.

**Files:**
- Modify: `test/browser/` (add a spec; read `test/browser/push.spec.ts` and `docs/runbooks/browser-testing.md` first)

- [ ] **Step 1: Write a browser test that reaches the compose page**

Sign in as an organiser, open the fixture compose page, assert the four audience radios and both checkboxes are present and operable with scripting available, and capture a screenshot of the page.

- [ ] **Step 2: Run the browser suite**

Run: `npx playwright test` (~5min; run it in the controller, never backgrounded)
Expected: PASS.

- [ ] **Step 3: Read the PNG**

Open the captured screenshot and actually look at it. Check: the textarea is styled like the inputs beside it; the two checkboxes are visible against their track in both themes; the audience radios and their counts line up; the submit button's count reads correctly; nothing overflows at phone width.

- [ ] **Step 4: Fix whatever the PNG showed, and re-capture**

If the page needed a CSS change, it goes in `FORM_CSS` (already enumerated) — and if a genuinely new block proves necessary, it must be added to `PAGE_STYLE_BLOCKS` or it will be silently dropped in production with every test still green.

- [ ] **Step 5: Commit**

```bash
git add test/browser/
git commit -m "test: see the compose page in a browser, not only in assertions"
```

---

### Task 13: Spec and docs

**Files:**
- Modify: `docs/superpowers/specs/2026-08-10-make-the-team-design.md`, `docs/superpowers/specs/2026-08-18-quick-message-design.md`

- [ ] **Step 1: Amend the master spec**

Four edits, per the design's §11:

- §2.8's notification catalogue table gains: `| N-10 | Organiser broadcast | Chosen audience of a game or fixture, never guests (BR-32) | 1 per send per player | Email + Push |`
- §2.8's dedupe-key table gains: `| N-10 organiser broadcast | n10:<broadcast_id>:<player_id> | Once per recipient per send; the id is minted per request, so a second broadcast always sends |`
- A new **BR-36** in the business-rules list, stating: an Owner may send a short message (subject ≤ 60 characters, body ≤ 500) to a chosen audience of a Game or one of its Fixtures, on either channel or both, at most three times per Game per UTC day; guests and unaddressable players are never recipients; nothing is stored for players to read later.
- §2.14's build order gains an **M15** row, done when an organiser can message their squad from the fixture page and a phone with a registered device receives it.

- [ ] **Step 2: Close the design's one open question**

The design's §9 leaves erasure "to be confirmed against `src/domain/erase-player.ts`". It has since been read: that module updates `notification_log` rows by `player_id` with no reference to `notification_type`, so `n10` rows are covered with no new handling. Replace the TBC sentence with that finding, and add the confirming assertion to whichever existing erasure test covers `notification_log`.

- [ ] **Step 3: Mark the design delivered**

Add a `**Status:** delivered by docs/superpowers/plans/2026-08-18-m15-quick-message.md` line, matching how the earlier specs record theirs.

- [ ] **Step 4: Run the full suite**

Run: `npm test` (>120s — wait for it, never background it), then `npm run lint && npx tsc --noEmit`.
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add docs/ test/
git commit -m "docs: N-10 and BR-36 in the specification"
```

---

## Delivery

Work happens in a sibling worktree, `../maketheteam-m15`, created with the `superpowers:using-git-worktrees` skill and given its own `npm install` (do **not** add an `allowScripts` block to `package.json` to make that work). When every task is done and `npm test`, `npx playwright test`, `npm run lint` and `npx tsc --noEmit` are all green, use `superpowers:requesting-code-review` for a whole-branch review, then fast-forward merge to `main`. **Pushing `main` deploys to production.**

Two standing rules for the review round, both earned expensively:

- **When a review names a defect *class*, the class guard ships in that same round** — not as a follow-up. Patching one instance and parking the class is how the same crash reached production six times in one branch.
- **Do not put a detail in a follow-up brief you have not read from source.** "Find X in this file" is shorter and cannot be wrong.

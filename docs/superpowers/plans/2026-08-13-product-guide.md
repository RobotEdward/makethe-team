# Product Guide Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A journey-shaped guide in `docs/guide/`, illustrated with phone-width screenshots taken from a real browser, that renders on GitHub with no build step.

**Architecture:** A `@guide`-tagged Playwright project builds a deterministic squad by driving the app's own surface, captures one PNG per shot, and emits `manifest.json`. The markdown is written against that manifest and committed as ordinary prose — regenerating updates images and never touches the words.

**Tech Stack:** `@playwright/test` 1.62, `wrangler dev`, Pillow (already installed) for PNG optimisation.

**Spec:** `docs/superpowers/specs/2026-08-13-product-guide-design.md`

## Global Constraints

- **Only what is built.** Every sentence and screenshot describes production behaviour today. The master spec's J6 promises owner overrides and one-off guests; both are J6b and **do not exist**. Chapter 05 is silent on them — no "coming soon", no mention.
- **Written for a squad organiser**, in plain language. Product words only ("waitlist", "organiser"). Never a rule id, a route pattern, a lifecycle name, or a table name.
- **Nothing may resemble a real person.** Invented names, `@example.test` addresses, never the author's address. This is a public repository and these images are permanent.
- **Capture is scripted; prose is committed.** The generator writes `docs/guide/images/` and `docs/guide/manifest.json` and **nothing else**. It must never write a `.md` file.
- Drive the app's own surface to build the world. Do not `INSERT` rows: a hand-built world can be inconsistent in ways a real one cannot, and this world becomes a public document.
- Local D1 is read via `wrangler d1 execute --local --json` only — never open the SQLite file (Miniflare holds its own connection; a second writer is a documented WAL-deadlock hazard).
- Images: 390px wide, `deviceScaleFactor: 1`, full page, **written only when the bytes change**.
- The guide capture is excluded from the default browser run and from CI, like `@capture`.
- Commit after each task, with the repo's trailer convention.

---

### Task 1: Bring `/leave/:token` and `/cancel/:token` into the catalogue

Closes both `NOT_CATALOGUED` exclusions. Beyond the guide, this puts two pages
under the console/CSP gate for the first time — each reached from an email by
someone with no session.

**Files:**
- Modify: `test/browser/world.ts`
- Modify: `test/browser/catalogue.ts`

**Interfaces:**
- Produces: `World` gains `ownerPlayerId: string` and `cancelToken: string`.

- [ ] **Step 1: Mint a cancel token in `seedWorld`**

`/leave/:token` needs nothing new — it verifies the *same* response token as
`/r/:token` (`src/routes/respond.ts`) and differs only in what it renders. Only
the cancel token is new.

In `test/browser/world.ts`, add to the imports:

```ts
import { signCancelToken, signResponseToken } from "../../src/domain/token.js";
```

Add `ownerPlayerId` and `cancelToken` to the `World` interface, then after the
existing `member` lookup add:

```ts
  const [owner] = await query<{ id: string }>(
    `SELECT id FROM players WHERE email = '${TEST_OWNER}' LIMIT 1`,
  );
  if (!owner) throw new Error(`the owner ${TEST_OWNER} has no player row`);

  // `/cancel/:token` is an owner's one-tap link out of the "this fixture needs
  // attention" email. It is signed with a *different* secret from the response
  // token on purpose (see CANCEL_TOKEN_SECRET in src/env.ts): the two are kept
  // apart so a leaked response key cannot forge a cancellation.
  const cancelToken = await signCancelToken(
    {
      ownerPlayerId: owner.id,
      fixtureId: fixture.id,
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
    },
    CANCEL_SECRET,
  );
```

Add alongside the existing `RESPONSE_SECRET` constant:

```ts
/** Matches `test/browser/browser.env`. Separate from the response secret. */
const CANCEL_SECRET = "local-browser-tests-only-not-a-real-secret";
```

Return `ownerPlayerId: owner.id` and `cancelToken` from `seedWorld`.

- [ ] **Step 2: Add both pages to the catalogue**

In `test/browser/catalogue.ts`, add two entries after `respond`:

```ts
  {
    id: "leave",
    title: "Leave a game",
    path: (w) => `/leave/${w.responseToken}`,
    persona: "anonymous",
    note: "Reached from the footer of every email (BR-22). Verifies the same response token as /r/.",
  },
  {
    id: "cancel",
    title: "Call a fixture off",
    path: (w) => `/cancel/${w.cancelToken}`,
    persona: "anonymous",
    note: "An owner's one-tap link out of the fixture-needs-attention email.",
  },
```

And delete the `/leave/:token` and `/cancel/:token` entries from
`NOT_CATALOGUED` — they are covered now.

- [ ] **Step 3: Map the routes**

In `test/browser/catalogue.spec.ts`, add to `ROUTE_TO_ID`:

```ts
  ["/leave/:token", "leave"],
  ["/cancel/:token", "cancel"],
```

- [ ] **Step 4: Run the browser suite**

Run: `npm run test:browser`
Expected: 37 passed — the previous 35 plus a console-gate test for each new
page. If either new page fails the gate, **that is a real finding**: report the
directive and the page, and do not weaken the assertion.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "test: bring the leave and cancel pages under the console gate"
```

---

### Task 2: The guide world

**Files:**
- Create: `test/browser/guide-world.ts`

**Interfaces:**
- Consumes: `signIn`, `TEST_OWNER` from `./sign-in.js`.
- Produces:
  ```ts
  export interface GuideWorld {
    gameId: string;
    fixtureId: string;
    inviteToken: string;
    cancelToken: string;
    /** A response token for a player who is `in`. */
    inToken: string;
    /** A response token for a player who is waitlisted. */
    waitlistedToken: string;
    /** A response token for the player who answered "can't make it". */
    outToken: string;
    /**
     * The member the removal confirmation page is shown for. Deliberately the
     * player who already answered "can't make it", so the page is not about
     * someone holding a place — removing them would trigger a promotion and
     * the screenshot would describe a different situation from the one the
     * chapter is explaining.
     */
    removablePlayerId: string;
  }
  export const GUIDE_ORGANISER = "jamie@example.test";
  export async function buildGuideWorld(page: Page, browser: Browser): Promise<GuideWorld>;
  ```

- [ ] **Step 1: The cast**

Create `test/browser/guide-world.ts`. Thirteen members: the organiser plus
twelve who join. Invented names, `@example.test` throughout.

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Browser, Page } from "@playwright/test";
import { signCancelToken, signResponseToken } from "../../src/domain/token.js";
import { BASE_URL } from "../../playwright.config.js";
import { signIn } from "./sign-in.js";
import { imminentSlot } from "./world.js";

const run = promisify(execFile);
const RESPONSE_SECRET = "local-browser-tests-only-not-a-real-secret";
const CANCEL_SECRET = "local-browser-tests-only-not-a-real-secret";

/**
 * The organiser. Every address here is `@example.test` and every name is
 * invented: these screenshots are committed to a public repository and are
 * permanent, so nothing may resemble a real person.
 */
export const GUIDE_ORGANISER = "jamie@example.test";

/**
 * The twelve who join, in the order they answer. The first nine take the
 * remaining places (the organiser has the tenth), the next two are
 * waitlisted, and the last one cannot make it — which is how one world comes
 * to show a full fixture, a waitlist and a dropout at once.
 */
const SQUAD = [
  { name: "Priya Raman", email: "priya@example.test" },
  { name: "Tom Okonjo", email: "tom@example.test" },
  { name: "Sarah Vance", email: "sarah@example.test" },
  { name: "Diego Marín", email: "diego@example.test" },
  { name: "Ken Adeyemi", email: "ken@example.test" },
  { name: "Lucy Brandt", email: "lucy@example.test" },
  { name: "Omar Haddad", email: "omar@example.test" },
  { name: "Nina Kowalski", email: "nina@example.test" },
  { name: "Rob Ellery", email: "rob@example.test" },
  { name: "Mika Toivonen", email: "mika@example.test" },
  { name: "Grace Abara", email: "grace@example.test" },
  { name: "Sam Whitlock", email: "sam@example.test" },
] as const;

/** Read-only D1 access, via the supported path. See `sign-in.ts` for why. */
async function query<T>(sql: string): Promise<T[]> {
  const { stdout } = await run(
    "npx",
    ["wrangler", "d1", "execute", "makethe-team", "--local", "--json", "--command", sql],
    { cwd: process.cwd(), maxBuffer: 4 * 1024 * 1024 },
  );
  const start = stdout.indexOf("[");
  if (start === -1) throw new Error(`unexpected wrangler output:\n${stdout}`);
  return (JSON.parse(stdout.slice(start)) as { results?: T[] }[])[0]?.results ?? [];
}
```

- [ ] **Step 2: Create the game and let everyone join**

`GUIDE_ORGANISER` must be in `SIGNIN_ALLOWLIST`; Step 6 adds it. Max 10 is what
makes a waitlist reachable with thirteen members.

```ts
export async function buildGuideWorld(page: Page, browser: Browser): Promise<GuideWorld> {
  await signIn(page, GUIDE_ORGANISER);

  await page.goto("/g/new");
  await page.fill('input[name="name"]', "Thursday Night Football");
  await page.fill('input[name="venueName"]', "Meadow Park 3G");
  await page.fill('input[name="venueAddress"]', "14 Meadow Lane");

  // The weekday and kickoff time must be chosen from the clock, not fixed.
  // A fixture only opens once its reminder instant — 09:00 the day before
  // kickoff — has passed and it has not yet ended, so a hardcoded weekday
  // leaves the first fixture up to a week away and permanently `scheduled`.
  // `imminentSlot` is exported from `./world.js`, where Task 1 added it after
  // exactly this bug made the browser suite pass only on the luck of the hour
  // it was run. Do not reimplement it here.
  const slot = imminentSlot(new Date());
  await page.selectOption('select[name="weekday"]', slot.weekday);
  await page.fill('input[name="kickoffTime"]', slot.kickoffTime);

  await page.fill('input[name="minPlayers"]', "8");
  // Max 10 rather than the default 14: with thirteen members answering, a
  // waitlist is only reachable if the cap is below the squad size, and a
  // waitlist is one of the three things this single world has to illustrate.
  await page.fill('input[name="maxPlayers"]', "10");
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/g\/[^/]+$/);

  const gameId = new URL(page.url()).pathname.split("/")[2]!;
  const inviteToken = (await page.inputValue("#invite-url")).split("/j/")[1]!;

  // Each joiner in its own context: a joiner carrying the organiser's session
  // would exercise a path no real visitor takes.
  for (const person of SQUAD) {
    const context = await browser.newContext();
    const joinerPage = await context.newPage();
    await joinerPage.goto(`/j/${inviteToken}`);
    await joinerPage.fill('input[name="name"]', person.name);
    await joinerPage.fill('input[name="email"]', person.email);
    await joinerPage.click('button[type="submit"]');
    await joinerPage.waitForLoadState("networkidle");
    await context.close();
  }

  await page.goto(`/g/${gameId}`);
  const squadSize = await page.locator("ul.squad li:has(.member)").count();
  if (squadSize !== SQUAD.length + 1) {
    throw new Error(
      `buildGuideWorld: expected ${SQUAD.length + 1} members, found ${squadSize}. ` +
        `Every screenshot depends on this world being what it claims.`,
    );
  }
```

- [ ] **Step 3: Open a fixture and record everyone's answer**

Both crons are needed: materialisation creates fixtures, the hourly sweep opens
them. Answers are posted **in order**, because waitlist position is assigned in
arrival order and the guide's prose names who is on it.

```ts
  await page.request.get(`${BASE_URL}/cdn-cgi/handler/scheduled?cron=15+3+*+*+*`);
  await page.request.get(`${BASE_URL}/cdn-cgi/handler/scheduled?cron=0+*+*+*+*`);

  const [fixture] = await query<{ id: string }>(
    `SELECT id FROM fixtures WHERE game_id = '${gameId}'
       AND lifecycle = 'open' ORDER BY kicks_off_at LIMIT 1`,
  );
  if (!fixture) throw new Error(`buildGuideWorld: game ${gameId} has no open fixture`);

  const players = await query<{ id: string; email: string }>(
    `SELECT id, email FROM players WHERE email LIKE '%@example.test'`,
  );
  const idFor = (email: string): string => {
    const found = players.find((p) => p.email === email);
    if (!found) throw new Error(`buildGuideWorld: no player row for ${email}`);
    return found.id;
  };

  const tokenFor = async (email: string): Promise<string> =>
    signResponseToken(
      { playerId: idFor(email), fixtureId: fixture.id, expiresAt: Date.now() + 7 * 864e5 },
      RESPONSE_SECRET,
    );

  // The organiser takes a place first, then the next nine fill the cap of ten.
  // Sequential and awaited: waitlist position is arrival order, and the guide
  // names who ended up on it.
  const answering = [GUIDE_ORGANISER, ...SQUAD.slice(0, 11).map((p) => p.email)];
  for (const email of answering) {
    const token = await tokenFor(email);
    await page.request.post(`${BASE_URL}/r/${token}`, {
      form: { intent: "in" },
      headers: { origin: BASE_URL },
    });
  }

  // And one who cannot make it.
  const outEmail = SQUAD[11]!.email;
  const outToken = await tokenFor(outEmail);
  await page.request.post(`${BASE_URL}/r/${outToken}`, {
    form: { intent: "out" },
    headers: { origin: BASE_URL },
  });
```

- [ ] **Step 4: Verify the world is what it claims, then mint the tokens**

The postcondition check is not optional. A world that is subtly wrong produces
a *public document* that is subtly wrong.

```ts
  const counts = await query<{ status: string; n: number }>(
    `SELECT status, COUNT(*) AS n FROM responses
       WHERE fixture_id = '${fixture.id}' GROUP BY status`,
  );
  const count = (status: string): number =>
    counts.find((row) => row.status === status)?.n ?? 0;

  if (count("in") !== 10 || count("waitlisted") !== 2 || count("out") !== 1) {
    throw new Error(
      `buildGuideWorld: expected 10 in / 2 waitlisted / 1 out, got ` +
        `${JSON.stringify(counts)}. The guide's prose states these numbers.`,
    );
  }

  return {
    gameId,
    fixtureId: fixture.id,
    inviteToken,
    inToken: await tokenFor(GUIDE_ORGANISER),
    waitlistedToken: await tokenFor(SQUAD[10]!.email),
    outToken,
    removablePlayerId: idFor(outEmail),
    cancelToken: await signCancelToken(
      {
        ownerPlayerId: idFor(GUIDE_ORGANISER),
        fixtureId: fixture.id,
        expiresAt: Date.now() + 7 * 864e5,
      },
      CANCEL_SECRET,
    ),
  };
}
```

- [ ] **Step 5: Export the cast for the prose**

Add at the end, so a chapter can name people without hardcoding them twice:

```ts
/** The squad, for the guide's prose and its tests. */
export const GUIDE_SQUAD = SQUAD;
```

- [ ] **Step 6: Allowlist the guide's addresses**

In `test/browser/browser.env`, extend `SIGNIN_ALLOWLIST` to include
`jamie@example.test`. Only the organiser signs in; the other twelve join
anonymously through the invite link and never need a sign-in link.

```
SIGNIN_ALLOWLIST=owner@example.test,player@example.test,jamie@example.test
```

- [ ] **Step 7: Prove it builds**

Write a temporary spec that calls `buildGuideWorld` and logs the returned ids,
run it, confirm it completes and that no postcondition throws, then delete the
temporary spec. **Paste the counts into the task report.**

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "test: a deterministic thirteen-player world for the guide"
```

---

### Task 3: The shot list

Separated from the capture spec so the list of what the guide shows is a
document in its own right — it is also the guide's table of contents.

**Files:**
- Create: `test/browser/guide-shots.ts`

**Interfaces:**
- Consumes: `GuideWorld` from `./guide-world.js`.
- Produces:
  ```ts
  export interface Shot {
    id: string;
    chapter: string;
    title: string;
    route: string;
    shows: string;
    path: (w: GuideWorld) => string;
    persona: "anonymous" | "organiser";
  }
  export const SHOTS: Shot[];
  export const CHAPTERS: { slug: string; title: string }[];
  ```

- [ ] **Step 1: Write the shot list**

`shows` is written by hand, not derived: it is what lets someone write accurate
prose without opening every image.

```ts
import type { GuideWorld } from "./guide-world.js";

export interface Shot {
  /** Stable slug — the image filename and the manifest key. */
  id: string;
  /** The chapter slug this shot belongs to, without `.md`. */
  chapter: string;
  title: string;
  /** The route pattern, for the manifest. Not used to navigate. */
  route: string;
  /** What this screenshot shows, in plain language. Written, not derived. */
  shows: string;
  path: (w: GuideWorld) => string;
  persona: "anonymous" | "organiser";
  /**
   * Capture just this element rather than the whole page.
   *
   * Three chapters need a picture of `/g/:id` for three different reasons.
   * Photographing the full page each time would write three byte-identical
   * PNGs under three names — duplication a reader gains nothing from, and
   * three times the churn. Scoping each to the part its chapter is about
   * makes every image earn its place.
   *
   * Note `ul.squad` matches **two** lists on that page — the squad and the
   * fixtures below it — so a selector for the squad must pin the first, or
   * Playwright's strict mode fails the run.
   */
  element?: string;
}

export const CHAPTERS = [
  { slug: "01-setting-up-a-game", title: "Setting up a game" },
  { slug: "02-inviting-your-squad", title: "Inviting your squad" },
  { slug: "03-answering-a-reminder", title: "Answering a reminder" },
  { slug: "04-when-someone-drops-out", title: "When someone drops out" },
  { slug: "05-running-your-squad", title: "Running your squad" },
  { slug: "06-calling-a-fixture-off", title: "Calling a fixture off" },
  { slug: "07-your-own-fixtures", title: "Your own fixtures" },
] as const;

export const SHOTS: Shot[] = [
  {
    id: "sign-in",
    chapter: "01-setting-up-a-game",
    title: "Signing in",
    route: "/sign-in",
    shows: "The sign-in page: one email field, and a passkey option below it.",
    path: () => "/sign-in",
    persona: "anonymous",
  },
  {
    id: "new-game",
    chapter: "01-setting-up-a-game",
    title: "The new game form",
    route: "/g/new",
    shows: "The form for a new game — name, venue, day, kickoff time, and squad sizes.",
    path: () => "/g/new",
    persona: "organiser",
  },
  {
    id: "game-overview",
    chapter: "01-setting-up-a-game",
    title: "Your game",
    route: "/g/:id",
    shows: "A game with thirteen members, the invite link and QR code, and the fixtures ahead.",
    path: (w) => `/g/${w.gameId}`,
    persona: "organiser",
  },
  {
    id: "invite",
    chapter: "02-inviting-your-squad",
    title: "The invite link",
    route: "/g/:id",
    shows: "The shareable link and its Copy button, as an organiser sees them.",
    path: (w) => `/g/${w.gameId}`,
    persona: "organiser",
    element: ".invite-link",
  },
  {
    id: "invite-qr",
    chapter: "02-inviting-your-squad",
    title: "The QR code",
    route: "/g/:id",
    shows: "The QR code for the same link, for people standing next to you.",
    path: (w) => `/g/${w.gameId}`,
    persona: "organiser",
    element: ".qr",
  },
  {
    id: "join",
    chapter: "02-inviting-your-squad",
    title: "What a player sees",
    route: "/j/:token",
    shows: "The join page a player reaches from the link: a name and an email, nothing else.",
    path: (w) => `/j/${w.inviteToken}`,
    persona: "anonymous",
  },
  {
    id: "respond-in",
    chapter: "03-answering-a-reminder",
    title: "Answering the reminder",
    route: "/r/:token",
    shows: "A player who is in, with their answer emphasised and the squad listed below.",
    path: (w) => `/r/${w.inToken}`,
    persona: "anonymous",
  },
  {
    id: "respond-waitlisted",
    chapter: "03-answering-a-reminder",
    title: "The waitlist",
    route: "/r/:token",
    shows: "A player who answered after the fixture filled, told their waitlist position.",
    path: (w) => `/r/${w.waitlistedToken}`,
    persona: "anonymous",
  },
  {
    id: "respond-out",
    chapter: "04-when-someone-drops-out",
    title: "Changing your mind",
    route: "/r/:token",
    shows: "A player who has said they cannot make it, and can still change back.",
    path: (w) => `/r/${w.outToken}`,
    persona: "anonymous",
  },
  {
    id: "leave",
    chapter: "04-when-someone-drops-out",
    title: "Leaving a game",
    route: "/leave/:token",
    shows: "The page reached from the footer of every email, explaining how to leave.",
    path: (w) => `/leave/${w.inToken}`,
    persona: "anonymous",
  },
  {
    id: "squad-controls",
    chapter: "05-running-your-squad",
    title: "The squad",
    route: "/g/:id",
    shows: "Each member's row, with the control to make them an organiser and to remove them.",
    path: (w) => `/g/${w.gameId}`,
    persona: "organiser",
    // The squad list, not the fixtures list below it — see `element` above.
    element: "ul.squad >> nth=0",
  },
  {
    id: "remove-member",
    chapter: "05-running-your-squad",
    title: "Removing someone",
    route: "/g/:id/squad/:playerId/remove",
    shows: "The confirmation page, naming the person and what removing them does.",
    path: (w) => `/g/${w.gameId}/squad/${w.removablePlayerId}/remove`,
    persona: "organiser",
  },
  {
    id: "edit-game",
    chapter: "05-running-your-squad",
    title: "Changing the details",
    route: "/g/:id/edit",
    shows: "The game's settings, filled in with what it currently uses.",
    path: (w) => `/g/${w.gameId}/edit`,
    persona: "organiser",
  },
  {
    id: "cancel",
    chapter: "06-calling-a-fixture-off",
    title: "Calling it off",
    route: "/cancel/:token",
    shows: "The cancellation page, with a box for the reason everyone will be told.",
    path: (w) => `/cancel/${w.cancelToken}`,
    persona: "anonymous",
  },
  {
    id: "dashboard",
    chapter: "07-your-own-fixtures",
    title: "Your fixtures",
    route: "/app",
    shows: "Every game a player belongs to, and the fixtures waiting on an answer.",
    path: () => "/app",
    persona: "organiser",
  },
  {
    id: "passkeys",
    chapter: "07-your-own-fixtures",
    title: "Signing in faster",
    route: "/app/passkeys",
    shows: "Where a player adds a passkey so they do not need an emailed link.",
    path: () => "/app/passkeys",
    persona: "organiser",
  },
];
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: clean. Every `path` callback must only read fields that exist on
`GuideWorld`; a typo surfaces here rather than as a broken URL at capture time.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "test: the guide's shot list"
```

---

### Task 4: The capture run and the manifest

**Files:**
- Create: `test/browser/guide-capture.spec.ts`
- Create: `scripts/optimise-png.py`
- Modify: `package.json` (a `guide:capture` script)

- [ ] **Step 1: The PNG optimiser**

Pillow is already installed system-wide, so this adds no dependency. Lossless:
the guide's screenshots contain text and must stay sharp.

Create `scripts/optimise-png.py`:

```python
#!/usr/bin/env python3
"""Losslessly shrink a PNG in place. Called by the guide capture run.

Lossless on purpose: these images are screenshots of text, and quantising
them makes small type mushy exactly where a reader is trying to read it.
"""
import sys
from PIL import Image

for path in sys.argv[1:]:
    with Image.open(path) as image:
        image.load()
        image.save(path, format="PNG", optimize=True)
```

- [ ] **Step 2: The capture spec**

Two properties matter: it asserts each page really rendered before
photographing it, and it writes a file only when the bytes change.

```ts
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { buildGuideWorld, GUIDE_ORGANISER, type GuideWorld } from "./guide-world.js";
import { SHOTS } from "./guide-shots.js";
import { signIn } from "./sign-in.js";

/**
 * Captures the guide's screenshots and writes `docs/guide/manifest.json`.
 *
 * It writes images and the manifest and *nothing else*. The chapters are
 * prose, committed, and edited by hand — if this run could rewrite them, every
 * regeneration would overwrite the writing and the guide could never get
 * better than whatever the last run produced.
 *
 * Tagged `@guide`, so it is excluded from the default browser run and from CI.
 */

const IMAGES = "docs/guide/images";
const MANIFEST = "docs/guide/manifest.json";

test("@guide capture every screen the guide shows", async ({ page, browser }) => {
  test.setTimeout(300_000);
  mkdirSync(IMAGES, { recursive: true });

  await page.setViewportSize({ width: 390, height: 844 });
  const world: GuideWorld = await buildGuideWorld(page, browser);

  const entries: Record<string, unknown>[] = [];
  const written: string[] = [];

  for (const shot of SHOTS) {
    if (shot.persona === "organiser") await signIn(page, GUIDE_ORGANISER);

    const response = await page.goto(shot.path(world), { waitUntil: "networkidle" });
    expect(response?.status(), `${shot.id} did not render`).toBe(200);
    // A page that has changed shape must fail the run rather than quietly
    // producing a photograph of an error page and shipping it in a public doc.
    await expect(page.locator("h1").first()).toBeVisible();

    const shotBuffer = await page.screenshot({ fullPage: true });
    const file = `${IMAGES}/${shot.id}.png`;

    const unchanged =
      existsSync(file) &&
      createHash("sha256").update(readFileSync(file)).digest("hex") ===
        createHash("sha256").update(shotBuffer).digest("hex");

    if (!unchanged) {
      writeFileSync(file, shotBuffer);
      written.push(file);
    }

    entries.push({
      id: shot.id,
      chapter: shot.chapter,
      title: shot.title,
      route: shot.route,
      image: `images/${shot.id}.png`,
      shows: shot.shows,
    });
  }

  // Optimise only what changed. No timestamp in the manifest: a captured-at
  // field would churn the file on every run for no reader's benefit.
  if (written.length > 0) {
    execFileSync("python3", ["scripts/optimise-png.py", ...written], { stdio: "inherit" });
  }

  writeFileSync(MANIFEST, `${JSON.stringify({ shots: entries }, null, 2)}\n`);
  console.log(`captured ${SHOTS.length} shots, ${written.length} changed`);
});
```

Note the hash compares the *unoptimised* buffer against the *optimised* file on
disk, so every run rewrites every image. Fix this in Step 3 — it is deliberate
that you see the naive version first.

- [ ] **Step 3: Compare against the optimised bytes**

Write the screenshot to a temporary path, optimise it, then compare *that*
against the committed file:

```ts
    const file = `${IMAGES}/${shot.id}.png`;
    const staging = `${IMAGES}/.${shot.id}.staging.png`;
    writeFileSync(staging, shotBuffer);
    execFileSync("python3", ["scripts/optimise-png.py", staging], { stdio: "inherit" });
    const optimised = readFileSync(staging);
    rmSync(staging);

    const digest = (bytes: Buffer): string =>
      createHash("sha256").update(bytes).digest("hex");

    if (!existsSync(file) || digest(readFileSync(file)) !== digest(optimised)) {
      writeFileSync(file, optimised);
      written.push(file);
    }
```

Import `rmSync` from `node:fs`, and drop the batch `execFileSync` at the end.

- [ ] **Step 4: Exclude `@guide` from the default run**

In `playwright.config.ts`, widen the existing `grepInvert`:

```ts
  // `@capture` and `@guide` both write files and assert little, so neither
  // belongs in the default run or in CI. Run them deliberately:
  //   npx playwright test --grep @capture
  //   npm run guide:capture
  grepInvert: process.env.CAPTURE ? undefined : /@capture|@guide/,
```

- [ ] **Step 5: The npm script**

In `package.json`:

```json
    "guide:capture": "CAPTURE=1 playwright test --grep @guide",
```

- [ ] **Step 6: Run it**

Run: `npm run guide:capture`
Expected: one test passes, `docs/guide/images/` holds 15 PNGs, and
`docs/guide/manifest.json` exists with 15 entries.

- [ ] **Step 7: Prove the no-churn property**

Run `npm run guide:capture` a second time and confirm the log says a small
number changed — only the three shots containing the invite token
(`game-overview`, `invite`, `join`). Confirm with `git status` that no other
image is modified. **Paste the second run's "N changed" line into the report.**

If every image is reported changed, Step 3 was not applied correctly.

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "test: capture the guide's screenshots and manifest"
```

---

### Task 5: The reference checks

**Files:**
- Create: `test/browser/guide-references.spec.ts`

These use no browser, but they live in the Playwright suite because the Vitest
pool runs inside workerd and has no `node:fs`. They run in the **default**
suite, so CI enforces them.

- [ ] **Step 1: Write the checks**

```ts
import { readFileSync, readdirSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { CHAPTERS, SHOTS } from "./guide-shots.js";

/**
 * The guide is a public artefact, so its failure modes are a broken image and
 * a stale picture nothing references. Both are cheap to detect and impossible
 * to notice by eye once there are fifteen of them.
 *
 * What is deliberately NOT checked: whether a sentence still describes the
 * screen beside it. Nothing can check that. The mitigation is procedural —
 * when a page changes, its chapter changes in the same commit — and it is
 * stated in the spec so it is not mistaken for an oversight.
 */

const GUIDE = "docs/guide";

function chapterSources(): { slug: string; body: string }[] {
  return CHAPTERS.map((chapter) => ({
    slug: chapter.slug,
    body: readFileSync(`${GUIDE}/${chapter.slug}.md`, "utf8"),
  }));
}

test("every chapter named in the shot list exists", () => {
  const present = new Set(
    readdirSync(GUIDE).filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, "")),
  );
  const missing = CHAPTERS.map((c) => c.slug).filter((slug) => !present.has(slug));
  expect(missing, `chapters missing from ${GUIDE}: ${missing.join(", ")}`).toEqual([]);
});

test("every image a chapter references exists on disk", () => {
  const files = new Set(readdirSync(`${GUIDE}/images`));
  const broken: string[] = [];

  for (const { slug, body } of chapterSources()) {
    for (const match of body.matchAll(/!\[[^\]]*\]\(images\/([^)]+)\)/g)) {
      if (!files.has(match[1]!)) broken.push(`${slug}.md → ${match[1]}`);
    }
  }

  expect(broken, `broken image references: ${broken.join(", ")}`).toEqual([]);
});

test("every captured image is referenced by some chapter", () => {
  const referenced = new Set<string>();
  for (const { body } of chapterSources()) {
    for (const match of body.matchAll(/!\[[^\]]*\]\(images\/([^)]+)\)/g)) {
      referenced.add(match[1]!);
    }
  }

  const orphans = readdirSync(`${GUIDE}/images`)
    .filter((file) => file.endsWith(".png"))
    .filter((file) => !referenced.has(file));

  expect(
    orphans,
    `images nothing references — a renamed shot or a deleted chapter left ` +
      `these behind: ${orphans.join(", ")}`,
  ).toEqual([]);
});

test("the manifest matches the shot list", () => {
  const manifest = JSON.parse(readFileSync(`${GUIDE}/manifest.json`, "utf8")) as {
    shots: { id: string }[];
  };
  expect(manifest.shots.map((s) => s.id).sort()).toEqual(SHOTS.map((s) => s.id).sort());
});
```

- [ ] **Step 2: Watch them fail first**

These cannot pass yet — Task 6 writes the chapters. Run:

`npm run test:browser -- --grep "chapter|image|manifest"`

Expected: the chapter and image tests FAIL because `docs/guide/*.md` does not
exist. **This is the point:** confirm the failure names the missing chapters
rather than erroring opaquely. Paste the output into the report.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "test: the guide's images and references stay in step"
```

---

### Task 6: Write the guide

**Files:**
- Create: `docs/guide/README.md` and the seven chapter files.

- [ ] **Step 1: Read the manifest and look at the images**

Open `docs/guide/manifest.json` and **look at every image** in
`docs/guide/images/`. The prose describes what is actually on screen; a
chapter written from the route names alone will be wrong in ways only a reader
notices.

- [ ] **Step 2: Write `README.md`**

The entry point. What Make The Team is, in a few sentences, then the chapters
in order as a linked list. Written for a squad organiser who has just been sent
the link.

- [ ] **Step 3: Write the seven chapters**

Each opens with what the reader is trying to do, walks its shots in order, and
stops where the journey stops. Reference images as
`![alt text](images/<id>.png)`.

Chapter titles and slugs come from `CHAPTERS` in `test/browser/guide-shots.ts`;
the shots for each are those in `SHOTS` with the matching `chapter`.

**The three rules that matter more than style:**

1. **Only what is built.** Chapter 05 covers roles, removal, editing and
   rotating the invite link. It does **not** mention an owner answering on
   someone's behalf, or one-off guests — those are J6b and do not exist. No
   "coming soon".
2. **No jargon.** "Waitlist" and "organiser" are product words and are fine.
   A reader must never meet a rule id, a route pattern, a lifecycle name, or a
   table name.
3. **Every claim must be true of the screenshot beside it.** If the image shows
   two people on the waitlist, the sentence says two.

**The register, by example.** This is the opening of
`03-answering-a-reminder.md`, written to the standard the rest should match:

```markdown
# Answering a reminder

The day before a game, everyone in the squad gets one email. It says when and
where, who is already in, and how many places are left. It has two buttons.

You do not need an account, a password, or the app open. Tapping either button
is the whole thing.

![The fixture page, showing a player who is in](images/respond-in.png)

Tapping **I'm in** takes you here. Your answer is already saved — this page is
confirming it, not asking again. The squad below shows who else is coming, and
you can change your mind by tapping the other button any time before kickoff.

## When it is already full

![A player told they are second on the waitlist](images/respond-waitlisted.png)

Thursday Night Football has room for ten. If you answer after the tenth person,
you go on the waitlist and the page tells you your position — here, second.

You do not need to do anything else. If someone drops out, the person at the
top of the waitlist is moved in automatically and emailed. Nobody else is
told.
```

Note what it does: second person, present tense, no rule ids, no route
patterns, and every number matches the picture above it. Note also what it does
*not* do — explain the data model, apologise for missing features, or describe
anything a reader cannot see.

- [ ] **Step 4: Run the reference checks**

Run: `npm run test:browser -- --grep "chapter|image|manifest"`
Expected: 4 passed. A failure here names a broken image path or an orphan.

- [ ] **Step 5: Read it as a stranger**

Read `README.md` through to the end of chapter 07 in order. Anything that only
makes sense if you have read the codebase is a defect. Fix it.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "docs: the product guide"
```

---

### Task 7: Documentation and wiring

**Files:**
- Modify: `docs/runbooks/browser-testing.md`
- Modify: `docs/known-issues.md`

- [ ] **Step 1: Extend the runbook**

Add a "The product guide" section: how to regenerate
(`npm run guide:capture`), that the capture writes images and the manifest and
never the markdown, that chapters are hand-edited prose, and the standing
obligation — **when a page's behaviour changes, its chapter changes in the same
commit and the capture is re-run.**

- [ ] **Step 2: Record what the guide does not cover**

Add a row to `docs/known-issues.md`: the guide's prose is not machine-checked
against the screens, so a chapter can silently go stale when a page changes.
Name the mitigation (the same-commit rule above) and the detection gap plainly.
Follow the existing row style: what, why it matters, files, when to revisit.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "docs: how to regenerate the guide, and what it cannot check"
```

---

## Manual verification

Read the guide on GitHub after pushing — image rendering, relative link
resolution and table layout all behave differently there from a local preview,
and the guide's whole value is that it renders correctly in that one place.

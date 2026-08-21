import { SELF, env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { ACCOUNT_PATH, DELETE_ACCOUNT_PATH, PASSKEYS_PATH, SIGN_IN_PATH, fixturePath } from "../../src/auth/paths.js";
import { getDb } from "../../src/db/client.js";
import { auditLog, players } from "../../src/db/schema.js";
import {
  insertFixture,
  insertGame,
  insertMembership,
  insertPlayer,
  insertResponse,
  insertResultClaim,
  insertSubscription,
  resetDatabase,
} from "../support/factories.js";
import { kickoffIn } from "../support/clock.js";
import {
  PUSH_BUTTON_ID,
  PUSH_KEY_ATTRIBUTE,
  PUSH_NAME_ID,
  PUSH_RELOAD_ATTRIBUTE,
  PUSH_TOKEN_ATTRIBUTE,
} from "../../src/views/scripts.js";
import { ALLOWED, ORIGIN, signIn } from "../support/sign-in.js";

const db = getDb(env.DB);

/** Far-future and fixed, so nothing here depends on how the suite ages. */
const NEXT_WEEK = new Date("2030-06-20T18:00:00Z");
const LAST_WEEK = new Date("2030-06-06T18:00:00Z");

/** The Player the sign-in journey created for `ALLOWED`. */
async function viewerId(): Promise<string> {
  const [player] = await db.select().from(players).where(eq(players.email, ALLOWED));
  expect(player, "signing in must have created a Player").toBeDefined();
  return player!.id;
}

function get(cookie?: string) {
  return SELF.fetch(`${ORIGIN}${ACCOUNT_PATH}`, {
    headers: cookie ? { cookie } : {},
    redirect: "manual",
  });
}

function post(cookie: string, fields: Record<string, string>, origin: string | null = ORIGIN) {
  return SELF.fetch(`${ORIGIN}${ACCOUNT_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie,
      ...(origin ? { origin } : {}),
    },
    body: new URLSearchParams(fields),
    redirect: "manual",
  });
}

beforeEach(resetDatabase);

describe("GET /app/account", () => {
  it("redirects an anonymous visitor to sign in", async () => {
    const response = await get();
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(SIGN_IN_PATH);
  });

  it("shows the viewer's name, their email, and the two account links", async () => {
    const { cookie } = await signIn();
    const body = await (await get(cookie)).text();

    const me = await viewerId();
    const [player] = await db.select().from(players).where(eq(players.id, me));

    expect(body).toContain(`value="${player!.name}"`);
    // Read-only text, not an input: §5.3 spends a whole section on why the
    // email can't be an editable field, and this is the property that pins
    // it — a regression that turned the email into an `<input>` would still
    // contain the address, so `toContain(ALLOWED)` alone would not catch it.
    expect(body).toContain(`<p>${ALLOWED}</p>`);
    expect(body).not.toContain(`value="${ALLOWED}"`);
    expect(body).not.toContain(`name="email"`);
    expect(body).toContain(`href="${PASSKEYS_PATH}"`);
    expect(body).toContain(`href="${DELETE_ACCOUNT_PATH}"`);
  });

  it("reads the email out with a caption, not inside the empty-state box", async () => {
    const { cookie } = await signIn();
    const body = await (await get(cookie)).text();

    expect(body).toContain(`<p class="readout-label">Email address</p>`);
    // Anything with an @ in it inside the dashed box is the misuse this
    // replaced: that box means "nothing here to act on", and an address the
    // page is reading out to you is a value, not an absence.
    expect(body).not.toMatch(/<p class="read-only">[^<]*@/);
  });

  it("keeps the dashed box for the state it means — nothing to act on", async () => {
    // Signed in, no memberships and so no fixtures: the empty history. Paired
    // deliberately with the assertion above, because a change that stripped
    // .read-only from every page would satisfy that one on its own.
    const { cookie } = await signIn();
    const body = await (await get(cookie)).text();

    expect(body).toContain(`<p class="read-only">Nothing yet.`);
  });

  it("groups signing in under one heading", async () => {
    const { cookie } = await signIn();
    const body = await (await get(cookie)).text();

    expect(body).toContain("<h2>Signing in</h2>");
    expect(body).not.toContain("<h2>Your email address</h2>");
    expect(body).not.toContain("<h2>How you sign in</h2>");
  });

  it("lists a played fixture, which the dashboard deliberately hides", async () => {
    const { cookie } = await signIn();
    const me = await viewerId();
    const gameId = await insertGame(db, { name: "Thursday 7-a-side" });
    await insertMembership(db, gameId, me);
    const fixtureId = await insertFixture(db, gameId, {
      lifecycle: "played",
      kicksOffAt: LAST_WEEK,
    });
    await insertResponse(db, fixtureId, me, { status: "in" });

    const body = await (await get(cookie)).text();
    expect(body).toContain("Thursday 7-a-side");
  });

  it("links each history row to its fixture, not to the game", async () => {
    const { cookie } = await signIn();
    const me = await viewerId();
    const gameId = await insertGame(db, { name: "Thursday 7-a-side" });
    await insertMembership(db, gameId, me);
    const fixtureId = await insertFixture(db, gameId, {
      lifecycle: "played",
      kicksOffAt: LAST_WEEK,
    });
    await insertResponse(db, fixtureId, me, { status: "in" });

    const body = await (await get(cookie)).text();

    // Not merely present: the game-name heading's own href, so a page that
    // still linked to the game and happened to also mention the fixture path
    // somewhere else could not pass this by accident.
    expect(body).toContain(`<h3><a href="${fixturePath(gameId, fixtureId)}">Thursday 7-a-side</a></h3>`);
    expect(body).not.toContain(`<h3><a href="/g/${gameId}">Thursday 7-a-side</a></h3>`);
  });

  it("shows the result on a locked row", async () => {
    const { cookie } = await signIn();
    const me = await viewerId();
    const gameId = await insertGame(db, { name: "Thursday 7-a-side" });
    await insertMembership(db, gameId, me);
    // More than 48 hours ago (BR-37), relative to the real wall clock the
    // route reads — `kickoffIn`, not the fixed `LAST_WEEK`, which sits in
    // 2030 and would still be inside its own window on the day this suite
    // actually runs.
    const fixtureId = await insertFixture(db, gameId, {
      lifecycle: "played",
      kicksOffAt: kickoffIn(-72),
    });
    await insertResponse(db, fixtureId, me, { status: "in" });
    await insertResultClaim(db, fixtureId, me, { outcome: "a" });

    const body = await (await get(cookie)).text();

    // "Team A" is the default team name `gameRow` leaves unset (schema
    // default). If this ever prints nothing, the omission is silent — the
    // negative half of this test is `test/routes/account.test.ts`'s sibling
    // above, which seeds no claim at all and must not show a result line.
    expect(body).toContain(`<p class="result-final">Team A won</p>`);
  });

  it("shows no result on a played fixture nobody has filed on yet", async () => {
    const { cookie } = await signIn();
    const me = await viewerId();
    const gameId = await insertGame(db, { name: "Thursday 7-a-side" });
    await insertMembership(db, gameId, me);
    const fixtureId = await insertFixture(db, gameId, {
      lifecycle: "played",
      kicksOffAt: kickoffIn(-72),
    });
    await insertResponse(db, fixtureId, me, { status: "in" });

    const body = await (await get(cookie)).text();

    expect(body).not.toContain(`class="result-final"`);
  });

  it("shows at most 20 fixtures, most recent first", async () => {
    const { cookie } = await signIn();
    const me = await viewerId();
    const gameId = await insertGame(db, { name: "Thursday 7-a-side" });
    await insertMembership(db, gameId, me);

    // 22 fixtures, one per week going backwards, each with its own venue
    // marker so the rendered order and the rendered set are both provable —
    // not just their count. `week` 0 is the most recent kickoff and `week` 21
    // the oldest; the two oldest (`week` 20 and 21) must not show, and the
    // twenty that do must render most-recent-first.
    //
    // Inserted **oldest first** (`week` descending) rather than in the order
    // `week` counts, so insertion order is the exact *reverse* of the correct
    // rendered order (kickoff descending). If the route's query ever lost its
    // `ORDER BY` and fell back to returning rows in insertion/rowid order, the
    // set and the order asserted below would both come out wrong and this
    // test would catch it. Seeding in `week`-ascending order would insert
    // fixtures kickoff-descending — the same sequence as the correct answer —
    // so a missing `ORDER BY` would accidentally render correctly and this
    // test would pass regardless of whether the route sorts anything. Do not
    // "tidy" this back to an ascending loop.
    for (let week = 21; week >= 0; week--) {
      const kicksOffAt = new Date(LAST_WEEK.getTime() - week * 7 * 24 * 3600_000);
      const fixtureId = await insertFixture(db, gameId, {
        lifecycle: "played",
        kicksOffAt,
        venueOverride: `Ground ${week}`,
      });
      await insertResponse(db, fixtureId, me, { status: "in" });
    }

    const body = await (await get(cookie)).text();
    const venues = [...body.matchAll(/<p class="venue">Ground (\d+)<\/p>/g)].map((match) =>
      Number(match[1]),
    );

    // The 20 most recent, in kickoff-descending order, is exactly `week` 0..19
    // in ascending numeric order — `week` counts backwards from the most
    // recent kickoff, so ascending `week` numbers are descending kickoffs.
    expect(venues).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });

  it("does not list fixtures from a game the viewer has left", async () => {
    const { cookie } = await signIn();
    const me = await viewerId();
    const gameId = await insertGame(db, { name: "Sunday league" });
    await insertMembership(db, gameId, me, { active: false, leftAt: LAST_WEEK });
    const fixtureId = await insertFixture(db, gameId, {
      lifecycle: "played",
      kicksOffAt: LAST_WEEK,
    });
    await insertResponse(db, fixtureId, me, { status: "in" });

    const body = await (await get(cookie)).text();
    expect(body).not.toContain("Sunday league");
  });

  it("words the viewer's own status in the present tense on a fixture that hasn't happened, and the past tense on one that has", async () => {
    const { cookie } = await signIn();
    const me = await viewerId();
    const gameId = await insertGame(db, { name: "Thursday 7-a-side" });
    await insertMembership(db, gameId, me);

    // Upcoming and still open — the case the review found reading "You were
    // in" and "You didn't answer" on a fixture the player can still act on.
    const upcomingIn = await insertFixture(db, gameId, {
      lifecycle: "open",
      kicksOffAt: NEXT_WEEK,
      venueOverride: "Upcoming in",
    });
    await insertResponse(db, upcomingIn, me, { status: "in" });

    const upcomingPending = await insertFixture(db, gameId, {
      lifecycle: "open",
      kicksOffAt: new Date(NEXT_WEEK.getTime() + 7 * 24 * 3600_000),
      venueOverride: "Upcoming pending",
    });
    await insertResponse(db, upcomingPending, me, { status: "pending" });

    // Terminal — the tense that was already correct and must stay so.
    const playedIn = await insertFixture(db, gameId, {
      lifecycle: "played",
      kicksOffAt: LAST_WEEK,
      venueOverride: "Played in",
    });
    await insertResponse(db, playedIn, me, { status: "in" });

    const body = await (await get(cookie)).text();

    // Scoped to each fixture's own card, so this pins the *pairing* of
    // lifecycle and tense rather than merely the presence of both phrases
    // somewhere on the page.
    const rowFor = (marker: string): string => {
      const start = body.indexOf(marker);
      expect(start, `expected to find a row for "${marker}"`).toBeGreaterThan(-1);
      return body.slice(start, body.indexOf("</li>", start));
    };

    expect(rowFor("Upcoming in")).toContain("You&#39;re in");
    expect(rowFor("Upcoming in")).not.toContain("You were in");

    expect(rowFor("Upcoming pending")).toContain("You haven&#39;t answered yet");
    expect(rowFor("Upcoming pending")).not.toContain("You didn&#39;t answer");

    // The played fixture keeps the past tense — proves this isn't a
    // status-keyed lookup that dropped the past tense everywhere.
    expect(rowFor("Played in")).toContain("You were in");
    expect(rowFor("Played in")).not.toContain("You&#39;re in");
  });

  it("never lists another player's fixture", async () => {
    const { cookie } = await signIn();
    const me = await viewerId();
    const gameId = await insertGame(db, { name: "Thursday 7-a-side" });
    await insertMembership(db, gameId, me);
    const stranger = await insertPlayer(db, { name: "Sam Okafor", email: "sam@example.com" });
    const theirGameId = await insertGame(db, { name: "Somebody else's game" });
    await insertMembership(db, theirGameId, stranger);
    const theirFixture = await insertFixture(db, theirGameId, { kicksOffAt: NEXT_WEEK });
    await insertResponse(db, theirFixture, stranger, { status: "in" });

    const body = await (await get(cookie)).text();
    expect(body).not.toContain("Somebody else's game");
    expect(body).not.toContain("Sam Okafor");
  });

  it("still renders a fixture whose stored lifecycle this build has never heard of", async () => {
    // `fixtures.lifecycle` is `text NOT NULL DEFAULT 'scheduled'` with no
    // CHECK constraint behind it, so the column can hold a value outside the
    // union: a legacy row, a hand-applied fix, or a newer deploy writing one
    // mid-rollout. `fixtureStatusLabel` was a switch with no `default`, so it
    // returned `undefined`, which the view hands to `escapeHtml` — a 500 on
    // this whole page, not one odd word in one row. `as never` is how such a
    // row is written in a test the type system would otherwise forbid.
    const { cookie } = await signIn();
    const me = await viewerId();
    const gameId = await insertGame(db, { name: "Thursday 7-a-side" });
    await insertMembership(db, gameId, me);
    const fixtureId = await insertFixture(db, gameId, {
      lifecycle: "abandoned" as never,
      kicksOffAt: NEXT_WEEK,
      venueOverride: "Unknown state",
    });
    await insertResponse(db, fixtureId, me, { status: "in" });

    const response = await get(cookie);
    expect(response.status).toBe(200);

    const body = await response.text();
    const start = body.indexOf("Unknown state");
    expect(start, "expected the fixture's row to render at all").toBeGreaterThan(-1);
    const row = body.slice(start, body.indexOf("</li>", start));

    // Words, not the stored token and not the absence of both.
    expect(row).toContain("Status unknown");
    expect(row).not.toContain("abandoned");
    expect(row).not.toContain("undefined");
  });

  it("offers the way back up through the header, not a body back link (M16)", async () => {
    // The §2.5 back link this page carried duplicated the header's Games
    // link the moment the header shipped, so it went. The header is the one
    // way back now — a body link reappearing would mean two.
    const { cookie } = await signIn();
    const body = await (await get(cookie)).text();

    expect(body).toContain(`<header class="site-header">`);
    expect(body).not.toContain(`class="back-link"`);
  });

  it("shows the pending-erasure banner and its link when one is due", async () => {
    const { cookie } = await signIn();
    const me = await viewerId();
    const erasesAt = new Date("2030-06-24T09:00:00Z");
    await db.update(players).set({ erasesAt }).where(eq(players.id, me));

    const body = await (await get(cookie)).text();

    expect(body).toContain("due to be erased on");
    expect(body).toContain(`href="${DELETE_ACCOUNT_PATH}"`);
  });
});

describe("POST /app/account", () => {
  it("renames the player, audits it, and redirects", async () => {
    const { cookie } = await signIn();
    const me = await viewerId();

    const response = await post(cookie, { name: "  Alex Mercer  " });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(ACCOUNT_PATH);

    const [row] = await db.select().from(players).where(eq(players.id, me));
    expect(row!.name).toBe("Alex Mercer");

    const audits = (await db.select().from(auditLog)).filter((a) => a.action === "player.renamed");
    expect(audits).toHaveLength(1);
    expect(audits[0]!.actorPlayerId).toBe(me);
    expect(audits[0]!.entityId).toBe(me);
    expect(JSON.parse(audits[0]!.afterJson!)).toEqual({ name: "Alex Mercer" });
  });

  it("refuses an empty name on the page itself, changing nothing", async () => {
    const { cookie } = await signIn();
    const me = await viewerId();
    const [before] = await db.select().from(players).where(eq(players.id, me));

    const response = await post(cookie, { name: "   " });
    expect(response.status).toBe(422);
    expect(await response.text()).toContain("Tell us what to call you.");

    const [after] = await db.select().from(players).where(eq(players.id, me));
    expect(after!.name).toBe(before!.name);
  });

  it("refuses a cross-origin post", async () => {
    const { cookie } = await signIn();
    const response = await post(cookie, { name: "Alex Mercer" }, "https://evil.example");
    expect(response.status).toBe(403);
  });

  it("does not write Better Auth's own user row", async () => {
    const { cookie } = await signIn();
    await post(cookie, { name: "Alex Mercer" });

    const rows = await env.DB.prepare("SELECT name FROM user").all<{ name: string }>();
    expect(rows.results.every((row) => row.name !== "Alex Mercer")).toBe(true);
  });
});

describe("the install section (M13)", () => {
  it("tells a player how to install with no script at all", async () => {
    // The baseline, and the whole no-JS rule in one assertion: the manual
    // route works on every platform — iOS has no install API at all, and
    // Chrome's menu has the same item — so the server renders it visible and
    // script only upgrades it to a button where one is possible.
    const { cookie } = await signIn();
    const body = await (await get(cookie)).text();

    expect(body).toContain("Add to Home Screen");
    expect(body).toContain("Share");
  });

  it("ships the button hidden, for script to reveal", async () => {
    // [hidden] is honoured with !important by STYLES precisely so a later
    // display rule cannot un-hide a control whose platform cannot use it.
    const { cookie } = await signIn();
    const body = await (await get(cookie)).text();

    expect(body).toMatch(/<button[^>]*data-install-button[^>]*hidden/);
  });
});

describe("the notification permission and device list (M14 Task 12)", () => {
  it("lists the player's registered devices with a way to remove each", async () => {
    // The counterweight to accepting token-based registration (spec §4): a
    // player must be able to see and revoke a subscription they did not make.
    const { cookie } = await signIn();
    const me = await viewerId();
    await insertSubscription(db, me, "https://push.example/endpoint-1", {
      userAgent: "This phone",
    });

    const body = await (await get(cookie)).text();

    expect(body).toContain("This phone");
    expect(body).toMatch(/<form[^>]*action="\/app\/push\/unsubscribe"/);
    expect(body).toContain(`value="https://push.example/endpoint-1"`);
  });

  it("says so, without a form, when no device is registered", async () => {
    const { cookie } = await signIn();
    const body = await (await get(cookie)).text();

    expect(body).toContain("No devices registered yet.");
    expect(body).not.toMatch(/action="\/app\/push\/unsubscribe"/);
  });

  it("escapes an untrusted user-agent caption rather than trusting it", async () => {
    const { cookie } = await signIn();
    const me = await viewerId();
    await insertSubscription(db, me, "https://push.example/endpoint-2", {
      userAgent: "<script>alert(1)</script>",
    });

    const body = await (await get(cookie)).text();

    expect(body).not.toContain("<script>alert(1)</script>");
    expect(body).toContain("&lt;script&gt;");
  });

  it("ships the permission button hidden, with the VAPID key on it, for script to reveal", async () => {
    const { cookie } = await signIn();
    const body = await (await get(cookie)).text();

    expect(body).toMatch(
      new RegExp(`<button[^>]*id="${PUSH_BUTTON_ID}"[^>]*${PUSH_KEY_ATTRIBUTE}="[^"]+"[^>]*hidden`),
    );
  });

  it("never carries a push token — the account page's button relies on the session, not a token (M14 Task 12 review, Finding 2/5)", async () => {
    // The mirror image of the response-confirmation offer, which always
    // carries one: this page's caller is signed in, `resolvePlayerId` in
    // `src/routes/push.ts` reads the session, and `renderPushSection`'s own
    // type has no way to be handed a token at all (unlike `renderPushOffer`).
    const { cookie } = await signIn();
    const body = await (await get(cookie)).text();

    expect(body).not.toContain(`${PUSH_TOKEN_ATTRIBUTE}="`);
  });

  it("renders no button at all when no VAPID key is configured (M14 ships dark)", async () => {
    // Production has no VAPID_PUBLIC_KEY right now — see wrangler.jsonc's own
    // comment on PUSH_NOTIFIER. A button with no key to subscribe with is a
    // control that can only fail, and this deployment must not ship one.
    const previousKey = env.VAPID_PUBLIC_KEY;
    // @ts-expect-error — genuinely absent at runtime despite the honestly-
    // dishonest `string` type; see `Bindings.VAPID_PUBLIC_KEY`'s own comment.
    env.VAPID_PUBLIC_KEY = undefined;
    try {
      const { cookie } = await signIn();
      const body = await (await get(cookie)).text();

      expect(body).not.toContain(`id="${PUSH_BUTTON_ID}"`);
      // `PUSH_KEY_ATTRIBUTE`'s name itself still appears in the script body —
      // `PUSH_SUBSCRIBE_JS` reads it off the button by name at runtime — so
      // this checks the *attribute*, not the bare string.
      expect(body).not.toContain(`${PUSH_KEY_ATTRIBUTE}="`);
    } finally {
      env.VAPID_PUBLIC_KEY = previousKey;
    }
  });
});

describe("the device table and its controls (M18)", () => {
  it("shows the friendly name over the user-agent, with the date enabled", async () => {
    const { cookie } = await signIn();
    const me = await viewerId();
    await insertSubscription(db, me, "https://push.example/named", {
      name: "Ed's phone",
      userAgent: "SomeBrowser/1.0",
      createdAt: new Date("2026-08-01T12:00:00Z"),
    });

    const body = await (await get(cookie)).text();

    expect(body).toContain("Ed&#39;s phone");
    expect(body).not.toContain("SomeBrowser/1.0");
    // Europe/London in August is BST, an hour ahead of the stored noon.
    expect(body).toContain("1 August");
    expect(body).toContain("13:00");
  });

  it("falls back to the user-agent caption for a pre-name row", async () => {
    const { cookie } = await signIn();
    const me = await viewerId();
    await insertSubscription(db, me, "https://push.example/old", { userAgent: "OldBrowser/2.0" });

    const body = await (await get(cookie)).text();
    expect(body).toContain("OldBrowser/2.0");
  });

  it("gives every row a Test form and a Remove form, and ships the badge hidden", async () => {
    const { cookie } = await signIn();
    const me = await viewerId();
    await insertSubscription(db, me, "https://push.example/row", { name: "Phone" });

    const body = await (await get(cookie)).text();

    expect(body).toMatch(/<form[^>]*action="\/app\/push\/test"/);
    expect(body).toMatch(/<form[^>]*action="\/app\/push\/unsubscribe"/);
    // Only the browser can know which row it is running on, so the badge
    // must never be visible to a scriptless reader.
    expect(body).toMatch(/<span class="this-device" hidden>/);
  });

  it("moves the enable control below the table once a device exists, and rewords it", async () => {
    const { cookie } = await signIn();
    const me = await viewerId();

    const before = await (await get(cookie)).text();
    expect(before).toContain(">Turn on notifications</button>");

    await insertSubscription(db, me, "https://push.example/row", { name: "Phone" });
    const after = await (await get(cookie)).text();
    expect(after).toContain(">Enable on this device</button>");
    expect(after).not.toContain(">Turn on notifications</button>");
    // Below, not above: the order assertion is paired with presence guards
    // because indexOf answers -1 for an absent needle and -1 < anything.
    const tableAt = after.indexOf('<table class="push-devices"');
    const buttonAt = after.indexOf(`id="${PUSH_BUTTON_ID}"`);
    expect(tableAt).toBeGreaterThan(-1);
    expect(buttonAt).toBeGreaterThan(tableAt);
  });

  it("pre-fills the name field with the player's own name, hidden until script reveals it", async () => {
    const { cookie } = await signIn();
    const me = await viewerId();
    const [player] = await db.select().from(players).where(eq(players.id, me));

    const body = await (await get(cookie)).text();

    expect(body).toMatch(new RegExp(`<label class="device-name"[^>]*hidden`));
    expect(body).toContain(`id="${PUSH_NAME_ID}"`);
    expect(body).toContain(`value="${player!.name}&#39;s phone"`);
  });

  it("sends a successful subscribe back to this page, flagged, and acknowledges it", async () => {
    const { cookie } = await signIn();

    const body = await (await get(cookie)).text();
    expect(body).toContain(`${PUSH_RELOAD_ATTRIBUTE}="${ACCOUNT_PATH}?push=enabled"`);

    const flagged = await SELF.fetch(`${ORIGIN}${ACCOUNT_PATH}?push=enabled`, {
      headers: { cookie },
      redirect: "manual",
    });
    expect(await flagged.text()).toContain("Notifications are on for this device.");
  });

  it("acknowledges a test outcome from the flag, and ignores a value it does not know", async () => {
    const { cookie } = await signIn();

    const sent = await SELF.fetch(`${ORIGIN}${ACCOUNT_PATH}?test=sent`, { headers: { cookie } });
    expect(await sent.text()).toContain("Test notification sent.");

    const failed = await SELF.fetch(`${ORIGIN}${ACCOUNT_PATH}?test=failed`, { headers: { cookie } });
    expect(await failed.text()).toContain("could not be sent");

    // The query string is attacker-typeable; an unknown value must render
    // as if no flag were present, never be echoed.
    const junk = await SELF.fetch(`${ORIGIN}${ACCOUNT_PATH}?test=%3Cscript%3E`, { headers: { cookie } });
    const junkBody = await junk.text();
    expect(junkBody).not.toContain("Test notification");
    expect(junkBody).not.toContain("<script>alert");
  });
});

describe("the device sections (M21, reversing M20 B5's merge)", () => {
  it("renders two page-level headings with the boxes below them", async () => {
    const { cookie } = await signIn();
    const html = await (await get(cookie)).text();

    // Each heading sits *outside* its card, at the same level as "Your
    // fixtures" — asserted structurally, not just by presence: the h2 must
    // come before the section tag that carries the box.
    expect(html).toMatch(/<h2>Install the app<\/h2>\s*<section class="install">/);
    expect(html).toMatch(/<h2>Manage notifications<\/h2>\s*<section class="install">/);
    // The merged panel and its heading are gone.
    expect(html).not.toContain("<h2>This device</h2>");
    expect(html).not.toContain("Add Make The Team to your home screen and turn on game notifications.");
    // Every working part of both survives.
    expect(html).toContain("data-install-button");
    expect(html).toContain("Your devices");
  });
});

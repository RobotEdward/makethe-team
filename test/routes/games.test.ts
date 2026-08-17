import { env, SELF } from "cloudflare:test";
import { eq, inArray } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { auditLog, fixtures, games, memberships, players } from "../../src/db/schema.js";
import { formatLocalDateTime } from "../../src/domain/time/zone.js";
import { COPY_INVITE_JS, SCRIPT_BLOCKS } from "../../src/views/scripts.js";
import { interferingBinding } from "../support/interference.js";
import { insertGame, insertMembership, insertPlayer, resetDatabase, testDb } from "../support/factories.js";
import { bindings, ORIGIN, signIn } from "../support/sign-in.js";

async function post(path: string, cookie: string, fields: Record<string, string>) {
  return SELF.fetch(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, cookie },
    body: new URLSearchParams(fields),
    redirect: "manual",
  });
}

const VALID = {
  name: "Thursday 7-a-side",
  venueName: "Oxford Sports Park",
  weekday: "TH",
  interval: "1",
  kickoffTime: "19:00",
  durationMinutes: "60",
  minPlayers: "10",
  maxPlayers: "14",
  prefersEvenNumbers: "on",
  // The hidden companion a browser always submits alongside the checkbox, so
  // these hand-built bodies are faithful to what the form actually posts. See
  // `PREFERS_EVEN_SUBMITTED` in `src/views/game-form.ts` for why it exists —
  // and the "unchecking survives a validation round-trip" test below, which is
  // the behaviour it buys.
  prefersEvenNumbersSubmitted: "1",
  squadVisibleToPlayers: "on",
  squadVisibleToPlayersSubmitted: "1",
};

describe("GET /g/new", () => {
  beforeEach(resetDatabase);

  it("redirects an anonymous visitor to sign in", async () => {
    const response = await SELF.fetch(`${ORIGIN}/g/new`, { redirect: "manual" });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/sign-in");
  });

  it("renders the form for a signed-in player", async () => {
    const { cookie } = await signIn();
    const response = await SELF.fetch(`${ORIGIN}/g/new`, { headers: { cookie } });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Set up a game");
  });
});

describe("the two settings on the game form", () => {
  beforeEach(resetDatabase);

  async function formHtml(): Promise<string> {
    const { cookie } = await signIn();
    return (await SELF.fetch(`${ORIGIN}/g/new`, { headers: { cookie } })).text();
  }

  it("gives every switch a hint, because one of them has no visible effect", async () => {
    const html = await formHtml();
    expect(html.match(/class="switch-row"/g) ?? []).toHaveLength(2);
    expect(html).toContain("Warns you when the maximum is an odd number.");
    expect(html).toContain("When off, players see only how many are in; you always see the names.");
  });

  /**
   * `.switch-row` places the checkbox explicitly but auto-places the label and
   * the hint, and CSS Grid fills auto rows in document order. Emit the hint
   * first and it silently takes row one with the label beneath it — no error,
   * no failing render, just an upside-down row. Only order catches that.
   */
  it.each([
    ["prefersEvenNumbers", "Warns you when the maximum is an odd number."],
    ["squadVisibleToPlayers", "When off, players see only how many are in; you always see the names."],
  ])("puts the label above the hint for %s", async (name, hint) => {
    const html = await formHtml();
    const label = html.indexOf(`<label for="${name}">`);
    const box = html.indexOf(`<input id="${name}"`);
    const hintAt = html.indexOf(hint);

    expect(label).toBeGreaterThan(-1);
    expect(box).toBeGreaterThan(label);
    expect(hintAt).toBeGreaterThan(box);
  });

  /**
   * The hidden companions are what tell an untick apart from a form that never
   * carried the field (see `PREFERS_EVEN_SUBMITTED`). Dropping one while
   * restyling the row turns every untick into a silent no-op, and no
   * fetch-level test of the *styling* would notice.
   */
  it("still submits both hidden companions, and both boxes still start ticked", async () => {
    const html = await formHtml();
    expect(html).toContain('<input type="hidden" name="prefersEvenNumbersSubmitted" value="1">');
    expect(html).toContain('<input type="hidden" name="squadVisibleToPlayersSubmitted" value="1">');

    for (const name of ["prefersEvenNumbers", "squadVisibleToPlayers"]) {
      const box = html.match(new RegExp(`<input id="${name}"[^>]*>`))?.[0] ?? "";
      expect(box).toContain(`name="${name}" type="checkbox"`);
      expect(box).toContain("checked");
    }
  });
});

describe("POST /g/new", () => {
  beforeEach(resetDatabase);

  it("creates the game and redirects to it", async () => {
    const { cookie } = await signIn();
    const response = await post("/g/new", cookie, VALID);

    expect(response.status).toBe(303);
    const location = response.headers.get("location")!;
    expect(location).toMatch(/^\/g\/[0-9a-f-]{36}$/);

    const [game] = await testDb().select().from(games);
    expect(game?.name).toBe("Thursday 7-a-side");
    expect(location).toBe(`/g/${game!.id}`);
  });

  it("redisplays the form with the submitted values on a bad submission", async () => {
    const { cookie } = await signIn();
    const response = await post("/g/new", cookie, { ...VALID, minPlayers: "20", name: "Keep me" });

    expect(response.status).toBe(422);
    const html = await response.text();
    // Nothing typed is thrown away.
    expect(html).toContain('value="Keep me"');
    // `escapeHtml` escapes `'` to `&#39;` (see its own doc comment) —
    // deliberate, so the assertion matches the escaped form rather than the
    // raw message text.
    expect(html).toContain("The minimum can&#39;t be higher than the maximum.");
    expect(await testDb().select().from(games)).toHaveLength(0);
  });

  it("shows the odd-max warning without refusing the game", async () => {
    const { cookie } = await signIn();
    const response = await post("/g/new", cookie, { ...VALID, maxPlayers: "13" });
    expect(response.status).toBe(303);
  });

  /**
   * The 422 page reflects raw, attacker-chosen form fields (`name`,
   * `venueName`, `venueAddress`, …) straight back into `value="..."`
   * attributes — the one branch of this route that renders user input at
   * all, and so the one this route's `no password field / no un-enumerated
   * script` coverage actually has to prove, not merely assert by reference
   * to a shared template. Mirrors the `pages` loop's own checks in
   * `test/routes/signin.test.ts`. This is what backs the `POST /g/new`
   * exclusion in that file's `pinRoutesToPages` — see the reason recorded
   * there.
   */
  it("escapes markup and quote-breakout attempts in a rejected submission rather than reflecting them live", async () => {
    const { cookie } = await signIn();
    const response = await post("/g/new", cookie, {
      ...VALID,
      // Bad enough to be rejected (min > max), so the 422 branch renders —
      // and every string field below is redisplayed via `values`.
      minPlayers: "20",
      name: `"><script>alert(1)</script>`,
      venueName: `Bob's Pitch`,
    });

    expect(response.status).toBe(422);
    const html = await response.text();

    expect(html, "must not contain a password field").not.toMatch(/type=.?password/i);

    // The injected markup must come back escaped, not live: no new <script>
    // tag introduced by the submission, and the raw payload does not appear
    // unescaped anywhere in the page.
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain(`"><script>`);
    expect(html).toContain("&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("Bob&#39;s Pitch");

    // Every <script> tag actually on the page — none introduced by this
    // submission — must be a bare, attribute-free tag whose text is a member
    // of `SCRIPT_BLOCKS`, exactly as the signin.test.ts pages loop requires,
    // so nothing here can carry a script the CSP hasn't hashed.
    for (const [, attributes, js] of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)) {
      expect(attributes, "any script tag on this page must carry no attributes").toBe("");
      expect(
        SCRIPT_BLOCKS as readonly string[],
        "any script tag on this page must be a member of SCRIPT_BLOCKS",
      ).toContain(js);
    }

    expect(await testDb().select().from(games)).toHaveLength(0);
  });

  /**
   * Proves the doc comment on `createGame` (src/domain/create-game.ts): a
   * materialisation failure must not turn an already-committed game into a
   * 500 the owner never sees a redirect from. Forces the failure by
   * intercepting the `fixtures` insert with `interferingBinding` rather than
   * crafting bad input — `parseGameForm` can never produce a `recurrenceRule`
   * that fails to parse, so the only way to exercise this branch through the
   * real route is to make the write itself fail.
   */
  it("still redirects to the new game when fixture materialisation fails", async () => {
    const { cookie } = await signIn();
    const app = createApp();

    const failing = interferingBinding(env.DB, {
      match: /insert into "fixtures"/i,
      before: async () => {
        throw new Error("simulated D1 failure while inserting fixtures");
      },
    });

    const response = await app.fetch(
      new Request(`${ORIGIN}/g/new`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, cookie },
        body: new URLSearchParams(VALID),
      }),
      bindings({ DB: failing }),
    );

    expect(response.status).toBe(303);
    const location = response.headers.get("location")!;
    expect(location).toMatch(/^\/g\/[0-9a-f-]{36}$/);

    // The game itself is there even though no fixtures are (the daily sweep
    // fills those in) — the write was not lost.
    const [game] = await testDb().select().from(games);
    expect(game?.name).toBe("Thursday 7-a-side");
    expect(location).toBe(`/g/${game!.id}`);
  });

  it("refuses a cross-site form post", async () => {
    const { cookie } = await signIn();
    const response = await SELF.fetch(`${ORIGIN}/g/new`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example", cookie },
      body: new URLSearchParams(VALID),
      redirect: "manual",
    });
    expect(response.status).toBe(403);
    expect(await testDb().select().from(games)).toHaveLength(0);
  });

  it("refuses an anonymous post", async () => {
    const response = await SELF.fetch(`${ORIGIN}/g/new`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN },
      body: new URLSearchParams(VALID),
      redirect: "manual",
    });
    expect(response.status).toBe(302);
    expect(await testDb().select().from(games)).toHaveLength(0);
  });
});

describe("GET /g/:id — entitlement (TR-18)", () => {
  beforeEach(resetDatabase);

  it("redirects an anonymous visitor to sign in", async () => {
    const response = await SELF.fetch(`${ORIGIN}/g/${crypto.randomUUID()}`, { redirect: "manual" });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/sign-in");
  });

  /** Creates a game owned by the signed-in player, returning its id and cookie. */
  async function ownedGame() {
    const { cookie } = await signIn();
    const response = await post("/g/new", cookie, VALID);
    const gameId = response.headers.get("location")!.replace("/g/", "");
    return { cookie, gameId };
  }

  it("shows the owner their game", async () => {
    const { cookie, gameId } = await ownedGame();
    const response = await SELF.fetch(`${ORIGIN}/g/${gameId}`, { headers: { cookie } });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Thursday 7-a-side");
  });

  it("404s for a signed-in player who is not a member", async () => {
    // The viewer signs in and owns their own game; this asks for somebody
    // else's, which they hold no membership row for at all. Testing it this
    // way round needs no second sign-in identity — `SELF.fetch` uses the
    // deployed bindings verbatim and cannot take a per-request allowlist.
    const { cookie } = await ownedGame();
    const db = testDb();
    const strangerId = await insertPlayer(db, { name: "Stranger" });
    const otherGameId = await insertGame(db);
    await insertMembership(db, otherGameId, strangerId, { role: "owner" });

    const response = await SELF.fetch(`${ORIGIN}/g/${otherGameId}`, { headers: { cookie }, redirect: "manual" });

    // 404, never 403 — a 403 would confirm the id names a real game.
    expect(response.status).toBe(404);
  });

  it("gives a member who is not an owner their own page", async () => {
    // A demoted owner falls through the owner check, but is still an active
    // member — Task 4 gives that case the player's page, not a 404 (see
    // `test/routes/player-game.test.ts` for the fuller entitlement matrix).
    const { cookie, gameId } = await ownedGame();
    const db = testDb();
    // Demote the only owner: the same person, no longer entitled as owner.
    await db.update(memberships).set({ role: "player" }).where(eq(memberships.gameId, gameId));

    const response = await SELF.fetch(`${ORIGIN}/g/${gameId}`, { headers: { cookie }, redirect: "manual" });
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain("Invite people");
  });

  it("404s for an owner whose membership has been deactivated", async () => {
    const { cookie, gameId } = await ownedGame();
    await testDb().update(memberships).set({ active: false }).where(eq(memberships.gameId, gameId));

    const response = await SELF.fetch(`${ORIGIN}/g/${gameId}`, { headers: { cookie }, redirect: "manual" });
    expect(response.status).toBe(404);
  });

  it("404s for a game id that does not exist", async () => {
    const { cookie } = await ownedGame();
    const response = await SELF.fetch(`${ORIGIN}/g/${crypto.randomUUID()}`, { headers: { cookie }, redirect: "manual" });
    expect(response.status).toBe(404);
  });
});

describe("the invite link on /g/:id", () => {
  beforeEach(resetDatabase);

  /** Creates a game owned by the signed-in player, returning its id and cookie. */
  async function ownedGame() {
    const { cookie } = await signIn();
    const response = await post("/g/new", cookie, VALID);
    const gameId = response.headers.get("location")!.replace("/g/", "");
    return { cookie, gameId };
  }

  it("shows the absolute invite URL and an inline QR code", async () => {
    const { cookie, gameId } = await ownedGame();
    const [game] = await testDb().select().from(games).where(eq(games.id, gameId));

    const html = await (await SELF.fetch(`${ORIGIN}/g/${gameId}`, { headers: { cookie } })).text();

    expect(html).toContain(`https://makethe.team/j/${game!.inviteToken}`);
    expect(html).toContain("<svg");
    // Inline, never fetched — the CSP has no img-src (spec §4.2).
    expect(html).not.toContain("<img");
  });

  it("replaces the token on rotation and dead-links the old one", async () => {
    const { cookie, gameId } = await ownedGame();
    const db = testDb();
    const before = (await db.select().from(games).where(eq(games.id, gameId)))[0]!.inviteToken;

    const response = await post(`/g/${gameId}/invite/rotate`, cookie, {});
    expect(response.status).toBe(303);

    const after = (await db.select().from(games).where(eq(games.id, gameId)))[0]!.inviteToken;
    expect(after).not.toBe(before);

    const [audit] = await db.select().from(auditLog).where(eq(auditLog.action, "game.invite_rotated"));
    expect(audit?.actorPlayerId).not.toBeNull();
    // The old token must not be recoverable from the audit trail.
    expect(JSON.stringify(audit)).not.toContain(before);
  });

  it("404s a rotation attempt by a non-owner", async () => {
    const { gameId } = await ownedGame();
    await testDb().update(memberships).set({ role: "player" }).where(eq(memberships.gameId, gameId));
    const { cookie } = await signIn();

    const response = await post(`/g/${gameId}/invite/rotate`, cookie, {});
    expect(response.status).toBe(404);
  });
});

describe("the squad list on /g/:id", () => {
  beforeEach(resetDatabase);

  /**
   * Pins `listSquad`'s ordering at the route level — this is exactly the gap
   * that let the "owners first" doc comment in `src/db/queries.ts` describe
   * the opposite of what `desc(memberships.role)` actually did (`"player" >
   * "owner"` lexicographically, so plain `desc()` put players first). A game
   * built via `insertGame`/`insertMembership` directly rather than through
   * `POST /g/new`, so the squad is exactly the three rows below and nothing
   * materialisation added on the side.
   */
  it("shows the owner before an ordinary member, and marks organiser and guest", async () => {
    const { cookie } = await signIn();
    const db = testDb();
    const [owner] = await db.select().from(players);
    const gameId = await insertGame(db);
    await insertMembership(db, gameId, owner!.id, { role: "owner" });

    const memberId = await insertPlayer(db, { name: "Zoe Ordinary Member" });
    await insertMembership(db, gameId, memberId, { role: "player" });

    const guestId = await insertPlayer(db, { name: "Gary Guest", email: null, isGuest: true });
    await insertMembership(db, gameId, guestId, { role: "player" });

    const html = await (await SELF.fetch(`${ORIGIN}/g/${gameId}`, { headers: { cookie } })).text();

    expect(html).toContain(owner!.name);
    expect(html).toContain("Zoe Ordinary Member");
    expect(html).toContain("Gary Guest");
    expect(html, "the owner's row carries the organiser marker").toContain("— organiser");
    expect(html, "the guest's row carries the guest marker").toContain("(guest)");

    // The property Important 1 was about: the owner's line renders BEFORE the
    // ordinary member's line, never the reverse.
    const ownerIndex = html.indexOf(owner!.name);
    const memberIndex = html.indexOf("Zoe Ordinary Member");
    expect(ownerIndex).toBeGreaterThan(-1);
    expect(memberIndex).toBeGreaterThan(-1);
    expect(ownerIndex).toBeLessThan(memberIndex);
  });
});

describe("the fixtures list on /g/:id", () => {
  beforeEach(resetDatabase);

  it("shows an upcoming fixture's local date, lifecycle and in-count", async () => {
    const { cookie } = await signIn();
    const db = testDb();
    const [owner] = await db.select().from(players);
    const gameId = await insertGame(db, { timezone: "Europe/London" });
    await insertMembership(db, gameId, owner!.id, { role: "owner" });

    const kickoff = new Date("2030-06-13T18:00:00Z");
    await db.insert(fixtures).values({
      id: crypto.randomUUID(),
      gameId,
      kicksOffAt: kickoff,
      lifecycle: "open",
      minPlayers: 10,
      maxPlayers: 14,
      prefersEvenNumbers: true,
      shortWarningOffsetHours: 12,
      durationMinutes: 60,
      inCount: 5,
    });

    const html = await (await SELF.fetch(`${ORIGIN}/g/${gameId}`, { headers: { cookie } })).text();

    expect(html).toContain(formatLocalDateTime(kickoff, "Europe/London"));
    expect(html).toContain("open");
    expect(html).toContain("5 in");
  });
});

/**
 * BR-29's advisory nudge, on the page both create and edit land on.
 *
 * The warning is re-derived from the saved row rather than carried through the
 * 303, so these drive it by seeding a game rather than by submitting a form —
 * which is also what pins the "it keeps showing" half of the behaviour.
 */
describe("the odd-max nudge on /g/:id", () => {
  beforeEach(resetDatabase);

  async function overviewFor(overrides: Record<string, unknown>) {
    const { cookie } = await signIn();
    const db = testDb();
    const [owner] = await db.select().from(players);
    const gameId = await insertGame(db, overrides);
    await insertMembership(db, gameId, owner!.id, { role: "owner" });
    return (await SELF.fetch(`${ORIGIN}/g/${gameId}`, { headers: { cookie } })).text();
  }

  it("warns when an odd maximum is paired with a preference for even numbers", async () => {
    const html = await overviewFor({ maxPlayers: 13, prefersEvenNumbers: true });
    expect(html).toContain("A squad of 13 can never split evenly");
  });

  it("says nothing when the maximum is even", async () => {
    const html = await overviewFor({ maxPlayers: 14, prefersEvenNumbers: true });
    expect(html).not.toContain("can never split evenly");
  });

  it("says nothing when even numbers are not preferred", async () => {
    const html = await overviewFor({ maxPlayers: 13, prefersEvenNumbers: false });
    expect(html).not.toContain("can never split evenly");
  });

  it("shows the venue address the owner saved", async () => {
    const html = await overviewFor({ venueAddress: "12 Iffley Road, Oxford" });
    expect(html).toContain("12 Iffley Road, Oxford");
  });
});

describe("editing a game", () => {
  beforeEach(resetDatabase);

  /** Creates a game owned by the signed-in player, returning its id and cookie. */
  async function ownedGame() {
    const { cookie } = await signIn();
    const response = await post("/g/new", cookie, VALID);
    const gameId = response.headers.get("location")!.replace("/g/", "");
    return { cookie, gameId };
  }

  it("prefills the form from the stored game", async () => {
    const { cookie, gameId } = await ownedGame();
    const html = await (await SELF.fetch(`${ORIGIN}/g/${gameId}/edit`, { headers: { cookie } })).text();

    expect(html).toContain('value="Thursday 7-a-side"');
    expect(html).toContain('value="19:00"');
    // The Advanced block is on edit only (spec §3.1).
    expect(html).toContain("<summary>Advanced</summary>");
  });

  /**
   * Regression test for a data-loss bug: this handler used to build `values`
   * field-by-field from the saved game row and omit teamAName/teamBName, so
   * the inputs rendered blank on every edit-form load. Blank is a valid
   * submission that `parseGameForm` defaults to "Team A"/"Team B" (by
   * design, so a genuinely new game can leave the fields empty) — so an
   * owner who edited anything else on the form, without retyping names they
   * had already set, would silently overwrite them back to the defaults.
   * Asserting the *edit form* carries the saved names is the assertion that
   * catches this; asserting only that a round-trip through the update path
   * preserves them would not, because that path never goes blank in the
   * first place.
   */
  it("prefills the edit form with custom team names rather than defaulting them", async () => {
    const { cookie } = await signIn();
    const response = await post("/g/new", cookie, { ...VALID, teamAName: "Bibs", teamBName: "Skins" });
    const gameId = response.headers.get("location")!.replace("/g/", "");

    const html = await (await SELF.fetch(`${ORIGIN}/g/${gameId}/edit`, { headers: { cookie } })).text();
    expect(html).toContain('value="Bibs"');
    expect(html).toContain('value="Skins"');
  });

  it("states how many fixtures the change will affect", async () => {
    const { cookie, gameId } = await ownedGame();
    const html = await (await SELF.fetch(`${ORIGIN}/g/${gameId}/edit`, { headers: { cookie } })).text();
    expect(html).toMatch(/This will update \d+ scheduled fixtures?\./);
  });

  it("saves and redirects", async () => {
    const { cookie, gameId } = await ownedGame();
    const response = await post(`/g/${gameId}/edit`, cookie, { ...VALID, name: "Friday 7-a-side", kickoffTime: "20:00" });

    expect(response.status).toBe(303);
    const [game] = await testDb().select().from(games).where(eq(games.id, gameId));
    expect(game?.name).toBe("Friday 7-a-side");
  });

  it("404s for a non-owner", async () => {
    const { cookie, gameId } = await ownedGame();
    await testDb().update(memberships).set({ role: "player" }).where(eq(memberships.gameId, gameId));

    expect((await SELF.fetch(`${ORIGIN}/g/${gameId}/edit`, { headers: { cookie }, redirect: "manual" })).status).toBe(404);
    expect((await post(`/g/${gameId}/edit`, cookie, VALID)).status).toBe(404);
  });

  /**
   * The existing "states how many fixtures the change will affect" test only
   * matches `/This will update \d+ scheduled fixtures?\./`, which is true for
   * both the singular and plural wording — it would not fail if
   * `propagationNotice`'s singular/plural ternaries were reversed. This drives
   * the counts to exactly one scheduled and one untouched fixture and pins
   * the exact singular strings, including the "fixture people have already
   * been emailed about stays unchanged" wording on the untouched half.
   */
  it("uses singular wording when exactly one fixture is affected either way", async () => {
    const { cookie, gameId } = await ownedGame();
    const db = testDb();
    const rows = await db.select().from(fixtures).where(eq(fixtures.gameId, gameId));
    expect(rows.length).toBeGreaterThan(1);

    const [, keepOpen, ...rest] = rows;
    await db.delete(fixtures).where(inArray(fixtures.id, rest.map((row) => row.id)));
    await db.update(fixtures).set({ lifecycle: "open" }).where(eq(fixtures.id, keepOpen!.id));

    const html = await (await SELF.fetch(`${ORIGIN}/g/${gameId}/edit`, { headers: { cookie } })).text();
    expect(html).toContain("This will update 1 scheduled fixture.");
    expect(html).toContain("1 fixture people have already been emailed about stays unchanged.");
  });

  /**
   * An unchecked checkbox is absent from the POST, so without the hidden
   * companion the redisplay cannot tell "unchecked" from "never submitted" and
   * silently re-checks the box — an owner who unchecks it, mistypes something
   * and corrects it ends up saving `prefers_even_numbers = true` against their
   * intent. The first assertion pins the hidden input's presence, because
   * these tests build the body by hand and would otherwise pass while a real
   * browser sent something different.
   */
  it("keeps 'prefer even numbers' unchecked through a validation round-trip", async () => {
    const { cookie, gameId } = await ownedGame();

    const form = await (await SELF.fetch(`${ORIGIN}/g/${gameId}/edit`, { headers: { cookie } })).text();
    expect(form).toContain('<input type="hidden" name="prefersEvenNumbersSubmitted" value="1">');

    // A browser sends nothing at all for an unchecked box, so the key is
    // deleted rather than emptied — an empty string is not how "unchecked"
    // appears on the wire.
    const unchecked: Record<string, string> = { ...VALID, minPlayers: "99" };
    delete unchecked["prefersEvenNumbers"];
    const response = await post(`/g/${gameId}/edit`, cookie, unchecked);

    expect(response.status).toBe(422);
    const html = await response.text();
    const box = html.match(/<input id="prefersEvenNumbers"[^>]*>/)?.[0] ?? "";
    expect(box).toContain('name="prefersEvenNumbers" type="checkbox"');
    expect(box).not.toContain("checked");
  });

  /**
   * The trap §6.1 exists to prevent: an unchecked box is absent from the
   * body, so without the hidden marker the redisplay re-ticks it and an
   * owner who unticked it, mistyped something else, and corrected that
   * silently saves it back on.
   */
  it("keeps the squad-visibility box unticked through a 422 redisplay", async () => {
    const { cookie, gameId } = await ownedGame();

    const unchecked: Record<string, string> = { ...VALID, kickoffTime: "not a time" };
    delete unchecked["squadVisibleToPlayers"];
    const response = await post(`/g/${gameId}/edit`, cookie, unchecked);

    expect(response.status).toBe(422);
    const html = await response.text();
    const box = html.match(/<input id="squadVisibleToPlayers"[^>]*>/)?.[0] ?? "";
    expect(box).not.toContain("checked");
  });

  /**
   * The notice warns about the *destructive* half of the edit, so the one
   * render where the owner is still deciding whether to resubmit is exactly
   * the render it must not disappear from.
   */
  it("still states how many fixtures the change will affect on a rejected edit", async () => {
    const { cookie, gameId } = await ownedGame();
    const response = await post(`/g/${gameId}/edit`, cookie, { ...VALID, kickoffTime: "not a time" });

    expect(response.status).toBe(422);
    expect(await response.text()).toMatch(/This will update \d+ scheduled fixtures?\./);
  });

  it("carries the odd-max nudge back with a rejected edit", async () => {
    const { cookie, gameId } = await ownedGame();
    const response = await post(`/g/${gameId}/edit`, cookie, {
      ...VALID,
      maxPlayers: "13",
      kickoffTime: "not a time",
    });

    expect(response.status).toBe(422);
    expect(await response.text()).toContain("A squad of 13 can never split evenly");
  });

  /**
   * Backs the `POST /g/:id/edit` exclusion in `test/routes/signin.test.ts`'s
   * `pinRoutesToPages`: that exclusion claims this route's only
   * HTML-returning branch shares `renderGameFormPage` with `GET /g/new` and
   * carries no template of its own, and that its script/password coverage
   * lives here. Mirrors the equivalent `POST /g/new` test above so that claim
   * is actually true rather than merely asserted.
   */
  it("escapes markup and quote-breakout attempts in a rejected edit submission", async () => {
    const { cookie, gameId } = await ownedGame();
    const response = await post(`/g/${gameId}/edit`, cookie, {
      ...VALID,
      // Bad enough to be rejected (min > max), so the 422 branch renders.
      minPlayers: "20",
      name: `"><script>alert(1)</script>`,
    });

    expect(response.status).toBe(422);
    const html = await response.text();

    expect(html, "must not contain a password field").not.toMatch(/type=.?password/i);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain(`"><script>`);
    expect(html).toContain("&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;");

    for (const [, attributes, js] of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)) {
      expect(attributes, "any script tag on this page must carry no attributes").toBe("");
      expect(
        SCRIPT_BLOCKS as readonly string[],
        "any script tag on this page must be a member of SCRIPT_BLOCKS",
      ).toContain(js);
    }
  });
});

describe("the copy-invite script's DOM ids stay in sync with the page", () => {
  beforeEach(resetDatabase);

  /**
   * `COPY_INVITE_JS` no-ops silently (`if (!input || !button) return;`) if
   * either id it looks up is missing, so a rename on either side breaks the
   * button with nothing failing loudly. Derives the expected ids from the
   * script's own source — the same technique `test/security/csp.test.ts`
   * uses to read `fetch` targets out of `SCRIPT_BLOCKS` — rather than
   * restating them, so this fails the moment the script and the page
   * actually disagree.
   */
  it("renders every id COPY_INVITE_JS looks up", async () => {
    const { cookie } = await signIn();
    const response = await post("/g/new", cookie, VALID);
    const gameId = response.headers.get("location")!.replace("/g/", "");

    const referencedIds = [...COPY_INVITE_JS.matchAll(/getElementById\("([^"]+)"\)/g)].map((m) => m[1]!);
    expect(referencedIds.length).toBeGreaterThan(0);

    const html = await (await SELF.fetch(`${ORIGIN}/g/${gameId}`, { headers: { cookie } })).text();
    for (const id of referencedIds) {
      expect(html, `page must render an element with id="${id}"`).toContain(`id="${id}"`);
    }
  });
});

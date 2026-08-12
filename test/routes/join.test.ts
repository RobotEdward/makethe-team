import { SELF } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { fixtures, games, memberships, notificationLog, players } from "../../src/db/schema.js";
import { insertGame, insertMembership, insertPlayer, resetDatabase, testDb } from "../support/factories.js";
import { ORIGIN } from "../support/sign-in.js";

async function seedGame(overrides = {}) {
  const db = testDb();
  const gameId = await insertGame(db, overrides);
  const [game] = await db.select().from(games).where(eq(games.id, gameId));
  return { db, game: game! };
}

function joinPost(token: string, fields: Record<string, string>, origin: string | null = ORIGIN) {
  return SELF.fetch(`${ORIGIN}/j/${token}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(origin === null ? {} : { origin }),
    },
    body: new URLSearchParams(fields),
    redirect: "manual",
  });
}

/**
 * The N-6 welcome is handed to `ctx.waitUntil`, so it is still in flight when
 * the response arrives — every assertion about it has to wait for the
 * background task rather than read straight after the fetch. Same shape, and
 * the same reasoning, as `waitForNotificationRows` in
 * `test/routes/respond-post.test.ts`: poll on the durable side effect until
 * it reaches a terminal status, never on a clock. Waiting for the status
 * specifically matters, because insert-before-send means the row exists as
 * `queued` for the whole duration of the send.
 *
 * Every test that triggers a send calls this before it finishes, even when it
 * asserts nothing about the email: a row that lands *after* the next test's
 * `resetDatabase` makes that reset's `DELETE FROM players` fail on
 * `notification_log`'s foreign key, and the failure surfaces in whichever
 * unrelated test happened to run next.
 */
async function waitForNotificationRows(atLeast: number, timeoutMs = 3000) {
  const db = testDb();
  const deadline = Date.now() + timeoutMs;
  const settled = (rows: Array<{ status: string }>) =>
    rows.length >= atLeast && rows.every((row) => row.status !== "queued");

  let rows = await db.select().from(notificationLog);
  while (!settled(rows) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    rows = await db.select().from(notificationLog);
  }
  return rows;
}

/**
 * Give any background send a generous chance to write, then report what is
 * there. Used where the *absence* of a row is the point — reading immediately
 * would pass even if a send had been started.
 */
async function notificationRowsAfterSettling() {
  const db = testDb();
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    const rows = await db.select().from(notificationLog);
    if (rows.length > 0) return rows;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return db.select().from(notificationLog);
}

describe("GET /j/:token", () => {
  beforeEach(resetDatabase);

  it("shows the game to an anonymous visitor with no session", async () => {
    const { game } = await seedGame();
    const response = await SELF.fetch(`${ORIGIN}/j/${game.inviteToken}`);

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Thursday 7-a-side");
    expect(html).toContain("Oxford Sports Park");
  });

  /**
   * Spec §4.3's full list. Someone deciding whether to join needs the address,
   * the day, the time, how long it runs and how many people are wanted — a
   * page that only names the game asks them to commit to a time and a place
   * they cannot see. The venue link is also the only place `parseGameForm`'s
   * `javascript:`-scheme rejection guards anything: it exists because this
   * value ends up in an `href` on the one page a stranger can reach.
   */
  it("shows the address, the schedule and the squad size (spec §4.3)", async () => {
    const { game } = await seedGame({
      venueAddress: "12 Iffley Road, Oxford",
      venueUrl: "https://example.com/pitch",
      recurrenceRule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=TH",
      kickoffTime: "19:00",
      durationMinutes: 90,
      timezone: "Europe/London",
      minPlayers: 10,
      maxPlayers: 14,
    });

    const html = await (await SELF.fetch(`${ORIGIN}/j/${game.inviteToken}`)).text();

    expect(html).toContain("12 Iffley Road, Oxford");
    expect(html).toContain('href="https://example.com/pitch"');
    expect(html).toContain("Every other Thursday at 19:00 (Europe/London), for 90 minutes.");
    expect(html).toContain("10 to 14 players.");
  });

  it("omits the optional venue fields rather than rendering blanks", async () => {
    const { game } = await seedGame();
    const html = await (await SELF.fetch(`${ORIGIN}/j/${game.inviteToken}`)).text();

    expect(html).not.toContain("More about the venue");
    expect(html).toContain("Every Thursday at 19:00");
  });

  it("redacts squad members to a first name and initial (BR-26)", async () => {
    const { db, game } = await seedGame();
    const playerId = await insertPlayer(db, { name: "Edward Charles", email: "edward@example.com" });
    await insertMembership(db, game.id, playerId);

    const html = await (await SELF.fetch(`${ORIGIN}/j/${game.inviteToken}`)).text();

    expect(html).toContain("Edward C.");
    expect(html).not.toContain("Charles");
    // Never an address, on a page anyone holding the link can open.
    expect(html).not.toContain("edward@example.com");
  });

  /**
   * Rotating the token and deactivating the game are an owner's only ways to
   * kill a leaked link. A shared cache holding a 200 for the old URL would
   * silently defeat both for the length of its TTL, so this page must never be
   * stored — and the 422 branch additionally echoes the submitter's own
   * address back into the form.
   */
  it("is never stored by a cache", async () => {
    const { game } = await seedGame();

    const get = await SELF.fetch(`${ORIGIN}/j/${game.inviteToken}`);
    expect(get.headers.get("cache-control")).toBe("private, no-store");

    const rejected = await joinPost(game.inviteToken, { name: "Alex", email: "not-an-address" });
    expect(rejected.status).toBe(422);
    expect(rejected.headers.get("cache-control")).toBe("private, no-store");
  });

  it("404s an unknown token", async () => {
    await seedGame();
    expect((await SELF.fetch(`${ORIGIN}/j/${crypto.randomUUID()}`)).status).toBe(404);
  });

  it("404s a rotated token without hinting that it was ever real", async () => {
    const { db, game } = await seedGame();
    const old = game.inviteToken;
    await db.update(games).set({ inviteToken: crypto.randomUUID() }).where(eq(games.id, game.id));

    const response = await SELF.fetch(`${ORIGIN}/j/${old}`);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("Thursday 7-a-side");
  });

  it("404s an inactive game", async () => {
    const { db, game } = await seedGame();
    await db.update(games).set({ active: false }).where(eq(games.id, game.id));
    expect((await SELF.fetch(`${ORIGIN}/j/${game.inviteToken}`)).status).toBe(404);
  });

  it("posts to the path the handler reads, with the field names it parses", async () => {
    // The assertion the connect-src post-mortem asks for: a form with the
    // wrong action, method or field names fails *identically* to a correct one
    // under server-side testing, because the handler is simply never called.
    //
    // So nothing here is restated from a constant — the request below is built
    // entirely out of the rendered markup (the form's own `action`, `method`
    // and input `name`s, parsed out of it) and then driven through the real
    // app. A form that posted to `/join/…`, or named its field `player-name`,
    // would still render, still 200, and still pass every other test in this
    // file; it fails here.
    const { db, game } = await seedGame();
    const html = await (await SELF.fetch(`${ORIGIN}/j/${game.inviteToken}`)).text();

    const form = /<form([^>]*)>([\s\S]*?)<\/form>/.exec(html);
    expect(form, "the page must carry a form to join with").not.toBeNull();
    const attributes = form![1]!;
    const body = form![2]!;

    const method = /method="([^"]+)"/.exec(attributes)?.[1];
    const action = /action="([^"]+)"/.exec(attributes)?.[1];
    expect(method, "a write must not be a GET").toBe("post");
    expect(action).toBeDefined();

    // Each input is identified by what it *is* — the one with `type="email"`
    // takes the address, the other takes the name — rather than by the order
    // the two happen to appear in. Reordering them is a presentational change
    // and must not fail this test with a confusing 422.
    const inputs = [...body.matchAll(/<input[^>]*>/g)].map((match) => match[0]!);
    expect(inputs, "two fields, and only two, to type into").toHaveLength(2);
    const nameOf = (input: string) => /\bname="([^"]+)"/.exec(input)?.[1];
    const emailInput = inputs.find((input) => /\btype="email"/.test(input));
    const otherInput = inputs.find((input) => input !== emailInput);
    expect(emailInput, "one field must be type=email — a phone keyboard and a free format check").toBeDefined();
    for (const input of inputs) {
      expect(nameOf(input), "every field must be named, or the handler cannot read it").toBeDefined();
      expect(input, "both fields must be required — this form has no JavaScript behind it").toMatch(
        /\brequired\b/,
      );
    }
    expect(body).toMatch(/<button[^>]*type="submit"/);

    // Drive exactly what the browser would send, at exactly the URL the markup
    // names, and prove the handler read both fields.
    const fields = {
      [nameOf(otherInput!)!]: "Alex Smith",
      [nameOf(emailInput!)!]: "alex@example.com",
    };
    const response = await SELF.fetch(new URL(action!, ORIGIN).toString(), {
      method: method!,
      headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN },
      body: new URLSearchParams(fields),
      redirect: "manual",
    });

    expect(response.status, "the form must post somewhere the app actually handles").toBe(200);
    expect(await response.text()).toContain("You're in");
    const [player] = await db.select().from(players).where(eq(players.email, "alex@example.com"));
    expect(player?.name, "the handler must read the field the form names").toBe("Alex Smith");
    expect(await db.select().from(memberships).where(eq(memberships.gameId, game.id))).toHaveLength(1);
    expect(await waitForNotificationRows(1)).toHaveLength(1);
  });
});

describe("POST /j/:token", () => {
  beforeEach(resetDatabase);

  it("creates the player and the membership and welcomes them", async () => {
    const { db, game } = await seedGame();

    const response = await joinPost(game.inviteToken, { name: "Alex Smith", email: "alex@example.com" });

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("You're in");
    // BR-2 on the branch with nothing scheduled — the person most likely to
    // see a game happening this week and assume it is theirs.
    expect(html).toContain("you're not in that one");

    const [player] = await db.select().from(players).where(eq(players.email, "alex@example.com"));
    expect(player?.name).toBe("Alex Smith");
    const [membership] = await db.select().from(memberships).where(eq(memberships.gameId, game.id));
    expect(membership?.active).toBe(true);

    const rows = await waitForNotificationRows(1);
    const log = rows.find((row) => row.notificationType === "n6");
    expect(log?.playerId).toBe(player!.id);
    // N-6 is about a membership, not a fixture — the only row in the
    // catalogue with a null fixture id.
    expect(log?.fixtureId).toBeNull();
  });

  /**
   * The same double-tap as `test/domain/join-squad.test.ts`, driven through
   * the route, because the failure mode this closes is an HTTP one: the loser
   * of the race used to get a 500 "something went wrong" for an operation that
   * had succeeded, leaving them unable to tell whether they were in the squad.
   */
  it("answers both halves of a double-tapped join without a 500", async () => {
    const { db, game } = await seedGame();

    const responses = await Promise.all([
      joinPost(game.inviteToken, { name: "Alex Smith", email: "alex@example.com" }),
      joinPost(game.inviteToken, { name: "Alex Smith", email: "alex@example.com" }),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(200);
    }
    expect(await db.select().from(players).where(eq(players.email, "alex@example.com"))).toHaveLength(1);
    expect(await db.select().from(memberships).where(eq(memberships.gameId, game.id))).toHaveLength(1);

    // Let any welcome land before the next test's reset — see the note above.
    await waitForNotificationRows(1);
  });

  it("is idempotent for someone already in the squad", async () => {
    const { db, game } = await seedGame();
    const playerId = await insertPlayer(db, { email: "alex@example.com" });
    await insertMembership(db, game.id, playerId);

    const response = await joinPost(game.inviteToken, { name: "Alex", email: "alex@example.com" });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("already in");
    expect(await db.select().from(memberships).where(eq(memberships.gameId, game.id))).toHaveLength(1);
    // No second welcome for someone who was already here.
    expect(await notificationRowsAfterSettling()).toHaveLength(0);
  });

  it("redisplays the form when the email is not plausible", async () => {
    const { db, game } = await seedGame();
    // A squad member with an address of their own, so the assertion below is
    // about the page's real invariant rather than about an empty squad.
    const memberId = await insertPlayer(db, { name: "Edward Charles", email: "edward@example.com" });
    await insertMembership(db, game.id, memberId);

    const response = await joinPost(game.inviteToken, { name: "Alex", email: "not-an-address" });

    expect(response.status).toBe(422);
    const html = await response.text();
    // Both fields come back, or somebody retypes the whole form on a phone.
    expect(html).toContain('value="Alex"');
    expect(html).toContain('value="not-an-address"');
    // The invariant that echo does *not* break: the only address on this page
    // is the one the person sending this request has just typed. Never a squad
    // member's.
    expect(html).not.toContain("edward@example.com");
    // Nothing was written: only the seeded squad member exists.
    expect(await db.select().from(players)).toHaveLength(1);
    expect(await db.select().from(memberships).where(eq(memberships.gameId, game.id))).toHaveLength(1);
  });

  it("requires a name", async () => {
    const { db, game } = await seedGame();
    const response = await joinPost(game.inviteToken, { name: "  ", email: "alex@example.com" });

    expect(response.status).toBe(422);
    expect(await db.select().from(players)).toHaveLength(0);
  });

  it("refuses a cross-site post", async () => {
    const { db, game } = await seedGame();
    const response = await joinPost(game.inviteToken, { name: "Alex", email: "alex@example.com" }, "https://evil.example");

    expect(response.status).toBe(403);
    expect(await db.select().from(players)).toHaveLength(0);
  });

  it("allows a post with no Origin header at all", async () => {
    // A non-browser client acting on its own behalf, same rule as the
    // dashboard and sign-out forms.
    const { game } = await seedGame();
    const response = await joinPost(game.inviteToken, { name: "Alex", email: "alex@example.com" }, null);
    expect(response.status).toBe(200);
    expect(await waitForNotificationRows(1)).toHaveLength(1);
  });

  it("404s an unknown token before doing any work", async () => {
    const db = testDb();
    const response = await joinPost(crypto.randomUUID(), { name: "Alex", email: "alex@example.com" });

    expect(response.status).toBe(404);
    expect(await db.select().from(players)).toHaveLength(0);
  });

  it("welcomes someone back after they had left", async () => {
    const { db, game } = await seedGame();
    const playerId = await insertPlayer(db, { email: "alex@example.com" });
    await insertMembership(db, game.id, playerId, { active: false, leftAt: new Date(Date.UTC(2026, 5, 1)) });

    const response = await joinPost(game.inviteToken, { name: "Alex", email: "alex@example.com" });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Welcome back");
    const [membership] = await db.select().from(memberships).where(eq(memberships.playerId, playerId));
    expect(membership?.active).toBe(true);
    expect(membership?.leftAt).toBeNull();
    // A rejoin is welcomed again — `joinSquad` resets `joined_at` so the N-6
    // dedupe key differs from the first join's (§4.4).
    expect(await waitForNotificationRows(1)).toHaveLength(1);
  });

  /**
   * BR-2, on the page rather than only in the email. A fixture that is already
   * `open` was populated with `pending` rows for the eligible set at the
   * moment it opened and nothing back-fills them, so a joiner is not in it —
   * the page must name the next `scheduled` one as their first game.
   */
  it("names the next scheduled fixture, never one already open (BR-2)", async () => {
    const { db, game } = await seedGame({ timezone: "Europe/London" });
    const common = {
      gameId: game.id,
      minPlayers: 10,
      maxPlayers: 14,
      durationMinutes: 60,
      prefersEvenNumbers: true,
      shortWarningOffsetHours: 12,
    };
    await db.insert(fixtures).values([
      {
        id: crypto.randomUUID(),
        ...common,
        kicksOffAt: new Date("2030-06-06T18:00:00Z"),
        lifecycle: "open",
      },
      {
        id: crypto.randomUUID(),
        ...common,
        kicksOffAt: new Date("2030-06-13T18:00:00Z"),
        lifecycle: "scheduled",
      },
    ]);

    const html = await (
      await joinPost(game.inviteToken, { name: "Alex", email: "alex@example.com" })
    ).text();

    expect(html).toContain("You're in");
    // 13 June, the scheduled one — not 6 June, which is already being
    // organised without them.
    expect(html).toContain("13 June");
    expect(html).not.toContain("6 June");
    expect(await waitForNotificationRows(1)).toHaveLength(1);
  });
});

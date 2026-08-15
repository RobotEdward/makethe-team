import { SELF, env } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import {
  DASHBOARD_PATH,
  DELETE_ACCOUNT_CANCEL_PATH,
  DELETE_ACCOUNT_PATH,
  SIGN_IN_PATH,
} from "../../src/auth/paths.js";
import { getDb } from "../../src/db/client.js";
import { auditLog, fixtures, memberships, players, responses, session } from "../../src/db/schema.js";
import { ERASURE_WINDOW_MS } from "../../src/domain/erasure-window.js";
import { openFixture } from "../../src/domain/open-fixture.js";
import { insertFixture, insertGame, insertMembership, insertPlayer, resetDatabase } from "../support/factories.js";
import { ALLOWED, ORIGIN, signIn } from "../support/sign-in.js";

const db = getDb(env.DB);

/** Far-future, so nothing here depends on how the suite ages. */
const KICKOFF = new Date("2030-06-13T18:00:00Z");
const OPENED_AT = new Date("2030-06-01T09:00:00Z");

/** The Player the sign-in journey created for `ALLOWED`. */
async function viewerId(): Promise<string> {
  const [player] = await db.select().from(players).where(eq(players.email, ALLOWED));
  expect(player, "signing in must have created a Player").toBeDefined();
  return player!.id;
}

/**
 * Everything goes through `SELF.fetch` (TR-29) rather than an in-process app:
 * `POST /app/delete` hands the N-8 email to `c.executionCtx.waitUntil`, and
 * only the real Worker invocation has an execution context to hand it to.
 */
function get(cookie?: string) {
  return SELF.fetch(`${ORIGIN}${DELETE_ACCOUNT_PATH}`, {
    headers: cookie ? { cookie } : {},
    redirect: "manual",
  });
}

function post(path: string, cookie?: string, origin: string | null = ORIGIN) {
  return SELF.fetch(`${ORIGIN}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(cookie ? { cookie } : {}),
      ...(origin ? { origin } : {}),
    },
    body: new URLSearchParams({}),
    redirect: "manual",
  });
}

async function playerRowFor(playerId: string) {
  const [row] = await db.select().from(players).where(eq(players.id, playerId));
  return row;
}

async function fixtureCounts(fixtureId: string) {
  const [row] = await db
    .select({ inCount: fixtures.inCount, waitlistCount: fixtures.waitlistCount })
    .from(fixtures)
    .where(eq(fixtures.id, fixtureId));
  return row!;
}

async function auditRows(action: string) {
  const rows = await db.select().from(auditLog);
  return rows.filter((row) => row.action === action);
}

beforeEach(async () => {
  await resetDatabase();
});

describe("GET /app/delete", () => {
  it("sends an anonymous visitor to sign in", async () => {
    const response = await get();

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(SIGN_IN_PATH);
  });

  it("offers erasure to an ordinary player, as a form post with no JavaScript", async () => {
    const { cookie } = await signIn();
    const playerId = await viewerId();
    const gameId = await insertGame(db, { name: "Thursday Five" });
    await insertMembership(db, gameId, playerId, { role: "player", active: true });

    const response = await get(cookie);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).not.toContain("<script");
    expect(body).toContain('method="post"');
    expect(body).toContain(`action="${DELETE_ACCOUNT_PATH}"`);
    // Both halves of what happens, and the delay that makes cancelling possible.
    expect(body).toMatch(/two days/i);
    expect(body).toMatch(/still count you/i);
  });

  /**
   * The sentence that stops the missing control from being reported as a bug —
   * an organiser who goes looking for a way to do this for a player must be
   * told plainly that there isn't one, on whichever state they land on.
   */
  it("says on every state that nobody else can do this for you", async () => {
    const { cookie } = await signIn();
    const playerId = await viewerId();

    expect(await (await get(cookie)).text()).toMatch(/neither can we/i);

    await db.update(players).set({ erasesAt: new Date(Date.now() + 1000) }).where(eq(players.id, playerId));
    expect(await (await get(cookie)).text()).toMatch(/neither can we/i);
  });

  it("refuses a sole organiser, names the game, and offers no button", async () => {
    const { cookie } = await signIn();
    const playerId = await viewerId();
    const gameId = await insertGame(db, { name: "Sole-Organised Game" });
    await insertMembership(db, gameId, playerId, { role: "owner", active: true });

    const body = await (await get(cookie)).text();

    expect(body).toContain("Sole-Organised Game");
    expect(body).toContain(`href="/g/${gameId}"`);
    // No button at all, not a disabled one: there is nothing to press until
    // the handover has happened.
    expect(body).not.toContain("<button");
  });

  /**
   * The ordering inside the `GET`, pinned because it is a decision rather than
   * an accident: a pending erasure is shown even to someone who has since
   * become a game's only organiser.
   *
   * They arrived here from the confirmation email to check or cancel a date,
   * and a refusal page that never mentions that date would answer a question
   * they did not ask while hiding the one thing they came for — an erasure
   * that is still counting down, because the block stops the sweep, not the
   * clock. A refactor that moved the sole-organiser scan above the `erases_at`
   * read would break exactly this and nothing else.
   */
  it("shows a pending erasure even to a sole organiser, rather than the refusal", async () => {
    const { cookie } = await signIn();
    const playerId = await viewerId();
    await post(DELETE_ACCOUNT_PATH, cookie);
    const gameId = await insertGame(db, { name: "Sole-Organised Game" });
    await insertMembership(db, gameId, playerId, { role: "owner", active: true });

    const response = await get(cookie);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("Keep my account");
    expect(body).toMatch(/due to be erased on/);
    expect(body).not.toContain("Sole-Organised Game");
  });

  it("offers the button to an owner who shares the game with another active organiser", async () => {
    const { cookie } = await signIn();
    const playerId = await viewerId();
    const gameId = await insertGame(db, { name: "Co-Organised Game" });
    await insertMembership(db, gameId, playerId, { role: "owner", active: true });
    const coOwnerId = await insertPlayer(db, { name: "Other Organiser" });
    await insertMembership(db, gameId, coOwnerId, { role: "owner", active: true });

    const body = await (await get(cookie)).text();

    expect(body).toContain("<button");
    expect(body).not.toContain("Co-Organised Game");
  });
});

describe("POST /app/delete", () => {
  /**
   * **The inertness guarantee (§2), and the most important test in this file.**
   *
   * Requesting an erasure sets a date and does nothing else. It must not end a
   * membership, touch a response, or move a fixture's counts — because ending
   * a membership frees open places and promotes waitlisted players by email,
   * and those emails cannot be recalled. If this handler ever starts doing the
   * erasure's work, "cancel" stops meaning cancel: the 48-hour window becomes
   * a delay on paperwork rather than a way back. A later refactor that folds
   * this route into the sweep's code path is exactly how that happens, and
   * this test is what stops it.
   */
  it("changes nothing but the deadline: no membership, response, fixture or erasure", async () => {
    const { cookie } = await signIn();
    const playerId = await viewerId();
    const gameId = await insertGame(db, { name: "Thursday Five", maxPlayers: 14 });
    await insertMembership(db, gameId, playerId, { role: "player", active: true });
    const fixtureId = await insertFixture(db, gameId, { kicksOffAt: KICKOFF, minPlayers: 1 });
    await openFixture(db, fixtureId, OPENED_AT);
    await env.FIXTURE_CAPACITY.getByName(fixtureId).setResponse({
      playerId,
      intent: "in",
      actorPlayerId: null,
      source: "web",
      whenFull: "waitlist",
      now: OPENED_AT.getTime(),
    });

    const [responseBefore] = await db
      .select()
      .from(responses)
      .where(and(eq(responses.fixtureId, fixtureId), eq(responses.playerId, playerId)));
    const countsBefore = await fixtureCounts(fixtureId);
    expect(countsBefore.inCount).toBe(1);
    // The session this request is made with. "No session is revoked" is part
    // of the guarantee: a request must leave the person still signed in, still
    // able to reach this page and cancel. Only the sweep destroys these rows.
    const sessionsBefore = await db.select().from(session);
    expect(sessionsBefore.length, "signing in must have left a session row").toBeGreaterThan(0);

    const response = await post(DELETE_ACCOUNT_PATH, cookie);
    expect(response.status).toBe(303);

    const [membership] = await db
      .select()
      .from(memberships)
      .where(and(eq(memberships.gameId, gameId), eq(memberships.playerId, playerId)));
    expect(membership?.active, "the membership must survive the request untouched").toBe(true);

    const [responseAfter] = await db
      .select()
      .from(responses)
      .where(and(eq(responses.fixtureId, fixtureId), eq(responses.playerId, playerId)));
    expect(responseAfter).toEqual(responseBefore);

    // The denormalised counts the capacity object maintains: a freed place
    // would show up here even if the response row somehow did not.
    expect(await fixtureCounts(fixtureId)).toEqual(countsBefore);

    expect(await db.select().from(session)).toEqual(sessionsBefore);

    // Nothing has been erased. Only the sweep (M7b Task 6) sets this.
    const player = await playerRowFor(playerId);
    expect(player!.erasedAt).toBeNull();
    expect(player!.name).not.toBe("[erased player]");
    expect(player!.email).toBe(ALLOWED);
  });

  it("sets erases_at exactly 48 hours out and audits the request once", async () => {
    const { cookie } = await signIn();
    const playerId = await viewerId();

    const before = Date.now();
    const response = await post(DELETE_ACCOUNT_PATH, cookie);
    const after = Date.now();

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(DELETE_ACCOUNT_PATH);

    const erasesAt = (await playerRowFor(playerId))!.erasesAt;
    expect(erasesAt).not.toBeNull();
    // Exactly the window ahead of the instant the handler read — bounded by
    // the two clock reads either side of the request rather than pinned to
    // one, because the handler's own `Date.now()` sits between them.
    expect(erasesAt!.getTime()).toBeGreaterThanOrEqual(before + ERASURE_WINDOW_MS);
    expect(erasesAt!.getTime()).toBeLessThanOrEqual(after + ERASURE_WINDOW_MS);

    const audits = await auditRows("player.erasure_requested");
    expect(audits).toHaveLength(1);
    expect(audits[0]!.actorPlayerId).toBe(playerId);
    expect(audits[0]!.entityType).toBe("player");
    expect(audits[0]!.entityId).toBe(playerId);
    expect(JSON.parse(audits[0]!.afterJson!)).toEqual({ erasesAt: erasesAt!.toISOString() });
  });

  it("then shows the pending state, naming the date and offering the cancel", async () => {
    const { cookie } = await signIn();
    await post(DELETE_ACCOUNT_PATH, cookie);

    const body = await (await get(cookie)).text();

    expect(body).toContain(`action="${DELETE_ACCOUNT_CANCEL_PATH}"`);
    expect(body).toContain("Keep my account");
    // The exact instant, formatted in Europe/London as the N-8 email formats it.
    expect(body).toMatch(/due to be erased on <strong>\w+day \d+ \w+ at \d\d:\d\d<\/strong>/);
  });

  /**
   * The page the form came from could be days old, and a co-organiser may have
   * left since. The check is re-run here and the answer is the page itself at
   * 422 — never a bare error, and never a scheduled erasure the sweep would
   * then refuse to perform after the email had promised a date.
   */
  it("re-refuses a sole organiser at 422 and schedules nothing", async () => {
    const { cookie } = await signIn();
    const playerId = await viewerId();
    const gameId = await insertGame(db, { name: "Sole-Organised Game" });
    await insertMembership(db, gameId, playerId, { role: "owner", active: true });

    const response = await post(DELETE_ACCOUNT_PATH, cookie);
    const body = await response.text();

    expect(response.status).toBe(422);
    expect(body).toContain("Sole-Organised Game");
    expect(body).toMatch(/needs at least one organiser/i);
    expect((await playerRowFor(playerId))!.erasesAt).toBeNull();
    expect(await auditRows("player.erasure_requested")).toHaveLength(0);
  });

  it("refuses a cross-site post", async () => {
    const { cookie } = await signIn();
    const playerId = await viewerId();

    const response = await post(DELETE_ACCOUNT_PATH, cookie, "https://evil.test");

    expect(response.status).toBe(403);
    expect((await playerRowFor(playerId))!.erasesAt).toBeNull();
  });
});

describe("POST /app/delete/cancel", () => {
  it("clears erases_at and audits the cancellation once", async () => {
    const { cookie } = await signIn();
    const playerId = await viewerId();
    await post(DELETE_ACCOUNT_PATH, cookie);
    expect((await playerRowFor(playerId))!.erasesAt).not.toBeNull();

    const response = await post(DELETE_ACCOUNT_CANCEL_PATH, cookie);

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(DASHBOARD_PATH);
    expect((await playerRowFor(playerId))!.erasesAt).toBeNull();

    const audits = await auditRows("player.erasure_cancelled");
    expect(audits).toHaveLength(1);
    expect(audits[0]!.actorPlayerId).toBe(playerId);
    expect(audits[0]!.entityId).toBe(playerId);
  });

  /** A double-submitted form must not read as a failure to cancel. */
  it("redirects rather than erroring when nothing is pending", async () => {
    const { cookie } = await signIn();
    const playerId = await viewerId();

    const response = await post(DELETE_ACCOUNT_CANCEL_PATH, cookie);

    expect(response.status).toBe(303);
    expect((await playerRowFor(playerId))!.erasesAt).toBeNull();
  });

  it("refuses a cross-site post and leaves the erasure scheduled", async () => {
    const { cookie } = await signIn();
    const playerId = await viewerId();
    await post(DELETE_ACCOUNT_PATH, cookie);

    const response = await post(DELETE_ACCOUNT_CANCEL_PATH, cookie, "https://evil.test");

    expect(response.status).toBe(403);
    expect((await playerRowFor(playerId))!.erasesAt).not.toBeNull();
  });

  /**
   * **The state this window cannot get out of, and the reason cancel now has
   * a refusal at all.**
   *
   * `erasePlayer` leaves squads one game at a time and can stop part-way — a
   * late sole-organiser refusal, a D1 error, the subrequest budget. By then
   * the player is out of some squads, whoever was waitlisted for their places
   * has been promoted and emailed, and none of that can be taken back.
   * Clearing `erases_at` there removes the only thing that would ever finish
   * the job, leaving an account permanently half-erased with nothing pending
   * and no retry.
   */
  it("refuses to cancel once execution has begun, and leaves the erasure pending", async () => {
    const { cookie } = await signIn();
    const playerId = await viewerId();
    await post(DELETE_ACCOUNT_PATH, cookie);
    const past = new Date(Date.now() - 3_600_000);
    await db
      .update(players)
      .set({ erasesAt: past, erasureStartedAt: past })
      .where(eq(players.id, playerId));

    const response = await post(DELETE_ACCOUNT_CANCEL_PATH, cookie);
    const body = await response.text();

    expect(response.status).toBe(422);
    expect(body).toMatch(/already started/i);
    // Still pending, and no audit row claiming a cancellation that did not
    // happen.
    expect((await playerRowFor(playerId))!.erasesAt?.getTime()).toBe(past.getTime());
    expect(await auditRows("player.erasure_cancelled")).toHaveLength(0);
  });

  /**
   * The other side of the same line: an erasure that is merely *overdue* —
   * blocked on a handover, or simply waiting for the next sweep — has written
   * nothing, and cancelling it must stay as easy as it ever was. A refusal
   * here would strand a blocked player with no way out at all.
   */
  it("still cancels an overdue erasure that has not begun", async () => {
    const { cookie } = await signIn();
    const playerId = await viewerId();
    await post(DELETE_ACCOUNT_PATH, cookie);
    const gameId = await insertGame(db, { name: "Sole-Organised Game" });
    await insertMembership(db, gameId, playerId, { role: "owner", active: true });
    await db
      .update(players)
      .set({ erasesAt: new Date(Date.now() - 3_600_000) })
      .where(eq(players.id, playerId));

    const response = await post(DELETE_ACCOUNT_CANCEL_PATH, cookie);

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(DASHBOARD_PATH);
    expect((await playerRowFor(playerId))!.erasesAt).toBeNull();
  });

  /**
   * MINOR 3: a cancel racing the sweep. `erasePlayer` sets `erased_at` without
   * touching `erases_at` — §2.1 keeps the latter as the record of what was
   * promised — so an unscoped cancel landing just after it would leave
   * `erased_at` set with `erases_at` null, a row that says it was erased with
   * no trace of the request that erased it.
   */
  it("does not clear erases_at on a player who has already been erased", async () => {
    const { cookie } = await signIn();
    const playerId = await viewerId();
    await post(DELETE_ACCOUNT_PATH, cookie);
    const erasesAt = (await playerRowFor(playerId))!.erasesAt!;
    await db
      .update(players)
      .set({ erasedAt: new Date(Date.now()) })
      .where(eq(players.id, playerId));

    const response = await post(DELETE_ACCOUNT_CANCEL_PATH, cookie);

    expect(response.status).toBe(303);
    expect((await playerRowFor(playerId))!.erasesAt?.getTime()).toBe(erasesAt.getTime());
  });
});

/**
 * The fourth state (§6). Until the final review the page had three, and an
 * erasure the sweep refused went on being rendered as `pending`: "due to be
 * erased on <a Wednesday three weeks ago>" and "until then nothing has
 * changed", with nothing naming the game that was actually holding it up.
 */
describe("GET /app/delete — the held-up state", () => {
  /** An hour ago; the sweep is hourly, so this is genuinely overdue. */
  const overdue = () => new Date(Date.now() - 3_600_000);

  it("names and links the game holding an overdue erasure up", async () => {
    const { cookie } = await signIn();
    const playerId = await viewerId();
    const gameId = await insertGame(db, { name: "Sole-Organised Game" });
    await insertMembership(db, gameId, playerId, { role: "owner", active: true });
    await db.update(players).set({ erasesAt: overdue() }).where(eq(players.id, playerId));

    const response = await get(cookie);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toMatch(/hasn't happened yet/);
    expect(body).toContain("Sole-Organised Game");
    expect(body).toContain(`href="/g/${gameId}"`);
    // The stale promise is gone: no future-tense date, and none of the
    // pending state's "nothing has changed".
    expect(body).not.toMatch(/is due to be erased on/);
    expect(body).not.toMatch(/still in your squads/);
    // Nothing has been written yet, so the way out is still open.
    expect(body).toContain("Keep my account");
  });

  /**
   * Overdue is not the same as blocked. The sweep runs on the hour, so a
   * deadline can be minutes past with nothing wrong at all — and the page must
   * not invent a problem, or a game, that does not exist.
   */
  it("says an unblocked overdue erasure is simply still to run", async () => {
    const { cookie } = await signIn();
    const playerId = await viewerId();
    await db.update(players).set({ erasesAt: overdue() }).where(eq(players.id, playerId));

    const body = await (await get(cookie)).text();

    expect(body).toMatch(/hasn't happened yet/);
    expect(body).toMatch(/should happen shortly/);
    expect(body).toContain("Keep my account");
  });

  it("says a part-run erasure has begun, and offers no way to stop it", async () => {
    const { cookie } = await signIn();
    const playerId = await viewerId();
    const past = overdue();
    await db
      .update(players)
      .set({ erasesAt: past, erasureStartedAt: past })
      .where(eq(players.id, playerId));

    const body = await (await get(cookie)).text();

    expect(body).toMatch(/already begun/);
    // The false sentence, in the place it mattered most: this player is *not*
    // still in their squads.
    expect(body).not.toMatch(/still in your squads/);
    expect(body).not.toContain("Keep my account");
    expect(body).not.toContain(`action="${DELETE_ACCOUNT_CANCEL_PATH}"`);
  });
});

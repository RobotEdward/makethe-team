import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { insertGame, insertMembership, insertPlayer, resetDatabase, testDb } from "../support/factories.js";
import { ALLOWED, ORIGIN, signIn } from "../support/sign-in.js";

/**
 * The 404 a person reaches by following a link (M38).
 *
 * The reason this suite exists is a real report: an organiser pasted a `/g/`
 * status link into their WhatsApp group as a sign-up link, and the one reader
 * not yet in the squad got `Not found` as three words of plain text with no
 * way forward. The page now says something useful — and the whole risk in
 * saying anything at all is that it says *more* for a game that exists than
 * for one that does not, which would hand a prober the oracle TR-18's 404
 * exists to deny. Hence the byte-identical assertions below rather than
 * `toContain` on each route separately.
 */
async function get(path: string, cookie?: string) {
  return SELF.fetch(`${ORIGIN}${path}`, {
    headers: cookie === undefined ? {} : { cookie },
    redirect: "manual",
  });
}

/** A signed-in player who is a member of one game and nothing else. */
async function signedInOutsider() {
  const db = testDb();
  const playerId = await insertPlayer(db, { email: ALLOWED, name: "Outsider" });
  const theirGame = await insertGame(db, { name: "A squad they are in" });
  await insertMembership(db, theirGame, playerId, { role: "player" });
  const { cookie } = await signIn();
  return cookie;
}

const MISSING_GAME_ID = "00000000-0000-4000-8000-000000000000";

describe("the not-found page", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("says the same thing for a game that exists as for one that does not", async () => {
    const cookie = await signedInOutsider();
    const db = testDb();
    const realGame = await insertGame(db, { name: "A squad they are not in" });

    const missing = await get(`/g/${MISSING_GAME_ID}`, cookie);
    const notMine = await get(`/g/${realGame}`, cookie);

    expect(missing.status).toBe(404);
    expect(notMine.status).toBe(404);
    // Byte-identical, not merely both-404: the whole point of TR-18's 404 is
    // that a game id cannot be probed, and a page that named the real cause
    // would undo it.
    expect(await notMine.text()).toBe(await missing.text());
  });

  it("names the invite link's shape, so a misdirected reader can ask for the right one", async () => {
    const cookie = await signedInOutsider();

    const response = await get(`/g/${MISSING_GAME_ID}`, cookie);
    const body = await response.text();

    expect(response.headers.get("content-type")).toContain("text/html");
    expect(body).toContain("/j/");
    expect(body).toContain("different email address");
  });

  it("is the same page for an invite token that no longer resolves", async () => {
    const cookie = await signedInOutsider();
    const expected = await (await get(`/g/${MISSING_GAME_ID}`, cookie)).text();

    const badToken = await get(`/j/${MISSING_GAME_ID}`);

    expect(badToken.status).toBe(404);
    expect(await badToken.text()).toBe(expected);
  });

  it("leaves the app-wide fallback a bare body, so a scanner learns nothing", async () => {
    // Deliberately NOT this page. `test/routes/access.test.ts` pins the
    // unmatched-route 404 as a bare string that names neither the product nor
    // the stack, and an HTML page titled "Make The Team" would undo it. The
    // routes above are the ones a person reaches by tapping a link; an
    // unrouted path is reached by a scanner.
    const response = await get("/no-such-path");

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not found");
  });

  it("still sends a signed-out visitor to sign in rather than showing them this", async () => {
    // Unchanged behaviour, pinned because the page above would be a worse
    // answer for somebody whose session simply expired.
    const response = await get(`/g/${MISSING_GAME_ID}`);

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/sign-in");
  });
});

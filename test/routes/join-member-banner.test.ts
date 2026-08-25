import { SELF } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { games } from "../../src/db/schema.js";
import { insertGame, insertMembership, insertPlayer, resetDatabase, testDb } from "../support/factories.js";
import { ALLOWED, ORIGIN, signIn } from "../support/sign-in.js";

/**
 * `GET /j/:token` recognising a signed-in member (M38).
 *
 * The invite link is the one link an organiser can safely post anywhere, so
 * it has to do something sensible for the people who are *already* in the
 * squad and click it anyway. It now greets them and points at the game.
 *
 * Two properties are load-bearing and both are pinned below. It must not
 * become a **redirect** — an organiser previewing their own invite link, or
 * scanning their own QR code off `/g/:id`, is signed in and is a member, and
 * a redirect would make their own invite page unreachable without a private
 * window. And it must change **nothing** for anyone who is not a member, so
 * that the page a stranger receives is what it always was.
 */
async function getJoin(token: string, cookie?: string) {
  return SELF.fetch(`${ORIGIN}/j/${token}`, {
    headers: cookie === undefined ? {} : { cookie },
    redirect: "manual",
  });
}

async function seedGame() {
  const db = testDb();
  const gameId = await insertGame(db, { name: "Wednesday Night Football" });
  const [game] = await db.select().from(games).where(eq(games.id, gameId));
  return { db, game: game! };
}

describe("the invite page for a signed-in member", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("greets a member by the address they are signed in as, and points at the game", async () => {
    const { db, game } = await seedGame();
    const playerId = await insertPlayer(db, { email: ALLOWED, name: "Andy" });
    await insertMembership(db, game.id, playerId, { role: "player" });
    const { cookie } = await signIn();

    const response = await getJoin(game.inviteToken, cookie);
    const body = await response.text();

    // Not a redirect: see this file's header.
    expect(response.status).toBe(200);
    expect(body).toContain("already in this squad");
    // The address is the point — being signed in under a second address is the
    // likeliest reason a squad link misbehaves (`src/auth/session.ts`).
    expect(body).toContain(ALLOWED);
    expect(body).toContain(`/g/${game.id}`);
  });

  it("still shows the member the invite page itself, so an organiser can preview their own link", async () => {
    const { db, game } = await seedGame();
    const playerId = await insertPlayer(db, { email: ALLOWED, name: "Owner" });
    await insertMembership(db, game.id, playerId, { role: "owner" });
    const { cookie } = await signIn();

    const body = await (await getJoin(game.inviteToken, cookie)).text();

    // The join form is what makes it a preview rather than a dead end.
    expect(body).toContain(`action="/j/${game.inviteToken}"`);
  });

  it("is byte-identical to the signed-out page for a signed-in non-member", async () => {
    const { db, game } = await seedGame();
    const otherGame = await insertGame(db, { name: "A different squad" });
    const playerId = await insertPlayer(db, { email: ALLOWED, name: "Somebody else" });
    await insertMembership(db, otherGame, playerId, { role: "player" });
    const { cookie } = await signIn();

    const signedOut = await (await getJoin(game.inviteToken)).text();
    const nonMember = await (await getJoin(game.inviteToken, cookie)).text();

    expect(nonMember).toBe(signedOut);
    expect(nonMember).not.toContain("already in this squad");
  });

  it("shows no banner to a visitor with no session at all", async () => {
    const { game } = await seedGame();

    const body = await (await getJoin(game.inviteToken)).text();

    expect(body).not.toContain("already in this squad");
  });
});

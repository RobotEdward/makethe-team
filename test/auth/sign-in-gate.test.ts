import { beforeEach, describe, expect, it } from "vitest";
import { isSignInPermitted } from "../../src/auth/sign-in-gate.js";
import { signupAllowlist } from "../../src/db/schema.js";
import {
  insertGame,
  insertMembership,
  insertPlayer,
  resetDatabase,
  testDb,
} from "../support/factories.js";

const SECRET = "operator@example.com";

/**
 * The union behaviour of the widened gate (M16). `isSignInAllowlisted`'s own
 * degenerate cases stay pinned in `magic-link.test.ts`; this suite covers the
 * two doors that did not exist before — the table and standing invitees — and
 * the seams between all three.
 */
describe("isSignInPermitted", () => {
  const db = testDb();

  beforeEach(async () => {
    await resetDatabase();
  });

  it("admits an address from the secret with no database rows at all", async () => {
    expect(await isSignInPermitted(db, SECRET, "operator@example.com")).toBe(true);
  });

  it("admits an address from the signup_allowlist table", async () => {
    await db.insert(signupAllowlist).values({ email: "friend@example.com" });
    expect(await isSignInPermitted(db, SECRET, "friend@example.com")).toBe(true);
    expect(await isSignInPermitted(db, undefined, "friend@example.com")).toBe(true);
  });

  it("folds ASCII case against the table, which stores folded addresses", async () => {
    await db.insert(signupAllowlist).values({ email: "friend@example.com" });
    expect(await isSignInPermitted(db, undefined, "Friend@Example.COM")).toBe(true);
  });

  it("admits an invited player holding an active membership", async () => {
    const gameId = await insertGame(db);
    const playerId = await insertPlayer(db, { email: "invitee@example.com" });
    await insertMembership(db, gameId, playerId);
    expect(await isSignInPermitted(db, undefined, "invitee@example.com")).toBe(true);
  });

  it("refuses an invited player whose only membership is inactive", async () => {
    const gameId = await insertGame(db);
    const playerId = await insertPlayer(db, { email: "removed@example.com" });
    await insertMembership(db, gameId, playerId, { active: false });
    expect(await isSignInPermitted(db, undefined, "removed@example.com")).toBe(false);
  });

  it("refuses an unknown address even when other doors have entries", async () => {
    await db.insert(signupAllowlist).values({ email: "friend@example.com" });
    const gameId = await insertGame(db);
    const playerId = await insertPlayer(db, { email: "invitee@example.com" });
    await insertMembership(db, gameId, playerId);
    expect(await isSignInPermitted(db, SECRET, "stranger@example.com")).toBe(false);
  });

  it("never matches a blank address against any door", async () => {
    // A guest player's email is NULL; a blank probe must not find it — and
    // must not reach SQL at all, mirroring isSignInAllowlisted's guard.
    const gameId = await insertGame(db);
    const playerId = await insertPlayer(db, { email: null, isGuest: true });
    await insertMembership(db, gameId, playerId);
    expect(await isSignInPermitted(db, SECRET, "")).toBe(false);
    expect(await isSignInPermitted(db, SECRET, "   ")).toBe(false);
  });
});

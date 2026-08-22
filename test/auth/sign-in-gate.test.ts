import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  explainSignIn,
  isSignInPermitted,
  recordSignInRefusal,
  REFUSAL_ROWS_KEPT,
} from "../../src/auth/sign-in-gate.js";
import { signinRefusals, signupAllowlist } from "../../src/db/schema.js";
import { setOpenSignups } from "../../src/domain/app-settings.js";
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

  it("permits a stranger while open sign ups is on", async () => {
    await setOpenSignups(db, true);
    expect(await isSignInPermitted(db, undefined, "stranger@example.com")).toBe(true);
  });

  it("refuses that same stranger again once open sign ups is turned back off", async () => {
    await setOpenSignups(db, true);
    await setOpenSignups(db, false);
    expect(await isSignInPermitted(db, SECRET, "stranger@example.com")).toBe(false);
  });

  it("still refuses a blank address while open sign ups is on", async () => {
    await setOpenSignups(db, true);
    expect(await isSignInPermitted(db, SECRET, "")).toBe(false);
    expect(await isSignInPermitted(db, SECRET, "   ")).toBe(false);
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

/**
 * The doctor's view of the gate (M17). Its contract with `isSignInPermitted`
 * — same door checks, no short-circuit — is what the per-door assertions pin.
 */
describe("explainSignIn", () => {
  const db = testDb();

  beforeEach(async () => {
    await resetDatabase();
  });

  it("answers every door even after an earlier one is already open", async () => {
    // The gate would stop at the secret; the doctor must keep going, or an
    // operator reading "table: closed" for a table-listed address would
    // "fix" a problem that does not exist.
    await db.insert(signupAllowlist).values({ email: "operator@example.com" });
    expect(await explainSignIn(db, SECRET, "operator@example.com")).toEqual({
      open: false,
      secret: true,
      table: true,
      member: false,
    });
  });

  it("reports all doors closed for a stranger and for a blank address", async () => {
    const shut = { open: false, secret: false, table: false, member: false };
    expect(await explainSignIn(db, SECRET, "stranger@example.com")).toEqual(shut);
    expect(await explainSignIn(db, SECRET, "   ")).toEqual(shut);
  });

  it("agrees with isSignInPermitted on the membership door", async () => {
    const gameId = await insertGame(db);
    const playerId = await insertPlayer(db, { email: "invitee@example.com" });
    await insertMembership(db, gameId, playerId);
    expect(await explainSignIn(db, undefined, "invitee@example.com")).toEqual({
      open: false,
      secret: false,
      table: false,
      member: true,
    });
  });

  it("reports the open door, and still answers the others behind it", async () => {
    // The doctor must not stop at the open door either: an operator about to
    // close open sign ups needs to see which addresses keep a way in.
    await setOpenSignups(db, true);
    await db.insert(signupAllowlist).values({ email: "friend@example.com" });
    expect(await explainSignIn(db, undefined, "friend@example.com")).toEqual({
      open: true,
      secret: false,
      table: true,
      member: false,
    });
  });

  /**
   * The doctor page recomputes "permitted" as the union of the doors it is
   * given (`admin-signin-doctor.ts`). If a door existed in the gate and not in
   * this shape, the doctor would call an address refused that the real gate
   * lets straight through.
   */
  it("agrees with isSignInPermitted that an open door alone permits a stranger", async () => {
    await setOpenSignups(db, true);
    const doors = await explainSignIn(db, undefined, "stranger@example.com");
    expect(doors).toEqual({ open: true, secret: false, table: false, member: false });
    expect(doors.open || doors.secret || doors.table || doors.member).toBe(
      await isSignInPermitted(db, undefined, "stranger@example.com"),
    );
  });
});

describe("recordSignInRefusal", () => {
  const db = testDb();

  beforeEach(async () => {
    await resetDatabase();
  });

  it("stores the address folded, stamped with the given clock", async () => {
    const now = new Date("2026-08-19T10:00:00Z");
    await recordSignInRefusal(db, "  Stranger@Example.COM ", now);
    const rows = await db.select().from(signinRefusals);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.email).toBe("stranger@example.com");
    expect(rows[0]!.createdAt).toEqual(now);
  });

  it("prunes to the newest REFUSAL_ROWS_KEPT rows", async () => {
    const start = Date.parse("2026-08-19T10:00:00Z");
    for (let i = 0; i < REFUSAL_ROWS_KEPT + 5; i++) {
      await recordSignInRefusal(db, `s${i}@example.com`, new Date(start + i * 1000));
    }
    const rows = await db.select().from(signinRefusals);
    expect(rows).toHaveLength(REFUSAL_ROWS_KEPT);
    // The five oldest are the ones that went.
    const kept = new Set(rows.map((r) => r.email));
    for (let i = 0; i < 5; i++) expect(kept.has(`s${i}@example.com`)).toBe(false);
    expect(kept.has(`s${REFUSAL_ROWS_KEPT + 4}@example.com`)).toBe(true);
  });

  it("swallows a database failure instead of throwing", async () => {
    // The refused branch of sendMagicLink must stay indistinguishable from
    // the permitted one; a throw here would 500 only refused addresses.
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const broken = {
        insert: () => {
          throw new Error("D1 is on fire");
        },
      } as unknown as Parameters<typeof recordSignInRefusal>[0];
      await expect(
        recordSignInRefusal(broken, "stranger@example.com", new Date("2026-08-19T10:00:00Z")),
      ).resolves.toBeUndefined();
      expect(spy).toHaveBeenCalledTimes(1);
      // The log line must carry the reason and never the address.
      expect(String(spy.mock.calls[0]?.[0])).not.toContain("stranger");
    } finally {
      spy.mockRestore();
    }
  });
});

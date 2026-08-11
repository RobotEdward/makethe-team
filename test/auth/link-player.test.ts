import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { linkPlayerOnSignIn, type LinkPlayerResult } from "../../src/auth/link-player.js";
import { getDb } from "../../src/db/client.js";
import { players } from "../../src/db/schema.js";
import { resetDatabase } from "../support/factories.js";

const db = getDb(env.DB);
const now = new Date("2026-08-13T18:00:00Z");

beforeEach(async () => {
  await resetDatabase();
});

/** Narrow to an outcome that carries a single `playerId`, or fail the test. */
function createdPlayerId(result: LinkPlayerResult): string {
  if (result.outcome !== "created") throw new Error(`expected "created", got "${result.outcome}"`);
  return result.playerId;
}

async function playerRow(id: string) {
  const [row] = await db.select().from(players).where(eq(players.id, id));
  return row;
}

describe("linkPlayerOnSignIn", () => {
  it("links an existing Player matched by verified email", async () => {
    const playerId = crypto.randomUUID();
    await db.insert(players).values({ id: playerId, name: "Ada Lovelace", email: "ada@example.com" });

    const result = await linkPlayerOnSignIn(db, {
      authUserId: "auth-1",
      verifiedEmail: "ada@example.com",
      name: "Ada L",
      now,
    });

    expect(result).toEqual({ outcome: "linked", playerId });
    const row = await playerRow(playerId);
    expect(row?.authUserId).toBe("auth-1");
    // The domain name is the squad's name for them; a provider profile name
    // never overwrites it.
    expect(row?.name).toBe("Ada Lovelace");
  });

  it("records the provider's verification in email_verified_at when the domain had none", async () => {
    const playerId = crypto.randomUUID();
    await db.insert(players).values({ id: playerId, name: "Ada", email: "ada@example.com" });

    await linkPlayerOnSignIn(db, {
      authUserId: "auth-1",
      verifiedEmail: "ada@example.com",
      name: "Ada",
      now,
    });

    expect((await playerRow(playerId))?.emailVerifiedAt).toEqual(now);
  });

  it("keeps an earlier email_verified_at rather than moving it forward", async () => {
    const playerId = crypto.randomUUID();
    const earlier = new Date("2026-01-01T00:00:00Z");
    await db
      .insert(players)
      .values({ id: playerId, name: "Ada", email: "ada@example.com", emailVerifiedAt: earlier });

    await linkPlayerOnSignIn(db, {
      authUserId: "auth-1",
      verifiedEmail: "ada@example.com",
      name: "Ada",
      now,
    });

    expect((await playerRow(playerId))?.emailVerifiedAt).toEqual(earlier);
  });

  it("is idempotent when the same identity signs in again", async () => {
    const playerId = crypto.randomUUID();
    await db.insert(players).values({ id: playerId, name: "Ada", email: "ada@example.com" });

    const first = await linkPlayerOnSignIn(db, {
      authUserId: "auth-1",
      verifiedEmail: "ada@example.com",
      name: "Ada",
      now,
    });
    const second = await linkPlayerOnSignIn(db, {
      authUserId: "auth-1",
      verifiedEmail: "ada@example.com",
      name: "Ada",
      now: new Date("2026-08-14T18:00:00Z"),
    });

    expect(first).toEqual({ outcome: "linked", playerId });
    expect(second).toEqual({ outcome: "already-linked", playerId });
    const rows = await db.select().from(players);
    expect(rows).toHaveLength(1);
  });

  it("finds the already-linked Player by auth_user_id even when the provider address has changed", async () => {
    const playerId = crypto.randomUUID();
    await db
      .insert(players)
      .values({ id: playerId, name: "Ada", email: "ada@example.com", authUserId: "auth-1" });

    const result = await linkPlayerOnSignIn(db, {
      authUserId: "auth-1",
      verifiedEmail: "ada+new@example.com",
      name: "Ada",
      now,
    });

    expect(result).toEqual({ outcome: "already-linked", playerId });
    expect(await db.select().from(players)).toHaveLength(1);
    // The address on file is domain data, not the provider's to rewrite.
    expect((await playerRow(playerId))?.email).toBe("ada@example.com");
  });

  it("refuses to overwrite a different auth_user_id and writes nothing", async () => {
    const playerId = crypto.randomUUID();
    await db
      .insert(players)
      .values({ id: playerId, name: "Ada", email: "ada@example.com", authUserId: "auth-1" });

    const result = await linkPlayerOnSignIn(db, {
      authUserId: "auth-2",
      verifiedEmail: "ada@example.com",
      name: "Ada",
      now,
    });

    expect(result).toEqual({
      outcome: "conflict",
      playerId,
      existingAuthUserId: "auth-1",
    });
    expect((await playerRow(playerId))?.authUserId).toBe("auth-1");
    // No duplicate Player was created as a consolation prize either.
    expect(await db.select().from(players)).toHaveLength(1);
  });

  it("creates a Player when no row matches", async () => {
    // A guest in the table alongside: BR-32 guests have no address, so they
    // are simply not in the running.
    await db.insert(players).values({ id: crypto.randomUUID(), name: "Dave from work", isGuest: true });

    const result = await linkPlayerOnSignIn(db, {
      authUserId: "auth-1",
      verifiedEmail: "New.Person@example.com",
      name: "New Person",
      now,
    });

    const rows = await db.select().from(players);
    const created = await playerRow(createdPlayerId(result));
    expect(created).toMatchObject({
      name: "New Person",
      email: "new.person@example.com",
      isGuest: false,
      authUserId: "auth-1",
      emailVerifiedAt: now,
      createdAt: now,
    });
    expect(rows).toHaveLength(2);
  });

  it("never links a guest, even one that somehow carries the address", async () => {
    // BR-32 says guests have no contact details, but the column is nullable
    // and nothing in SQL enforces the pairing. Such a row must never be
    // claimable by a sign-in.
    const guestWithEmailId = crypto.randomUUID();
    await db
      .insert(players)
      .values({ id: guestWithEmailId, name: "Guest", email: "ada@example.com", isGuest: true });

    const result = await linkPlayerOnSignIn(db, {
      authUserId: "auth-1",
      verifiedEmail: "ada@example.com",
      name: "Ada",
      now,
    });

    expect(result).toEqual({ outcome: "email-held-by-guest", playerIds: [guestWithEmailId] });
    expect((await playerRow(guestWithEmailId))?.authUserId).toBeNull();
    // Nothing written at all — not even a second Player, which would in any
    // case collide with the guest row on the unique email index.
    expect(await db.select().from(players)).toHaveLength(1);
  });

  it("matches case-insensitively and does not rewrite the stored address", async () => {
    const playerId = crypto.randomUUID();
    await db.insert(players).values({ id: playerId, name: "Ada", email: "Ada@Example.COM" });

    const result = await linkPlayerOnSignIn(db, {
      authUserId: "auth-1",
      verifiedEmail: "  ada@example.com  ",
      name: "Ada",
      now,
    });

    expect(result).toEqual({ outcome: "linked", playerId });
    expect((await playerRow(playerId))?.email).toBe("Ada@Example.COM");
    expect(await db.select().from(players)).toHaveLength(1);
  });

  it("refuses to guess when two Players differ only in the case of their address", async () => {
    // The partial unique index on players.email is case-sensitive, so both
    // rows can exist. Handing the account to whichever the query happened to
    // return first would be a coin toss over someone's squad history.
    const lowerId = crypto.randomUUID();
    const upperId = crypto.randomUUID();
    await db.insert(players).values([
      { id: lowerId, name: "Ada", email: "ada@example.com" },
      { id: upperId, name: "Ada (other)", email: "ADA@example.com" },
    ]);

    const result = await linkPlayerOnSignIn(db, {
      authUserId: "auth-1",
      verifiedEmail: "ada@example.com",
      name: "Ada",
      now,
    });

    expect(result.outcome).toBe("ambiguous-email");
    if (result.outcome !== "ambiguous-email") throw new Error("unreachable");
    expect([...result.playerIds].sort()).toEqual([lowerId, upperId].sort());
    expect((await playerRow(lowerId))?.authUserId).toBeNull();
    expect((await playerRow(upperId))?.authUserId).toBeNull();
    expect(await db.select().from(players)).toHaveLength(2);
  });

  it("never claims an existing Player when the provider has not verified an address", async () => {
    const playerId = crypto.randomUUID();
    await db.insert(players).values({ id: playerId, name: "Ada", email: "ada@example.com" });

    const result = await linkPlayerOnSignIn(db, {
      authUserId: "auth-2",
      verifiedEmail: null,
      name: "Impostor",
      now,
    });

    expect((await playerRow(playerId))?.authUserId).toBeNull();
    const created = await playerRow(createdPlayerId(result));
    expect(created).toMatchObject({
      name: "Impostor",
      email: null,
      isGuest: false,
      authUserId: "auth-2",
      emailVerifiedAt: null,
    });
  });
});

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

// ---------------------------------------------------------------------------
// Deterministic interleaving.
//
// Every concurrency claim this function makes — the compare-and-set on the
// link, `on conflict do nothing` on both creates — is about a second sign-in
// landing *between* a read and the write it decided on. workerd's test harness
// runs one request at a time and will never produce that by itself, so the
// interleaving is constructed: the D1 binding is wrapped, and a hook fires
// around the statement whose result the decision is built on, writing the
// competing row with the *unwrapped* handle. Everything else is the real
// function against the real database.
// ---------------------------------------------------------------------------

interface Interference {
  /** Fires only for statements whose SQL matches. */
  match: RegExp;
  /** Runs immediately before the matched statement executes. */
  before?: () => Promise<void>;
  /** Runs immediately after it returns, before the caller sees the rows. */
  after?: () => Promise<void>;
}

/** Wrap a callback so it fires at most once, however often it is invoked. */
function once(fn: () => Promise<void>): () => Promise<void> {
  let fired = false;
  return async () => {
    if (fired) return;
    fired = true;
    await fn();
  };
}

function interferingStatement(
  stmt: D1PreparedStatement,
  query: string,
  hooks: Interference,
): D1PreparedStatement {
  const matched = hooks.match.test(query);
  return new Proxy(stmt, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (typeof value !== "function") return value;
      const method = value as (...args: unknown[]) => unknown;
      if (prop === "bind") {
        return (...args: unknown[]) =>
          interferingStatement(method.apply(target, args) as D1PreparedStatement, query, hooks);
      }
      if (prop === "all" || prop === "run" || prop === "raw" || prop === "first") {
        return async (...args: unknown[]) => {
          if (matched) await hooks.before?.();
          const result = await (method.apply(target, args) as Promise<unknown>);
          if (matched) await hooks.after?.();
          return result;
        };
      }
      return method.bind(target);
    },
  });
}

/** A D1 binding that runs `hooks` around the statements it matches. */
function interferingBinding(binding: D1Database, hooks: Interference): D1Database {
  return new Proxy(binding, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (prop === "prepare") {
        return (query: string) =>
          interferingStatement(target.prepare(query), query, hooks);
      }
      if (typeof value !== "function") return value;
      return (value as (...args: unknown[]) => unknown).bind(target);
    },
  });
}

/** The statement whose result the email-match decision is built on. */
const EMAIL_LOOKUP = /lower\(/;
/** The statement whose result the `already-linked` decision is built on. */
const AUTH_LOOKUP = /where "players"\."auth_user_id" = \?/;

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

  it("never claims a Player whose stored address is the empty string", async () => {
    // `"   "` normalises to `""`, and `lower(email) = ''` would match this row
    // happily. Whitespace is not a verified address and must claim nothing.
    const emptyEmailId = crypto.randomUUID();
    await db.insert(players).values({ id: emptyEmailId, name: "Odd row", email: "" });

    const result = await linkPlayerOnSignIn(db, {
      authUserId: "auth-1",
      verifiedEmail: "   ",
      name: "Someone",
      now,
    });

    expect((await playerRow(emptyEmailId))?.authUserId).toBeNull();
    expect(await playerRow(createdPlayerId(result))).toMatchObject({
      email: null,
      authUserId: "auth-1",
      emailVerifiedAt: null,
    });
  });

  it("treats an untyped caller's undefined address as no address, rather than throwing", async () => {
    const playerId = crypto.randomUUID();
    await db.insert(players).values({ id: playerId, name: "Ada", email: "ada@example.com" });

    const identity = { authUserId: "auth-2", name: "Impostor", now } as unknown as Parameters<
      typeof linkPlayerOnSignIn
    >[1];
    const result = await linkPlayerOnSignIn(db, identity);

    expect(result.outcome).toBe("created");
    expect((await playerRow(playerId))?.authUserId).toBeNull();
  });

  describe("case folding matches SQLite's, not JavaScript's", () => {
    // `lower()` in SQLite (D1 is built without ICU) folds A-Z and nothing
    // else; `String.prototype.toLowerCase()` folds all of Unicode. When the
    // two sides disagreed, an address containing U+212A KELVIN SIGN folded
    // onto an ASCII `k` in JavaScript only — and claimed a Player it did not
    // own. The fold is now ASCII-only on both sides.

    it("does not let a U+212A KELVIN SIGN address claim an ASCII Player", async () => {
      const playerId = crypto.randomUUID();
      await db.insert(players).values({ id: playerId, name: "Kim", email: "k@example.com" });

      const result = await linkPlayerOnSignIn(db, {
        authUserId: "attacker",
        verifiedEmail: "K@example.com",
        name: "Not Kim",
        now,
      });

      expect(result.outcome).toBe("created");
      expect((await playerRow(playerId))?.authUserId).toBeNull();
      expect((await playerRow(playerId))?.emailVerifiedAt).toBeNull();
      expect(await db.select().from(players)).toHaveLength(2);
    });

    it.each([
      ["U+0130 dotted capital I", "İ@example.com", "i@example.com"],
      ["U+017F long s", "ſ@example.com", "s@example.com"],
      ["U+FB00 ff ligature", "ﬀ@example.com", "ff@example.com"],
      ["U+FF2B full-width K", "Ｋ@example.com", "k@example.com"],
      ["U+212B angstrom sign", "Å@example.com", "å@example.com"],
    ])("does not let %s claim the Player at %s", async (_name, confusable, stored) => {
      const playerId = crypto.randomUUID();
      await db.insert(players).values({ id: playerId, name: "Incumbent", email: stored });

      const result = await linkPlayerOnSignIn(db, {
        authUserId: "attacker",
        verifiedEmail: confusable,
        name: "Not them",
        now,
      });

      expect(result.outcome).toBe("created");
      expect((await playerRow(playerId))?.authUserId).toBeNull();
    });

    it("links a non-ASCII address to its own row, because both sides fold it identically", async () => {
      // The other half of the old asymmetry: JS produced `äda@…` and SQL
      // produced `Äda@…`, so this address missed its *own* row and minted a
      // duplicate, orphaning the original. ASCII-only folding on both sides
      // makes the round trip work.
      const playerId = crypto.randomUUID();
      await db.insert(players).values({ id: playerId, name: "Äda", email: "ÄDA@example.com" });

      const result = await linkPlayerOnSignIn(db, {
        authUserId: "auth-1",
        verifiedEmail: "ÄDA@example.com",
        name: "Äda",
        now,
      });

      expect(result).toEqual({ outcome: "linked", playerId });
      expect(await db.select().from(players)).toHaveLength(1);
    });

    it("treats two addresses differing only in non-ASCII case as two people", async () => {
      // The documented cost of never folding more than SQLite does: a false
      // miss, which creates a duplicate row a human can merge. The safe
      // direction — the alternative is a false match, i.e. a stolen account.
      const playerId = crypto.randomUUID();
      await db.insert(players).values({ id: playerId, name: "Äda", email: "äda@example.com" });

      const result = await linkPlayerOnSignIn(db, {
        authUserId: "auth-1",
        verifiedEmail: "Äda@example.com",
        name: "Äda",
        now,
      });

      expect(result.outcome).toBe("created");
      expect((await playerRow(playerId))?.authUserId).toBeNull();
    });
  });

  describe("concurrent sign-ins", () => {
    it("refuses when another identity claims the Player between the read and the write", async () => {
      // Pins the `AND auth_user_id IS NULL` compare-and-set on its own: without
      // it this UPDATE overwrites the winner and returns `linked`, i.e. a
      // silent account transfer.
      const playerId = crypto.randomUUID();
      await db.insert(players).values({ id: playerId, name: "Ada", email: "ada@example.com" });

      const racing = getDb(
        interferingBinding(env.DB, {
          match: EMAIL_LOOKUP,
          after: once(async () => {
            await db
              .update(players)
              .set({ authUserId: "auth-winner" })
              .where(eq(players.id, playerId));
          }),
        }),
      );

      const result = await linkPlayerOnSignIn(racing, {
        authUserId: "auth-loser",
        verifiedEmail: "ada@example.com",
        name: "Ada",
        now,
      });

      expect(result).toEqual({ outcome: "conflict", playerId, existingAuthUserId: "auth-winner" });
      expect((await playerRow(playerId))?.authUserId).toBe("auth-winner");
      expect(await db.select().from(players)).toHaveLength(1);
    });

    it("reports already-linked when the sign-in that won the race was this same identity", async () => {
      // A double-submitted magic link: both halves are `auth-1`. The loser must
      // not overwrite, and must still hand the caller a usable Player.
      const playerId = crypto.randomUUID();
      await db.insert(players).values({ id: playerId, name: "Ada", email: "ada@example.com" });

      const racing = getDb(
        interferingBinding(env.DB, {
          match: EMAIL_LOOKUP,
          after: once(async () => {
            await db
              .update(players)
              .set({ authUserId: "auth-1", emailVerifiedAt: now })
              .where(eq(players.id, playerId));
          }),
        }),
      );

      const result = await linkPlayerOnSignIn(racing, {
        authUserId: "auth-1",
        verifiedEmail: "ada@example.com",
        name: "Ada",
        now,
      });

      expect(result).toEqual({ outcome: "already-linked", playerId });
      expect(await db.select().from(players)).toHaveLength(1);
    });

    it("does not surface a raw constraint error when another sign-in creates the same address first", async () => {
      const rivalId = crypto.randomUUID();

      const racing = getDb(
        interferingBinding(env.DB, {
          match: EMAIL_LOOKUP,
          after: once(async () => {
            await db.insert(players).values({
              id: rivalId,
              name: "Ada",
              email: "ada@example.com",
              authUserId: "auth-winner",
            });
          }),
        }),
      );

      const result = await linkPlayerOnSignIn(racing, {
        authUserId: "auth-loser",
        verifiedEmail: "ada@example.com",
        name: "Ada",
        now,
      });

      expect(result).toEqual({
        outcome: "conflict",
        playerId: rivalId,
        existingAuthUserId: "auth-winner",
      });
      expect(await db.select().from(players)).toHaveLength(1);
    });

    it("mints only one Player when one identity with no verified address signs in twice at once", async () => {
      // Nothing but `players_auth_user_id_unique` (migration 0005) can stop
      // this: there is no address to collide on, and D1 has no transactions.
      const rivalId = crypto.randomUUID();

      const racing = getDb(
        interferingBinding(env.DB, {
          match: AUTH_LOOKUP,
          after: once(async () => {
            await db
              .insert(players)
              .values({ id: rivalId, name: "Ada", email: null, authUserId: "auth-1" });
          }),
        }),
      );

      const result = await linkPlayerOnSignIn(racing, {
        authUserId: "auth-1",
        verifiedEmail: null,
        name: "Ada",
        now,
      });

      expect(result).toEqual({ outcome: "already-linked", playerId: rivalId });
      expect(await db.select().from(players)).toHaveLength(1);
    });

    it("gives up with create-raced rather than spinning when every attempt loses", async () => {
      // Pathological: the competing row is removed before each read and put
      // back before each write, so no attempt can ever see what beat it.
      const rivalId = crypto.randomUUID();
      const racing = getDb(
        interferingBinding(env.DB, {
          match: EMAIL_LOOKUP,
          before: async () => {
            await db.delete(players).where(eq(players.id, rivalId));
          },
          after: async () => {
            await db
              .insert(players)
              .values({ id: rivalId, name: "Rival", email: "ada@example.com" });
          },
        }),
      );

      const result = await linkPlayerOnSignIn(racing, {
        authUserId: "auth-1",
        verifiedEmail: "ada@example.com",
        name: "Ada",
        now,
      });

      expect(result).toEqual({ outcome: "create-raced" });
      // Nothing of ours was written: only the interference's own row is there.
      const rows = await db.select().from(players);
      expect(rows.map((row) => row.id)).toEqual([rivalId]);
    });
  });
});

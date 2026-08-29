import { SELF, env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../src/db/client.js";
import { auditLog, fixtures, memberships, notificationLog, players, responses } from "../../src/db/schema.js";
import type { Lifecycle } from "../../src/domain/lifecycle.js";
import type { ResponseStatus } from "../../src/domain/response-status.js";
import { signCancelToken, signResponseToken } from "../../src/domain/token.js";
import {
  fillEmailQuota, insertGame, resetDatabase } from "../support/factories.js";
import { kickoffIn } from "../support/clock.js";
import { toLocalParts, toUtc } from "../../src/domain/time/zone.js";
import { renderCancelConfirmPage, type CancelConfirmPageOptions } from "../../src/views/cancel.js";
import { SERVICE_WORKER_JS } from "../../src/views/scripts.js";

const db = getDb(env.DB);
const CANCEL_SECRET = env.CANCEL_TOKEN_SECRET;
const RESPONSE_SECRET = env.RESPONSE_TOKEN_SECRET;

/**
 * `KICKOFF` is derived from `test/support/clock.ts`, not minted as an offset
 * of the moment a token happens to be signed here: `Date.now()` is frozen
 * between I/O inside workerd while the test isolate's own clock keeps moving,
 * so an expiry computed as "now + 1ms" at mint time is a coin flip against the
 * route's own read of the clock. `EXPIRED` is a fixed instant in the past —
 * the one hardcoded date that is safe, because the past cannot un-expire.
 *
 * The "shows what cancelling will do" test below asserts on the literal
 * rendered local time, "19:00". Pinning that by fixing the *UTC* hour (e.g.
 * 18:00 UTC) is wrong: Europe/London is only UTC+1 during BST (late March to
 * late October), so the same 18:00 UTC instant renders as "18:00" for the
 * other five months of the year, and `kickoffIn`'s floating date will land in
 * that window roughly half the year. Instead, take the calendar day
 * `kickoffIn` lands on and ask `toUtc` (`src/domain/time/zone.ts`) for the
 * instant that is genuinely 19:00 in `Europe/London` on that day — correct in
 * both GMT and BST, whatever day the suite happens to run.
 */
const KICKOFF = toUtc(
  { ...toLocalParts(kickoffIn(24 * 7), "Europe/London"), hour: 19, minute: 0, second: 0 },
  "Europe/London",
);
const EXPIRED = new Date("2000-01-01T00:00:00Z");

const OWNER = "owner-1";

interface Member {
  id: string;
  role?: "player" | "owner";
  active?: boolean;
  isGuest?: boolean;
  /** Omit for a player with no address at all (a non-guest anomaly). */
  email?: string | null;
  /** Omit for no response row at all. */
  status?: ResponseStatus;
}

interface Seeded {
  gameId: string;
  fixtureId: string;
}

async function seed(members: readonly Member[], opts: { lifecycle?: Lifecycle } = {}): Promise<Seeded> {
  const gameId = await insertGame(db, { name: "Thursday 7-a-side", venueName: "Oxford Sports Park" });
  const fixtureId = crypto.randomUUID();
  const inCount = members.filter((m) => m.status === "in").length;
  await db.insert(fixtures).values({
    id: fixtureId,
    gameId,
    kicksOffAt: KICKOFF,
    lifecycle: opts.lifecycle ?? "open",
    inCount,
    minPlayers: 10,
    maxPlayers: 14,
    prefersEvenNumbers: true,
    shortWarningOffsetHours: 12,
    durationMinutes: 60,
  });

  for (const member of members) {
    const isGuest = member.isGuest ?? false;
    const email = member.email === undefined ? (isGuest ? null : `${member.id}@example.com`) : member.email;
    await db.insert(players).values({ id: member.id, name: `Name ${member.id}`, email, isGuest });
    await db.insert(memberships).values({
      id: `m-${member.id}`,
      gameId,
      playerId: member.id,
      role: member.role ?? "player",
      active: member.active ?? true,
    });
    if (member.status) {
      await db.insert(responses).values({
        id: `r-${member.id}`,
        fixtureId,
        playerId: member.id,
        status: member.status,
        waitlistPosition: member.status === "waitlisted" ? 1 : null,
        source: "web",
      });
    }
  }

  return { gameId, fixtureId };
}

/** One active owner, two `in` players, one waitlisted, one `out`, one guest who is in. */
async function seedSquad(opts: { lifecycle?: Lifecycle } = {}): Promise<Seeded> {
  return seed(
    [
      { id: OWNER, role: "owner", status: "in" },
      { id: "p-in", status: "in" },
      { id: "p-wait", status: "waitlisted" },
      { id: "p-out", status: "out" },
      { id: "p-pending", status: "pending" },
      { id: "p-guest", isGuest: true, status: "in" },
    ],
    opts,
  );
}

async function cancelToken(fixtureId: string, ownerPlayerId = OWNER, expiresAt = KICKOFF.getTime()) {
  return signCancelToken({ ownerPlayerId, fixtureId, expiresAt }, CANCEL_SECRET);
}

async function getCancel(token: string) {
  return SELF.fetch(`https://makethe.team/cancel/${token}`);
}

async function postCancel(token: string, reason?: string) {
  const params = new URLSearchParams();
  if (reason !== undefined) params.set("reason", reason);
  return SELF.fetch(`https://makethe.team/cancel/${token}`, { method: "POST", body: params });
}

/**
 * Flips one bit in the first byte of a base64url signature, producing a
 * genuinely different — and still canonical — value. Copied in spirit from
 * `respond-get.test.ts`: toggling the last character can be a no-op, because
 * the final base64 character of a 32-byte HMAC carries discarded padding bits.
 */
function tamperSignature(signature: string): string {
  const padded = signature.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (signature.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  bytes[0] = (bytes[0] ?? 0) ^ 0x01;
  let flipped = "";
  for (const b of bytes) flipped += String.fromCharCode(b);
  return btoa(flipped).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Sign an arbitrary payload object the way `src/domain/token.ts` does, so a
 * test can present a body no minting function in the codebase will produce.
 */
async function handCraftedToken(payload: object, secret: string): Promise<string> {
  const body = base64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return `${body}.${base64Url(signature)}`;
}

/**
 * Everything this endpoint could conceivably write, in one comparable value:
 * the fixture row itself, every response row, every audit row and every
 * notification row. A `GET` must leave this byte-identical (the whole point
 * of the prefetcher test), and a rejected token must leave it byte-identical
 * on either verb.
 */
async function snapshotEverything() {
  return {
    fixtures: await db.select().from(fixtures),
    responses: await db.select().from(responses),
    audit: await db.select().from(auditLog),
    notifications: await db.select().from(notificationLog),
  };
}

async function lifecycleOf(fixtureId: string): Promise<Lifecycle | undefined> {
  const [row] = await db.select().from(fixtures).where(eq(fixtures.id, fixtureId));
  return row?.lifecycle;
}

async function n3Rows(fixtureId: string) {
  const rows = await db.select().from(notificationLog).where(eq(notificationLog.fixtureId, fixtureId));
  return rows.filter((row) => row.notificationType === "n3");
}

/** The body of the shared "this link isn't working" page, fetched from the response route. */
async function sharedFailurePage(): Promise<string> {
  return (await SELF.fetch("https://makethe.team/r/not-a-real-token")).text();
}

beforeEach(async () => {
  await resetDatabase();
});

describe("GET /cancel/:token", () => {
  it("shows what cancelling will do before it happens", async () => {
    const { fixtureId } = await seedSquad();
    const response = await getCancel(await cancelToken(fixtureId));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(body).toContain("Thursday 7-a-side");
    expect(body).toContain("Oxford Sports Park");
    // Formatted through src/domain/time/zone.ts in the game's timezone
    // (Europe/London). KICKOFF above is built to be genuinely 19:00 local on
    // whatever day it lands, in both GMT and BST.
    expect(body).toContain("19:00");
    // 3 players are `in` (owner, p-in, p-guest); 3 will be emailed (owner,
    // p-in, p-wait — the guest is excluded by BR-32, `out`/`pending` by BR-20).
    expect(body).toMatch(/3 players are in/i);
    expect(body).toMatch(/3 people will be emailed/i);
  });

  it("styles the irreversible action as dangerous, never as primary", async () => {
    const { fixtureId } = await seedSquad();
    const body = await getCancel(await cancelToken(fixtureId)).then((r) => r.text());

    expect(body).toContain(`class="button danger"`);
    expect(body).not.toContain(`class="button primary"`);
    // The cancel button's colour comes from the shared `.button.danger` rule
    // now, not a page-local override to `--warn` (amber) — cancelling a game
    // is destructive, not a correctable form error.
    expect(body).not.toMatch(/\.cancel-form \.button\.danger \{[^}]*--warn/);
    expect(body).toMatch(/\.cancel-heading\s*\{[^}]*--danger/);
  });

  it("offers exactly one form, one submit and a reason field, with no JavaScript", async () => {
    const { fixtureId } = await seedSquad();
    const token = await cancelToken(fixtureId);
    const body = await getCancel(token).then((r) => r.text());

    // Every page carries the site-wide service worker registration (M13
    // Task 5); stripped first so this keeps proving nothing *else* needs
    // script.
    expect(body).toContain(`<script>${SERVICE_WORKER_JS}</script>`);
    expect(body.replace(`<script>${SERVICE_WORKER_JS}</script>`, "")).not.toContain("<script");
    expect(body.match(/<form/g)).toHaveLength(1);
    expect(body).toContain(`action="/cancel/${token}"`);
    expect(body).toContain('method="post"');
    expect(body).toContain('name="reason"');
    expect(body.match(/type="submit"/g)).toHaveLength(1);
  });

  it("shows the live in-count from responses, not a stale denormalised counter", async () => {
    const { fixtureId } = await seedSquad();
    // Force `fixtures.inCount` to disagree with the actual `responses` rows
    // (3 are genuinely `in`: owner, p-in, p-guest) the way a missed or racing
    // write to the denormalised counter could in production. The page's
    // whole purpose is telling the owner what is about to happen before it
    // happens, so it must read the same table it counts recipients from, not
    // this counter.
    await db.update(fixtures).set({ inCount: 99 }).where(eq(fixtures.id, fixtureId));

    const body = await getCancel(await cancelToken(fixtureId)).then((r) => r.text());

    expect(body).not.toMatch(/99 players/i);
    expect(body).toMatch(/3 players are in/i);
  });

  it("records nothing at all — a prefetcher leaves no trace", async () => {
    const { fixtureId } = await seedSquad();
    const token = await cancelToken(fixtureId);

    const before = await snapshotEverything();
    await getCancel(token);
    await getCancel(token);
    expect(await snapshotEverything()).toEqual(before);
  });

  it("says a cancelled fixture is already cancelled, and offers no form", async () => {
    const { fixtureId } = await seedSquad({ lifecycle: "cancelled" });
    const body = await getCancel(await cancelToken(fixtureId)).then((r) => r.text());

    expect(body).toMatch(/already cancelled/i);
    expect(body).not.toContain("<form");
  });

  it("refuses to offer cancellation for a fixture that has been played", async () => {
    const { fixtureId } = await seedSquad({ lifecycle: "played" });
    const body = await getCancel(await cancelToken(fixtureId)).then((r) => r.text());

    expect(body).toMatch(/already been played/i);
    expect(body).not.toContain("<form");
  });
});

describe("a token that will not do", () => {
  /**
   * Every way a request to `/cancel/` can fail to be a usable cancellation,
   * each of which must produce the *same* page. Anything that varies between
   * these is an oracle telling a prober which guess was closer.
   */
  async function badTokens(fixtureId: string): Promise<Record<string, string>> {
    const good = await cancelToken(fixtureId);
    const [body, signature] = good.split(".");
    return {
      // The single most important one: a response token replayed at /cancel/.
      // Two independent things refuse it — the secrets differ, and the `kind`
      // baked into the signed payload says "response" — so the case below
      // exists as well, to pin each of them on its own.
      "a response token": await signResponseToken(
        { playerId: OWNER, fixtureId, expiresAt: KICKOFF.getTime() },
        RESPONSE_SECRET,
      ),
      // A response token whose *signature* is valid for this endpoint's
      // secret. Nothing mints this in production; it is the shape a
      // shared-secret world would hand an attacker for free. Rejected on its
      // payload shape (no `ownerPlayerId`) rather than on the discriminator.
      "a response token signed with the cancel secret": await signResponseToken(
        { playerId: OWNER, fixtureId, expiresAt: KICKOFF.getTime() },
        CANCEL_SECRET,
      ),
      // The one case only the discriminator can refuse: a correctly signed
      // body that satisfies *both* payload shapes, marked `kind: "response"`.
      // Neither the key separation nor `isCancelPayload` has anything to say
      // about it — delete the `kind` check in `verifyToken` and this token
      // cancels a game. Hand-built rather than minted through
      // `signResponseToken`, because no minting function will produce a
      // payload carrying both shapes (that is the point of the
      // discriminator-override fix in `src/domain/token.ts`).
      "a dual-shape body marked as a response, signed with the cancel secret": await handCraftedToken(
        { kind: "response", playerId: OWNER, ownerPlayerId: OWNER, fixtureId, expiresAt: KICKOFF.getTime() },
        CANCEL_SECRET,
      ),
      expired: await cancelToken(fixtureId, OWNER, EXPIRED.getTime()),
      tampered: `${body}.${tamperSignature(signature ?? "")}`,
      malformed: "not-a-token",
      empty: "%20",
      "signed with the response secret": await signCancelToken(
        { ownerPlayerId: OWNER, fixtureId, expiresAt: KICKOFF.getTime() },
        RESPONSE_SECRET,
      ),
      "a plain member, never an owner": await cancelToken(fixtureId, "p-in"),
      "an owner whose membership was deactivated": await cancelToken(fixtureId, "ex-owner"),
      "a stranger with no membership at all": await cancelToken(fixtureId, "nobody"),
      "a fixture that does not exist": await cancelToken(crypto.randomUUID()),
    };
  }

  async function seedForBadTokens(): Promise<Seeded> {
    return seed([
      { id: OWNER, role: "owner", status: "in" },
      { id: "p-in", status: "in" },
      { id: "ex-owner", role: "owner", active: false },
    ]);
  }

  it("renders the same shared failure page for every one of them, on GET and POST", async () => {
    const { fixtureId } = await seedForBadTokens();
    const shared = await sharedFailurePage();
    const tokens = await badTokens(fixtureId);

    for (const [label, token] of Object.entries(tokens)) {
      const get = await getCancel(token);
      expect(get.status, `GET status with ${label}`).toBe(200);
      expect(await get.text(), `GET with ${label}`).toBe(shared);

      const post = await postCancel(token, "Pitch flooded");
      expect(await post.text(), `POST with ${label}`).toBe(shared);
    }
  });

  it("cancels nothing and records nothing for any of them", async () => {
    const { fixtureId } = await seedForBadTokens();
    const tokens = await badTokens(fixtureId);
    const before = await snapshotEverything();

    for (const token of Object.values(tokens)) {
      await getCancel(token);
      await postCancel(token, "Pitch flooded");
    }

    expect(await snapshotEverything()).toEqual(before);
    expect(await lifecycleOf(fixtureId)).toBe("open");
  });
});

describe("POST /cancel/:token", () => {
  it("cancels the fixture, records it, and emails everyone who held or wanted a slot", async () => {
    const { fixtureId } = await seedSquad();
    const response = await postCancel(await cancelToken(fixtureId), "Pitch flooded");
    const body = await response.text();

    expect(response.status).toBe(200);
    const [row] = await db.select().from(fixtures).where(eq(fixtures.id, fixtureId));
    expect(row?.lifecycle).toBe("cancelled");
    expect(row?.cancellationReason).toBe("Pitch flooded");
    expect(row?.cancelledAt).toBeInstanceOf(Date);

    const audit = await db.select().from(auditLog);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.action).toBe("fixture.cancelled");
    expect(audit[0]?.actorPlayerId).toBe(OWNER);

    const sent = await n3Rows(fixtureId);
    expect(sent.map((r) => r.playerId).sort()).toEqual([OWNER, "p-in", "p-wait"].sort());
    expect(sent.every((r) => r.status === "sent")).toBe(true);
    expect(sent.map((r) => r.dedupeKey).sort()).toEqual(
      [`n3:${fixtureId}:${OWNER}`, `n3:${fixtureId}:p-in`, `n3:${fixtureId}:p-wait`].sort(),
    );

    expect(body).toMatch(/cancelled/i);
    expect(body).toMatch(/3 players/i);
  });

  it("hands the organiser the WhatsApp message, reason included, on the cancelled page (M22)", async () => {
    const { fixtureId } = await seedSquad();
    const body = await (await postCancel(await cancelToken(fixtureId), "Pitch flooded")).text();
    expect(body).toContain('id="whatsapp"');
    expect(body).toMatch(/Thursday 7-a-side on [^<]+ is cancelled\.\nPitch flooded<\/textarea>/);
    expect(body).toContain("https://wa.me/?text=");
    expect(body).toContain('data-copy="whatsapp-cancelled"');
  });

  it("records an audit row naming everyone the daily send ceiling stopped being told (TR-31)", async () => {
    // Pre-filling today's quota to the configured ceiling makes
    // QuotaNotifier refuse every N-3 this request
    // would send. The refusal deletes each `notification_log` row so a retry
    // stays possible — but nothing retries a cancellation, the fixture is
    // terminal, and the squad would otherwise turn up to a game that is off.
    // The audit row is the only durable record that happened.
    const { fixtureId } = await seedSquad();
    await fillEmailQuota(db, new Date(Date.now()).toISOString().slice(0, 10));

    const response = await postCancel(await cancelToken(fixtureId), "Pitch flooded");
    expect(response.status).toBe(200);

    // Deleted, exactly as before — the retryability asymmetry is unchanged.
    expect(await n3Rows(fixtureId)).toHaveLength(0);

    const deferred = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "fixture.cancellation_email_deferred"));
    expect(deferred).toHaveLength(1);
    expect(deferred[0]?.entityId).toBe(fixtureId);
    expect(deferred[0]?.actorPlayerId).toBeNull();
    const after = JSON.parse(deferred[0]?.afterJson ?? "{}") as { notificationType: string; playerIds: string[] };
    expect(after.notificationType).toBe("n3");
    expect(after.playerIds.sort()).toEqual([OWNER, "p-in", "p-wait"].sort());
  });

  it("writes no deferral audit row when every cancellation email went out", async () => {
    const { fixtureId } = await seedSquad();

    await postCancel(await cancelToken(fixtureId), "Pitch flooded");

    expect(
      await db.select().from(auditLog).where(eq(auditLog.action, "fixture.cancellation_email_deferred")),
    ).toHaveLength(0);
  });

  it("accepts an empty reason and stores it verbatim", async () => {
    const { fixtureId } = await seedSquad();
    const response = await postCancel(await cancelToken(fixtureId), "");

    expect(response.status).toBe(200);
    const [row] = await db.select().from(fixtures).where(eq(fixtures.id, fixtureId));
    expect(row?.lifecycle).toBe("cancelled");
    expect(row?.cancellationReason).toBe("");
  });

  it("refuses a request with no reason field at all, cancelling nothing", async () => {
    const { fixtureId } = await seedSquad();
    const before = await snapshotEverything();

    const response = await postCancel(await cancelToken(fixtureId));

    expect(response.status).toBe(400);
    expect(await snapshotEverything()).toEqual(before);
  });

  it("refuses an over-long reason, cancelling nothing and saying so", async () => {
    const { fixtureId } = await seedSquad();
    const before = await snapshotEverything();

    const response = await postCancel(await cancelToken(fixtureId), "x".repeat(2001));
    const body = await response.text();

    expect(response.status).toBe(400);
    expect(body).toMatch(/2000/);
    expect(await snapshotEverything()).toEqual(before);
    expect(await lifecycleOf(fixtureId)).toBe("open");
  });

  it("truncates an over-long reason on a code point boundary, never a lone surrogate half", async () => {
    const { fixtureId } = await seedSquad();
    // A 1-character (2 UTF-16 code unit) emoji straddling the 2000-unit cap:
    // 1999 filler characters put the astral character's high surrogate at
    // index 1999 and its low surrogate at 2000 — exactly the boundary
    // `slice(0, 2000)` would cut through. `slice(0, 2000)` alone leaves a
    // dangling high surrogate in the JS string; by the time that string is
    // UTF-8 encoded into the HTTP response body and decoded back by `.text()`
    // here, the platform's own encoder has already turned the unpaired
    // surrogate into U+FFFD (the visible "replacement character" glyph the
    // review observed in the textarea) — so that glyph, not a raw surrogate
    // code unit, is what a fixed truncation must avoid producing.
    const reason = "x".repeat(1999) + "\u{1F600}" + "y".repeat(10);
    const response = await postCancel(await cancelToken(fixtureId), reason);
    const body = await response.text();

    expect(response.status).toBe(400);
    expect(body).not.toContain("�");
    // The textarea holds only the filler that came before the emoji — the
    // emoji itself did not fit whole, so it and everything after it was
    // dropped rather than being split.
    expect(body).toContain("x".repeat(1999));
    expect(body).not.toContain("y".repeat(10));
  });

  it("accepts a reason exactly at the cap", async () => {
    const { fixtureId } = await seedSquad();
    const reason = "y".repeat(2000);

    const response = await postCancel(await cancelToken(fixtureId), reason);

    expect(response.status).toBe(200);
    const [row] = await db.select().from(fixtures).where(eq(fixtures.id, fixtureId));
    expect(row?.cancellationReason).toBe(reason);
  });

  it("skips a non-guest with no address rather than failing the whole send", async () => {
    const { fixtureId } = await seed([
      { id: OWNER, role: "owner", status: "in" },
      { id: "p-noaddress", email: null, status: "in" },
      { id: "p-blank", email: "   ", status: "in" },
    ]);

    const response = await postCancel(await cancelToken(fixtureId), "Off");
    expect(response.status).toBe(200);

    const sent = await n3Rows(fixtureId);
    expect(sent.map((r) => r.playerId)).toEqual([OWNER]);
    expect(await lifecycleOf(fixtureId)).toBe("cancelled");
  });

  it("is idempotent: a second POST says it is already cancelled and sends nothing further", async () => {
    const { fixtureId } = await seedSquad();
    const token = await cancelToken(fixtureId);

    await postCancel(token, "Pitch flooded");
    const after = await snapshotEverything();

    const second = await postCancel(token, "Changed my mind");
    const body = await second.text();

    expect(body).toMatch(/already cancelled/i);
    expect(await snapshotEverything()).toEqual(after);
    // The first reason stands; a second POST rewrites nothing.
    const [row] = await db.select().from(fixtures).where(eq(fixtures.id, fixtureId));
    expect(row?.cancellationReason).toBe("Pitch flooded");
  });

  it("emails each player at most once per fixture, even if the fixture is cancelled twice", async () => {
    const { fixtureId } = await seedSquad();
    const token = await cancelToken(fixtureId);

    await postCancel(token, "Pitch flooded");
    const firstSend = await n3Rows(fixtureId);
    expect(firstSend).toHaveLength(3);

    // Reopen behind the route's back so `cancelFixture` runs a second time in
    // full: the lifecycle guard is out of the way, and the *only* thing left
    // standing between the squad and a duplicate N-3 is the unique index on
    // `notification_log.dedupe_key` (the key carries no timestamp).
    await db.update(fixtures).set({ lifecycle: "open", cancelledAt: null }).where(eq(fixtures.id, fixtureId));

    await postCancel(token, "Pitch flooded again");
    expect(await lifecycleOf(fixtureId)).toBe("cancelled");
    expect(await db.select().from(auditLog)).toHaveLength(2);

    const secondSend = await n3Rows(fixtureId);
    expect(secondSend).toHaveLength(3);
    expect(secondSend.map((r) => r.id).sort()).toEqual(firstSend.map((r) => r.id).sort());
  });

  it("will not cancel a fixture that has already been played", async () => {
    const { fixtureId } = await seedSquad({ lifecycle: "played" });
    const body = await postCancel(await cancelToken(fixtureId), "Too late").then((r) => r.text());

    expect(body).toMatch(/already been played/i);
    expect(await lifecycleOf(fixtureId)).toBe("played");
    expect(await n3Rows(fixtureId)).toHaveLength(0);
  });
});

/**
 * `renderCancelConfirmPage`'s copy, at the unit level — the page names the
 * date rather than the game (M10 §3.7), so one week's cancellation cannot
 * read as ending the whole thing.
 */
function preview(overrides: Partial<CancelConfirmPageOptions>): CancelConfirmPageOptions {
  return {
    gameName: "Thursday 7-a-side",
    venueName: "Oxford Sports Park",
    kicksOffAtLocal: "Sunday 16 August, 19:00",
    inCount: 10,
    recipientCount: 12,
    unreachableCount: 0,
    token: "a-token",
    gameId: "game-1",
    fixtureId: "fixture-1",
    ...overrides,
  };
}

describe("renderCancelConfirmPage copy", () => {
  it("names the date, not the game, so one week cannot read as all of them", () => {
    const html = renderCancelConfirmPage(preview({ kicksOffAtLocal: "Sunday 16 August, 19:00" }));
    expect(html).toContain("Sunday 16 August, 19:00 won't be played");
    expect(html).not.toContain("Cancel this game?");
  });

  it("puts the number of people in the button being pressed", () => {
    const html = renderCancelConfirmPage(preview({ recipientCount: 12, unreachableCount: 0 }));
    expect(html).toContain("Call it off and email 12 people");
  });

  // Restored by the whole-branch review's Important 3: 23e271d dropped this
  // link for want of a real destination, but the fixture's gameId/fixtureId
  // are available at the route (loadCancelContext reads both), so
  // CancelConfirmPageOptions now carries them and the page has a real exit.
  it("offers a way back out, to the fixture the owner would manage it from", () => {
    const html = renderCancelConfirmPage(preview({ gameId: "g-42", fixtureId: "f-99" }));
    expect(html).toContain("Keep the game on");
    expect(html).toContain('href="/g/g-42/f/f-99"');
  });

  it("names the game and the single date in the page title, not just the game", () => {
    const html = renderCancelConfirmPage(
      preview({ gameName: "Thursday 7-a-side", kicksOffAtLocal: "Sunday 16 August, 19:00" }),
    );
    expect(html).toContain("<title>Call off Thursday 7-a-side on Sunday 16 August, 19:00 — Make The Team</title>");
  });
});

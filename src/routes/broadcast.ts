import { Hono } from "hono";
import { gamePath, ownerFixturePath } from "../auth/paths.js";
import { requirePlayer } from "../auth/session.js";
import { recordAudit } from "../db/audit.js";
import { getDb } from "../db/client.js";
import {
  countBroadcastsSince,
  listFixtureRecipients,
  listGameRecipients,
  type BroadcastRecipient,
} from "../db/broadcast-queries.js";
import { findGameForOwner, getFixtureWithSquad } from "../db/queries.js";
import {
  BROADCAST_AUDIENCES,
  DEFAULT_FIXTURE_AUDIENCE,
  FIXTURE_AUDIENCES,
  audienceSelectsStatus,
  isAddressable,
  type BroadcastAudience,
} from "../domain/broadcast-audience.js";
import { parseBroadcastForm, type BroadcastFormValues } from "../domain/broadcast-form.js";
import { MAX_BROADCASTS_PER_GAME_PER_DAY, utcDayStart } from "../domain/broadcast-limit.js";
import { formatLocalDateTime } from "../domain/time/zone.js";
import type { AppEnv, Bindings } from "../env.js";
import { createNotifier } from "../notify/factory.js";
import { sendBroadcast } from "../notify/send-broadcast.js";
import { renderBroadcastPage, type BroadcastPageParams } from "../views/broadcast.js";

export const broadcast = new Hono<AppEnv>();

/** This deployment's own origin, matching the `wrongOrigin` in every other state-changing route file. */
function originOf(env: Bindings): string {
  return new URL(env.BETTER_AUTH_URL).origin;
}

/**
 * Rejects a cross-site form post. Mirrors `wrongOrigin` in `src/routes/games.ts`
 * and `src/routes/account.ts`: a browser always sends `Origin` on a
 * cross-site form submission, so a *mismatched* one is refused, and a
 * *missing* one is a non-browser client acting on its own behalf.
 */
function wrongOrigin(c: { req: { header: (name: string) => string | undefined }; env: Bindings }): boolean {
  const origin = c.req.header("origin");
  return origin !== undefined && origin !== originOf(c.env);
}

/** What the cap refusal says on the page, naming the number so raising it needs no copy change elsewhere. */
function capMessage(): string {
  return `This game has already sent ${MAX_BROADCASTS_PER_GAME_PER_DAY} messages today. Try again tomorrow.`;
}

/**
 * Every audience at zero, the shape `BroadcastPageParams.counts` requires
 * even where a scope leaves some of its keys unused — see the two builders
 * below for which keys each actually fills in.
 */
function zeroCounts(): Record<BroadcastAudience, number> {
  const counts = {} as Record<BroadcastAudience, number>;
  for (const audience of BROADCAST_AUDIENCES) counts[audience] = 0;
  return counts;
}

/**
 * The `everyone` count from one run of `listGameRecipients`, reduced through
 * `isAddressable` so the number on the page is the number a send would
 * actually reach — not a raw membership count (a guest, or a member with
 * neither an email nor a device, inflates the latter but is never sent to).
 * The four fixture-scoped keys stay zero: this page renders no radios for
 * them, so nothing reads those keys.
 */
function countsForGame(recipients: readonly BroadcastRecipient[]): Record<BroadcastAudience, number> {
  const counts = zeroCounts();
  counts.everyone = recipients.filter(isAddressable).length;
  return counts;
}

/**
 * The four fixture audiences from one run of `listFixtureRecipients`,
 * reduced the same way `countsForGame` reduces the membership list: through
 * both `audienceSelectsStatus` (which audience a row belongs to) and
 * `isAddressable` (whether that row could actually be reached) — one query,
 * one pass, four counts, rather than a query per audience. `everyone` stays
 * zero: this page never renders that radio and the button reads
 * `counts[values.audience]` on this scope, never `counts.everyone`.
 */
function countsForFixture(recipients: readonly BroadcastRecipient[]): Record<BroadcastAudience, number> {
  const counts = zeroCounts();
  for (const recipient of recipients) {
    if (!isAddressable(recipient)) continue;
    for (const audience of FIXTURE_AUDIENCES) {
      if (audienceSelectsStatus(audience, recipient.status ?? "")) counts[audience]++;
    }
  }
  return counts;
}

/** The empty form a fresh `GET` renders: no text, both channels on. */
function emptyValues(audience: BroadcastAudience): BroadcastFormValues {
  return { subject: "", message: "", email: true, push: true, audience };
}

/**
 * The game-scoped compose page (M15 spec §2): a message to everyone in the
 * squad.
 *
 * `findGameForOwner` and a 404 on `null` is the entitlement check, and the
 * whole reason this handler exists rather than reusing a member-scoped
 * lookup (TR-18) — a signed-in member of this game who is not an owner, and a
 * signed-in stranger, both get the same 404 with nothing to tell them apart.
 */
broadcast.get("/g/:id/message", requirePlayer, async (c) => {
  const db = getDb(c.env.DB);
  const game = await findGameForOwner(db, c.req.param("id"), c.get("player")!.id);
  if (game === null) return c.text("Not found", 404);

  const recipients = await listGameRecipients(db, game.id);

  return c.html(
    renderBroadcastPage({
      gameId: game.id,
      gameName: game.name,
      counts: countsForGame(recipients),
      values: emptyValues("everyone"),
    }),
  );
});

/**
 * The fixture-scoped compose page (M15 spec §2): a message to one of the
 * four response-derived audiences.
 *
 * Loads the fixture the same way `loadFixtureTarget` in `src/routes/games.ts`
 * does: `findGameForOwner` first, then the fixture, then a check that the
 * fixture actually belongs to that game. Skipping that last check would let a
 * fixture id from a different game the same owner also runs answer 200 here —
 * the game resolved, but not at this path.
 */
broadcast.get("/g/:id/f/:fixtureId/message", requirePlayer, async (c) => {
  const db = getDb(c.env.DB);
  const game = await findGameForOwner(db, c.req.param("id"), c.get("player")!.id);
  if (game === null) return c.text("Not found", 404);

  const fixtureId = c.req.param("fixtureId");
  const withSquad = await getFixtureWithSquad(db, fixtureId);
  // No such fixture, or one that belongs to a different game: `loadFixtureTarget`
  // in `src/routes/games.ts` makes the same check for the same reason
  // (TR-18) — the game already resolved above, but not necessarily *this*
  // fixture's game, and skipping this would let a fixture id from another
  // game the same owner runs answer 200 at this path.
  if (withSquad === null || withSquad.fixture.gameId !== game.id) return c.text("Not found", 404);
  const { fixture } = withSquad;

  const recipients = await listFixtureRecipients(db, fixtureId);

  return c.html(
    renderBroadcastPage({
      gameId: game.id,
      gameName: game.name,
      fixture: {
        id: fixture.id,
        whenLocal: formatLocalDateTime(fixture.kicksOffAt, game.timezone),
      },
      counts: countsForFixture(recipients),
      values: emptyValues(DEFAULT_FIXTURE_AUDIENCE),
    }),
  );
});

/**
 * Sends the broadcast in the background and logs anything that goes wrong.
 *
 * A rejected promise inside `c.executionCtx.waitUntil` resolves into nothing
 * — `games.ts`'s own `publishTeams` and `notifyRemovedPlayer` carry the same
 * `catch`, for the same reason: without it, a thrown D1 error here vanishes
 * entirely, with no line anywhere saying the send never happened.
 */
async function backgroundSend(
  env: AppEnv["Bindings"],
  params: Parameters<typeof sendBroadcast>[0],
): Promise<void> {
  try {
    await sendBroadcast(params);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`sendBroadcast: broadcast ${params.broadcastId} on game ${params.gameId} failed: ${reason}`);
  }
}

/**
 * Sending a game-scoped quick message (M15 spec §2, §7, §8, N-10).
 *
 * The audit row is written **before** `waitUntil` hands the send off, because
 * it is what `countBroadcastsSince` counts — the daily cap (BR-36). Writing
 * it after would let two concurrent submissions each read a count of zero and
 * both send, and the cap would not cap anything. `recipientCount` on that row
 * is computed here, synchronously, from the same reduction `countsForGame`
 * gives the `GET` page: the send that would tell the real count runs inside
 * `waitUntil`, after this row is already written, so there is no later count
 * to read it from. The row records who the message was *aimed at*; the
 * per-recipient truth of what actually went out lives in `notification_log`.
 *
 * `fixtureId: null` and `audience: "everyone"` are passed explicitly to
 * `sendBroadcast` even though the sender already scopes the fixture out of an
 * `everyone` send itself — belt-and-braces, so this route stays honest about
 * what it is regardless of what the sender happens to do with it.
 */
broadcast.post("/g/:id/message", requirePlayer, async (c) => {
  if (wrongOrigin(c)) return c.text("Forbidden", 403);

  const db = getDb(c.env.DB);
  const player = c.get("player")!;
  const game = await findGameForOwner(db, c.req.param("id"), player.id);
  if (game === null) return c.text("Not found", 404);

  const now = new Date(Date.now());
  const recipients = await listGameRecipients(db, game.id);
  const counts = countsForGame(recipients);

  const rerender = (values: BroadcastFormValues, extra: Partial<BroadcastPageParams>) =>
    c.html(renderBroadcastPage({ gameId: game.id, gameName: game.name, counts, values, ...extra }), 422);

  const form = await c.req.parseBody();
  const parsed = parseBroadcastForm(form, "game");
  if (!parsed.ok) return rerender(parsed.values, { errors: parsed.errors });

  const sentToday = await countBroadcastsSince(db, game.id, utcDayStart(now));
  if (sentToday >= MAX_BROADCASTS_PER_GAME_PER_DAY) {
    return rerender(parsed.values, { problem: capMessage() });
  }

  const broadcastId = crypto.randomUUID();
  const recipientCount = counts.everyone;
  const channels = { email: parsed.values.email, push: parsed.values.push };

  await recordAudit(db, {
    actorPlayerId: player.id,
    entityType: "game",
    entityId: game.id,
    action: "game.broadcast_sent",
    // Never the message body (spec §8) — see AUDIT_ACTIONS's doc comment for
    // "game.broadcast_sent".
    after: { audience: "everyone", channels, recipientCount, fixtureId: null, subject: parsed.values.subject },
    now,
  });

  c.executionCtx.waitUntil(
    backgroundSend(c.env, {
      db,
      notifier: createNotifier(c.env, db, now),
      broadcastId,
      gameId: game.id,
      fixtureId: null,
      audience: "everyone",
      subject: parsed.values.subject,
      message: parsed.values.message,
      organiserName: player.name,
      channels,
      now,
      responseTokenSecret: c.env.RESPONSE_TOKEN_SECRET,
    }),
  );

  return c.redirect(gamePath(game.id), 303);
});

/**
 * Sending a fixture-scoped quick message (M15 spec §2, §7, §8, N-10).
 *
 * Same ordering and the same reasoning as `POST /g/:id/message` above: the
 * audit row is the rate-limit counter and is written before the send is
 * handed to `waitUntil`, and `recipientCount` is read from `countsForFixture`
 * — the same reduction the `GET` page renders — rather than from the send
 * result, which does not exist yet when this row is written.
 *
 * Loads and checks the fixture the same way the `GET` handler above does
 * (TR-18): `findGameForOwner` first, then the fixture, then a check that it
 * actually belongs to this game, so a fixture id from a different game the
 * same owner runs cannot be posted to through this path.
 */
broadcast.post("/g/:id/f/:fixtureId/message", requirePlayer, async (c) => {
  if (wrongOrigin(c)) return c.text("Forbidden", 403);

  const db = getDb(c.env.DB);
  const player = c.get("player")!;
  const game = await findGameForOwner(db, c.req.param("id"), player.id);
  if (game === null) return c.text("Not found", 404);

  const fixtureId = c.req.param("fixtureId");
  const withSquad = await getFixtureWithSquad(db, fixtureId);
  if (withSquad === null || withSquad.fixture.gameId !== game.id) return c.text("Not found", 404);
  const { fixture } = withSquad;

  const now = new Date(Date.now());
  const recipients = await listFixtureRecipients(db, fixtureId);
  const counts = countsForFixture(recipients);
  const fixtureParams = { id: fixture.id, whenLocal: formatLocalDateTime(fixture.kicksOffAt, game.timezone) };

  const rerender = (values: BroadcastFormValues, extra: Partial<BroadcastPageParams>) =>
    c.html(
      renderBroadcastPage({ gameId: game.id, gameName: game.name, fixture: fixtureParams, counts, values, ...extra }),
      422,
    );

  const form = await c.req.parseBody();
  const parsed = parseBroadcastForm(form, "fixture");
  if (!parsed.ok) return rerender(parsed.values, { errors: parsed.errors });

  const sentToday = await countBroadcastsSince(db, game.id, utcDayStart(now));
  if (sentToday >= MAX_BROADCASTS_PER_GAME_PER_DAY) {
    return rerender(parsed.values, { problem: capMessage() });
  }

  const broadcastId = crypto.randomUUID();
  const recipientCount = counts[parsed.values.audience];
  const channels = { email: parsed.values.email, push: parsed.values.push };

  await recordAudit(db, {
    actorPlayerId: player.id,
    entityType: "game",
    entityId: game.id,
    action: "game.broadcast_sent",
    after: {
      audience: parsed.values.audience,
      channels,
      recipientCount,
      fixtureId: fixture.id,
      subject: parsed.values.subject,
    },
    now,
  });

  c.executionCtx.waitUntil(
    backgroundSend(c.env, {
      db,
      notifier: createNotifier(c.env, db, now),
      broadcastId,
      gameId: game.id,
      fixtureId: fixture.id,
      audience: parsed.values.audience,
      subject: parsed.values.subject,
      message: parsed.values.message,
      organiserName: player.name,
      channels,
      now,
      responseTokenSecret: c.env.RESPONSE_TOKEN_SECRET,
    }),
  );

  return c.redirect(ownerFixturePath(game.id, fixture.id), 303);
});

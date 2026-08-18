import type { Context } from "hono";
import { Hono } from "hono";
import { wrongOrigin } from "../auth/origin.js";
import { gamePath, ownerFixturePath } from "../auth/paths.js";
import { requirePlayer, type Player } from "../auth/session.js";
import { recordAudit } from "../db/audit.js";
import { getDb, type Db } from "../db/client.js";
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
import type { AppEnv } from "../env.js";
import { recordCeilingDeferral } from "../notify/ceiling-audit.js";
import { createNotifier } from "../notify/factory.js";
import { sendBroadcast } from "../notify/send-broadcast.js";
import { renderBroadcastPage, type BroadcastPageParams } from "../views/broadcast.js";

export const broadcast = new Hono<AppEnv>();

/** What the cap refusal says on the page, naming the number so raising it needs no copy change elsewhere. */
function capMessage(): string {
  return `This game has already sent ${MAX_BROADCASTS_PER_GAME_PER_DAY} messages today. Try again tomorrow.`;
}

/**
 * What the zero-recipient refusal says on the page — see the check in
 * `handleSend`. Worded to hold on both scopes: the game scope has no
 * audience picker to point the organiser back at, so this can't say "choose
 * a different audience".
 */
function noRecipientsMessage(): string {
  return "Nobody matches this audience, so there is nobody to send this message to.";
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
 *
 * **Also writes the durable ceiling-deferral record (TR-31, N-10).** This is
 * the hook `sendBroadcast`'s own `BroadcastSendResult` was going begging for:
 * a ceiling refusal deletes its `notification_log` row (`applySendResult`),
 * so without a row here "was this player ever told?" becomes unanswerable —
 * exactly the gap N-2/N-3/N-4/N-9 each closed the same way
 * (`recordCeilingDeferral`). Written from the route's continuation, after
 * awaiting the send, matching N-9's `publishTeams` shape — not inside
 * `sendBroadcast` itself, which stays a pure sender with no audit-writing of
 * its own. No `collapseWindowMs`: a broadcast is an act of a person, already
 * capped at `MAX_BROADCASTS_PER_GAME_PER_DAY`, so — unlike the sweep-driven
 * N-1/N-4 — the row count is already bounded, and a collapse window would
 * silently drop the second or third deferral of the same hour.
 */
async function backgroundSend(
  env: AppEnv["Bindings"],
  params: Parameters<typeof sendBroadcast>[0],
): Promise<void> {
  try {
    const result = await sendBroadcast(params);
    if (result.deferred > 0) {
      await recordCeilingDeferral(params.db, {
        action: "game.broadcast_email_deferred",
        notificationType: "n10",
        entityType: "game",
        entityId: params.gameId,
        // Names *which* broadcast this was: `entityId` is the game, not a
        // per-message id, so two broadcasts deferred on the same game in the
        // same day would otherwise be indistinguishable in this row.
        broadcastId: params.broadcastId,
        playerIds: result.deferredPlayerIds,
        now: params.now,
      });
      console.error(
        `broadcast (N-10) refused by the daily send ceiling for ${result.deferred} player(s) and NOTHING WILL RETRY IT (audit_log row written): broadcast ${params.broadcastId} on game ${params.gameId}`,
      );
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`sendBroadcast: broadcast ${params.broadcastId} on game ${params.gameId} failed: ${reason}`);
  }
}

/**
 * What the two routes below need to know about their scope, everything else
 * being identical between them: which page to re-render a refusal on, which
 * counts reduction to read `recipientCount` from, and which page a
 * successful send redirects to.
 */
interface SendScope {
  game: { id: string; name: string; timezone: string };
  /** Present only for the fixture-scoped route; `null` means "everyone". */
  fixture: { id: string; whenLocal: string } | null;
  formScope: "game" | "fixture";
  counts: Record<BroadcastAudience, number>;
  redirectTo: string;
}

/**
 * The shared body of both `POST` routes below (M15 spec §2, §7, §8, N-10) —
 * ownership and fixture-ownership have already been checked by the caller,
 * so this starts at parsing the form.
 *
 * The audit row is written **before** `waitUntil` hands the send off,
 * because it is what `countBroadcastsSince` counts — the daily cap (BR-36).
 * Writing it after would let two concurrent submissions each read a count of
 * zero and both send, and the cap would not cap anything. `recipientCount`
 * on that row is computed here, synchronously, from `scope.counts` — the
 * same reduction the `GET` page renders — rather than from the send result,
 * which does not exist yet when this row is written. The row records who the
 * message was *aimed at*; the per-recipient truth of what actually went out
 * lives in `notification_log`.
 *
 * `parseBroadcastForm` forces `audience` to `"everyone"` on the `"game"`
 * scope regardless of what was submitted, so reading `parsed.values.audience`
 * uniformly here is safe on both scopes without a branch.
 */
async function handleSend(
  c: Context<AppEnv>,
  db: Db,
  player: Player,
  scope: SendScope,
  now: Date,
): Promise<Response> {
  const rerender = (values: BroadcastFormValues, extra: Partial<BroadcastPageParams>) =>
    c.html(
      renderBroadcastPage({
        gameId: scope.game.id,
        gameName: scope.game.name,
        fixture: scope.fixture ?? undefined,
        counts: scope.counts,
        values,
        ...extra,
      }),
      422,
    );

  const form = await c.req.parseBody();
  const parsed = parseBroadcastForm(form, scope.formScope);
  if (!parsed.ok) return rerender(parsed.values, { errors: parsed.errors });

  // Same reduction the GET page's button label reads (`scope.counts` is
  // `countsForGame`/`countsForFixture`'s output, passed through unchanged),
  // so a zero-recipient refusal here matches what the organiser saw before
  // pressing submit — no second query. Before the cap check, not after: the
  // cap counts sends via `recordAudit` below, and an attempt that reaches
  // nobody must not spend one of the game's three daily sends.
  const recipientCount = scope.counts[parsed.values.audience];
  if (recipientCount === 0) {
    return rerender(parsed.values, { problem: noRecipientsMessage() });
  }

  const sentToday = await countBroadcastsSince(db, scope.game.id, utcDayStart(now));
  if (sentToday >= MAX_BROADCASTS_PER_GAME_PER_DAY) {
    return rerender(parsed.values, { problem: capMessage() });
  }

  const broadcastId = crypto.randomUUID();
  const fixtureId = scope.fixture === null ? null : scope.fixture.id;
  const channels = { email: parsed.values.email, push: parsed.values.push };

  await recordAudit(db, {
    actorPlayerId: player.id,
    entityType: "game",
    entityId: scope.game.id,
    action: "game.broadcast_sent",
    // Never the message body (spec §8) — see AUDIT_ACTIONS's doc comment for
    // "game.broadcast_sent".
    after: { audience: parsed.values.audience, channels, recipientCount, fixtureId, subject: parsed.values.subject },
    now,
  });

  c.executionCtx.waitUntil(
    backgroundSend(c.env, {
      db,
      notifier: createNotifier(c.env, db, now),
      broadcastId,
      gameId: scope.game.id,
      fixtureId,
      audience: parsed.values.audience,
      subject: parsed.values.subject,
      message: parsed.values.message,
      organiserName: player.name,
      channels,
      now,
      responseTokenSecret: c.env.RESPONSE_TOKEN_SECRET,
    }),
  );

  return c.redirect(scope.redirectTo, 303);
}

/**
 * Sending a game-scoped quick message: a message to everyone in the squad.
 *
 * `fixture: null` on the `SendScope` passed to `handleSend` is what makes
 * `sendBroadcast` receive `fixtureId: null` — belt-and-braces alongside
 * `sendBroadcast`'s own scoping-out of a fixture on an `everyone` audience,
 * so this route stays honest about what it is regardless of what the sender
 * happens to do with it.
 */
broadcast.post("/g/:id/message", requirePlayer, async (c) => {
  if (wrongOrigin(c)) return c.text("Forbidden", 403);

  const db = getDb(c.env.DB);
  const player = c.get("player")!;
  const game = await findGameForOwner(db, c.req.param("id"), player.id);
  if (game === null) return c.text("Not found", 404);

  const now = new Date(Date.now());
  const recipients = await listGameRecipients(db, game.id);

  return handleSend(
    c,
    db,
    player,
    {
      game,
      fixture: null,
      formScope: "game",
      counts: countsForGame(recipients),
      redirectTo: gamePath(game.id),
    },
    now,
  );
});

/**
 * Sending a fixture-scoped quick message: a message to one of the four
 * response-derived audiences.
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

  return handleSend(
    c,
    db,
    player,
    {
      game,
      fixture: { id: fixture.id, whenLocal: formatLocalDateTime(fixture.kicksOffAt, game.timezone) },
      formScope: "fixture",
      counts: countsForFixture(recipients),
      redirectTo: ownerFixturePath(game.id, fixture.id),
    },
    now,
  );
});

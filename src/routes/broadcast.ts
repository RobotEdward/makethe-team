import { Hono } from "hono";
import { requirePlayer } from "../auth/session.js";
import { getDb } from "../db/client.js";
import { listFixtureRecipients, listGameRecipients, type BroadcastRecipient } from "../db/broadcast-queries.js";
import { findGameForOwner, getFixtureWithSquad } from "../db/queries.js";
import {
  BROADCAST_AUDIENCES,
  DEFAULT_FIXTURE_AUDIENCE,
  FIXTURE_AUDIENCES,
  audienceSelectsStatus,
  isAddressable,
  type BroadcastAudience,
} from "../domain/broadcast-audience.js";
import type { BroadcastFormValues } from "../domain/broadcast-form.js";
import { formatLocalDateTime } from "../domain/time/zone.js";
import type { AppEnv } from "../env.js";
import { renderBroadcastPage } from "../views/broadcast.js";

export const broadcast = new Hono<AppEnv>();

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

import { Hono } from "hono";
import { getFixtureWithSquad } from "../db/queries.js";
import { getDb, type Db } from "../db/client.js";
import { fixtureView } from "../domain/fixture-view.js";
import { formatLocalDateTime } from "../domain/time/zone.js";
import { verifyResponseToken } from "../domain/token.js";
import type { ResponseIntent } from "../capacity/types.js";
import type { AppEnv } from "../env.js";
import { escapeHtml, layout } from "../views/layout.js";
import { renderFixturePage, type ReadOnlyReason } from "../views/fixture.js";

export const respond = new Hono<AppEnv>();

/**
 * One shared "this link isn't working" page for every way a token can fail to
 * verify, and for a fixture that no longer exists.
 *
 * Deliberately not branching on the reason (bad signature, expired, malformed,
 * fixture-not-found): distinguishing them would turn the page into an oracle
 * that tells a prober which guesses were closer to a real token. The real
 * reason still goes to `console.error` for operators.
 *
 * 200, not 410 or 404: the link the player tapped is not itself gone or
 * malformed from an HTTP point of view — it is simply not something this
 * request can act on right now, and the body says so in plain language. A
 * player's own mail client, and any prefetcher ahead of them, should see an
 * ordinary page, not an error status that might get treated specially (e.g.
 * retried, or flagged) by something in the delivery path. Nothing here is a
 * server fault, so 5xx is never appropriate.
 */
function renderLinkProblemPage(): string {
  const body = `
    <h1>This link isn't working</h1>
    <p>It may have expired, already been used for a fixture that's since finished, or been copied incorrectly.</p>
    <p>Ask whoever organises your game to send you a fresh link, or get in touch with them directly.</p>
  `;
  return layout({ title: "This link isn't working — Make The Team", body });
}

function parseIntent(value: string | undefined): "in" | "out" | null {
  return value === "in" || value === "out" ? value : null;
}

/**
 * The interim `/leave/:token` page (BR-22, task-15 fix round 1).
 *
 * Leaving a Game is not self-service yet — there is no write path here, on
 * purpose: this route is `GET`-only and renders, never mutates. It exists so
 * the reminder email's leave link is truthful rather than a 404: the token
 * verifies (proving it really was issued to this player for this fixture)
 * and the page says plainly what a player can and can't do here today,
 * rather than presenting buttons that quietly do nothing (or, worse, that
 * look like "I'm in" / "Can't make it" and get mistaken for a real opt-out).
 * The full self-service leave flow is a later milestone.
 */
function renderLeavePage(gameName: string): string {
  const body = `
    <h1>Leaving ${escapeHtml(gameName)}</h1>
    <p>You can't remove yourself from a Game here yet — that isn't self-service yet.</p>
    <p>Ask whoever organises ${escapeHtml(gameName)} to take you off the squad, or get in touch with them directly.</p>
  `;
  return layout({ title: `Leaving ${gameName} — Make The Team`, body });
}

/**
 * Load a fixture and render the page one player sees of it — the read path
 * shared by the `GET` and, after it has (or has not) written anything, the
 * `POST`.
 *
 * Returns `null` only when the fixture itself cannot be found, which the
 * caller treats identically to a token failure (never leaking whether a
 * fixture existed, per the `GET`'s existing behaviour).
 *
 * `readOnlyReason` is derived from **`fixture.lifecycle` and squad
 * membership alone** — never from a Durable Object outcome. That is
 * deliberate: this function is the single place either handler decides what
 * a viewer may do here, so the two can no longer disagree about it. A
 * `scheduled` fixture (`not-open`) and a missing squad row (`not-eligible`)
 * are exactly the two conditions under which the Durable Object would also
 * refuse a write (`fixture-not-open` on a lifecycle other than `played`/
 * `cancelled`, and `not-eligible` respectively), so re-deriving from the
 * fixture row after the fact gives the same answer without the route having
 * to interpret the outcome's `reason` at all.
 */
async function renderFixtureForViewer(params: {
  db: Db;
  fixtureId: string;
  playerId: string;
  token: string;
  now: Date;
  intent: ResponseIntent | null;
}): Promise<string | null> {
  const { db, fixtureId, playerId, token, now, intent } = params;
  const loaded = await getFixtureWithSquad(db, fixtureId);
  if (!loaded) return null;

  const { fixture, game, squad } = loaded;
  const view = fixtureView(
    {
      lifecycle: fixture.lifecycle,
      kicksOffAt: fixture.kicksOffAt,
      inCount: fixture.inCount,
      minPlayers: fixture.minPlayers,
      maxPlayers: fixture.maxPlayers,
      prefersEvenNumbers: fixture.prefersEvenNumbers,
      shortWarningOffsetHours: fixture.shortWarningOffsetHours,
    },
    now,
  );

  // A player with no response row was eligible when the fixture opened but is
  // not any more (most likely removed from the squad after their link was
  // sent) — the token still verifies, so this is not a token failure, but
  // there is nothing for them to do here.
  const viewerMember = squad.find((member) => member.playerId === playerId);
  const viewer = {
    playerId,
    status: viewerMember?.status ?? ("pending" as const),
    waitlistRank: viewerMember?.waitlistRank ?? null,
  };

  const readOnlyReason: ReadOnlyReason | undefined =
    fixture.lifecycle === "played" || fixture.lifecycle === "cancelled"
      ? fixture.lifecycle
      : fixture.lifecycle === "scheduled"
        ? "not-open"
        : viewerMember === undefined
          ? "not-eligible"
          : undefined;

  return renderFixturePage({
    gameName: game.name,
    venueName: fixture.venueOverride ?? game.venueName,
    kicksOffAtLocal: formatLocalDateTime(fixture.kicksOffAt, game.timezone),
    view,
    squad,
    viewer,
    token,
    intent,
    readOnlyReason,
  });
}

respond.get("/r/:token", async (c) => {
  const token = c.req.param("token");
  // The one place this route reads the real wall clock; everything downstream
  // takes `now` as a parameter (see the lint rule banning bare `new Date()`).
  const now = new Date(Date.now());
  const verification = await verifyResponseToken(token, c.env.RESPONSE_TOKEN_SECRET, now);

  if (!verification.ok) {
    console.error(`response token rejected: ${verification.reason}`);
    return c.html(renderLinkProblemPage(), 200);
  }

  const { playerId, fixtureId } = verification.payload;
  const db = getDb(c.env.DB);
  const intent = parseIntent(c.req.query("intent"));

  const html = await renderFixtureForViewer({ db, fixtureId, playerId, token, now, intent });
  if (html === null) {
    console.error(`response token verified for a fixture that no longer exists: ${fixtureId}`);
    return c.html(renderLinkProblemPage(), 200);
  }

  return c.html(html, 200);
});

/**
 * Record a player's response and re-render the same page in place.
 *
 * Deliberately not a redirect (see the design note on `renderLinkProblemPage`
 * for why the equivalent choice was made on the failure path): a redirect
 * would have to carry the token in the URL again, and buys nothing without
 * JavaScript on this page (TR-4, TR-15).
 *
 * The write goes through `FIXTURE_CAPACITY.getByName(fixtureId).setResponse`
 * and nowhere else — that Durable Object is what serialises capacity-affecting
 * writes (TR-10) and is the only thing that may decide `in` versus
 * `waitlisted`. Its rejections are not otherwise inspected: `fixture-not-open`
 * and `not-eligible` are re-derived independently by `renderFixtureForViewer`
 * from the fixture row it reads immediately afterwards (see that function's
 * doc comment for why that is deliberately the single source of truth for
 * both handlers), and the waitlist number shown to the player always comes
 * from `getFixtureWithSquad`'s `waitlistRank`, never from the object's
 * `waitlistPosition`, which is a permanent, gappy, internal bookkeeping
 * number (spec amendment 5). Only `fixture-not-found` is checked directly,
 * because that is the one outcome `renderFixtureForViewer` cannot re-derive —
 * there is no fixture row left to read.
 */
respond.post("/r/:token", async (c) => {
  const token = c.req.param("token");
  const now = new Date(Date.now());
  const verification = await verifyResponseToken(token, c.env.RESPONSE_TOKEN_SECRET, now);

  if (!verification.ok) {
    console.error(`response token rejected: ${verification.reason}`);
    return c.html(renderLinkProblemPage(), 200);
  }

  const { playerId, fixtureId } = verification.payload;

  const form = await c.req.parseBody();
  const rawIntent = form["intent"];
  const intent = parseIntent(typeof rawIntent === "string" ? rawIntent : undefined);
  if (intent === null) {
    return c.text('Bad Request: "intent" must be exactly "in" or "out"', 400);
  }

  const outcome = await c.env.FIXTURE_CAPACITY.getByName(fixtureId).setResponse({
    playerId,
    intent,
    actorPlayerId: null,
    source: "token",
    now: now.getTime(),
  });

  if (outcome.kind === "rejected" && outcome.reason === "fixture-not-found") {
    // Same not-yet-fatal race the GET handles: the token verified fine, the
    // fixture is simply gone by the time the write reached D1.
    console.error(`response token verified for a fixture that no longer exists: ${fixtureId}`);
    return c.html(renderLinkProblemPage(), 200);
  }

  const db = getDb(c.env.DB);
  const html = await renderFixtureForViewer({ db, fixtureId, playerId, token, now, intent });
  if (html === null) {
    console.error(`fixture disappeared between recording a response and re-rendering it: ${fixtureId}`);
    return c.html(renderLinkProblemPage(), 200);
  }

  return c.html(html, 200);
});

/**
 * `GET /leave/:token` — see `renderLeavePage` for why this exists and why it
 * has no corresponding `POST`. Reuses the same signed response token and the
 * same "this link isn't working" page a bad or expired token gets on `/r/`,
 * so an attacker learns nothing new by trying this path instead.
 */
respond.get("/leave/:token", async (c) => {
  const token = c.req.param("token");
  const now = new Date(Date.now());
  const verification = await verifyResponseToken(token, c.env.RESPONSE_TOKEN_SECRET, now);

  if (!verification.ok) {
    console.error(`leave link token rejected: ${verification.reason}`);
    return c.html(renderLinkProblemPage(), 200);
  }

  const { fixtureId } = verification.payload;
  const db = getDb(c.env.DB);
  const loaded = await getFixtureWithSquad(db, fixtureId);
  if (!loaded) {
    console.error(`leave link token verified for a fixture that no longer exists: ${fixtureId}`);
    return c.html(renderLinkProblemPage(), 200);
  }

  return c.html(renderLeavePage(loaded.game.name), 200);
});

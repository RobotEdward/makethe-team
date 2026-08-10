import { Hono } from "hono";
import { getFixtureWithSquad } from "../db/queries.js";
import { getDb } from "../db/client.js";
import { fixtureView } from "../domain/fixture-view.js";
import { formatLocalDateTime } from "../domain/time/zone.js";
import { verifyResponseToken } from "../domain/token.js";
import type { AppEnv } from "../env.js";
import { layout } from "../views/layout.js";
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
  const loaded = await getFixtureWithSquad(db, fixtureId);

  if (!loaded) {
    console.error(`response token verified for a fixture that no longer exists: ${fixtureId}`);
    return c.html(renderLinkProblemPage(), 200);
  }

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
      : viewerMember === undefined
        ? "not-eligible"
        : undefined;

  const intent = parseIntent(c.req.query("intent"));

  const html = renderFixturePage({
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
 * `waitlisted`. Every rejection the object can return (`fixture-not-open`,
 * `not-eligible`, `fixture-not-found`) is handled here by re-deriving the read
 * state rather than trusting the outcome's own fields for anything shown to
 * the player: the waitlist number in particular always comes from
 * `getFixtureWithSquad`'s `waitlistRank`, computed fresh from the current
 * squad, never from the object's `waitlistPosition`, which is a permanent,
 * gappy, internal bookkeeping number (spec amendment 5).
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
  const loaded = await getFixtureWithSquad(db, fixtureId);

  if (!loaded) {
    console.error(`fixture disappeared between recording a response and re-rendering it: ${fixtureId}`);
    return c.html(renderLinkProblemPage(), 200);
  }

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

  const viewerMember = squad.find((member) => member.playerId === playerId);
  const viewer = {
    playerId,
    status: viewerMember?.status ?? ("pending" as const),
    waitlistRank: viewerMember?.waitlistRank ?? null,
  };

  // `not-eligible` is read off the outcome, since that is the only thing that
  // actually attempted the write and found no row for this player (BR-2).
  // `played`/`cancelled` are read off the freshly loaded fixture rather than
  // the outcome's generic `fixture-not-open`, because that reason is also
  // returned for a `scheduled` fixture and only these two lifecycles have
  // copy of their own (BR-15).
  const readOnlyReason: ReadOnlyReason | undefined =
    outcome.kind === "rejected" && outcome.reason === "not-eligible"
      ? "not-eligible"
      : fixture.lifecycle === "played" || fixture.lifecycle === "cancelled"
        ? fixture.lifecycle
        : undefined;

  const html = renderFixturePage({
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

  return c.html(html, 200);
});

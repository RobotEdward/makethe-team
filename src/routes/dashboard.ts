import { Hono } from "hono";
import { DASHBOARD_PATH } from "../auth/paths.js";
import { requirePlayer } from "../auth/session.js";
import type { ResponseIntent } from "../capacity/types.js";
import { getDb } from "../db/client.js";
import { findActionableFixture, listDashboardFixtures } from "../db/dashboard-queries.js";
import type { DashboardFixture } from "../db/dashboard-queries.js";
import { fixtureView } from "../domain/fixture-view.js";
import { formatLocalDateTime } from "../domain/time/zone.js";
import type { AppEnv, Bindings } from "../env.js";
import { renderDashboardPage, type DashboardRow } from "../views/dashboard.js";
import type { SetResponseOutcome } from "../capacity/types.js";

/**
 * A mechanical tripwire for the M4 merge marker below, not decoration.
 *
 * A prose comment sitting over the `setResponse` call is not enough: this
 * file does not exist on the M4 branch, so merging M4 produces no conflict
 * here, and `outcome.kind === "rejected"` keeps compiling and passing once
 * M4 adds a `promoted` field to the `recorded`/`waitlisted` variants of
 * `SetResponseOutcome` — `tsc` stays green while the notification is
 * silently dropped. Typing `outcome` as `NoPromotion<SetResponseOutcome>`
 * makes that impossible: the moment `"promoted"` becomes a key of any member
 * of `SetResponseOutcome`, this alias collapses that member to `never`, the
 * assignment below fails to compile, and the merger lands on this exact line
 * with no archaeology required.
 *
 * Written as `T extends unknown ? (... : T)` rather than the more obvious
 * `"promoted" extends keyof T ? never : T` on purpose: `keyof` of a *union*
 * type is the intersection of each member's keys (only a key common to every
 * branch is safe to read without narrowing first), so a bare `keyof T` over
 * `SetResponseOutcome` never sees `"promoted"` even after M4 adds it to just
 * the `recorded`/`waitlisted` variants — that version of this type silently
 * never fires. `T extends unknown ? X : never` is the standard trick to force
 * a naked type parameter to distribute over the union first, so each variant
 * is checked against `keyof` on its own, whether the field M4 adds is
 * optional or required.
 *
 * **Discharging it (do this, don't delete the annotation to make the build
 * green):** handle `outcome.promoted` the way `POST /r/:token` does — send
 * the promoted player the N-2 "you're in" email, using one `db` handle per
 * request for the notifier, never a second Drizzle wrapper — and only then
 * remove this type and the `NoPromotion<...>` annotation on `outcome` below.
 */
type NoPromotion<T> = T extends unknown ? ("promoted" extends keyof T ? never : T) : never;

export const dashboard = new Hono<AppEnv>();

/**
 * `requirePlayer`, not `requireSession`. An anonymous visitor is redirected to
 * the sign-in page and a session with no linked Player gets the 403 page with
 * its exits — neither of which says anything about whether a particular
 * address has a Player here, because neither reads an address at all. There is
 * no player identifier anywhere in this route's URLs: the viewer is always
 * `c.get("player")`, so there is nothing to enumerate.
 *
 * The guard establishes *who*, and stops there (TR-18). Every entitlement
 * question — which games, which fixtures, whether this one may be changed — is
 * re-asked against the database by `src/db/dashboard-queries.ts`.
 */
dashboard.get(DASHBOARD_PATH, requirePlayer, async (c) => {
  // The one wall-clock read at this edge; `fixtureView` takes it as an
  // argument (see the lint rule banning bare `new Date()` downstream).
  const now = new Date(Date.now());
  const player = c.get("player")!;

  const rows = await listDashboardFixtures(getDb(c.env.DB), player.id);

  return c.html(renderDashboardPage({ playerName: player.name, rows: rows.map((row) => toRow(row, now)) }));
});

/** A queried fixture as the page shows it. No other player's data is involved. */
function toRow(fixture: DashboardFixture, now: Date): DashboardRow {
  return {
    fixtureId: fixture.fixtureId,
    gameName: fixture.gameName,
    venueName: fixture.venueName,
    // Every timezone conversion in this codebase goes through this one module.
    kicksOffAtLocal: formatLocalDateTime(fixture.kicksOffAt, fixture.timezone),
    view: fixtureView(fixture, now),
    myStatus: fixture.myStatus,
  };
}

function parseIntent(value: unknown): ResponseIntent | null {
  return value === "in" || value === "out" ? value : null;
}

/** This deployment's own origin, as the sign-out handler compares it. */
function originOf(env: Bindings): string {
  return new URL(env.BETTER_AUTH_URL).origin;
}

/**
 * Change one response, then send the browser back to the page.
 *
 * **A redirect, unlike `POST /r/:token`.** That handler re-renders in place on
 * purpose, because a redirect there would have to put the response token back
 * in a URL and buys nothing without JavaScript. Here there is no token, the
 * destination is a fixed constant, and redirecting means the dashboard has
 * exactly one renderer — `renderDashboardPage`, reached only through the `GET`
 * above — rather than a second copy of the page assembled after a write, which
 * is precisely how two renderings of the same list drift apart. 303, so the
 * browser follows it with a `GET` and a refresh does not re-post.
 *
 * The origin check mirrors `POST /sign-out`'s, for the same reason: this is a
 * state-changing form post, a browser always sends `Origin` on a cross-site
 * one, and a missing header is a non-browser client acting on its own behalf.
 */
dashboard.post(DASHBOARD_PATH, requirePlayer, async (c) => {
  const origin = c.req.header("origin");
  if (origin !== undefined && origin !== originOf(c.env)) {
    return c.text("Forbidden", 403);
  }

  const now = new Date(Date.now());
  const player = c.get("player")!;

  const form = await c.req.parseBody();
  const intent = parseIntent(form["intent"]);
  if (intent === null) {
    return c.text('Bad Request: "intent" must be exactly "in" or "out"', 400);
  }
  const fixtureId = typeof form["fixtureId"] === "string" ? form["fixtureId"] : "";

  // ---- The entitlement re-check (TR-18). ----
  // Nothing above this line has established that this viewer may touch this
  // fixture: the form is the caller's own input and the middleware only said
  // who they are. This asks the database the same question the listing asked —
  // active membership in the fixture's Game, a response row of the viewer's
  // own, and a non-terminal lifecycle — and a `null` here is a flat 404 rather
  // than a 403, so a fixture id cannot be probed for existence. It is also
  // what locks a `played` fixture (BR-15) against a replayed form: the page
  // offers no action on one because it is not listed, and this refuses one
  // even when the form is resubmitted by hand.
  const actionable = await findActionableFixture(getDb(c.env.DB), player.id, fixtureId);
  if (actionable === null) return c.text("Not found", 404);

  // The write goes through the Durable Object addressed by fixture id and
  // nowhere else (TR-10) — it is the only thing that may decide `in` versus
  // `waitlisted`, and `setResponse` derives the fixture id from its own
  // identity rather than taking one, so there is no argument here to disagree
  // with the lock. `source: "web"` is what distinguishes a dashboard change
  // from a `"token"` change made from a reminder email.
  //
  // ---- MERGE MARKER: M4 waitlist promotion (branch `m4-...`, unmerged). ----
  // On the M4 branch, `setResponse` promotes the longest-waiting waitlisted
  // player inside the capacity lock when someone leaves `in`, and reports it
  // as a `promoted` field on the outcome; its caller is responsible for
  // sending that player the N-2 "you're in" email. Neither the field nor N-2
  // exists on this branch, so nothing is wired up here.
  //
  // **Whoever merges M4 into M5 must handle it here.** A dropout posted from
  // this dashboard frees a slot exactly as a dropout from `/r/:token` does, so
  // the promotion will happen the moment the branches meet — and if this call
  // site ignores `outcome.promoted`, the promoted player is moved off the
  // waitlist and into the squad silently and never told. Copy whatever
  // `POST /r/:token` does with `promoted` (notifier construction included: one
  // `db` handle per request, never a second Drizzle wrapper) to this site.
  const outcome: NoPromotion<SetResponseOutcome> = await c.env.FIXTURE_CAPACITY.getByName(actionable.fixtureId).setResponse({
    playerId: player.id,
    intent,
    // The player set it themselves. An owner override is a different route
    // and would name the owner here (BR-27).
    actorPlayerId: null,
    source: "web",
    now: now.getTime(),
  });

  if (outcome.kind === "rejected") {
    // Not a fault, and not something to explain in its own page: the check
    // above passed, so this is a race — the fixture was cancelled, played or
    // deleted between that read and the lock. The redirect re-renders the list
    // from the database, which is the honest answer either way.
    console.warn(`dashboard response rejected by the capacity object: ${outcome.reason}`);
  }

  return c.redirect(DASHBOARD_PATH, 303);
});

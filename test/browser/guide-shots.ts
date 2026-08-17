import type { GuideWorld } from "./guide-world.js";

export interface Shot {
  /** Stable slug — the image filename and the manifest key. */
  id: string;
  /** The chapter slug this shot belongs to, without `.md`. */
  chapter: string;
  title: string;
  /** The route pattern, for the manifest. Not used to navigate. */
  route: string;
  /** What this screenshot shows, in plain language. Written, not derived. */
  shows: string;
  path: (w: GuideWorld) => string;
  persona: "anonymous" | "organiser";
  /**
   * Capture just this element rather than the whole page.
   *
   * Three chapters need a picture of `/g/:id` for three different reasons.
   * Photographing the full page each time would write three byte-identical
   * PNGs under three names — duplication a reader gains nothing from, and
   * three times the churn. Scoping each to the part its chapter is about
   * makes every image earn its place.
   *
   * Note `ul.squad` matches **two** lists on that page — the squad and the
   * fixtures below it — so a selector for the squad must pin the first, or
   * Playwright's strict mode fails the run.
   */
  element?: string;
}

export const CHAPTERS = [
  { slug: "01-setting-up-a-game", title: "Setting up a game" },
  { slug: "02-inviting-your-squad", title: "Inviting your squad" },
  { slug: "03-answering-a-reminder", title: "Answering a reminder" },
  { slug: "04-when-someone-drops-out", title: "When someone drops out" },
  { slug: "05-running-your-squad", title: "Running your squad" },
  { slug: "06-calling-a-fixture-off", title: "Calling a fixture off" },
  { slug: "07-your-own-fixtures", title: "Your own fixtures" },
] as const;

export const SHOTS: Shot[] = [
  {
    id: "sign-in",
    chapter: "01-setting-up-a-game",
    title: "Signing in",
    route: "/sign-in",
    shows: "The sign-in page: one email field, and a passkey option below it.",
    path: () => "/sign-in",
    persona: "anonymous",
  },
  {
    id: "new-game",
    chapter: "01-setting-up-a-game",
    title: "The new game form",
    route: "/g/new",
    shows: "The form for a new game — name, venue, day, kickoff time, and squad sizes.",
    path: () => "/g/new",
    persona: "organiser",
  },
  {
    id: "game-overview",
    chapter: "01-setting-up-a-game",
    title: "Your game",
    route: "/g/:id",
    shows: "A game with fourteen members, the invite link and QR code, and the fixtures ahead.",
    path: (w) => `/g/${w.gameId}`,
    persona: "organiser",
  },
  {
    id: "invite",
    chapter: "02-inviting-your-squad",
    title: "The invite link",
    route: "/g/:id",
    shows: "The shareable link and its Copy button, as an organiser sees them.",
    path: (w) => `/g/${w.gameId}`,
    persona: "organiser",
    element: ".invite-link",
  },
  {
    id: "invite-qr",
    chapter: "02-inviting-your-squad",
    title: "The QR code",
    route: "/g/:id",
    shows: "The QR code for the same link, for people standing next to you.",
    path: (w) => `/g/${w.gameId}`,
    persona: "organiser",
    element: ".qr",
  },
  {
    id: "join",
    chapter: "02-inviting-your-squad",
    title: "What a player sees",
    route: "/j/:token",
    shows: "The join page a player reaches from the link: a name and an email, nothing else.",
    path: (w) => `/j/${w.inviteToken}`,
    persona: "anonymous",
  },
  {
    id: "respond-pending",
    chapter: "03-answering-a-reminder",
    title: "Arriving from the email",
    route: "/r/:token",
    shows:
      "The page a player lands on from the email before they have answered: " +
      "the game, the time, and two untapped buttons.",
    path: (w) => `/r/${w.pendingToken}`,
    persona: "anonymous",
  },
  {
    id: "respond-in",
    chapter: "03-answering-a-reminder",
    title: "After you answer",
    route: "/r/:token",
    shows:
      "The same page once the player has tapped a button on it: \"You're in.\" " +
      "above the squad, with both buttons still there to change the answer.",
    path: (w) => `/r/${w.inToken}`,
    persona: "anonymous",
  },
  {
    id: "respond-waitlisted",
    chapter: "03-answering-a-reminder",
    title: "The waitlist",
    route: "/r/:token",
    shows: "A player who answered after the fixture filled, told their waitlist position.",
    path: (w) => `/r/${w.waitlistedToken}`,
    persona: "anonymous",
  },
  {
    id: "respond-squad-shown",
    chapter: "03-answering-a-reminder",
    title: "Who else is playing",
    route: "/r/:token",
    shows:
      "The squad list on the response page, with everyone's name and answer, which is " +
      "what a player sees while their organiser leaves the default setting on.",
    // The same page as `respond-in`, cropped to the squad list — reusing that
    // page's URL is deliberate (see `invite`/`invite-qr` above for the same
    // pattern), so this needs no game of its own.
    path: (w) => `/r/${w.inToken}`,
    persona: "anonymous",
    // M10 §3.5 regrouped the player-facing squad into a `<div class="squad">`
    // of chips (`src/views/fixture.ts`), replacing the `<ul class="squad">`
    // this selector used to target — left stale by that change since @guide
    // is excluded from the default browser run and CI, so nothing caught it
    // until this capture run failed partway through on "element has no box".
    element: ".squad",
  },
  {
    id: "respond-squad-hidden",
    chapter: "03-answering-a-reminder",
    title: "When it's turned off",
    route: "/r/:token",
    shows:
      "The response page for a game whose organiser has turned the setting off: a " +
      "headcount and the player's own answer, no other names.",
    path: (w) => `/r/${w.hiddenSquadToken}`,
    persona: "anonymous",
  },
  {
    id: "respond-out",
    chapter: "04-when-someone-drops-out",
    title: "Changing your mind",
    route: "/r/:token",
    shows: "A player who has said they cannot make it, and can still change back.",
    path: (w) => `/r/${w.outToken}`,
    persona: "anonymous",
  },
  {
    id: "leave",
    chapter: "04-when-someone-drops-out",
    title: "Leaving a game",
    route: "/leave/:token",
    shows:
      "The confirmation page reached from the footer of every email: what leaving " +
      "does, and the button that actually does it.",
    path: (w) => `/leave/${w.leaveToken}`,
    persona: "anonymous",
  },
  {
    id: "squad-controls",
    chapter: "05-running-your-squad",
    title: "The squad",
    route: "/g/:id",
    shows: "Each member's row, with a Manage disclosure that opens to the role button and the remove link.",
    path: (w) => `/g/${w.gameId}`,
    persona: "organiser",
    // The squad list, not the fixtures list below it — see `element` above.
    element: "ul.squad >> nth=0",
  },
  {
    id: "remove-member",
    chapter: "05-running-your-squad",
    title: "Removing someone",
    route: "/g/:id/squad/:playerId/remove",
    shows: "The confirmation page, naming the person and what removing them does.",
    path: (w) => `/g/${w.gameId}/squad/${w.removablePlayerId}/remove`,
    persona: "organiser",
  },
  {
    id: "edit-game",
    chapter: "05-running-your-squad",
    title: "Changing the details",
    route: "/g/:id/edit",
    shows: "The game's settings, filled in with what it currently uses.",
    path: (w) => `/g/${w.gameId}/edit`,
    persona: "organiser",
  },
  {
    id: "squad-visibility-checkbox",
    chapter: "05-running-your-squad",
    title: "Choosing who sees the squad",
    route: "/g/:id/edit",
    shows:
      "The Let players see who else is playing checkbox on the edit form, checked " +
      "because that's the default every game starts with.",
    path: (w) => `/g/${w.gameId}/edit`,
    persona: "organiser",
    element: '.field:has(#squadVisibleToPlayers)',
  },
  {
    id: "squad-member",
    chapter: "05-running-your-squad",
    title: "Looking somebody up",
    route: "/g/:id/squad/:playerId",
    shows:
      "A squad member's own small page: their name, their email address, whether " +
      "they're an organiser, and how long they've been in the squad — nothing about " +
      "what they've played.",
    path: (w) => `/g/${w.gameId}/squad/${w.removablePlayerId}`,
    persona: "organiser",
  },
  {
    id: "owner-fixture",
    chapter: "05-running-your-squad",
    title: "One fixture, as its organiser sees it",
    route: "/g/:id/f/:fixtureId",
    shows: "Everyone's answer for one fixture, with an In/Out segment beside each name.",
    path: (w) => `/g/${w.demoGameId}/f/${w.demoFixtureId}`,
    persona: "organiser",
  },
  {
    id: "owner-marked-in",
    chapter: "05-running-your-squad",
    title: "Answering for someone",
    route: "/g/:id/f/:fixtureId",
    shows: "A player marked in by the organiser, with the attribution line naming who did it.",
    path: (w) => `/g/${w.demoGameId}/f/${w.demoFixtureId}`,
    persona: "organiser",
    // Every one of these three shots is the same URL and (by the time any of
    // them is captured) the same final page — `buildOverrideDemo` finishes
    // driving both the mark-in and the guest-add before this run ever takes
    // a screenshot, so an unscoped capture here would be byte-identical to
    // `owner-fixture`. Scoping to the one row this shot is actually about
    // keeps that from happening, the same reason `squad-controls`/`invite`/
    // `invite-qr` above are each scoped to their own part of `/g/:id`.
    element: 'ul.squad li:has-text("Nadia Okafor")',
  },
  {
    id: "owner-guest-added",
    chapter: "05-running-your-squad",
    title: "A guest for one week",
    route: "/g/:id/f/:fixtureId",
    shows: "A guest in the squad list, marked as a guest, occupying a slot.",
    path: (w) => `/g/${w.demoGameId}/f/${w.demoFixtureId}`,
    persona: "organiser",
    element: 'ul.squad li:has-text("Jono Fielding")',
  },
  {
    id: "team-picker",
    chapter: "05-running-your-squad",
    title: "Picking the teams",
    route: "/g/:id/f/:fixtureId",
    shows:
      "The team picker below the squad on the same fixture page: the two sides " +
      "named, and every player who is in with three choices beside their name.",
    // The same fixture page as `owner-fixture` above, scoped to the picker
    // itself — an unscoped shot here would be a second photograph of a page
    // this chapter already shows, for the same reason `invite`/`invite-qr`
    // are each scoped to their own part of `/g/:id`.
    //
    // Nobody in this world has been given a side, which is deliberate: it is
    // the state an organiser actually opens the picker in, and it keeps this
    // shot from depending on a pick that would have to be driven — and kept
    // in step with the prose — on every regeneration.
    path: (w) => `/g/${w.demoGameId}/f/${w.demoFixtureId}`,
    persona: "organiser",
    element: "#team-picker",
  },
  {
    id: "cancel",
    chapter: "06-calling-a-fixture-off",
    title: "Calling it off",
    route: "/cancel/:token",
    shows: "The cancellation page, with a box for the reason everyone will be told.",
    path: (w) => `/cancel/${w.cancelToken}`,
    persona: "anonymous",
  },
  {
    id: "dashboard",
    chapter: "07-your-own-fixtures",
    title: "Your fixtures",
    route: "/app",
    shows:
      "A fixture card for a player who is already in, with the buttons they'd use " +
      "to change their answer.",
    path: () => "/app",
    persona: "organiser",
    // Element-scoped, not full-page: `buildGuideWorld` creates a fresh game on
    // every capture run and nothing retires the previous ones, so the full
    // fixture list grows without bound across regenerations. The first card —
    // what a player actually acts on — stays a fixed size run to run.
    // `nth=0` pins it, matching `squad-controls` above, since `li.fixture-card`
    // matches every card on the page and Playwright's strict mode would
    // otherwise fail the run.
    element: "li.fixture-card >> nth=0",
  },
  {
    id: "passkeys",
    chapter: "07-your-own-fixtures",
    title: "Signing in faster",
    route: "/app/passkeys",
    shows: "Where a player adds a passkey so they do not need an emailed link.",
    path: () => "/app/passkeys",
    persona: "organiser",
  },
  {
    id: "account",
    chapter: "07-your-own-fixtures",
    title: "Your account",
    route: "/app/account",
    shows:
      "A player's own account page: their name in an editable field, their email " +
      "address beside it, a link to manage passkeys, and their last fixtures across " +
      "every game, most recent first.",
    path: () => "/app/account",
    persona: "organiser",
  },
  {
    id: "offline",
    chapter: "07-your-own-fixtures",
    title: "No connection",
    route: "/offline",
    shows:
      "What the installed app shows if you open it with no signal: a short " +
      "explanation and nothing that pretends to be live.",
    path: () => "/offline",
    persona: "anonymous",
  },
];

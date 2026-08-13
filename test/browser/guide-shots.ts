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
    shows: "A game with thirteen members, the invite link and QR code, and the fixtures ahead.",
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
    id: "respond-in",
    chapter: "03-answering-a-reminder",
    title: "Answering the reminder",
    route: "/r/:token",
    shows: "A player who is in, with their answer emphasised and the squad listed below.",
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
    shows: "The page reached from the footer of every email, explaining how to leave.",
    path: (w) => `/leave/${w.inToken}`,
    persona: "anonymous",
  },
  {
    id: "squad-controls",
    chapter: "05-running-your-squad",
    title: "The squad",
    route: "/g/:id",
    shows: "Each member's row, with the control to make them an organiser and to remove them.",
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
    shows: "Every game a player belongs to, and the fixtures waiting on an answer.",
    path: () => "/app",
    persona: "organiser",
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
];

import {
  DASHBOARD_PATH,
  DELETE_ACCOUNT_PATH,
  NEW_GAME_PATH,
  PASSKEYS_PATH,
  SIGN_IN_PATH,
} from "../../src/auth/paths.js";
import type { World } from "./world.js";

export type Persona = "anonymous" | "owner" | "player";

export interface CataloguePage {
  /** Stable slug. Used in test names and screenshot filenames. */
  id: string;
  title: string;
  /** Built from the seeded world, for parameterised routes. */
  path: (world: World) => string;
  persona: Persona;
  /** What this page is for — read by a human, and later by the guide. */
  note: string;
  /**
   * The HTTP status this page is *supposed* to answer with. Defaults to 200.
   *
   * Declared per page rather than assumed, because Chromium logs "Failed to
   * load resource: the server responded with a status of 404" as a console
   * error for the navigation itself — so the 404 page trips the console gate
   * simply by being a 404. Naming the expected status here lets the gate
   * discount exactly that message and nothing else.
   */
  expectedStatus?: number;
}

/**
 * Every page the app renders, in one list.
 *
 * Three consumers iterate it: the console/CSP gate, the visual capture, and
 * (in its own later spec) the product guide generator. One list means a page
 * cannot be documented without being CSP-checked, or checked without being
 * documented — `test/security/csp.test.ts` enumerated pages by hand and had
 * silently drifted to cover no `/g/*` page at all, which is the failure
 * `catalogue.spec.ts` now makes impossible.
 */
export const CATALOGUE: CataloguePage[] = [
  {
    id: "home",
    title: "Home",
    path: () => "/",
    persona: "anonymous",
    note: "The holding page an unauthenticated visitor lands on.",
  },
  {
    id: "sign-in",
    title: "Sign in",
    path: () => SIGN_IN_PATH,
    persona: "anonymous",
    note: "Email field plus the passkey affordance, which script reveals.",
  },
  {
    id: "dashboard",
    title: "Dashboard",
    path: () => DASHBOARD_PATH,
    persona: "owner",
    note: "A player's games and the fixtures awaiting an answer.",
  },
  {
    id: "passkeys",
    title: "Passkeys",
    path: () => PASSKEYS_PATH,
    persona: "owner",
    note: "Register and manage passkeys. All of its behaviour is script.",
  },
  {
    id: "delete-account",
    title: "Delete my data",
    // The `player` persona, not `owner`: the seeded owner is their game's only
    // organiser, so they get the refusal state, which carries no form at all.
    // The joined member reaches the `offer` state — the branch with the
    // destructive button on it, and the one worth putting in front of a
    // browser and a CSP.
    path: () => DELETE_ACCOUNT_PATH,
    persona: "player",
    note: "Where a player schedules their own erasure, 48 hours out, and cancels it.",
  },
  {
    id: "new-game",
    title: "Set up a game",
    path: () => NEW_GAME_PATH,
    persona: "owner",
    note: "The game creation form — the app's largest form.",
  },
  {
    id: "game-overview",
    title: "Game overview",
    path: (w) => `/g/${w.gameId}`,
    persona: "owner",
    note: "Squad, fixtures, invite link, QR code, and the J6a squad controls.",
  },
  {
    id: "player-game",
    title: "Game (player)",
    path: (world) => `/g/${world.gameId}`,
    persona: "player",
    note: "A member's view of a game: who's playing this week, and what's coming up.",
  },
  {
    id: "owner-fixture",
    title: "Fixture (organiser)",
    path: (world) => `/g/${world.gameId}/f/${world.fixtureId}`,
    persona: "owner",
    note: "One fixture as its organiser sees it: everyone's state, and the controls to change it.",
  },
  {
    id: "edit-game",
    title: "Edit game",
    path: (w) => `/g/${w.gameId}/edit`,
    persona: "owner",
    note: "The same form as creation, populated.",
  },
  {
    id: "remove-member",
    title: "Remove a member",
    path: (w) => `/g/${w.gameId}/squad/${w.memberPlayerId}/remove`,
    persona: "owner",
    note: "J6a's confirmation page, stating the consequences from live rows.",
  },
  {
    id: "join",
    title: "Join a squad",
    path: (w) => `/j/${w.inviteToken}`,
    persona: "anonymous",
    note: "The public invite page. Reachable by anyone holding the link.",
  },
  {
    id: "respond",
    title: "Respond to a fixture",
    path: (w) => `/r/${w.responseToken}`,
    persona: "anonymous",
    note: "Where a reminder email lands. Token-authenticated, no session.",
  },
  {
    id: "leave",
    title: "Leave a game",
    path: (world) => `/leave/${world.leaveToken}`,
    persona: "anonymous",
    note: "The confirmation a player reaches from the leave link in any email.",
  },
  {
    id: "cancel",
    title: "Call a fixture off",
    path: (w) => `/cancel/${w.cancelToken}`,
    persona: "anonymous",
    note: "An owner's one-tap link out of the fixture-needs-attention email.",
  },
  {
    id: "not-found",
    title: "Not found",
    path: () => "/definitely-not-a-page",
    persona: "anonymous",
    note: "The 404. Carries the same CSP as everything else.",
    expectedStatus: 404,
  },
];

/**
 * Routes that render no page, or no page reachable without state this
 * catalogue does not build. Every entry carries its reason: an unexplained
 * exclusion is exactly how the old hand-written enumeration lost coverage.
 */
export const NOT_CATALOGUED = new Map<string, string>([
  ["/robots.txt", "plain text, no document, no CSP surface"],
  ["/sign-in/complete", "a redirect-through, not a page anyone dwells on"],
]);

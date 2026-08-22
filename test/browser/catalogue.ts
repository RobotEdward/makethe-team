import {
  ACCOUNT_PATH,
  ADMIN_ALLOWLIST_PATH,
  ADMIN_DELIVERY_PATH,
  ADMIN_PATH,
  ADMIN_SIGNIN_DOCTOR_PATH,
  DASHBOARD_PATH,
  DELETE_ACCOUNT_PATH,
  gamePastFixturesPath,
  NEW_GAME_PATH,
  OFFLINE_PATH,
  PASSKEYS_PATH,
  PRIVACY_PATH,
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
    id: "privacy",
    title: "Privacy",
    path: () => PRIVACY_PATH,
    persona: "anonymous",
    note: "What the product holds about a person, and the four things erasure cannot reach. Anonymous on purpose: it has to be readable before anybody hands over an address.",
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
    id: "account",
    title: "Your account",
    path: () => ACCOUNT_PATH,
    // The `owner` persona: the seeded owner has fixtures, so the history list
    // renders with rows rather than as its empty state, which is the version
    // worth putting in front of a browser and a CSP.
    persona: "owner",
    note: "A player's own record: their name (editable), their email (not), how they sign in, their push notification devices (M14), and their last 20 fixtures across every game.",
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
    id: "past-fixtures",
    title: "Past fixtures",
    path: (world) => gamePastFixturesPath(world.gameId),
    persona: "owner",
    note: "The fixtures a game has already had — every one for an organiser, cancelled ones included; the played ones a member was in.",
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
    // Extended rather than joined by a second entry: the team picker (BR-35)
    // is a fragment of *this* page, not a page of its own, and a second
    // catalogue row for the same route would run the same console/CSP gate
    // twice while `catalogue.spec.ts`'s ROUTE_TO_ID still mapped the route to
    // one of them.
    note:
      "One fixture as its organiser sees it: everyone's state, the controls to change it, " +
      "and the team picker — the only owner page carrying script (TEAM_PICKER_JS).",
  },
  {
    id: "team-picker",
    title: "Pick the teams",
    path: (w) => `/g/${w.gameId}/f/${w.fixtureId}/teams`,
    // The organiser can reach it too, and this is the persona the seeded
    // world already has entitled for this fixture. What a delegate sees
    // differs only by the opening sentence, which
    // test/routes/picker-delegation.test.ts pins.
    persona: "owner",
    note:
      "M29's standalone picker: the same team picker the organiser's fixture page carries, " +
      "on a page of its own for whoever they handed the pick to.",
  },
  {
    id: "edit-game",
    title: "Edit game",
    path: (w) => `/g/${w.gameId}/edit`,
    persona: "owner",
    note: "The same form as creation, populated, plus the edit-only Notifications section (M26).",
  },
  {
    id: "game-message",
    title: "Message the squad",
    path: (w) => `/g/${w.gameId}/message`,
    persona: "owner",
    note: "M15's game-scoped quick message: everyone in the squad, no audience radios.",
  },
  {
    id: "fixture-message",
    title: "Message a fixture's squad",
    path: (w) => `/g/${w.gameId}/f/${w.fixtureId}/message`,
    persona: "owner",
    note: "M15's fixture-scoped quick message: the four response-derived audiences, and both channel checkboxes.",
  },
  {
    id: "remove-member",
    title: "Remove a member",
    path: (w) => `/g/${w.gameId}/squad/${w.memberPlayerId}/remove`,
    persona: "owner",
    note: "J6a's confirmation page, stating the consequences from live rows.",
  },
  {
    id: "squad-member",
    title: "Squad member",
    path: (w) => `/g/${w.gameId}/squad/${w.memberPlayerId}`,
    persona: "owner",
    note: "One squad member as their organiser sees them — name, email, role, joined date, and deliberately no history.",
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
  {
    id: "offline",
    title: "No connection",
    path: () => OFFLINE_PATH,
    persona: "anonymous",
    note: "What an installed app shows when a navigation fails with no network.",
  },
];

/**
 * Routes that render no page, or no page reachable without state this
 * catalogue does not build. Every entry carries its reason: an unexplained
 * exclusion is exactly how the old hand-written enumeration lost coverage.
 */
export const NOT_CATALOGUED = new Map<string, string>([
  [
    ADMIN_ALLOWLIST_PATH,
    "reachable only with state this catalogue does not build: user.is_admin, " +
      "which no UI sets (it is flipped by the operator in SQL). Its rendered " +
      "output and status codes are pinned in test/routes/admin.test.ts and " +
      "the TR-16 sweep in test/routes/signin.test.ts; its style block is " +
      "hashed like every other by test/security/csp.test.ts.",
  ],
  [
    ADMIN_PATH,
    "reachable only with user.is_admin, which no UI sets — same exclusion " +
      "and same coverage as the allow-list entry above (M17).",
  ],
  [
    ADMIN_SIGNIN_DOCTOR_PATH,
    "reachable only with user.is_admin, which no UI sets — same exclusion " +
      "and same coverage as the allow-list entry above (M17).",
  ],
  [
    ADMIN_DELIVERY_PATH,
    "reachable only with user.is_admin, which no UI sets — same exclusion " +
      "and same coverage as the allow-list entry above (M17).",
  ],
  ["/robots.txt", "plain text, no document, no CSP surface"],
  ["/sign-in/complete", "a redirect-through, not a page anyone dwells on"],
  ["/manifest.webmanifest", "JSON, no document, no CSP surface — covered by pwa.spec.ts instead"],
  ["/icon-192.png", "a binary image, no document, no CSP surface"],
  ["/icon-512.png", "a binary image, no document, no CSP surface"],
  ["/apple-touch-icon.png", "a binary image, no document, no CSP surface"],
  ["/sw.js", "a script with its own standalone CSP, not the page policy — covered by pwa.spec.ts instead"],
]);

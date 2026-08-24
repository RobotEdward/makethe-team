import {
  inviteNextPath,
  inviteOrderPath,
  inviteTierDeletePath,
  inviteTierPath,
} from "../auth/paths.js";
import { escapeHtml, layout, type PageNav } from "./layout.js";
import { INVITE_ORDER_CSS, FORM_CSS } from "./styles.js";

/** One member as the editor lists them. */
export interface OrderMember {
  playerId: string;
  name: string;
}

/** One rung of the order. `tierId` is null for the implicit final tier (BR-38). */
export interface OrderTier {
  tierId: string | null;
  name: string;
  /** Ascending; asked earlier. Zero for the implicit tier, which is never posted back. */
  position: number;
  members: OrderMember[];
}

export interface InviteOrderParams {
  nav: PageNav;
  gameId: string;
  gameName: string;
  squadSize: number;
  /**
   * In invite order, the implicit tier last. Never empty — the implicit tier
   * always exists, even for a Game whose owner has defined no tiers at all.
   */
  tiers: OrderTier[];
  problem?: string;
}

/**
 * The owner's invite-order editor (M34, BR-38).
 *
 * Two controls rather than one list, deliberately. "Who is asked when the game
 * opens" and "in what order does everybody else follow" are different
 * questions, and a single drag-everything list makes the core group look like
 * just another row — when it is the only rung most owners will ever set.
 *
 * **Entirely scriptless.** Assignment is a `<select>` per member and ordering
 * is a number per tier, because those are the controls that work with no
 * JavaScript at all. Drag-and-drop would need a scripted fallback for the same
 * page anyway, and this page is edited rarely and read never.
 *
 * The implicit tier is rendered last, dimmed, with its members named and no
 * remove control. Naming them matters: an owner who cannot see who is in
 * "everyone else" cannot tell whether a new joiner has landed somewhere
 * sensible, which is the whole reason the implicit tier exists.
 */
export function renderInviteOrderPage(params: InviteOrderParams): string {
  const { gameId, gameName, squadSize, tiers } = params;

  const core = tiers[0];
  const rest = tiers.slice(1);

  const problem =
    params.problem === undefined ? "" : `<p class="problem">${escapeHtml(params.problem)}</p>`;

  // Every removable tier's form lives out here, after the editor form, and is
  // reached from its row by the button's `form` attribute. A `<form>` nested
  // inside another `<form>` is invalid HTML and browsers drop the inner one,
  // which would leave every Remove button silently submitting the save.
  const deleteForms = rest
    .filter((tier) => tier.tierId !== null)
    .map(
      (tier) =>
        `<form method="post" id="delete-${escapeHtml(tier.tierId!)}" action="${escapeHtml(
          inviteTierDeletePath(gameId, tier.tierId!),
        )}"></form>`,
    )
    .join("");

  const body = `
<h1>Invite order</h1>
<p class="invite-sub">${escapeHtml(gameName)} · ${squadSize} in squad</p>
${problem}
<form method="post" action="${escapeHtml(inviteOrderPath(gameId))}">
  <section class="invite-box">
    <h2 class="invite-cap">Core group — asked when the game opens</h2>
    ${core === undefined ? "" : renderMembers(core, tiers)}
  </section>

  <section class="invite-box">
    <h2 class="invite-cap">Then, as spots come free</h2>
    ${rest.length === 1 ? '<p class="invite-empty">No further groups yet — everyone else is asked together.</p>' : ""}
    <ol class="invite-ord">
      ${rest.map((tier) => renderOrderRow(tier)).join("")}
    </ol>
  </section>

  ${rest
    .slice(0, -1)
    .map((tier) => renderMembersFor(tier, tiers))
    .join("")}

  <button type="submit" class="button">Save invite order</button>
</form>

${deleteForms}

<form method="post" action="${escapeHtml(inviteTierPath(gameId))}" class="invite-add">
  <label for="new-tier-name">Add a group</label>
  <input id="new-tier-name" name="name" type="text" maxlength="60" required placeholder="Regulars">
  <button type="submit" class="button button-quiet">Add</button>
</form>
`;

  return layout({
    nav: params.nav,
    title: `Invite order — ${gameName}`,
    body,
    // FORM_CSS last: it owns the button and input styling this page borrows,
    // and INVITE_ORDER_CSS declares no selector FORM_CSS also declares — see
    // test/views/style-cascade.test.ts, which fails if that stops being true.
    pageStyles: [INVITE_ORDER_CSS, FORM_CSS],
  });
}

function renderMembersFor(tier: OrderTier, allTiers: OrderTier[]): string {
  return `
  <section class="invite-box">
    <h2 class="invite-cap">${escapeHtml(tier.name)}</h2>
    ${renderMembers(tier, allTiers)}
  </section>`;
}

function renderMembers(tier: OrderTier, allTiers: OrderTier[]): string {
  if (tier.members.length === 0) return '<p class="invite-empty">Nobody yet.</p>';
  return `<ul class="invite-members">${tier.members
    .map((member) => renderMemberRow(member, tier, allTiers))
    .join("")}</ul>`;
}

function renderMemberRow(member: OrderMember, tier: OrderTier, allTiers: OrderTier[]): string {
  const field = `tier-${member.playerId}`;
  const options = allTiers
    .map((candidate) => {
      // The implicit tier posts an empty value, which the handler reads as "no
      // tier". A sentinel string would be one more thing to keep in step
      // between this view and the parser.
      const value = candidate.tierId ?? "";
      const selected = candidate.tierId === tier.tierId ? " selected" : "";
      return `<option value="${escapeHtml(value)}"${selected}>${escapeHtml(candidate.name)}</option>`;
    })
    .join("");

  return `
    <li>
      <span class="invite-name">${escapeHtml(member.name)}</span>
      <label class="signal-label" for="${escapeHtml(field)}">Group for ${escapeHtml(member.name)}</label>
      <select id="${escapeHtml(field)}" name="${escapeHtml(field)}" class="invite-select">${options}</select>
    </li>`;
}

function renderOrderRow(tier: OrderTier): string {
  const names =
    tier.members.length === 0 ? "nobody yet" : tier.members.map((member) => member.name).join(", ");

  // The implicit tier is pinned last and can be neither reordered nor removed:
  // it is not a row in `invite_tiers` at all, it is everybody the owner has
  // not placed, and it is what makes a player who joins next week reachable
  // that same day with no owner action.
  if (tier.tierId === null) {
    return `
    <li class="invite-implicit">
      <span class="invite-grp">${escapeHtml(tier.name)}
        <span class="invite-who">${escapeHtml(names)}</span>
      </span>
      <span class="invite-pinned">always last</span>
    </li>`;
  }

  const id = escapeHtml(tier.tierId);
  return `
    <li>
      <span class="invite-grp">${escapeHtml(tier.name)}
        <span class="invite-who">${escapeHtml(names)}</span>
      </span>
      <label class="signal-label" for="pos-${id}">Position of ${escapeHtml(tier.name)}</label>
      <input id="pos-${id}" class="invite-pos" type="number" min="1" max="99"
             name="position-${id}" value="${tier.position}">
      <button type="submit" form="delete-${id}" class="invite-remove">Remove</button>
    </li>`;
}

/** One tier's state on a live fixture, as the owner's panel shows it. */
export interface ProgressTier {
  name: string;
  /** Already formatted in the game's timezone by the caller (TR-5); null if never asked. */
  askedAtLocal: string | null;
  inCount: number;
  outCount: number;
  waitingCount: number;
  memberCount: number;
}

export interface InviteProgressParams {
  gameId: string;
  fixtureId: string;
  /** In invite order, the implicit tier last. */
  tiers: ProgressTier[];
  /** How the held tiers will be released, phrased for the owner. Null when the fallback is off. */
  fallbackNote: string | null;
  /** Whether to offer the manual release — false once every tier is out. */
  canReleaseNext: boolean;
  /** The tier the button would release. Null when there is none. */
  nextTierName: string | null;
}

/**
 * The owner's invite-progress panel on a fixture page (M34).
 *
 * A panel rather than a single line, because the interesting thing is *why* a
 * tier is held rather than merely that it is: "next up, asked automatically at
 * 12h before if still short" is a sentence, not a status word, and an owner who
 * cannot see it has no way to tell a working gate from a stuck one.
 *
 * Rendered only for a gated Game. An ungated fixture has no invite order to
 * report on, and an empty panel there would be a control implying a feature
 * that is switched off.
 */
export function renderInviteProgress(params: InviteProgressParams): string {
  const { tiers, fallbackNote, canReleaseNext, nextTierName } = params;

  // The first tier with nothing asked yet is the one the next release reaches.
  const nextIndex = tiers.findIndex((tier) => tier.askedAtLocal === null);

  const rows = tiers
    .map((tier, index) => {
      const state =
        tier.askedAtLocal !== null
          ? `<span class="invite-badge invite-badge-ok">asked ${escapeHtml(tier.askedAtLocal)}</span>`
          : index === nextIndex
            ? '<span class="invite-badge invite-badge-wait">next up</span>'
            : '<span class="invite-badge invite-badge-idle">held</span>';

      const detail =
        tier.askedAtLocal !== null
          ? `${tier.inCount} in · ${tier.outCount} out${
              tier.waitingCount === 0 ? "" : ` · ${tier.waitingCount} waiting`
            }`
          : index === nextIndex && fallbackNote !== null
            ? fallbackNote
            : `${tier.memberCount} ${tier.memberCount === 1 ? "player" : "players"}`;

      const kind =
        tier.askedAtLocal !== null ? "sent" : index === nextIndex ? "next" : "held";

      return `
      <li class="invite-state invite-state-${kind}">
        <span class="invite-state-top">
          <span class="invite-state-label">${escapeHtml(tier.name)}</span>
          ${state}
        </span>
        <span class="invite-meter">${escapeHtml(detail)}</span>
      </li>`;
    })
    .join("");

  const button =
    canReleaseNext && nextTierName !== null
      ? `
  <form method="post" action="${escapeHtml(inviteNextPath(params.gameId, params.fixtureId))}">
    <button type="submit" class="button">Invite ${escapeHtml(nextTierName)} now</button>
  </form>`
      : "";

  return `
<section class="invite-progress">
  <h2>Invite progress</h2>
  <ul class="invite-states">${rows}</ul>
  ${button}
</section>`;
}

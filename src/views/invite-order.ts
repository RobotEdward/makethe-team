import {
  gamePath,
  inviteNextPath,
  inviteOrderPath,
  inviteTierDeletePath,
  inviteTierPath,
} from "../auth/paths.js";
import { MAX_ASK_AFTER_HOURS } from "../domain/invite-schedule.js";
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
  /**
   * Waking hours after the group above that this one is asked (M69). Null
   * only for the implicit tier, meaning it is asked only when the groups above
   * cannot fill the game. Unused for the first group.
   */
  askAfterHours: number | null;
  members: OrderMember[];
}

/** One line of the schedule preview, already formatted in the game's zone (TR-5). */
export interface SchedulePreviewRow {
  name: string;
  when: string;
  late: boolean;
}

/** The slowest schedule the order runs to, for one representative game. */
export interface SchedulePreview {
  /** e.g. "Wed 7 Oct, 21:00". */
  kickoffLocal: string;
  /** The time of day after which nothing is asked by the clock, e.g. "18:00". */
  cutoffLocal: string;
  rows: SchedulePreviewRow[];
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
  /** Null when the Game has no upcoming fixture to lay the schedule against. */
  schedule: SchedulePreview | null;
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

  // With no explicit groups, `tiers` holds only the implicit final one — it is
  // never empty (BR-38) — so `core` *is* "everyone else". Heading that card
  // "Core group — asked when the game opens" asserted a membership its own
  // selects denied, and it was the first thing every organiser saw on this
  // page: the M52 design review read it as "an organiser cannot tell what this
  // editor currently does". The honest heading for that state says what
  // actually happens, which is that everybody is asked at once.
  const noGroupsYet = core !== undefined && core.tierId === null;
  const coreHeading = noGroupsYet
    ? "Everyone — asked together when the game opens"
    : "Core group — asked when the game opens";

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
    <h2 class="invite-cap">${escapeHtml(coreHeading)}</h2>
    ${core === undefined ? "" : renderMembers(core, tiers)}
  </section>

  <section class="invite-box">
    <h2 class="invite-cap">Then, one group after another</h2>
    ${
      // `<= 1`, not `=== 1`. With no explicit groups `rest` is *empty*, so the
      // old check was false exactly when the reassurance was most needed and
      // the card rendered as a heading over an empty list. One group makes
      // `rest` the implicit tier alone, which is the other case with nothing
      // to order.
      rest.length <= 1
        ? '<p class="invite-empty">No further groups yet — everyone else is asked together.</p>'
        : ""
    }
    ${
      rest.length === 0
        ? ""
        : `<ol class="invite-ord">
      ${rest.map((tier) => renderOrderRow(tier)).join("")}
    </ol>`
    }
  </section>

  ${renderSchedule(params.schedule, rest.length > 0)}

  ${rest.map((tier) => renderMembersFor(tier, tiers)).join("")}

  <!-- Save first: pressing Enter in a box submits the first button. -->
  <div class="invite-actions">
    <button type="submit" class="button">Save invite order</button>
    <button type="submit" name="intent" value="preview" class="button quiet">Check schedule</button>
  </div>
</form>

${deleteForms}

<form method="post" action="${escapeHtml(inviteTierPath(gameId))}" class="invite-add">
  <label for="new-tier-name">Add a group</label>
  <input id="new-tier-name" name="name" type="text" maxlength="60" required placeholder="Regulars">
  <button type="submit" class="button quiet">Add</button>
</form>

<!-- §5's one text back-link. Without it the last thing on this page was the
     Add button, and the only way back to the game was the site header. -->
<p class="back-link"><a href="${escapeHtml(gamePath(gameId))}">Back to the game</a></p>
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

/**
 * One tier's own section of assignment controls.
 *
 * Rendered for **every** tier, the implicit one included. An earlier version
 * skipped the implicit tier on the reasoning that it is not a real row — which
 * made the editor unusable the moment an owner added their first group, since
 * at that instant every member of the squad is still unplaced and so had no
 * control at all. Being named in the order row above is not the same as being
 * assignable: that line is plain text.
 */
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
      <label class="visually-hidden" for="${escapeHtml(field)}">Group for ${escapeHtml(member.name)}</label>
      <span class="select"><select id="${escapeHtml(field)}" name="${escapeHtml(field)}" class="invite-select">${options}</select></span>
    </li>`;
}

/** What a new group, or the final group switched back to timed, starts at. */
const DEFAULT_ASK_AFTER_HOURS = 12;

function hoursBox(field: string, value: number, tierName: string): string {
  return `<label class="visually-hidden" for="${escapeHtml(field)}">Head start before ${escapeHtml(tierName)} is asked, in hours</label>
          <input id="${escapeHtml(field)}" class="invite-hours" type="number" inputmode="numeric"
                 min="0" max="${MAX_ASK_AFTER_HOURS}" name="${escapeHtml(field)}" value="${value}">`;
}

/**
 * When each group will be asked, at the latest (M69).
 *
 * The slowest case on purpose: auto-advance can only bring a group forward,
 * so these are the times an owner can promise their subs. A later row moves
 * whenever an earlier head start changes, which is why the whole list is
 * shown rather than one time per row.
 */
function renderSchedule(schedule: SchedulePreview | null, hasLaterGroups: boolean): string {
  if (!hasLaterGroups) return "";
  if (schedule === null) {
    return `
  <section class="invite-box">
    <h2 class="invite-cap">When each group is asked</h2>
    <p class="invite-empty">No upcoming game to lay the schedule against yet.</p>
  </section>`;
  }

  const rows = schedule.rows
    .map(
      (row) => `
      <li${row.late ? ' class="invite-plan-late"' : ""}>
        <span class="invite-plan-name">${escapeHtml(row.name)}</span>
        <span class="invite-plan-when">${escapeHtml(row.when)}</span>
      </li>`,
    )
    .join("");

  return `
  <section class="invite-box invite-schedule">
    <h2 class="invite-cap">When each group is asked</h2>
    <p class="invite-note">The latest each group hears, for the game on ${escapeHtml(schedule.kickoffLocal)}. A group is asked sooner if the groups above can't fill the game, and not while the game is full. Head starts only count between 06:00 and 23:00.</p>
    <ol class="invite-plan">${rows}
      <li class="invite-plan-kickoff">
        <span class="invite-plan-name">Kickoff</span>
        <span class="invite-plan-when">${escapeHtml(schedule.kickoffLocal)} · every timed group asked by ${escapeHtml(schedule.cutoffLocal)}</span>
      </li>
    </ol>
  </section>`;
}

function renderOrderRow(tier: OrderTier): string {
  const names =
    tier.members.length === 0 ? "nobody yet" : tier.members.map((member) => member.name).join(", ");

  // The implicit tier is pinned last and can be neither reordered nor removed:
  // it is not a row in `invite_tiers` at all, it is everybody the owner has
  // not placed, and it is what makes a player who joins next week reachable
  // that same day with no owner action.
  if (tier.tierId === null) {
    const whenNeeded = tier.askAfterHours === null;
    return `
    <li class="invite-implicit">
      <span class="invite-grp">${escapeHtml(tier.name)}
        <span class="invite-who">${escapeHtml(names)}</span>
      </span>
      <span class="invite-pinned">always last</span>
      <span class="invite-when">
        <span class="invite-when-line">
          <label class="invite-choice">
            <input type="radio" name="everyone-mode" value="timed"${whenNeeded ? "" : " checked"}>
            <span>asked</span>
          </label>
          ${hoursBox("after-everyone", tier.askAfterHours ?? DEFAULT_ASK_AFTER_HOURS, tier.name)}
          <span>waking hours after the group above</span>
        </span>
        <label class="invite-choice">
          <input type="radio" name="everyone-mode" value="needed"${whenNeeded ? " checked" : ""}>
          <span>only if the groups above can't fill the game</span>
        </label>
      </span>
    </li>`;
  }

  const id = escapeHtml(tier.tierId);
  return `
    <li>
      <span class="invite-grp">${escapeHtml(tier.name)}
        <span class="invite-who">${escapeHtml(names)}</span>
      </span>
      <label class="visually-hidden" for="pos-${id}">Position of ${escapeHtml(tier.name)}</label>
      <input id="pos-${id}" class="invite-pos" type="number" min="1" max="99"
             name="position-${id}" value="${tier.position}">
      <button type="submit" form="delete-${id}" class="invite-remove">Remove</button>
      <span class="invite-when">
        <span class="invite-when-line">
          <span>asked</span>
          ${hoursBox(`after-${tier.tierId}`, tier.askAfterHours ?? DEFAULT_ASK_AFTER_HOURS, tier.name)}
          <span>waking hours after the group above</span>
        </span>
      </span>
    </li>`;
}

/** One tier's state on a live fixture, as the owner's panel shows it. */
export interface ProgressTier {
  name: string;
  /** Already formatted in the game's timezone by the caller (TR-5); null if not asked by a release. */
  askedAtLocal: string | null;
  inCount: number;
  outCount: number;
  pendingCount: number;
  waitingCount: number;
  memberCount: number;
  /**
   * For a tier not yet asked: when it will be, already phrased — "due Wed
   * 10:00", "only if the groups above can't fill the game". Null once asked.
   */
  dueNote: string | null;
}

export interface InviteProgressParams {
  gameId: string;
  fixtureId: string;
  /** In invite order, the implicit tier last. */
  tiers: ProgressTier[];
  /** Whether to offer the manual release — false once every tier is out. */
  canReleaseNext: boolean;
  /** The tier the button would release. Null when there is none. */
  nextTierName: string | null;
}

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

/**
 * The owner's invite-progress panel on a fixture page (M34, M69).
 *
 * A panel rather than a single line, because the interesting thing is *when*
 * a held group will be asked rather than merely that it is held: an owner who
 * cannot see "due Wed 10:00" cannot tell a working order from a stuck one —
 * which is exactly what went wrong on 30 September 2026.
 *
 * A group not yet asked still shows who in it is already in (a hand invite or
 * an owner's override) and who has said yes early, because those are the
 * people an owner is most likely to be asked about.
 *
 * Rendered only for a gated Game. An ungated fixture has no invite order to
 * report on, and an empty panel there would be a control implying a feature
 * that is switched off.
 */
export function renderInviteProgress(params: InviteProgressParams): string {
  const { tiers, canReleaseNext, nextTierName } = params;

  // The first tier with nothing asked yet is the one the next release reaches.
  const nextIndex = tiers.findIndex((tier) => tier.askedAtLocal === null);

  const rows = tiers
    .map((tier, index) => {
      const asked = tier.askedAtLocal !== null;
      const kind = asked ? "sent" : index === nextIndex ? "next" : "held";
      const state = asked
        ? `<span class="invite-badge invite-badge-ok">asked ${escapeHtml(tier.askedAtLocal!)}</span>`
        : kind === "next"
          ? '<span class="invite-badge invite-badge-wait">next up</span>'
          : '<span class="invite-badge invite-badge-idle">later</span>';

      const counts = asked
        ? [
            `${tier.inCount} in`,
            `${tier.outCount} out`,
            `${tier.pendingCount} not answered`,
            ...(tier.waitingCount === 0 ? [] : [`${tier.waitingCount} waiting`]),
          ]
        : [
            ...(tier.dueNote === null ? [] : [tier.dueNote]),
            ...(tier.inCount === 0 ? [] : [`${tier.inCount} in already`]),
            ...(tier.waitingCount === 0 ? [] : [`${plural(tier.waitingCount, "said", "said")} yes early`]),
            plural(tier.memberCount, "player", "players"),
          ];

      return `
      <li class="invite-state invite-state-${kind}">
        <span class="invite-state-top">
          <span class="invite-state-label">${escapeHtml(tier.name)}</span>
          ${state}
        </span>
        <span class="invite-meter">${escapeHtml(counts.join(" · "))}</span>
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

  const note =
    nextIndex === -1
      ? ""
      : '<p class="invite-note">The next group is also asked straight away if the groups already asked can no longer fill the game. Nobody is asked between 23:00 and 06:00.</p>';

  return `
<section class="invite-progress">
  <h2>Invite progress</h2>
  <ul class="invite-states">${rows}</ul>
  ${note}
  ${button}
</section>`;
}

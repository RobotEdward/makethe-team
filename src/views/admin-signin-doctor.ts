import { ADMIN_SIGNIN_CHECK_PATH } from "../auth/paths.js";
import type { SignInDoors } from "../auth/sign-in-gate.js";
import { formatLocalDateTime } from "../domain/time/zone.js";
import { escapeHtml, layout, type PageNav } from "./layout.js";
import { ADMIN_ALLOWLIST_CSS, ADMIN_TOOLS_CSS, FORM_CSS } from "./styles.js";

/** One refused sign-in attempt, as the doctor lists it. */
export interface RefusalRow {
  email: string;
  at: Date;
}

/** One live magic-link request parsed out of Better Auth's `verification` table. */
export interface AttemptRow {
  email: string;
  at: Date;
  /** What the gate says for this address *now*, not at the time of the request. */
  permitted: boolean;
}

export interface AdminSigninDoctorPageParams {
  /** The signed-in header (M16); see PageNav in layout.ts. */
  nav: PageNav;
  /**
   * The checked address and each gate door's answer, when the check form has
   * been posted; absent on a plain GET.
   */
  verdict?: { email: string; doors: SignInDoors };
  /** Refused attempts, newest first, already capped by the route (max 10). */
  refusals: readonly RefusalRow[];
  /**
   * Magic-link requests still sitting in `verification`, newest first. Those
   * rows expire with the links (minutes), so this is "what just happened",
   * not history — the refusals table below is the durable half.
   */
  attempts: readonly AttemptRow[];
  /** A validation message for the check form, echoed on the 422 re-render. */
  error?: string;
}

/**
 * UTC on purpose, and labelled as such: this page has no game and therefore
 * no game timezone to borrow (TR-5's `formatLocalDateTime` is still the one
 * formatter, just pointed at UTC), and a diagnostic timestamp that silently
 * meant some other zone would send the operator grepping the wrong hour of
 * the provider's logs.
 */
function utcStamp(at: Date): string {
  return `${formatLocalDateTime(at, "Etc/UTC")} UTC`;
}

function door(label: string, open: boolean): string {
  return `<li>${escapeHtml(label)}: <span class="${open ? "door-open" : "door-shut"}">${
    open ? "open" : "closed"
  }</span></li>`;
}

/**
 * The sign-in doctor (M17): would the gate let this address in, and who has
 * it turned away lately?
 *
 * Every address on this page — checked or refused — is typed by whoever was
 * at the sign-in form, so all of them are attacker-controlled and every one
 * goes through `escapeHtml`.
 */
export function renderAdminSigninDoctorPage(params: AdminSigninDoctorPageParams): string {
  const { verdict, refusals, attempts, error } = params;

  const verdictHtml = verdict
    ? (() => {
        const permitted = verdict.doors.secret || verdict.doors.table || verdict.doors.member;
        return `
      <h2>${escapeHtml(verdict.email)}</h2>
      <p>${permitted ? "Can sign in." : "Cannot sign in — every door is closed."}</p>
      <ul class="doors">
        ${door("Server config allow list", verdict.doors.secret)}
        ${door("Sign-up allow list", verdict.doors.table)}
        ${door("Invited player with an active squad place", verdict.doors.member)}
      </ul>`;
      })()
    : "";

  const refusalItems = refusals.map(
    (r) => `<tr><td>${escapeHtml(r.email)}</td><td>${escapeHtml(utcStamp(r.at))}</td></tr>`,
  );
  const refusalsHtml =
    refusalItems.length === 0
      ? `<p>No refused attempts recorded.</p>`
      : `<table class="admin-log">
          <thead><tr><th>Address</th><th>When</th></tr></thead>
          <tbody>${refusalItems.join("")}</tbody>
        </table>`;

  const attemptItems = attempts.map(
    (a) => `<tr><td>${escapeHtml(a.email)}</td><td>${escapeHtml(utcStamp(a.at))}</td><td>${
      a.permitted ? "would be sent a link" : "would be refused"
    }</td></tr>`,
  );
  const attemptsHtml =
    attemptItems.length === 0
      ? `<p>No pending link requests.</p>`
      : `<table class="admin-log">
          <thead><tr><th>Address</th><th>When</th><th>Gate now</th></tr></thead>
          <tbody>${attemptItems.join("")}</tbody>
        </table>`;

  const errorHtml = error ? `<span class="error" id="check-error">${escapeHtml(error)}</span>` : "";

  return layout({
    nav: params.nav,
    title: "Sign-in doctor — Make The Team",
    // ADMIN_ALLOWLIST_CSS is here for the `.allowlist-add` form row shared
    // with the allow-list page. Order follows PAGE_STYLE_BLOCKS' own order.
    pageStyles: [FORM_CSS, ADMIN_ALLOWLIST_CSS, ADMIN_TOOLS_CSS],
    body: `
      <h1>Sign-in doctor</h1>
      <p>Check an address against the sign-in gate. Someone can sign in if any door is open.</p>
      <form method="post" action="${escapeHtml(ADMIN_SIGNIN_CHECK_PATH)}" class="allowlist-add">
        <div class="field${error ? " field-invalid" : ""}">
          <label for="email">Email address</label>
          <input type="email" id="email" name="email" required${error ? ` aria-describedby="check-error"` : ""}>
          ${errorHtml}
        </div>
        <button class="button primary" type="submit">Check</button>
      </form>
      ${verdictHtml}
      <h2>Link requests in the last few minutes</h2>
      <p>Read from the pending sign-in links themselves, so entries disappear as the links expire.</p>
      ${attemptsHtml}
      <h2>Recently refused</h2>
      <p>Addresses the gate turned away. They saw the normal "check your inbox" page and no email was sent.</p>
      ${refusalsHtml}
    `,
  });
}

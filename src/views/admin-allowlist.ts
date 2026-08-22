import {
  ADMIN_ALLOWLIST_ADD_PATH,
  ADMIN_ALLOWLIST_REMOVE_PATH,
  ADMIN_SIGNUP_MODE_PATH,
} from "../auth/paths.js";
import { escapeHtml, layout, type PageNav } from "./layout.js";
import { ADMIN_ALLOWLIST_CSS, FIXTURE_STYLES_CSS, FORM_CSS } from "./styles.js";

export interface AdminAllowlistPageParams {
  /** The signed-in header (M16); see PageNav in layout.ts. */
  nav: PageNav;
  /**
   * Entries from the `SIGNIN_ALLOWLIST` secret, already folded and de-blanked.
   * Shown without a remove button: they live in a Cloudflare secret this
   * screen cannot write, and hiding them instead would leave the operator
   * looking at a list that quietly disagrees with who can actually sign in.
   */
  secretEntries: readonly string[];
  /** Entries from the `signup_allowlist` table, oldest first. */
  tableEntries: readonly string[];
  /**
   * Whether open sign ups is on (M30) — i.e. whether the allow list below is
   * in effect at all.
   */
  openSignups: boolean;
  /** A validation message for the add form, echoed on the 422 re-render. */
  error?: string;
}

/** The operator's allow-list screen (M16): who may sign in without an invite. */
export function renderAdminAllowlistPage(params: AdminAllowlistPageParams): string {
  const { secretEntries, tableEntries, openSignups, error } = params;

  const secretItems = secretEntries.map(
    (email) => `<li>${escapeHtml(email)} <span class="provenance">from server config</span></li>`,
  );
  const tableItems = tableEntries.map(
    (email) => `
      <li>${escapeHtml(email)}
        <form method="post" action="${escapeHtml(ADMIN_ALLOWLIST_REMOVE_PATH)}">
          <input type="hidden" name="email" value="${escapeHtml(email)}">
          <button class="button danger" type="submit">Remove</button>
        </form>
      </li>`,
  );
  const items = [...secretItems, ...tableItems];
  const list =
    items.length === 0
      ? `<p>Nobody is on the allow list.${openSignups ? "" : " Only invited players can sign in."}</p>`
      : `<ul class="allowlist">${items.join("")}</ul>`;

  // "danger" marks opening the site to the whole internet, not closing it
  // again: the consequential press is the one that should give the operator
  // pause, and colouring "restrict" as the risky one had it backwards.
  //
  // The words come from the boolean, never from the stored string: an
  // `app_settings.value` this build has never heard of reads as off in
  // `isOpenSignups` and so cannot reach this page as a missing lookup.
  const mode = openSignups
    ? {
        state: "Open to everyone.",
        detail:
          "Anyone can ask for a sign-in link and create an account. The allow list below is not in effect.",
        button: "Restrict to the allow list",
      }
    : {
        state: "Allow list only.",
        detail:
          "Only the addresses below, and players already invited to a squad, can ask for a sign-in link.",
        button: "Open sign ups to everyone",
      };

  const errorHtml = error
    ? `<span class="error" id="email-error">${escapeHtml(error)}</span>`
    : "";

  return layout({
    nav: params.nav,
    title: "Sign-up allow list — Make The Team",
    // FIXTURE_STYLES_CSS is here for `.back-link` alone, the same way
    // `passkeys.ts` carries it. Order follows PAGE_STYLE_BLOCKS' own order.
    pageStyles: [FIXTURE_STYLES_CSS, FORM_CSS, ADMIN_ALLOWLIST_CSS],
    body: `
      <h1>Sign-up allow list</h1>
      <section class="signup-mode">
        <h2>Who can sign up</h2>
        <p><span class="state">${escapeHtml(mode.state)}</span> ${escapeHtml(mode.detail)}</p>
        <form method="post" action="${escapeHtml(ADMIN_SIGNUP_MODE_PATH)}">
          <input type="hidden" name="open" value="${openSignups ? "off" : "on"}">
          <button class="button ${openSignups ? "primary" : "danger"}" type="submit">${escapeHtml(mode.button)}</button>
        </form>
      </section>
      <p>${
        openSignups
          ? "These addresses are kept for when sign ups are restricted again. While sign ups are open they change nothing — anyone can sign in."
          : "People on this list can create an account without being invited to a game first. Anyone already invited to a squad can sign in regardless — this list is only for letting someone in ahead of their first invite."
      }</p>
      ${list}
      <form method="post" action="${escapeHtml(ADMIN_ALLOWLIST_ADD_PATH)}" class="allowlist-add">
        <div class="field${error ? " field-invalid" : ""}">
          <label for="email">Email address</label>
          <input type="email" id="email" name="email" required${error ? ` aria-describedby="email-error"` : ""}>
          ${errorHtml}
        </div>
        <button class="button primary" type="submit">Add</button>
      </form>
    `,
  });
}

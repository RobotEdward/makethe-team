import { SIGN_OUT_PATH } from "../auth/paths.js";
import { escapeHtml } from "./layout.js";

/**
 * The sign-out control, as a form.
 *
 * A form and not a link, because sign-out is a `POST` and only a `POST` — a
 * `GET` sign-out is triggerable by any `<img>` tag, link prefetcher or
 * antivirus scanner that happens to touch the page, and there is no client
 * JavaScript here to turn a link into a request of the right method.
 *
 * Its own module because it appears on pages owned by three different files
 * (the `requirePlayer` 403, the sign-in flow's refusal pages, and the
 * dashboard next task), and copying a `<form method="post">` into each is how
 * one of them ends up on the wrong path.
 *
 * `label` is caller-supplied wording — "Sign out" on the dashboard, "Sign out
 * and try a different address" where that is the likely fix — and is escaped
 * on the way in even though every current caller passes a literal.
 */
export function signOutForm(label = "Sign out"): string {
  return `<form class="signout" method="post" action="${SIGN_OUT_PATH}">
      <button class="button" type="submit">${escapeHtml(label)}</button>
    </form>`;
}

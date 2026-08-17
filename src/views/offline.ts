import { ICON_192_PATH } from "../auth/paths.js";
import { layout } from "./layout.js";
import { OFFLINE_STYLES_CSS } from "./styles.js";

/**
 * What an installed app shows when a navigation fails (M13, spec §8).
 *
 * `centred: true` — this page says one thing and offers nothing to scan,
 * which is exactly the test `LayoutOptions.centred` documents.
 *
 * Deliberately has no retry button. A button that needs the network is a
 * button that does nothing at the only moment this page is ever on screen;
 * the browser's own reload control already exists and is honest about what
 * it does.
 */
export function renderOfflinePage(): string {
  return layout({
    title: "No connection",
    centred: true,
    pageStyles: [OFFLINE_STYLES_CSS],
    body: `
      <img class="offline-mark" src="${ICON_192_PATH}" alt="" width="88" height="88">
      <h1>No connection</h1>
      <p>
        Make The Team needs to be online — kickoff times, who's in and how many
        places are left all change while you're not looking, so there's nothing
        here worth showing you from memory.
      </p>
      <p>There's no connection right now — reconnect and try again.</p>
    `,
  });
}

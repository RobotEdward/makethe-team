/**
 * "Add to your home screen" (M13, spec §11).
 *
 * Three states, and the *server* renders the one that works everywhere:
 * manual instructions. Script then upgrades it — to a real button on a
 * browser that fired `beforeinstallprompt`, or to a confirmation on a device
 * where the app is already installed.
 *
 * Rendering the instructions as the baseline rather than the button is the
 * whole no-JS rule applied honestly. iOS has no install API of any kind: the
 * Share sheet is the only route Apple offers, so a player on an iPhone reads
 * these instructions whether or not anything runs. Chrome's menu carries the
 * same item, so the instructions are never wrong — only sometimes bettered.
 *
 * The button and the "already installed" confirmation both ship `hidden`
 * (see `INSTALL_JS` in `src/views/scripts.ts` for what reveals which one),
 * and `[hidden] { display: none !important; }` in `STYLES` is what keeps
 * them that way for anyone whose script never runs: nothing in
 * `INSTALL_STYLES_CSS` gives `.install` a `display:` rule that could
 * out-specificity the attribute and reveal a control the platform cannot
 * act on.
 */
export function renderInstallSection(): string {
  return `
    <section class="install">
      <h2>Add to your home screen</h2>
      <p data-install-instructions>
        Keep Make The Team a tap away, and it opens like an app rather than a tab.
      </p>
      <ol data-install-steps>
        <li>Open the browser's <strong>Share</strong> or menu button.</li>
        <li>Choose <strong>Add to Home Screen</strong>.</li>
      </ol>
      <button class="button" type="button" data-install-button hidden>Add to home screen</button>
      <p data-install-done hidden>Make The Team is installed on this device.</p>
    </section>
  `;
}

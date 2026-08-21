import {
  AUTH_API_PREFIX,
  PASSKEYS_PATH,
  PUSH_SUBSCRIBE_PATH,
  SERVICE_WORKER_PATH,
  SIGN_IN_COMPLETE_PATH,
} from "../auth/paths.js";

/**
 * Every line of client-side JavaScript this app can emit, in one place.
 *
 * # Why there is any at all
 *
 * There was none until M5 Task 8, and the bar for adding some is high: the
 * rule is a guideline rather than an absolute, but JavaScript has to *earn*
 * its place. WebAuthn earns it on the only ground that counts — it is a
 * browser API (`navigator.credentials`), and there is no server-side
 * substitute for it at any price. Passkeys are therefore an **enhancement**
 * and the magic link stays the baseline: every page below is fully usable
 * with scripting off, and the passkey affordance simply is not present. Each
 * block starts by feature-detecting and returns without touching the page if
 * anything it needs is missing, so "scripting off" and "scripting on, no
 * WebAuthn" are the same experience.
 *
 * # Why they are enumerated rather than written at the call site
 *
 * Exactly the argument `src/views/styles.ts` makes for `<style>` blocks, and
 * with sharper teeth. M4 shipped a Content-Security-Policy containing
 * **`script-src 'none'`**, set deliberately on the stated grounds that this
 * site had no client JavaScript at all. Adding these blocks made that false,
 * and `src/security/csp.ts` now emits `script-src` as the SHA-256 hash of
 * every entry in `SCRIPT_BLOCKS` below, computed at runtime from these
 * exported constants — never pasted, so the header cannot go stale. Not
 * `'unsafe-inline'` and not `'unsafe-hashes'`: these are plain inline
 * `<script>` elements, which a bare hash covers. `test/views/scripts.test.ts`
 * fails the moment `src/security/csp.ts` stops naming `SCRIPT_BLOCKS`.
 *
 * # A hash lets a script run. It does not let it do anything.
 *
 * **Read this before adding a block that talks to the network.** `script-src`
 * governs execution and nothing else. Every *other* thing a script might do
 * is a separate directive, and any directive the header does not name falls
 * back to `default-src` — which is `'none'`. That is not a theoretical
 * hazard: these two blocks shipped to production able to run and unable to
 * `fetch` anything, because the header named no `connect-src`. Both passkey
 * buttons revealed themselves and then failed on every browser, and no
 * request ever reached the Worker, so nothing server-side could have caught
 * it (post-mortem in `docs/known-issues.md`).
 *
 * `connect-src 'self'` now covers the `fetch` calls, and
 * `test/security/csp.test.ts` reads the `fetch("…")` targets straight out of
 * `SCRIPT_BLOCKS` and asserts each one is a same-origin absolute path the
 * directive permits. A new block that fetches a *new* same-origin path is
 * therefore already covered. A block that needs anything else — an image, a
 * web font, a worker, a WebSocket to another host — needs its own directive
 * added to `src/security/csp.ts` and its own assertion, and will otherwise
 * fail exactly as silently as this one did.
 *
 * Inline and same-origin only. `default-src 'none'` forbids external hosts
 * and there is no CDN in this project, so nothing here may grow a `src=`
 * attribute or fetch anything off-origin.
 *
 * A block that exists but was never added to `PAGE_SCRIPT_BLOCKS` fails to
 * *compile* at the `layout()` call site (`pageScripts` is typed
 * `PageScriptBlock`), and a `<script>` smuggled directly into a page's `body`
 * string — which the type cannot see — fails
 * `test/routes/signin.test.ts`'s page enumeration, which checks every
 * script on every reachable page against `SCRIPT_BLOCKS`.
 */

/**
 * Sign in with a passkey, from the sign-in page.
 *
 * The affordance ships `hidden` and this reveals it, so a browser that never
 * runs this — scripting off, an old browser, a CSP that blocks it — shows a
 * page identical to the one before passkeys existed. Feature detection is
 * total: no `PublicKeyCredential`, no JSON serialisation helpers, no
 * `navigator.credentials.get`, and the button stays hidden rather than
 * appearing and failing.
 *
 * `PublicKeyCredential.parseRequestOptionsFromJSON` / `credential.toJSON()`
 * are used instead of hand-rolled base64url conversion, and instead of
 * `@simplewebauthn/browser`: an external script is unreachable under
 * `default-src 'none'`, and a bundled one could not be hashed from source the
 * way `SCRIPT_BLOCKS` requires. A browser too old for those two methods is a
 * browser that keeps the magic link, which is exactly the intended fallback.
 *
 * Lands on `/sign-in/complete` rather than the dashboard: verification mints
 * the session, and that page is what connects the session to a domain Player
 * (and renders the four refusals when it can't). Skipping it would give a
 * passkey holder a session with no Player and the 403.
 *
 * The failure message is deliberately generic and nothing from the error is
 * shown or logged — a WebAuthn error can name a credential id, and this page
 * is reachable by anyone.
 */
export const PASSKEY_SIGN_IN_JS = `
(function () {
  var section = document.getElementById("passkey");
  var button = document.getElementById("passkey-button");
  var problem = document.getElementById("passkey-problem");
  if (!section || !button || !problem) return;
  if (typeof window.PublicKeyCredential !== "function") return;
  if (typeof window.PublicKeyCredential.parseRequestOptionsFromJSON !== "function") return;
  if (typeof window.PublicKeyCredential.prototype.toJSON !== "function") return;
  if (!navigator.credentials || typeof navigator.credentials.get !== "function") return;

  section.hidden = false;

  button.addEventListener("click", function () {
    problem.hidden = true;
    button.disabled = true;
    fetch("${AUTH_API_PREFIX}/passkey/generate-authenticate-options", {
      credentials: "same-origin",
      headers: { accept: "application/json" }
    }).then(function (response) {
      if (!response.ok) throw new Error("options");
      return response.json();
    }).then(function (options) {
      return navigator.credentials.get({
        publicKey: window.PublicKeyCredential.parseRequestOptionsFromJSON(options)
      });
    }).then(function (credential) {
      if (!credential) throw new Error("cancelled");
      return fetch("${AUTH_API_PREFIX}/passkey/verify-authentication", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ response: credential.toJSON() })
      });
    }).then(function (response) {
      if (!response.ok) throw new Error("verify");
      window.location.assign("${SIGN_IN_COMPLETE_PATH}");
    }).catch(function () {
      problem.textContent = "That passkey didn't work. Ask for an email link instead.";
      problem.hidden = false;
      button.disabled = false;
    });
  });
})();
`;

/**
 * Add a passkey, from `/app/passkeys`.
 *
 * The mirror image of the block above, and the same discipline: the button
 * ships `hidden`, the page explains itself without it, and the list of
 * passkeys already registered is server-rendered so the page says something
 * true even when this never runs.
 *
 * Registration is gated on an existing session by the *server*
 * (`registration.requireSession` in `src/auth/factory.ts`, plus
 * `requirePlayer` on the page) — nothing here is a check, and this script
 * could be replayed by hand with no session and get a 401 from Better Auth.
 *
 * Reloads rather than appending a row on success, so the list a player sees
 * is always the one in the database rather than this script's guess at it.
 */
export const PASSKEY_REGISTER_JS = `
(function () {
  var section = document.getElementById("passkey-add");
  var button = document.getElementById("passkey-add-button");
  var problem = document.getElementById("passkey-problem");
  if (!section || !button || !problem) return;
  if (typeof window.PublicKeyCredential !== "function") return;
  if (typeof window.PublicKeyCredential.parseCreationOptionsFromJSON !== "function") return;
  if (typeof window.PublicKeyCredential.prototype.toJSON !== "function") return;
  if (!navigator.credentials || typeof navigator.credentials.create !== "function") return;

  section.hidden = false;

  button.addEventListener("click", function () {
    problem.hidden = true;
    button.disabled = true;
    fetch("${AUTH_API_PREFIX}/passkey/generate-register-options", {
      credentials: "same-origin",
      headers: { accept: "application/json" }
    }).then(function (response) {
      if (!response.ok) throw new Error("options");
      return response.json();
    }).then(function (options) {
      return navigator.credentials.create({
        publicKey: window.PublicKeyCredential.parseCreationOptionsFromJSON(options)
      });
    }).then(function (credential) {
      if (!credential) throw new Error("cancelled");
      return fetch("${AUTH_API_PREFIX}/passkey/verify-registration", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ response: credential.toJSON() })
      });
    }).then(function (response) {
      if (!response.ok) throw new Error("verify");
      window.location.assign("${PASSKEYS_PATH}");
    }).catch(function () {
      problem.textContent = "That didn't work. Nothing was saved — you can try again.";
      problem.hidden = false;
      button.disabled = false;
    });
  });
})();
`;

/**
 * Copy a field's value to the clipboard — the invite link on `/g/:id`, and
 * each prepared WhatsApp message (M22).
 *
 * The first script in this project that is pure convenience rather than a
 * browser-only capability, and it earns its place on the terms the module
 * comment sets: the page is complete without it. The value renders in a
 * `readonly` input or textarea that can be selected and copied by hand, and
 * this only adds a button beside it. Scripting off, or an old browser
 * without `navigator.clipboard`, is the same page minus one button.
 *
 * Generalised from a single hard-coded pair of ids in M22: a button carries
 * `data-copy="<id of the field>"` and ships `hidden`, so one block serves
 * every copy button in the app and a page with none of them is untouched.
 * A button whose target is missing is left hidden rather than revealed and
 * broken — and `test/routes/games.test.ts` checks the targets exist, since
 * that silence is exactly the failure it cannot report itself.
 *
 * No `fetch`, so it adds nothing to `connect-src`. If a future version of this
 * block ever does talk to the network, re-read the "a hash lets a script run"
 * section above first.
 */
export const COPY_BUTTON_JS = `
(function () {
  if (!navigator.clipboard || typeof navigator.clipboard.writeText !== "function") return;
  var buttons = document.querySelectorAll("button[data-copy]");
  for (var i = 0; i < buttons.length; i++) {
    (function (button) {
      var field = document.getElementById(button.getAttribute("data-copy"));
      if (!field) return;
      button.hidden = false;
      button.addEventListener("click", function () {
        navigator.clipboard.writeText(field.value).then(function () {
          var original = button.textContent;
          button.textContent = "Copied";
          setTimeout(function () { button.textContent = original; }, 2000);
        }).catch(function () {
          // The field is still there and still selectable — say so rather than
          // failing silently, which is the diagnosability lesson from the passkey
          // scripts' bare .catch() (docs/known-issues.md).
          button.textContent = "Press and hold to copy";
        });
      });
    })(buttons[i]);
  }
})();
`;

/**
 * "Post to WhatsApp too", on the broadcast compose page (M22).
 *
 * A broadcast's body is never stored (M15 spec §8), so there is no page after
 * Send that could offer it — this keeps a `wa.me` link in step with what the
 * organiser is typing, and reveals the panel it sits in. Scripting off, the
 * panel stays `hidden` and the page is the M15 compose form exactly.
 *
 * The `wa.me` prefix is **read from the anchor's own `href`**, not written
 * here: `test/views/scripts.test.ts` forbids any off-origin URL in a script
 * block, and it is right to — a script holding one is a script that may be
 * about to fetch it. This one only ever sets an anchor's `href`, which is a
 * navigation the person performs by tapping, not a request the page makes.
 *
 * The text shape — subject, blank line, message; message alone when the
 * subject is blank — is `broadcastMessage` in `src/domain/whatsapp-message.ts`,
 * and test/views/whatsapp.test.ts runs this block against a fake DOM to hold
 * the two to the same answer.
 *
 * No `fetch`, so `connect-src` is untouched.
 */
export const BROADCAST_WHATSAPP_JS = `
(function () {
  var panel = document.getElementById("whatsapp");
  var link = document.getElementById("whatsapp-link");
  var subject = document.getElementById("subject");
  var message = document.getElementById("message");
  if (!panel || !link || !subject || !message) return;
  var base = link.getAttribute("href");
  if (!base) return;
  function update() {
    var head = subject.value.trim();
    var text = head === "" ? message.value : head + "\\n\\n" + message.value;
    link.setAttribute("href", base + encodeURIComponent(text));
  }
  subject.addEventListener("input", update);
  message.addEventListener("input", update);
  update();
  panel.hidden = false;
})();
`;

/**
 * Drag a name onto a side, on the owner's fixture page (BR-35 §4).
 *
 * # The radios stay the source of truth
 *
 * This is the whole reason the block is allowed to exist. `renderTeamPicker`
 * is a plain form of radio groups, one per player, and a save posts those
 * radios — so this script **never posts anything, never disables the form and
 * never becomes required**. A drop does exactly two things: it sets the
 * corresponding radio's `checked`, and it moves the row into that side's
 * column. Everything downstream — the save route, the publish guard, the
 * emails — reads the same radios it read before this block existed, which is
 * what makes "picked by dragging" and "picked by clicking" provably the same
 * act rather than two code paths that agree by inspection.
 *
 * The corollary is the `change` listener: an organiser who ignores the
 * columns and clicks a radio must not be left with a name sitting under a
 * side its radio contradicts. Moving the row on `change` keeps the one state
 * this page has looking like one state. **It is also the one place this block
 * can make a person worse off than no block at all**, which is why `place`
 * carries focus across the move — see the note there.
 *
 * # What happens when it does not run
 *
 * The columns ship `hidden` and this reveals them, so scripting off, an old
 * browser, or a CSP that drops this block all leave the page exactly as it
 * was in Tasks 1-6: a list of named radio groups and a Save button. Every
 * guard below returns before touching anything, and the early returns are
 * *why* there is no error message anywhere in here — unlike the copy-invite
 * button there is no user-visible action that can begin and then fail. There
 * is no promise, no callback and therefore no `catch` to swallow: the
 * diagnosability defect `docs/known-issues.md` records for the passkey blocks
 * has no shape to take here.
 *
 * No `fetch`, so `connect-src` is untouched. If that ever changes, read the
 * "a hash lets a script run" section at the top of this file first.
 */
export const TEAM_PICKER_JS = `
(function () {
  var form = document.getElementById("team-picker");
  var columns = document.getElementById("team-columns");
  if (!form || !columns) return;

  // Drag and drop is the one capability this block cannot do without, so it
  // is detected the way the passkey blocks detect WebAuthn: on the element
  // and the API, before anything on the page is touched.
  var probe = document.createElement("li");
  if (!("draggable" in probe)) return;
  if (typeof probe.closest !== "function") return;
  if (typeof probe.contains !== "function") return;
  if (!probe.classList) return;
  if (typeof window.DataTransfer !== "function") return;

  // Every drop target carries the value it stands for, including the pool of
  // players nobody has placed yet (\`data-team=""\`, the "Not picked yet"
  // radio). One attribute for all three means dragging a name back out of a
  // side is the same code as dragging it in, rather than a case that has to
  // be remembered.
  var lists = form.querySelectorAll("ul[data-team]");
  var rows = form.querySelectorAll("li[data-player]");
  if (lists.length === 0 || rows.length === 0) return;

  // The radios are found by walking the row rather than by building a
  // selector from the player id: the id is the radio group's \`name\`, and a
  // selector assembled from data is a class of bug this page has no need to
  // be exposed to.
  function radioFor(row, team) {
    var inputs = row.getElementsByTagName("input");
    for (var i = 0; i < inputs.length; i++) {
      if (inputs[i].type === "radio" && inputs[i].value === team) return inputs[i];
    }
    return null;
  }

  function checkedValue(row) {
    var inputs = row.getElementsByTagName("input");
    for (var i = 0; i < inputs.length; i++) {
      if (inputs[i].type === "radio" && inputs[i].checked) return inputs[i].value;
    }
    return null;
  }

  function listFor(team) {
    for (var i = 0; i < lists.length; i++) {
      if (lists[i].getAttribute("data-team") === team) return lists[i];
    }
    return null;
  }

  // Counted off the radios, never off how many rows sit in a column: the
  // radios are what the save posts, so a head count taken from anything else
  // could disagree with the pick the organiser is about to store.
  function recount() {
    var counts = form.querySelectorAll("[data-count]");
    for (var i = 0; i < counts.length; i++) {
      var team = counts[i].getAttribute("data-count");
      var total = 0;
      for (var j = 0; j < rows.length; j++) {
        var radio = radioFor(rows[j], team);
        if (radio && radio.checked) total++;
      }
      counts[i].textContent = String(total);
    }
  }

  function place(row, team) {
    var radio = radioFor(row, team);
    var list = listFor(team);
    // A row with no radio for this side, or a side with no column, is left
    // exactly where it is: half a move would put the picture and the form out
    // of step, which is the one thing this block must never do.
    if (!radio || !list) return;
    radio.checked = true;
    // \`appendChild\` detaches the row, and detaching blurs whatever inside it
    // held focus. Left alone that makes this block *worse than absent* for
    // anyone picking with a keyboard: Space checks the radio, the row moves,
    // focus lands on <body>, and arrowing to the next side is impossible —
    // an interaction that is perfectly ordinary with scripting off. So the
    // focus is carried across the move. Read before, restored after; a drop
    // leaves focus on <body>, so this is a no-op for the mouse.
    var focused = row.contains(document.activeElement) ? document.activeElement : null;
    list.appendChild(row);
    if (focused && typeof focused.focus === "function") focused.focus();
    recount();
  }

  var dragging = null;

  for (var r = 0; r < rows.length; r++) {
    (function (row) {
      row.draggable = true;
      row.addEventListener("dragstart", function (event) {
        dragging = row;
        row.classList.add("dragging");
        if (event.dataTransfer) {
          // Some browsers start no drag at all unless data is set, even when
          // the drop handler never reads it.
          event.dataTransfer.setData("text/plain", row.getAttribute("data-player") || "");
          event.dataTransfer.effectAllowed = "move";
        }
      });
      row.addEventListener("dragend", function () {
        dragging = null;
        row.classList.remove("dragging");
      });
    })(rows[r]);
  }

  for (var l = 0; l < lists.length; l++) {
    (function (list) {
      list.addEventListener("dragover", function (event) {
        // Preventing the default is what makes an element a drop target at
        // all; without it the drop event never fires and the name springs
        // back with no explanation.
        if (!dragging) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
        list.classList.add("over");
      });
      list.addEventListener("dragleave", function () {
        list.classList.remove("over");
      });
      list.addEventListener("drop", function (event) {
        event.preventDefault();
        list.classList.remove("over");
        if (!dragging) return;
        place(dragging, list.getAttribute("data-team") || "");
      });
    })(lists[l]);
  }

  form.addEventListener("change", function (event) {
    var input = event.target;
    if (!input || input.type !== "radio") return;
    var row = input.closest("li[data-player]");
    if (row) place(row, input.value);
  });

  columns.hidden = false;
  // Sort what the server already rendered into the columns, so the two
  // pictures start out agreeing. A pick saved earlier arrives with its radios
  // checked and its rows in the flat list; leaving them there would show an
  // organiser two empty sides above a completed pick.
  for (var s = 0; s < rows.length; s++) {
    var value = checkedValue(rows[s]);
    if (value !== null) place(rows[s], value);
  }
  recount();
})();
`;

/**
 * Registers the service worker (M13).
 *
 * The fifth script block in the project, and the first that every page
 * carries. It earns its place on the same ground as the passkey ones: there
 * is no server-side substitute — a service worker can only be registered by
 * a page, from script.
 *
 * Enhancement, not provision. Registration failing for any reason at all —
 * an old browser, a private window, a corporate policy, a user who has
 * scripting off — must leave every page exactly as it already was, which is
 * fully working. Nothing on this site needs the worker to function; it adds
 * an offline page and makes the app installable.
 *
 * The `catch` is deliberately empty rather than logging. A failed
 * registration is not an error condition for the visitor, and a console error
 * on every page load would trip the browser-test console gate for something
 * that is working as designed.
 *
 * Deliberately **not** a member of `PAGE_SCRIPT_BLOCKS`: that array is what
 * `layout()`'s `pageScripts` parameter is typed against, i.e. the set a page
 * can *opt into*, and this block is never opted into — every page carries it,
 * the same way every page carries `STYLES` in `src/views/styles.ts` without
 * being able to opt out. See `SCRIPT_BLOCKS` below for where it actually
 * joins the enumeration the CSP hashes.
 *
 * `window.addEventListener("load", ...)`, the idiom every guide for this API
 * reaches for, deferring registration off the critical path of the initial
 * page load. An earlier version of this block dropped the deferral (and,
 * briefly, tried `window.onload = ...` instead) because both idioms put the
 * literal substring "event" or "onload" into the served bytes of *every*
 * page, and two vocabulary-guard tests — `test/routes/respond-get.test.ts`
 * and `test/views/fixture.test.ts` — happened to ban those words in the
 * pages they cover. That was the wrong fix: `PASSKEY_SIGN_IN_JS`,
 * `PASSKEY_REGISTER_JS`, `COPY_BUTTON_JS` and `TEAM_PICKER_JS` already ship
 * `addEventListener` and bare `event` identifiers to real browsers on
 * `/sign-in`, `/app/passkeys`, `/g/:id` and the owner fixture page, so "no
 * 'event' anywhere in the served bytes" was never a real site-wide
 * invariant — only an accident of which pages happened to have both a
 * vocabulary test and no page script. The two vocabulary tests now strip
 * `<script>…</script>` before scanning (the same technique
 * `test/routes/team-publish.test.ts` uses to separate "no script" from
 * "no domain vocabulary in the copy"), so this block is free to use the
 * idiomatic form its behaviour actually calls for.
 */
export const SERVICE_WORKER_JS = `
(function () {
  if (!("serviceWorker" in navigator)) return;
  var hadController = !!navigator.serviceWorker.controller;
  window.addEventListener("load", function () {
    navigator.serviceWorker.register("${SERVICE_WORKER_PATH}").catch(function () {});
  });

  // The new-version overlay (M18). Only for the installed app: a browser tab
  // gets fresh pages on every navigation, but an installed PWA can sit open
  // for days with no reload control of its own. "controllerchange" fires
  // when an updated worker takes over this page (the worker skips its
  // wait phase and claims open pages as soon as the browser's own update
  // check finds a new deploy); the hadController guard keeps the very
  // first install - a change from no controller to one, not an update -
  // from announcing a new version to a brand-new page.
  if (!window.matchMedia || !window.matchMedia("(display-mode: standalone)").matches) return;
  navigator.serviceWorker.addEventListener("controllerchange", function () {
    if (!hadController) {
      hadController = true;
      return;
    }
    if (document.querySelector(".update-overlay")) return;
    var overlay = document.createElement("div");
    overlay.className = "update-overlay";
    var text = document.createElement("p");
    text.textContent = "A new version is available.";
    var button = document.createElement("button");
    button.type = "button";
    button.className = "button primary";
    button.textContent = "Refresh";
    button.addEventListener("click", function () {
      button.disabled = true;
      button.textContent = "Refreshing\u2026";
      location.reload();
    });
    overlay.appendChild(text);
    overlay.appendChild(button);
    document.body.appendChild(overlay);
  });
})();
`;

/**
 * Upgrades the install section on the account page (M13).
 *
 * Feature detection only — never user-agent sniffing. `beforeinstallprompt`
 * is a Chromium event and its absence is exactly the signal that the manual
 * instructions are the only route, which is the case on every iPhone.
 *
 * Three transitions, all of them subtractive if anything is missing:
 *   - already installed (display-mode: standalone) → hide the how-to, show
 *     the confirmation;
 *   - installable → hide the how-to, show the button, and fire the saved
 *     prompt on click;
 *   - neither → change nothing, and the server-rendered instructions stand.
 *
 * Unlike `SERVICE_WORKER_JS`, this *is* a member of `PAGE_SCRIPT_BLOCKS`:
 * the registration above is unconditional, carried by every page, while this
 * enhancement is opted into by the one page that renders
 * `renderThisDeviceSection()` (`src/views/install.ts`) — the ordinary case the
 * enumeration exists for, not the site-wide exception `SERVICE_WORKER_JS` is.
 *
 * No `fetch`, so `connect-src` is untouched. If that ever changes, read the
 * "a hash lets a script run" section at the top of this file first.
 */
export const INSTALL_JS = `
(function () {
  var section = document.querySelector(".install");
  if (!section) return;

  var steps = section.querySelector("[data-install-steps]");
  var intro = section.querySelector("[data-install-instructions]");
  var button = section.querySelector("[data-install-button]");
  var done = section.querySelector("[data-install-done]");

  if (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) {
    if (steps) steps.hidden = true;
    if (intro) intro.hidden = true;
    if (done) done.hidden = false;
    return;
  }

  var saved = null;
  window.addEventListener("beforeinstallprompt", function (event) {
    // Chromium shows its own prompt otherwise, at a moment of its choosing.
    event.preventDefault();
    saved = event;
    if (steps) steps.hidden = true;
    if (button) button.hidden = false;
  });

  if (button) {
    button.addEventListener("click", function () {
      if (!saved) return;
      saved.prompt();
      // A prompt can only be used once. Whatever the player chose, this one
      // is spent, and holding a stale event would give them a button that
      // does nothing the second time.
      saved = null;
      button.hidden = true;
      if (steps) steps.hidden = false;
    });
  }

  window.addEventListener("appinstalled", function () {
    if (button) button.hidden = true;
    if (steps) steps.hidden = true;
    if (intro) intro.hidden = true;
    if (done) done.hidden = false;
  });
})();
`;

/**
 * The DOM contract `PUSH_SUBSCRIBE_JS` reads from, exported by name rather
 * than left as string literals inside the block below (M14 Task 11 review,
 * finding 2).
 *
 * `PUSH_SUBSCRIBE_JS`'s own markup lives on whichever page opts into it —
 * Task 12's account page and post-response offer — and that markup was, on
 * the first pass, a set of ids and an attribute name typed independently in
 * two files that agree only by convention. A typo on either side —
 * `id="notify-button"` where the script reads `push-button` — would
 * typecheck, lint and pass every test that does not specifically assert the
 * two strings match, and leave the affordance permanently, silently inert.
 * Importing these four constants at both call sites turns that mismatch
 * into a compile error instead.
 */
export const PUSH_BUTTON_ID = "push-button";
/** Where `PUSH_SUBSCRIBE_JS` explains a denial or a failed subscribe attempt. */
export const PUSH_PROBLEM_ID = "push-problem";
/**
 * The attribute `PUSH_SUBSCRIBE_JS` reads the VAPID public key from. Not
 * present at all is a valid, intended state (see the "data-" section below) —
 * whoever renders the button decides whether to emit it.
 */
export const PUSH_KEY_ATTRIBUTE = "data-push-key";
/**
 * The attribute `PUSH_SUBSCRIBE_JS` reads a response token from (M14 Task 12
 * review, Finding 2). Absent on the account page, which relies on the
 * session `resolvePlayerId` already reads (`src/routes/push.ts`) — that page
 * renders no token at all, on purpose, so there is nothing here to leak
 * beyond what a signed-in visitor's own session already proves. Present on
 * the response-confirmation page's one-time offer: that page's entire
 * audience is signed out (a `/r/:token` visitor), so without a token in the
 * subscribe POST, `resolvePlayerId` finds neither a session nor a body
 * `token` and answers 404 — the offer's button could never have worked, and
 * the once-ever prompt would already have been spent on it by the time the
 * click happened.
 */
export const PUSH_TOKEN_ATTRIBUTE = "data-push-token";
/**
 * The friendly-name field revealed alongside the button ("Ed's phone").
 * Its value rides in the subscribe POST as `name`; blank is fine — the
 * route stores null and the list falls back to the user-agent caption.
 */
export const PUSH_NAME_ID = "push-name";
/**
 * The inline acknowledgement revealed after a successful subscribe — but
 * only when `PUSH_RELOAD_ATTRIBUTE` is absent. A page that gave the button
 * somewhere to navigate acknowledges by arriving there instead.
 */
export const PUSH_DONE_ID = "push-done";
/**
 * Where to navigate after a successful subscribe. The account page sets it
 * to its own URL with a confirmation flag, so the new device appears in the
 * table that page renders — an inline "done" note beside a table still
 * missing the row it describes would be worse than a round trip.
 */
export const PUSH_RELOAD_ATTRIBUTE = "data-push-reload";
/**
 * The label to swap onto the button when the this-device check finds this
 * browser already registered — server copy, carried as data rather than
 * typed in this script, so the words live with the rest of the page's.
 */
export const PUSH_REENABLE_ATTRIBUTE = "data-push-reenable";

/**
 * Asks for notification permission and registers a device (M14 Task 11).
 *
 * A page-specific enhancement, unlike `SERVICE_WORKER_JS`: it is opted into
 * by whichever page renders the permission button — the account page and the
 * one-time post-response offer, both landing in M14 Task 12 — the same way
 * `INSTALL_JS` is opted into by the page that renders
 * `renderThisDeviceSection()`. This block does not itself register the worker;
 * `SERVICE_WORKER_JS` already does that, unconditionally, on every page.
 *
 * # Feature detection, in the order the API actually needs each piece
 *
 * `"serviceWorker" in navigator` first — a push subscription is created
 * through a service worker registration, so there is nothing to do at all
 * without one, and this is the same guard `SERVICE_WORKER_JS` opens with.
 * Then `"PushManager" in window`, the Push API itself, and
 * `typeof Notification === "function"` (not `!== "undefined"`: iOS Safari
 * defines a non-callable stub before the app is installed to the Home
 * Screen, so `typeof` alone would pass and `Notification.requestPermission`
 * would then throw). Any one missing and the button stays exactly as the
 * server rendered it — hidden, if the caller ships it that way — which is
 * the same "scripting off and scripting on are the same page" rule every
 * other block here follows.
 *
 * # The permission prompt lives inside the click handler, on both platforms
 *
 * `Notification.requestPermission()` is called nowhere but the `click`
 * listener. Both Chromium and Safari require a user gesture in the same call
 * stack; calling it from a `load` handler like `SERVICE_WORKER_JS` does
 * silently fails everywhere, and on iOS the whole `Notification` object does
 * not exist until the gesture that installed the app already happened, so
 * there is no earlier moment to call it from even if the platform allowed it.
 *
 * # A denied permission cannot be re-requested by the page
 *
 * `Notification.requestPermission()` resolves back to `"denied"` immediately
 * on a browser that already denied it — no prompt, no way for a page to ask
 * again, ever, short of the visitor opening their own browser settings. A
 * button that stays present and silently does nothing on every click is
 * worse than no button, so `"denied"` hides it and swaps in a sentence that
 * says why, both on load (someone who denied it last visit) and from the
 * result of a click that resolves `"denied"` for the first time.
 *
 * # The key comes from a `data-` attribute, not a hardcoded constant
 *
 * `applicationServerKey` has to be the base64url-encoded **public** half of
 * whichever VAPID pair this deployment is currently signing with
 * (`VAPID_PUBLIC_KEY` in `src/env.ts`) — baking it into this string, which
 * `SCRIPT_BLOCKS` hashes once per isolate, would mean rotating the pair
 * requires a deploy that changes source, when the value is already a
 * same-origin server response away. Reading it off `PUSH_KEY_ATTRIBUTE` on
 * the button keeps the key exactly as current as the page that rendered it,
 * and — the point M14's brief calls out by name — lets the *caller* decide
 * not to render the attribute at all while `VAPID_PUBLIC_KEY` is unset (M14
 * ships dark: production has no VAPID pair until the owner generates one).
 * No attribute, no key, nothing this script can subscribe with, so it
 * returns rather than revealing a button that can only fail.
 *
 * # What a click actually does
 *
 * Ask for permission; if it is not `"granted"`, stop (denied is handled
 * above, and a dismissed prompt — neither granted nor denied — just leaves
 * the button as it was, so a visitor who was not ready can click it again).
 * Otherwise wait for `navigator.serviceWorker.ready` — `SERVICE_WORKER_JS`
 * registers on `load` and this script cannot assume that has finished — and
 * call `pushManager.subscribe`. The resulting subscription's own `toJSON()`
 * carries `endpoint` and `keys`, wrapped under a `subscription` key in the
 * POST body — the shape `POST ${PUSH_SUBSCRIBE_PATH}` actually reads
 * (`isSubscriptionInput`/`body["subscription"]` in `src/routes/push.ts`).
 * **This wrapping is load-bearing and was missing for the whole of M14 Task
 * 12** (review Finding 1): the route 400s on anything else, so every
 * subscribe attempt failed silently behind this script's own `.catch()`
 * until it was added — `connect-src 'self'` making the `fetch` reachable at
 * all was never the problem, the two ends were simply describing different
 * bodies. `test/routes/push.test.ts` now runs this exact block (not a
 * hand-built payload) against the real route, so the two cannot drift apart
 * silently again.
 *
 * `${PUSH_TOKEN_ATTRIBUTE}` rides along in the same body, only when the
 * button carries one: the account page's button never does (its caller is
 * signed in, and `resolvePlayerId` in `src/routes/push.ts` reads the
 * session), while the response-confirmation offer's button always does — see
 * that constant's own doc comment for why omitting it there means the whole
 * offer 404s.
 *
 * A failure anywhere in that chain (subscribe refused, the POST failing, a
 * network error) re-enables the button and says the attempt didn't work,
 * matching the diagnosability lesson `docs/known-issues.md` records for the
 * passkey blocks' original bare `.catch()`.
 */
export const PUSH_SUBSCRIBE_JS = `
(function () {
  var button = document.getElementById("${PUSH_BUTTON_ID}");
  var problem = document.getElementById("${PUSH_PROBLEM_ID}");
  if (!button) return;
  if (!("serviceWorker" in navigator)) return;
  if (!("PushManager" in window)) return;
  if (typeof Notification !== "function") return;

  var key = button.getAttribute("${PUSH_KEY_ATTRIBUTE}");
  if (!key) return;

  var token = button.getAttribute("${PUSH_TOKEN_ATTRIBUTE}");
  var reloadTo = button.getAttribute("${PUSH_RELOAD_ATTRIBUTE}");
  var nameField = document.getElementById("${PUSH_NAME_ID}");
  // The input is nested inside its label, so the label is what hides and
  // reveals as one unit with the button.
  var nameLabel = nameField ? nameField.parentNode : null;
  var done = document.getElementById("${PUSH_DONE_ID}");

  function showDenied() {
    button.hidden = true;
    if (nameLabel) nameLabel.hidden = true;
    if (problem) {
      problem.textContent = "Notifications are blocked for this site. You can turn them back on in your browser's site settings.";
      problem.hidden = false;
    }
  }

  if (Notification.permission === "denied") {
    showDenied();
    return;
  }

  button.hidden = false;
  if (nameLabel) nameLabel.hidden = false;

  // Which row of the device table is the browser this script is running in?
  // Only the browser knows (the server sees identical requests from every
  // device), so the badge ships hidden and this comparison reveals it. The
  // endpoints read here are the hidden form fields the page already
  // carries — a read, not a new disclosure. "ready" resolves only once a
  // worker is active; if registration failed the promise simply stays
  // pending and the page keeps its server-rendered shape, which is the
  // correct degraded answer.
  navigator.serviceWorker.ready.then(function (registration) {
    return registration.pushManager.getSubscription();
  }).then(function (existing) {
    if (!existing) return;
    var fields = document.querySelectorAll('table.push-devices input[name="endpoint"]');
    for (var i = 0; i < fields.length; i++) {
      if (fields[i].value !== existing.endpoint) continue;
      var row = fields[i].closest("tr");
      var badge = row ? row.querySelector(".this-device") : null;
      if (badge) badge.hidden = false;
      var reenable = button.getAttribute("${PUSH_REENABLE_ATTRIBUTE}");
      if (reenable) button.textContent = reenable;
    }
  }).catch(function () {});

  function urlBase64ToUint8Array(base64) {
    var padding = "====".substring(0, (4 - (base64.length % 4)) % 4);
    var base64Safe = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
    var raw = atob(base64Safe);
    var bytes = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return bytes;
  }

  button.addEventListener("click", function () {
    if (problem) problem.hidden = true;
    button.disabled = true;

    Notification.requestPermission().then(function (permission) {
      if (permission === "denied") {
        showDenied();
        return;
      }
      if (permission !== "granted") {
        // Neither granted nor denied: the prompt was dismissed rather than
        // answered. Nothing was refused, so the button just becomes
        // clickable again rather than claiming a failure that didn't happen.
        button.disabled = false;
        return;
      }

      navigator.serviceWorker.ready.then(function (registration) {
        return registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(key)
        });
      }).then(function (subscription) {
        var json = subscription.toJSON();
        var body = { subscription: { endpoint: json.endpoint, keys: json.keys } };
        if (token) body.token = token;
        if (nameField && nameField.value) body.name = nameField.value;
        return fetch("${PUSH_SUBSCRIBE_PATH}", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body)
        });
      }).then(function (response) {
        if (!response.ok) throw new Error("subscribe");
        if (reloadTo) {
          // The device table on this page is now missing the row that was
          // just created; arriving back at the page is the acknowledgement.
          location.assign(reloadTo);
          return;
        }
        button.hidden = true;
        if (nameLabel) nameLabel.hidden = true;
        if (done) done.hidden = false;
      }).catch(function () {
        button.disabled = false;
        if (problem) {
          problem.textContent = "That didn't work. You can try again.";
          problem.hidden = false;
        }
      });
    }).catch(function () {
      // Notification.requestPermission() itself rejecting (rather than
      // resolving to "denied") is rare, but not guarded by the inner
      // subscribe chain's own .catch above — that one only covers
      // serviceWorker.ready onward. Without this, a rejection here leaves
      // button.disabled = true (set just above) permanently, with no
      // message shown — a dead control, which is exactly what this block
      // exists to prevent.
      button.disabled = false;
      if (problem) {
        problem.textContent = "That didn't work. You can try again.";
        problem.hidden = false;
      }
    });
  });
})();
`;

/**
 * Every page-specific script, for `layout()`'s `pageScripts` parameter to be
 * typed against. See the module comment for what enforces membership.
 *
 * `SERVICE_WORKER_JS` is deliberately absent — see its own comment for why.
 */
export const PAGE_SCRIPT_BLOCKS = [
  PASSKEY_SIGN_IN_JS,
  PASSKEY_REGISTER_JS,
  COPY_BUTTON_JS,
  BROADCAST_WHATSAPP_JS,
  TEAM_PICKER_JS,
  INSTALL_JS,
  PUSH_SUBSCRIBE_JS,
] as const;

export type PageScriptBlock = (typeof PAGE_SCRIPT_BLOCKS)[number];

/**
 * The complete set of `<script>` blocks the app can ever emit — the site-wide
 * service worker registration plus every page-specific block above. Mirrors
 * `STYLE_BLOCKS = [STYLES, ...PAGE_STYLE_BLOCKS]` in `src/views/styles.ts`
 * exactly, including the reason: `layout()` emits `SERVICE_WORKER_JS`
 * unconditionally (never through `pageScripts`), so it has to be added to
 * this array by hand rather than arriving automatically the way a
 * `PAGE_SCRIPT_BLOCKS` member does.
 *
 * **This is the value a CSP's `script-src` hashing must map over** — see the
 * module comment for the exact change M4's `src/security/csp.ts` has to make.
 */
export const SCRIPT_BLOCKS = [SERVICE_WORKER_JS, ...PAGE_SCRIPT_BLOCKS] as const;

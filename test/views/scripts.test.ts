/// <reference types="vite/client" />
// `import.meta.glob` is Vite's, resolved at transform time — the mechanism the
// merge tripwire below is built on. `tsconfig.json`'s `types` array is a
// closed list (workers-types, the pool's types, node), so the reference has to
// be made explicitly here rather than inherited; it is scoped to this file
// on purpose, since nothing in `src/` may depend on a bundler feature.
import { describe, expect, it } from "vitest";
import * as scripts from "../../src/views/scripts.js";
import { PAGE_SCRIPT_BLOCKS, PRESENCE_JS, SCRIPT_BLOCKS, SERVICE_WORKER_JS } from "../../src/views/scripts.js";
import { STYLE_BLOCKS } from "../../src/views/styles.js";

/**
 * The enumeration M4's Content-Security-Policy will hash, and the tripwire
 * that makes it impossible to merge M4 without noticing.
 */

describe("the script enumeration", () => {
  it("contains every script block this module exports", () => {
    // The type union in `layout()` catches a block that is *used* without
    // being enumerated. This catches the other half: a block that exists,
    // gets enumerated nowhere, and is passed somewhere the type is widened —
    // or simply forgotten and then quietly reached for later.
    const exported = Object.entries(scripts)
      .filter(([name]) => name.endsWith("_JS"))
      .map(([, value]) => value as string);

    expect(exported.length).toBeGreaterThan(0);
    for (const block of exported) {
      expect(SCRIPT_BLOCKS as readonly string[]).toContain(block);
    }
    expect(SCRIPT_BLOCKS).toHaveLength(exported.length);
    // SERVICE_WORKER_JS is deliberately not a PAGE_SCRIPT_BLOCKS member (it is
    // never opted into — see its own comment in src/views/scripts.ts), so the
    // enumeration this test pins is SCRIPT_BLOCKS = [SERVICE_WORKER_JS,
    // ...PAGE_SCRIPT_BLOCKS], not the bare page-script array.
    // PRESENCE_JS (M33) is the second block of that kind: `layout()` emits it
    // on every page carrying `nav`, so it is never opted into either and it
    // has to be listed here by hand for the same reason.
    expect([...SCRIPT_BLOCKS]).toEqual([SERVICE_WORKER_JS, PRESENCE_JS, ...PAGE_SCRIPT_BLOCKS]);
  });

  it("is inline, same-origin and free of anything a hash cannot cover", () => {
    for (const block of SCRIPT_BLOCKS) {
      // `default-src 'none'` forbids every external host, and there is no CDN
      // in this project. Every fetch must be a same-origin absolute path.
      expect(block, "no off-origin URL").not.toMatch(/https?:\/\//);
      expect(block, "no protocol-relative URL").not.toMatch(/["']\/\//);
      // A hash covers the text of an inline element; it cannot cover script
      // conjured at runtime, and `'unsafe-eval'` is not on the table.
      expect(block, "no eval").not.toMatch(/\beval\s*\(/);
      expect(block, "no Function constructor").not.toMatch(/new Function\s*\(/);
      expect(block, "no document.write").not.toContain("document.write");
      // Nothing may inject further script, which would need its own hash.
      expect(block, "no innerHTML").not.toContain("innerHTML");
      // A `</script>` in the text would end the tag early.
      expect(block, "cannot break out of its own tag").not.toContain("</script");
      // Feature-detected before it touches the page: "scripting on but the
      // capability is missing" must look exactly like "scripting off". The
      // two WebAuthn scripts detect `PublicKeyCredential`; `COPY_BUTTON_JS`
      // (M6a Task 7, generalised in M22) is not a WebAuthn affordance at all and instead detects
      // `navigator.clipboard`, so this checks for either rather than only the
      // one every block used to share. `TEAM_PICKER_JS` (M9 Task 7) is a third
      // kind again: it needs drag and drop, so it detects `window.DataTransfer`
      // before it makes a single row draggable or reveals a single column, and
      // a browser without it keeps the picker's radio form exactly as served.
      // `SERVICE_WORKER_JS` (M13) is a fourth: it detects `"serviceWorker" in
      // navigator` before it ever calls `.register(...)`, so an old browser
      // takes the same early return every other block does.
      //
      // Deliberately not a bare substring match on the guard token: a script
      // that called `navigator.clipboard.writeText(...)` with no guard at all
      // would still contain the literal string "navigator.clipboard" — in the
      // very call that would break the page for a browser without it — and a
      // substring check would wave it through. This instead requires the
      // token to sit inside an `if (...) return;` guard clause, which is what
      // every block below actually does before it touches the API.
      // SERVICE_WORKER_JS's guard is `if (!("serviceWorker" in navigator))
      // return;` — a double close-paren the other three blocks' guards don't
      // have (the extra one belongs to `!(...)`), so it gets its own
      // alternative rather than reusing the single-`\)` shape above.
      // `INSTALL_JS` (M13 Task 6) is a fifth kind, and a different shape
      // again: it has no single browser capability whose absence must short-
      // circuit the whole block, because every API it touches already
      // degrades safely on its own — `window.matchMedia` is checked inline
      // before use, and `beforeinstallprompt`/`appinstalled` are ordinary
      // events that simply never fire on a browser that doesn't dispatch
      // them. What it guards instead is its DOM anchor: `if (!section)
      // return;` before anything else, so a page that never rendered
      // `renderInstallSection()` — or a future markup change that drops the
      // `.install` class — gets the same silent no-op every other block gets
      // for a missing capability. `BROADCAST_WHATSAPP_JS` (M22) is the same
      // shape as INSTALL_JS — `encodeURIComponent` and `setAttribute` need no
      // detecting — and guards its four DOM anchors together: `if (!panel ||
      // !link || !subject || !message) return;`. `FRESHNESS_JS` (M24) is the
      // same shape again and for the same reason: `Date.now`, `setInterval`
      // and `document.hidden` all predate service workers by years, so there
      // is no capability whose absence should silence it — only its own bar,
      // `if (!bar) return;`, which a page that never called `renderFreshness`
      // has not rendered.
      // `PRESENCE_JS` (M33) is a capability guard again rather than a DOM
      // one: everything it does is a `fetch`, so `if (!window.fetch) return;`
      // is both the detection and the whole reason to carry on.
      // `WHATSAPP_LINKS_JS` (M38) is a DOM guard for the same reason as
      // `BROADCAST_WHATSAPP_JS` beside it — `encodeURIComponent`,
      // `setAttribute` and `checked` need no detecting — and it guards the
      // two anchors a group cannot work without: `if (!field || !link)
      // return;`. It runs per matched fieldset, so a page with no WhatsApp
      // card matches nothing and does nothing, which is the same silent
      // no-op by another route.
      // `SIGN_IN_SUBMIT_JS` (August 2026) is that same shape once more:
      // `addEventListener` and `disabled` need no detecting, so what it
      // guards is its two anchors together — `if (!form || !button) return;`
      // — and a page without the sign-in form gets the usual silent no-op.
      expect(block, "must feature-detect before use, in a guard-then-return").toMatch(
        /if\s*\([^)]*PublicKeyCredential[^)]*\)\s*return;|if\s*\([^)]*navigator\.clipboard[^)]*\)\s*return;|if\s*\([^)]*DataTransfer[^)]*\)\s*return;|if\s*\(!\([^)]*serviceWorker[^)]*\)\)\s*return;|if\s*\(!section\)\s*return;|if\s*\(!bar\)\s*return;|if\s*\(!panel \|\| !link \|\| !subject \|\| !message\)\s*return;|if\s*\(!form \|\| !button\)\s*return;|if\s*\(!field \|\| !link\)\s*return;|if\s*\(!window\.fetch\)\s*return;/,
      );
    }
  });

  /**
   * **The merge tripwire for M4.**
   *
   * M4 (unmerged, code-complete on its own branch) ships a CSP containing
   * `script-src 'none'`, set on the stated grounds that this site had no
   * client JavaScript. M5 Task 8 made that false. Nothing on *this* branch
   * can test against a header that does not exist here, and the note in
   * `src/views/scripts.ts` is only a note — this project has already had one
   * merge marker upgraded to a tripwire because a comment cannot fire.
   *
   * So this test fires the moment `src/security/` arrives. `import.meta.glob`
   * is resolved by Vite at transform time: today the pattern matches nothing
   * and the loop below is vacuous. After the merge it matches M4's `csp.ts`,
   * and the assertions demand exactly the two changes that file needs — its
   * `script-src` computed from `SCRIPT_BLOCKS`, and its `style-src` switched
   * from two hardcoded imports to mapping `STYLE_BLOCKS` (the instruction
   * Task 7 left in `src/views/styles.ts`).
   *
   * Deliberately a source-text check rather than a check of the emitted
   * header: this branch cannot know M4's export names or function signature,
   * and a test that guessed them would fail to compile at merge instead of
   * failing with a message that says what to do. If the merger implements
   * both properly, this test goes green on its own; if they satisfy it
   * cosmetically without wiring the hashes up, the browser is the next thing
   * to complain, so it is worth replacing this with an assertion on the real
   * header once the two branches are one.
   */
  /**
   * Strips `//` and `/* *\/` comments before the tripwire below looks for
   * `SCRIPT_BLOCKS` / `STYLE_BLOCKS`, so that a comment mentioning the name —
   * "TODO: wire up SCRIPT_BLOCKS" — cannot discharge it. (M5 Task 8 review,
   * minor #1: the check used to be satisfied by the bare string appearing
   * anywhere in the file, comments included.) Good enough for this purpose —
   * it does not need to be a real parser, only to refuse to be satisfied by
   * prose that never reaches code — but it is still only a source-text check.
   * **Once M4's `csp.ts` is merged, replace this whole test with an assertion
   * on the real emitted `Content-Security-Policy` header** (fetch a page,
   * read the header, assert it contains the hash of every `SCRIPT_BLOCKS` /
   * `STYLE_BLOCKS` entry) — a header is the actual guarantee; a source-text
   * check is only ever a stand-in for one that cannot exist until both
   * branches are one.
   */
  function withoutComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  }

  it("fails loudly once M4's csp.ts exists without hashing these blocks", () => {
    const cspSources = import.meta.glob("../../src/security/*.ts", {
      query: "?raw",
      import: "default",
      eager: true,
    }) as Record<string, string>;

    for (const [path, source] of Object.entries(cspSources)) {
      if (!path.endsWith("csp.ts")) continue;

      const code = withoutComments(source);

      expect(
        code,
        `${path} must compute script-src from SCRIPT_BLOCKS in src/views/scripts.ts — ` +
          "M5 added inline passkey scripts and `script-src 'none'` will drop them silently. " +
          "Hash every entry, no 'unsafe-inline' and no 'unsafe-hashes'. (A mention inside a " +
          "comment does not count — this check strips comments before looking.)",
      ).toContain("SCRIPT_BLOCKS");

      expect(
        code,
        `${path} must compute style-src by mapping STYLE_BLOCKS in src/views/styles.ts ` +
          "rather than importing individual blocks, so a page-specific block added later " +
          "is covered automatically (see that file's module comment). (A mention inside a " +
          "comment does not count — this check strips comments before looking.)",
      ).toContain("STYLE_BLOCKS");
    }

    // A guard on the guard: if `STYLE_BLOCKS` were ever renamed, the string
    // above would go stale and this test would pass while meaning nothing.
    expect(STYLE_BLOCKS.length).toBeGreaterThan(0);
  });
});

it("registers the service worker without requiring it to succeed", () => {
  // The rule this whole module is built on: scripting off and scripting on
  // must be the same experience. Registration failing — an old browser, a
  // private window, a policy — must leave every page exactly as it was.
  expect(SERVICE_WORKER_JS).toContain('"serviceWorker" in navigator');
  expect(SERVICE_WORKER_JS).toContain(".catch(");
});

it("is enumerated, so the CSP hashes it", () => {
  // A block that is not in this array is script the browser silently drops.
  expect(SCRIPT_BLOCKS).toContain(SERVICE_WORKER_JS);
});

it("explains itself rather than offering a dead button when permission was denied", () => {
  // A denied permission cannot be re-requested by the page (M14 Task 12,
  // spec §11 state 5). A button that silently does nothing on every click is
  // worse than a sentence saying why.
  expect(scripts.PUSH_SUBSCRIBE_JS).toContain('"denied"');
});

/**
 * The new-version overlay (M18), exercised by running the shipped
 * `SERVICE_WORKER_JS` text under faked browser globals — the same
 * run-the-real-block technique `test/routes/push.test.ts` uses for
 * `PUSH_SUBSCRIBE_JS`, and for the same reason: a hand-built stand-in could
 * drift from the block it claims to describe.
 */
describe("the update overlay in SERVICE_WORKER_JS", () => {
  interface FakeElement {
    className: string;
    textContent: string;
    type: string;
    disabled: boolean;
    children: FakeElement[];
    clickHandler: (() => void) | null;
    appendChild(child: FakeElement): void;
    addEventListener(type: string, handler: () => void): void;
  }

  function fakeElement(): FakeElement {
    return {
      className: "",
      textContent: "",
      type: "",
      disabled: false,
      children: [],
      clickHandler: null,
      appendChild(child: FakeElement) {
        this.children.push(child);
      },
      addEventListener(type: string, handler: () => void) {
        if (type === "click") this.clickHandler = handler;
      },
    };
  }

  function run(options: { standalone: boolean; hadController: boolean }) {
    const body = fakeElement();
    let controllerChange: (() => void) | null = null;
    let reloaded = 0;
    const documentFake = {
      body,
      querySelector: (selector: string) =>
        selector === ".update-overlay" && body.children.length > 0 ? body.children[0] : null,
      createElement: () => fakeElement(),
    };
    const navigatorFake = {
      serviceWorker: {
        controller: options.hadController ? {} : null,
        register: () => Promise.resolve(),
        addEventListener: (type: string, handler: () => void) => {
          if (type === "controllerchange") controllerChange = handler;
        },
      },
    };
    const windowFake = {
      matchMedia: (query: string) => ({ matches: options.standalone && query.includes("standalone") }),
      addEventListener: () => undefined,
    };
    const locationFake = {
      reload: () => {
        reloaded += 1;
      },
    };
    new Function("document", "navigator", "window", "location", scripts.SERVICE_WORKER_JS)(
      documentFake,
      navigatorFake,
      windowFake,
      locationFake,
    );
    return {
      body,
      fireControllerChange: () => controllerChange?.(),
      listening: () => controllerChange !== null,
      reloads: () => reloaded,
    };
  }

  it("does not listen at all outside the installed app", () => {
    // A browser tab gets a fresh page on every navigation; only the
    // installed PWA, which can sit open for days, needs the prompt.
    const harness = run({ standalone: false, hadController: true });
    expect(harness.listening()).toBe(false);
  });

  it("stays silent when the first-ever worker claims the page", () => {
    // First install is a change from no controller to one — not an update,
    // and announcing a new version to a brand-new page would be a lie.
    const harness = run({ standalone: true, hadController: false });
    harness.fireControllerChange();
    expect(harness.body.children).toHaveLength(0);
  });

  it("shows one overlay when an updated worker takes over, however many times the event fires", () => {
    const harness = run({ standalone: true, hadController: true });
    harness.fireControllerChange();
    harness.fireControllerChange();
    expect(harness.body.children).toHaveLength(1);
    const overlay = harness.body.children[0]!;
    expect(overlay.className).toBe("update-overlay");
    const [text, button] = overlay.children;
    expect(text!.textContent).toContain("new version");
    expect(button!.textContent).toBe("Refresh");
  });

  it("refreshes on click, saying so and disarming the button first", () => {
    const harness = run({ standalone: true, hadController: true });
    harness.fireControllerChange();
    const button = harness.body.children[0]!.children[1]!;
    button.clickHandler!();
    expect(button.disabled).toBe(true);
    expect(button.textContent).toContain("Refreshing");
    expect(harness.reloads()).toBe(1);
  });
});

describe("PASSKEY_SIGN_IN_JS in the installed app (M40)", () => {
  interface Node {
    id: string;
    hidden: boolean;
    disabled: boolean;
    textContent: string;
    className: string;
    parentNode: Parent | null;
    addEventListener(type: string, handler: () => void): void;
    clickHandler: (() => void) | null;
  }
  interface Parent {
    children: Node[];
    insertBefore(node: Node, before: Node): void;
  }

  function node(id: string): Node {
    return {
      id,
      hidden: true,
      disabled: false,
      textContent: "",
      className: "",
      parentNode: null,
      clickHandler: null,
      addEventListener(type, handler) {
        if (type === "click") this.clickHandler = handler;
      },
    };
  }

  function run(options: { standalone: boolean; navigatorStandalone?: boolean; conditional?: boolean }) {
    const form = node("form");
    const section = node("passkey");
    const button = node("passkey-button");
    const problem = node("passkey-problem");
    const lead = node("passkey-lead");
    lead.textContent = "Already added a passkey to this account?";
    lead.hidden = false;
    const intro = node("signin-intro");
    intro.textContent = "We'll email you a link that signs you in.";
    const submit = node("signin-submit");
    submit.className = "button primary";
    button.className = "button";
    const parent: Parent = {
      children: [form, section],
      insertBefore(n, before) {
        this.children = this.children.filter((c) => c !== n);
        this.children.splice(this.children.indexOf(before), 0, n);
      },
    };
    form.parentNode = parent;
    section.parentNode = parent;
    const byId: Record<string, Node> = {
      passkey: section,
      "passkey-button": button,
      "passkey-problem": problem,
      "passkey-lead": lead,
      "signin-intro": intro,
      "signin-submit": submit,
    };
    const documentFake = {
      getElementById: (id: string) => byId[id] ?? null,
      querySelector: (selector: string) => (selector === "form.signin" ? form : null),
    };
    const gets: Array<Record<string, unknown>> = [];
    const navigatorFake = {
      standalone: options.navigatorStandalone,
      credentials: {
        get: (request: Record<string, unknown>) => {
          gets.push(request);
          return new Promise(() => undefined); // never settles; the ceremony is not under test
        },
      },
    };
    class PublicKeyCredential {
      static parseRequestOptionsFromJSON(o: unknown) {
        return o;
      }
      static isConditionalMediationAvailable() {
        return Promise.resolve(options.conditional === true);
      }
      toJSON() {
        return {};
      }
    }
    const windowFake = {
      PublicKeyCredential,
      AbortController,
      navigator: navigatorFake,
      matchMedia: (query: string) => ({ matches: options.standalone && query.includes("standalone") }),
      location: { assign: () => undefined },
    };
    const fetchFake = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ challenge: "c" }) });
    new Function("document", "navigator", "window", "fetch", scripts.PASSKEY_SIGN_IN_JS)(
      documentFake,
      navigatorFake,
      windowFake,
      fetchFake,
    );
    return { parent, section, lead, intro, button, submit, gets };
  }

  it("reveals the block below the form in a browser tab, copy unchanged", () => {
    const { parent, section, lead, intro, button, submit } = run({ standalone: false });
    expect(section.hidden).toBe(false);
    expect(parent.children.map((c) => c.id)).toEqual(["form", "passkey"]);
    expect(lead.hidden).toBe(false);
    expect(intro.textContent).toBe("We'll email you a link that signs you in.");
    expect(submit.className).toBe("button primary");
    expect(button.className).toBe("button");
  });

  it("moves the block above the form inside the installed app and says why", () => {
    const { parent, lead, intro, button, submit } = run({ standalone: true });
    expect(parent.children.map((c) => c.id)).toEqual(["passkey", "form"]);
    // The intro is retitled rather than a second sentence added under it,
    // so the page never says "we'll email you a link" above a block that
    // says the link is no use here; and the orange button follows the path
    // that works.
    expect(intro.textContent).toContain("An emailed link opens in your browser, not in this app.");
    expect(lead.hidden).toBe(true);
    expect(button.className).toBe("button primary");
    expect(submit.className).toBe("button");
  });

  it("treats the older navigator.standalone flag as installed too", () => {
    const { parent } = run({ standalone: false, navigatorStandalone: true });
    expect(parent.children.map((c) => c.id)).toEqual(["passkey", "form"]);
  });

  it("starts a conditional-mediation request only where the browser offers it", async () => {
    const withIt = run({ standalone: false, conditional: true });
    const without = run({ standalone: false, conditional: false });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(withIt.gets).toHaveLength(1);
    expect(withIt.gets[0]?.["mediation"]).toBe("conditional");
    expect(withIt.gets[0]?.["signal"]).toBeInstanceOf(AbortSignal);
    expect(without.gets).toHaveLength(0);
  });
});

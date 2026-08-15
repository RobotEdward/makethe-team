/// <reference types="vite/client" />
// `import.meta.glob` is Vite's, resolved at transform time — the mechanism the
// merge tripwire below is built on. `tsconfig.json`'s `types` array is a
// closed list (workers-types, the pool's types, node), so the reference has to
// be made explicitly here rather than inherited; it is scoped to this file
// on purpose, since nothing in `src/` may depend on a bundler feature.
import { describe, expect, it } from "vitest";
import * as scripts from "../../src/views/scripts.js";
import { PAGE_SCRIPT_BLOCKS, SCRIPT_BLOCKS } from "../../src/views/scripts.js";
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
    expect([...SCRIPT_BLOCKS]).toEqual([...PAGE_SCRIPT_BLOCKS]);
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
      // two WebAuthn scripts detect `PublicKeyCredential`; `COPY_INVITE_JS`
      // (M6a Task 7) is not a WebAuthn affordance at all and instead detects
      // `navigator.clipboard`, so this checks for either rather than only the
      // one every block used to share. `TEAM_PICKER_JS` (M9 Task 7) is a third
      // kind again: it needs drag and drop, so it detects `window.DataTransfer`
      // before it makes a single row draggable or reveals a single column, and
      // a browser without it keeps the picker's radio form exactly as served.
      //
      // Deliberately not a bare substring match on the guard token: a script
      // that called `navigator.clipboard.writeText(...)` with no guard at all
      // would still contain the literal string "navigator.clipboard" — in the
      // very call that would break the page for a browser without it — and a
      // substring check would wave it through. This instead requires the
      // token to sit inside an `if (...) return;` guard clause, which is what
      // every block below actually does before it touches the API.
      expect(block, "must feature-detect before use, in a guard-then-return").toMatch(
        /if\s*\([^)]*PublicKeyCredential[^)]*\)\s*return;|if\s*\([^)]*navigator\.clipboard[^)]*\)\s*return;|if\s*\([^)]*DataTransfer[^)]*\)\s*return;/,
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

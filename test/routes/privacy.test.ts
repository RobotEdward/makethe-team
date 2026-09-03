import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { DELETE_ACCOUNT_PATH, PRIVACY_PATH, SIGN_IN_PATH } from "../../src/auth/paths.js";
import { PRIVACY_CONTACT } from "../../src/views/privacy.js";

/**
 * `/privacy` (M7c).
 *
 * These tests are deliberately about *reachability* and *the promises the page
 * makes*, not about its prose. Copy will be edited; the guarantees below are
 * the ones that must survive an edit, because each of them is a way the page
 * could quietly stop doing its job while still rendering nicely.
 */

const url = (path: string) => `https://makethe.team${path}`;

describe("privacy page", () => {
  it("is readable with no session and no token", async () => {
    // The whole point. Somebody deciding whether to hand over an email address
    // must be able to read this *before* they do, and somebody who never signs
    // up at all still has the right to read it. A privacy page behind a login
    // is not a privacy page.
    const response = await SELF.fetch(url(PRIVACY_PATH));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
  });

  it("gives a working way to exercise a right", async () => {
    // A privacy page with no contact route is decoration. Asserted as a real
    // mailto so a future edit cannot reduce it to prose about "getting in
    // touch" with nothing to touch.
    const body = await (await SELF.fetch(url(PRIVACY_PATH))).text();

    expect(body).toContain(`mailto:${PRIVACY_CONTACT}`);
    expect(body).toContain(DELETE_ACCOUNT_PATH);
  });

  it("names all three companies that see something", async () => {
    // Each is a genuine disclosure and each was easy to leave out: Cloudflare
    // stores the data, Resend receives an address to deliver to, and Google is
    // told the visitor's IP on every page load simply because the pages are
    // set in its fonts (M10 §2.4). Naming them individually is what stops a
    // later rewrite collapsing them into "our service providers".
    const body = await (await SELF.fetch(url(PRIVACY_PATH))).text();

    for (const processor of ["Cloudflare", "Resend", "Google"]) {
      expect(body, `${processor} must be named on the privacy page`).toContain(processor);
    }
  });

  it("names the push services on the privacy page", async () => {
    // Same treatment the Google Fonts IP disclosure already gets, and a
    // stronger case: this one is per-player, persistent and opted into. Named
    // individually for the same reason as the processor test above — a
    // rewrite to "whichever push service your device uses" would drop Mozilla
    // silently while still satisfying a bare `toContain("Apple")` (Google is
    // already present via the fonts paragraph, and "push" via any prose).
    const body = await (await SELF.fetch(url(PRIVACY_PATH))).text();

    for (const processor of ["Google", "Apple", "Mozilla"]) {
      expect(body, `${processor} must be named as a push processor on the privacy page`).toContain(processor);
    }
    // The two substantive claims, not just the vocabulary: that the endpoint
    // is a lasting way to reach the device, and that the device — not this
    // product — is what picks the processor.
    expect(body).toMatch(/persistent identifier/i);
    expect(body).toMatch(/your device (chooses|choos)|choice is your device's/i);
  });

  it("discloses that an organiser can message you (M15 §9)", async () => {
    // What changes for a player with M15 is not what is collected but who can
    // cause mail to arrive: the product, and now their organiser. Both
    // channels named, because a player who has registered a device is told
    // about push here just as they are for the product's own notifications.
    const body = await (await SELF.fetch(url(PRIVACY_PATH))).text();

    expect(body).toMatch(/organiser.*can (send|write).*message/i);
    expect(body).toMatch(/email/i);
    expect(body).toMatch(/push/i);
  });

  it("states the four things erasure cannot reach", async () => {
    // These come off the list `docs/known-issues.md` kept specifically for this
    // page. They are the admissions a person needs *before* they rely on
    // "delete my data" meaning all of it, so each is pinned by the fact it
    // asserts rather than by its wording.
    const body = await (await SELF.fetch(url(PRIVACY_PATH))).text();

    // The sole-organiser block, which can hold a request indefinitely.
    expect(body).toMatch(/only organiser/i);
    // The trial allowlist, which can stop somebody reaching the page at all.
    expect(body).toMatch(/trial/i);
    // Free text another person wrote, which no erasure can search.
    expect(body).toMatch(/organiser types|another person typed/i);
    // Played fixtures, which keep the count and drop the name.
    expect(body).toMatch(/former player/i);
  });

  it("says plainly that the delivery and change records are kept indefinitely", async () => {
    // The one retention answer that is a policy choice rather than a fact about
    // the schema, and the one a reader is most likely to be surprised by: those
    // rows outlive the account that produced them. Said out loud, or not at all.
    const body = await (await SELF.fetch(url(PRIVACY_PATH))).text();

    expect(body).toMatch(/kept indefinitely/i);
  });

  it("is linked from the pages where somebody hands over an address", async () => {
    // A privacy page nobody can find is the same as not having one. These are
    // the two anonymous pages that ask for an email — the sign-in form and the
    // public invite — plus the holding page, which is the only thing a stranger
    // sees at the bare domain.
    for (const path of [SIGN_IN_PATH, "/"]) {
      const body = await (await SELF.fetch(url(path))).text();
      expect(body, `${path} must link to ${PRIVACY_PATH}`).toContain(`href="${PRIVACY_PATH}"`);
    }
  });

  /**
   * The contents list and the headings are generated from one array, and
   * `heading()` throws when asked for an id that array does not hold. That is
   * the right failure mode — a silently missing heading would leave a section
   * of a legal page untitled — but it means a typo takes the whole page down
   * with a 500, on the one page somebody reads before deciding whether to
   * trust us with an address. So the page is rendered here, in full, and every
   * link in the contents is checked against an anchor that exists.
   */
  it("gives every contents link a heading to land on", async () => {
    const body = await (await SELF.fetch(url(PRIVACY_PATH))).text();

    const targets = [...body.matchAll(/<a href="#([a-z]+)">/g)].map((match) => match[1]);
    const anchors = [...body.matchAll(/<h2 id="([a-z]+)">/g)].map((match) => match[1]);

    expect(targets.length).toBeGreaterThan(5);
    expect(targets).toEqual(anchors);
  });

  it("offers a way off itself that needs no session", async () => {
    // The page takes no `nav`, so the header every signed-in page carries is
    // absent here by design and this link is the only way onward.
    const body = await (await SELF.fetch(url(PRIVACY_PATH))).text();

    expect(body).toContain(`<p class="back-link"><a href="/">`);
  });

  it("is not indexable, like every other page here", async () => {
    const response = await SELF.fetch(url(PRIVACY_PATH));
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });
});

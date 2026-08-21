import { expect } from "vitest";
import { FRESHNESS_ATTRIBUTE, FRESHNESS_JS } from "../../src/views/scripts.js";
import { FRESHNESS_CSS } from "../../src/views/styles.js";

/**
 * The freshness bar's three parts, asserted together (M24).
 *
 * Markup, stylesheet and script are registered in three different places, and
 * two of the three fail *silently* when one is missed: a `<style>` block
 * absent from `PAGE_STYLE_BLOCKS` is dropped by the CSP with every test still
 * green, and a page that renders the bar without its script shows an age that
 * never counts and never re-fetches — which is the whole feature. So no page
 * asserts one part without the other two.
 *
 * @param refreshPath the path this page's Refresh link must point at — its
 *   own, since "refresh" here means an ordinary GET of the page you are on.
 */
export function expectFreshness(html: string, refreshPath: string): void {
  expect(html, "renders the freshness bar").toContain(`class="freshness" ${FRESHNESS_ATTRIBUTE}`);
  expect(html, "Refresh links at this page").toContain(`class="freshness-refresh" href="${refreshPath}"`);
  expect(html, "carries the freshness stylesheet").toContain(FRESHNESS_CSS);
  expect(html, "carries the freshness script").toContain(FRESHNESS_JS);
}

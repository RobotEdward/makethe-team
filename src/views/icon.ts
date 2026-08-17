/**
 * The home-screen icon (spec §5), authored once here and rasterised by
 * `scripts/build-icons.mjs` into `src/views/icon-bytes.ts`.
 *
 * Five dots along a checkmark: four filled, the fifth hollow — a five-a-side
 * squad with one spot left, which is the number the whole product exists to
 * move. Large it reads as a group of people; small the gaps close and it
 * resolves into a plain tick, which is the size it spends its life at in a
 * notification tray.
 *
 * # The geometry is not arbitrary — do not "tidy" the numbers
 *
 * The dots are spaced *outward from the vertex*, one before and three after,
 * at 86.5 units. The obvious alternative — equal distances along the path
 * from its start — puts **no dot on the corner at all**, so the turn is
 * described by a gap and the elbow reads as visibly slipped down and left.
 * That version was drawn and rejected.
 *
 * The vertex dot at (213,369) is then nudged 7 units further into the corner
 * along the outer bisector, because at a turn the eye follows the *outside*
 * of the bend and a dot centred on the true vertex looks like it has fallen
 * inside it. That is why its coordinates do not sit exactly on the two arms.
 *
 * Short arm 45° down, long arm 55° up. The asymmetry is what separates a tick
 * from a V.
 *
 * Full bleed on purpose: Android crops maskable icons to whatever shape the
 * launcher prefers, and a transparent or inset background produces a mark
 * floating in a grey circle on exactly the devices you did not test on.
 */
export const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
<rect width="512" height="512" fill="#1f6f4a"/>
<g fill="#fbfaf8">
<circle cx="151" cy="301" r="36"/>
<circle cx="213" cy="369" r="36"/>
<circle cx="262" cy="291" r="36"/>
<circle cx="311" cy="221" r="36"/>
</g>
<circle cx="361" cy="150" r="30" fill="none" stroke="#fbfaf8" stroke-width="11" stroke-opacity="0.8"/>
</svg>`;

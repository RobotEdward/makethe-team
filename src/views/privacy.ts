import { DELETE_ACCOUNT_PATH, SIGN_IN_PATH } from "../auth/paths.js";
import { escapeHtml, layout } from "./layout.js";
import { PRIVACY_STYLES_CSS } from "./styles.js";

/**
 * `/privacy` — the one page that tells a person what this product knows about
 * them (M7c).
 *
 * **Written from the schema, not from intent.** Every claim below was checked
 * against `src/db/schema.ts` and `src/domain/erase-player.ts` when it was
 * written, and the four things erasure cannot reach come off the list
 * `docs/known-issues.md` has been keeping for exactly this page. A privacy
 * page that describes what the author meant to build rather than what the code
 * does is worse than none: it is a promise nobody kept, in writing.
 *
 * **Public, and deliberately so.** No session, no token. Someone deciding
 * whether to hand over an email address has to be able to read this first,
 * which means it must be reachable from the join page and the sign-in page
 * before they type anything — and by somebody who never signs up at all.
 *
 * If you change what the product collects, shares, or keeps, this page is part
 * of that change and not a follow-up to it.
 */

/** The address privacy requests go to. Must actually deliver somewhere read. */
export const PRIVACY_CONTACT = "privacy@makethe.team";

/** Shown at the foot of the page and changed whenever the content is. */
export const PRIVACY_LAST_UPDATED = "18 August 2026";

interface Entry {
  what: string;
  why: string;
}

/**
 * What is stored about a person, and why — one entry per group of columns in
 * `src/db/schema.ts`. Kept as data rather than prose so a new table is an
 * obvious omission from a list rather than a missing sentence in a paragraph.
 */
const HELD: readonly Entry[] = [
  {
    what: "Your name and email address.",
    why: "To show the rest of your squad who has answered, and to send you the email this product exists to send — the reminder that a game is on, and the message when it is called off.",
  },
  {
    what: "Which games you are in, and whether you organise them.",
    why: "A game is a squad of people; being in it is the record that you should be asked about its fixtures.",
  },
  {
    what: "Your answer to each fixture — in, out, or on the waitlist — the side you were put on if the teams were picked, and who recorded the answer if it was not you.",
    why: "It is the answer to the question the product asks. The last part matters: an organiser can mark you in or out, and you are entitled to see that it was them and not you.",
  },
  {
    what: "How you sign in: your sessions, and any passkeys you have added.",
    why: "To keep you signed in, and to let you back in without a password. Passkeys are stored as public keys — the private half never leaves your device.",
  },
  {
    what: "A record of the emails and push notifications we sent you, and whether each was delivered.",
    why: "So that a reminder is never sent twice, and so a failure can be found and explained rather than silently dropped.",
  },
  {
    what: "If you turn on notifications: the subscription your browser creates for your device, so we can send to it — not your name or email, and nothing readable by anyone but the push service that delivers it.",
    why: "To send you a push notification instead of, or alongside, an email — the same events, delivered to your device rather than your inbox. Removing the device (from your own page) or erasing your account deletes this immediately.",
  },
  {
    what: "A record of who changed what — including who marked you in or out, and who removed you from a squad.",
    why: "So that changes made to your place in a game can be traced to whoever made them.",
  },
];

/** The four limits `docs/known-issues.md` has been holding for this page. */
const LIMITS: readonly { title: string; body: string }[] = [
  {
    title: "If you are the only organiser of a game, it will not run yet.",
    body: "Erasing you would leave that game with nobody able to manage it, so the request waits instead — indefinitely, if nothing changes. Making somebody else an organiser is the only thing that releases it. Nothing else does, and you are told which game is holding it up on your own page. You can also simply cancel the request and keep your account.",
  },
  {
    title: "While this is a trial, you may not be able to reach the page at all.",
    body: "Deleting your data needs you to be signed in, and during the trial only invited addresses can sign in. If yours is not one of them, email the address at the top of this page and it will be done for you. This limit disappears when the trial does.",
  },
  {
    title: "Something another person typed can still name you.",
    body: "A game's name, a venue, a note against a fixture — an organiser types those freely, and they are not structured, so nothing automatic can find your name inside them. Erasure rewrites your own records; it cannot rewrite somebody else's sentence. Ask the organiser, or ask us and we will.",
  },
  {
    title: "Fixtures you already played still count you.",
    body: "They count you as a former player with no name attached. That is deliberate: it is what keeps a past game's numbers honest for everybody else who was there.",
  },
];

function entries(): string {
  return HELD.map(
    (entry) =>
      `<div class="held"><p class="held-what">${escapeHtml(entry.what)}</p><p class="held-why">${escapeHtml(entry.why)}</p></div>`,
  ).join("");
}

function limits(): string {
  return LIMITS.map(
    (limit) => `<div class="held"><p class="held-what">${escapeHtml(limit.title)}</p><p class="held-why">${escapeHtml(limit.body)}</p></div>`,
  ).join("");
}

export function renderPrivacyPage(): string {
  const contact = escapeHtml(PRIVACY_CONTACT);

  const body = `
    <h1>Privacy</h1>
    <p class="lede">This product exists to get a regular game on. It needs your name to show your squad who is playing, and your email address to tell you when there is a game. That is nearly all of it. This page is the rest.</p>

    <h2>Who holds it</h2>
    <p>Make The Team, run by the person who built it. For anything on this page — a copy of your data, a correction, a deletion, or a complaint — write to <a href="mailto:${contact}">${contact}</a>.</p>

    <h2>What is held, and why</h2>
    ${entries()}
    <p>Guests are the exception worth naming: an organiser can add somebody to a single fixture by typing their name, with no email address and no account. If that is you, the product holds a name and nothing else, and it is gone with the fixture.</p>

    <h2>Why we are allowed to</h2>
    <p>For your name, your email address, your squads and your answers: because you asked us to organise your games, and none of it can be done without them. That is a contract, not consent — which also means there is no box to tick and no banner to dismiss.</p>
    <p>For the delivery and change records: because a product that emails people needs to know what it sent and who changed what, and we judge that a fair thing to expect. If you disagree in your own case, say so and we will look at it.</p>

    <h2>Who else sees it</h2>
    <p><strong>Other people in your squad.</strong> Your name and your answer are shown to the rest of the squad, because that is the point. An organiser can turn that off for their game, in which case players see only the count — but you can always see your own answer and your own side.</p>
    <p><strong>Three companies, doing three jobs.</strong> Cloudflare hosts the product and stores its database. Resend delivers the email. Google serves the two typefaces the pages are set in — which means Google is told your IP address every time you open a page here, before you have done anything at all. Nobody is sent your data to use for their own purposes, and nothing here is sold, shared for advertising, or used to train anything.</p>
    <p><strong>If you turn on push notifications, one more company sees something: whichever of Google, Apple or Mozilla runs the push service on the device you turned it on for.</strong> That choice is your device's, not ours — it is decided by the browser or phone you say yes on, and we have no way to pick a different one; for many people it will be Google again, the same company named above, on a different device and for a different reason. Saying yes hands that company a subscription: an address that lets this app wake that specific device with a notification. It carries no name and no email address, but it is a standing way to reach that device, and the subscription's mere existence is itself a persistent identifier for it, held by whichever company your device chose. This disclosure is not imposed the way the font one above is — it happens only if you turn push on, and only for the device you turned it on for — but it is more personal while it lasts: it is tied to you, it persists until you remove that device or turn push off, and erasing your account deletes it along with everything else.</p>

    <h2>How long it is kept</h2>
    <p>Your account and your answers are kept for as long as you have an account. You can end that yourself at any time — see below.</p>
    <p><strong>The delivery and change records are kept indefinitely, and they outlive your account.</strong> When you delete your data those records stay, with your name taken out of them: they say that somebody was emailed, or that an organiser marked somebody in, without saying who. We would rather tell you that plainly than promise a tidy date we have not built.</p>

    <h2>What you can do</h2>
    <p>Two of these you can do yourself, right now, without asking anybody:</p>
    <p><strong>Leave a game.</strong> Every email we send you carries a link to leave that game. It takes you out of the squad and stops the email.</p>
    <p><strong>Delete everything.</strong> <a href="${escapeHtml(DELETE_ACCOUNT_PATH)}">Delete my data</a>, from your own account. It erases your name, your email address and every way of signing in, and takes you out of every squad. It happens two days later, not straight away, and you can stop it at any point before then — so a mis-tap is not the end of anything.</p>
    <p>You can also ask us for a copy of what we hold, ask us to correct it, ask us to stop doing something with it, or object to the change and delivery records being kept. Write to <a href="mailto:${contact}">${contact}</a>.</p>
    <p>If you are not happy with how we have handled any of that, you can complain to the Information Commissioner's Office at <a href="https://ico.org.uk/make-a-complaint/" rel="noopener noreferrer">ico.org.uk</a>. We would rather you told us first, but you do not have to.</p>

    <h2>What deleting your data does not reach</h2>
    <p>Four things, said out loud here so nobody finds them out afterwards:</p>
    ${limits()}

    <h2>Cookies</h2>
    <p>One, and only once you sign in: the cookie that keeps you signed in. There is no analytics, no advertising, and nothing that follows you to another site.</p>

    <p class="updated">Last updated ${escapeHtml(PRIVACY_LAST_UPDATED)}. <a href="${escapeHtml(SIGN_IN_PATH)}">Sign in</a></p>
  `;

  return layout({ title: "Privacy — Make The Team", body, pageStyles: [PRIVACY_STYLES_CSS] });
}

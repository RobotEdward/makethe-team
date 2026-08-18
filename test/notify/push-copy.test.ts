import { describe, expect, it } from "vitest";
import { NOTIFICATION_TYPES } from "../../src/notify/dedupe-key.js";
import { PUSH_COPY } from "../../src/notify/push-copy.js";
import { MAX_PAYLOAD_BYTES } from "../../src/notify/web-push.js";

/**
 * One object satisfying every notification type's payload at once, so the
 * same literal can be handed to each `PUSH_COPY[type]` in the loops below.
 * Every field any of the ten builders reads is here; each builder narrows
 * to the handful it actually needs (see `push-copy.ts`'s own doc comment on
 * why the parameter types are the real per-type payload interfaces rather
 * than one loose shape).
 */
const sampleContext = {
  playerName: "Sam",
  ownerName: "Jamie",
  organiserName: "Jamie",
  subject: "Pitch has moved",
  message: "We're on the astro tonight.",
  gameName: "Thursday 5-a-side",
  venueName: "Riverside Park",
  kicksOffAtLocal: "Thu 18 Feb, 7:30pm",
  // A plain string, not `string | null`: `WelcomeEmailPayload.whenLocal` is
  // nullable (a squad can have no fixture yet) but `ErasureScheduledEmailPayload.whenLocal`
  // is not, and a string satisfies both — a `| null` union here would not.
  whenLocal: "Thu 18 Feb, 7:30pm",
  inCount: 8,
  spotsLeft: 2,
  respondInUrl: "https://makethe.team/r/abc?intent=in",
  respondOutUrl: "https://makethe.team/r/abc?intent=out",
  leaveUrl: "https://makethe.team/leave/abc",
  reason: "Pitch waterlogged",
  problem: { kind: "short", inCount: 8, minPlayers: 10 } as
    | { kind: "short"; inCount: number; minPlayers: number }
    | { kind: "uneven"; inCount: number },
  inPlayers: ["Sam", "Jamie", "Alex"],
  nonResponders: ["Chris"],
  cancelUrl: "https://makethe.team/cancel/abc",
  ceilingReached: false,
  signInUrl: "https://makethe.team/magic-link/verify?token=abc",
  expiresInLabel: "5 minutes",
  dashboardUrl: "https://makethe.team/dashboard",
  yourSideName: "Reds",
  lineUps: [
    { name: "Reds", players: ["Sam", "Jamie"] },
    { name: "Blues", players: ["Alex", "Chris"] },
  ] as readonly { name: string; players: readonly string[] }[] | null,
};

/**
 * An entirely ordinary game name for this product — a day of the week plus
 * a descriptor plus "Massive" — at 28 characters, kept separate from
 * `sampleContext.gameName` (18 characters) on purpose. The short sample
 * name is convenient for reading test failures elsewhere in this file, but
 * it is short enough that a title built by naively concatenating a fixed
 * phrase with `gameName` can fit under the 40-character budget without the
 * copy actually enforcing that budget for a realistic name. A day +
 * descriptor + "Football"/"5-a-side" routinely lands in the
 * mid-to-high-twenties of characters, so this is the length the
 * length-budget test needs to exercise, not the comfortable one.
 */
const LONG_GAME_NAME = "The Tuesday 6-a-side Massive";

describe("push copy", () => {
  it("covers every notification type", () => {
    // The catalogue is the source of truth. A type added later without copy
    // would otherwise silently send nothing on the push channel.
    for (const type of NOTIFICATION_TYPES) {
      expect(PUSH_COPY[type], `no push copy for ${type}`).toBeDefined();
    }
  });

  it("keeps every title short enough to survive a notification tray", () => {
    // Android truncates around forty characters, and a title that gets cut
    // mid-word is the difference between "Thursday is short" and "Thursday
    // is sh…". Deliberately not derived from email subjects, which are prose.
    //
    // Uses LONG_GAME_NAME, not sampleContext.gameName: the short sample name
    // (18 characters) fits under the budget even without the copy actually
    // enforcing it, so this test would pass on a title built by naive
    // concatenation right up until a realistic game name broke it in
    // production. The 28-character name exercises the boundary the copy is
    // actually meant to hold.
    for (const type of NOTIFICATION_TYPES) {
      const { title } = PUSH_COPY[type]({ ...sampleContext, gameName: LONG_GAME_NAME });
      expect(title.length, `${type}: "${title}"`).toBeLessThanOrEqual(40);
    }
  });

  it("keeps the broadcast title inside the tray budget however long the subject is", () => {
    // n10's title is built from the organiser's own subject, not a game name
    // (see push-copy.ts's `broadcast` builder), so the general
    // "keeps every title short enough" case above — which varies gameName,
    // never subject — cannot exercise this budget on its own.
    const copy = PUSH_COPY.n10({ ...sampleContext, subject: "x".repeat(60) });
    expect(copy.title.length).toBeLessThanOrEqual(40);
    expect(copy.title.endsWith("…")).toBe(true);
  });

  it("stays inside the wire payload's 4KB limit with the longest plausible values", () => {
    // Asserted here rather than discovered at the push service, which
    // rejects an oversized payload outright. Measured in bytes, via
    // TextEncoder, since a game or venue name may not be ASCII — and
    // against MAX_PAYLOAD_BYTES (the plaintext limit, imported from
    // web-push.ts) rather than a hardcoded 4096, which is the limit on the
    // encrypted wire body, not on this JSON.
    for (const type of NOTIFICATION_TYPES) {
      const copy = PUSH_COPY[type]({ ...sampleContext, gameName: "x".repeat(200), venueName: "y".repeat(200) });
      const bytes = new TextEncoder().encode(JSON.stringify(copy)).length;
      expect(bytes, `${type}: ${bytes} bytes`).toBeLessThan(MAX_PAYLOAD_BYTES);
    }
  });

  it("never uses forbidden vocabulary", () => {
    // Same banned list the email templates and views are held to
    // (test/notify/templates/reminder.test.ts, test/views/fixture.test.ts):
    // "fixture", never "event"; no "rsvp", "match" or "user" either.
    for (const type of NOTIFICATION_TYPES) {
      const { title, body, tag } = PUSH_COPY[type]({ ...sampleContext });
      for (const rendition of [title.toLowerCase(), body.toLowerCase(), tag.toLowerCase()]) {
        for (const word of ["rsvp", "event", "match", "user", "team list"]) {
          expect(rendition, `${type}: "${rendition}" contains "${word}"`).not.toContain(word);
        }
      }
    }
  });
});

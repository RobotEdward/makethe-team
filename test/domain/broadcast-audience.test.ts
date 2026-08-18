import { describe, expect, it } from "vitest";
import {
  AUDIENCE_LABELS,
  BROADCAST_AUDIENCES,
  DEFAULT_FIXTURE_AUDIENCE,
  FIXTURE_AUDIENCES,
  audienceSelectsStatus,
  isAddressable,
  isBroadcastAudience,
  isReachableOn,
  type BroadcastAudience,
} from "../../src/domain/broadcast-audience.js";
import { RESPONSE_STATUSES } from "../../src/domain/response-status.js";

/**
 * The whole point of this file (milestone workflow rule 1): every audience,
 * against every stored status including one this build cannot name, and
 * against every shape of unaddressable player — enumerated once, here, so no
 * calling site has to re-derive the rule.
 */
describe("broadcast audiences", () => {
  it("names every audience and gives each a label", () => {
    expect([...BROADCAST_AUDIENCES]).toEqual(["everyone", "playing", "waitlisted", "pending", "unavailable"]);
    for (const audience of BROADCAST_AUDIENCES) {
      expect(AUDIENCE_LABELS[audience].length).toBeGreaterThan(0);
    }
  });

  it("offers exactly the four fixture audiences, defaulting to playing", () => {
    expect([...FIXTURE_AUDIENCES]).toEqual(["playing", "waitlisted", "pending", "unavailable"]);
    expect(FIXTURE_AUDIENCES).not.toContain("everyone");
    expect(DEFAULT_FIXTURE_AUDIENCE).toBe("playing");
  });

  it("maps each fixture audience onto exactly the statuses the spec names", () => {
    const selected = (audience: BroadcastAudience): string[] =>
      RESPONSE_STATUSES.filter((status) => audienceSelectsStatus(audience, status));

    expect(selected("playing")).toEqual(["in"]);
    expect(selected("waitlisted")).toEqual(["waitlisted"]);
    expect(selected("pending")).toEqual(["pending"]);
    expect(selected("unavailable")).toEqual(["out", "withdrawn"]);
  });

  it("selects nobody by status for the game-scoped audience", () => {
    // `everyone` is resolved from memberships, never from response rows. A
    // truthy answer here would silently give a game-scoped send a second,
    // narrower recipient set depending on which query the caller happened to
    // use.
    for (const status of RESPONSE_STATUSES) {
      expect(audienceSelectsStatus("everyone", status)).toBe(false);
    }
  });

  it("excludes a stored status this build cannot name, from every audience", () => {
    // `responses.status` is text with no CHECK constraint, so a row can hold
    // anything. Excluded, not defaulted into a bucket: a message reaching
    // someone because their row was corrupt is worse than one not sent.
    for (const audience of BROADCAST_AUDIENCES) {
      expect(audienceSelectsStatus(audience, "cancelled")).toBe(false);
      expect(audienceSelectsStatus(audience, "")).toBe(false);
    }
  });

  it("every response status is claimed by exactly one fixture audience", () => {
    for (const status of RESPONSE_STATUSES) {
      const claiming = FIXTURE_AUDIENCES.filter((audience) => audienceSelectsStatus(audience, status));
      expect(claiming, `status ${status}`).toHaveLength(1);
    }
  });

  it("treats a player with an address or a device as addressable", () => {
    expect(isAddressable({ isGuest: false, email: "sam@example.com", hasDevice: false })).toBe(true);
    expect(isAddressable({ isGuest: false, email: null, hasDevice: true })).toBe(true);
  });

  it("excludes a guest however reachable they look", () => {
    // BR-32. A guest row can carry an email if an organiser typed one; it is
    // still not a person who agreed to hear from the product.
    expect(isAddressable({ isGuest: true, email: "guest@example.com", hasDevice: true })).toBe(false);
  });

  it("excludes a blank or whitespace-only address with no device", () => {
    // The `.trim()` is load-bearing: an email of " " is truthy, and letting it
    // through mints a queued row and a `no-recipient` result recorded as
    // failed forever (`applySendResult`).
    expect(isAddressable({ isGuest: false, email: null, hasDevice: false })).toBe(false);
    expect(isAddressable({ isGuest: false, email: "", hasDevice: false })).toBe(false);
    expect(isAddressable({ isGuest: false, email: "   ", hasDevice: false })).toBe(false);
  });

  it("reaches a player only on a channel they actually have, and only one that was ticked", () => {
    const emailOnly = { isGuest: false, email: "sam@example.com", hasDevice: false };
    const deviceOnly = { isGuest: false, email: null, hasDevice: true };
    // The pairs that decide whether a send reaches anybody at all: each of
    // these `false`s is a broadcast that would otherwise spend one of the
    // game's three daily sends and deliver nothing.
    expect(isReachableOn(emailOnly, { email: false, push: true })).toBe(false);
    expect(isReachableOn(emailOnly, { email: true, push: false })).toBe(true);
    expect(isReachableOn(deviceOnly, { email: true, push: false })).toBe(false);
    expect(isReachableOn(deviceOnly, { email: false, push: true })).toBe(true);
    // The trim applies per channel, not only to the both-channels case.
    expect(isReachableOn({ isGuest: false, email: "   ", hasDevice: true }, { email: true, push: false })).toBe(false);
    // BR-32 holds whichever channel is asked for.
    expect(isReachableOn({ isGuest: true, email: "guest@example.com", hasDevice: true }, { email: true, push: true })).toBe(
      false,
    );
  });

  it("recognises exactly the audience names, from unknown input", () => {
    expect(isBroadcastAudience("playing")).toBe(true);
    expect(isBroadcastAudience("Playing")).toBe(false);
    expect(isBroadcastAudience(undefined)).toBe(false);
    expect(isBroadcastAudience(7)).toBe(false);
  });
});

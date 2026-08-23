import { describe, expect, it } from "vitest";
import {
  PRESENCE_STAMP_INTERVAL_MS,
  QUIET_DAYS,
  shouldStampPresence,
  squadSignals,
  type SquadPresence,
} from "../../src/domain/presence.js";
import { NOW } from "../support/clock.js";

const DAY = 24 * 60 * 60 * 1000;

const REACHABLE: SquadPresence = {
  isGuest: false,
  lastSeenAt: new Date(NOW.getTime() - DAY),
  lastAnsweredAt: new Date(NOW.getTime() - DAY),
  lastStandaloneAt: new Date(NOW.getTime() - DAY),
  pushDevices: 1,
  deliveryFailing: false,
};

describe("squadSignals", () => {
  it("says nothing at all about a player who is installed, pushed and active", () => {
    expect(squadSignals(REACHABLE, NOW)).toEqual({
      notInstalled: false,
      noPush: false,
      deliveryTrouble: false,
      quiet: false,
    });
  });

  it("reports a player never seen in the installed app", () => {
    expect(squadSignals({ ...REACHABLE, lastStandaloneAt: null }, NOW).notInstalled).toBe(true);
  });

  it("reports a player with no registered device", () => {
    expect(squadSignals({ ...REACHABLE, pushDevices: 0 }, NOW).noPush).toBe(true);
  });

  it("reports a player whose sends are failing", () => {
    expect(squadSignals({ ...REACHABLE, deliveryFailing: true }, NOW).deliveryTrouble).toBe(true);
  });

  it("counts an answer as being seen, even from a player who never opens the app", () => {
    const signals = squadSignals(
      {
        ...REACHABLE,
        lastSeenAt: null,
        lastAnsweredAt: new Date(NOW.getTime() - DAY),
      },
      NOW,
    );

    expect(signals.quiet).toBe(false);
  });

  it("counts opening the app as being seen, from a player who answers nothing", () => {
    const signals = squadSignals({ ...REACHABLE, lastAnsweredAt: null }, NOW);

    expect(signals.quiet).toBe(false);
  });

  it("takes the newer of the two, not the one that happens to be first", () => {
    const stale = new Date(NOW.getTime() - 60 * DAY);
    const fresh = new Date(NOW.getTime() - DAY);

    expect(squadSignals({ ...REACHABLE, lastSeenAt: stale, lastAnsweredAt: fresh }, NOW).quiet).toBe(
      false,
    );
    expect(squadSignals({ ...REACHABLE, lastSeenAt: fresh, lastAnsweredAt: stale }, NOW).quiet).toBe(
      false,
    );
  });

  it("goes quiet only once both are older than the threshold", () => {
    const justInside = new Date(NOW.getTime() - (QUIET_DAYS * DAY - 1));
    const justOutside = new Date(NOW.getTime() - (QUIET_DAYS * DAY + 1));

    expect(
      squadSignals({ ...REACHABLE, lastSeenAt: justInside, lastAnsweredAt: null }, NOW).quiet,
    ).toBe(false);
    expect(
      squadSignals({ ...REACHABLE, lastSeenAt: justOutside, lastAnsweredAt: null }, NOW).quiet,
    ).toBe(true);
  });

  it("reports a player we have never seen at all as quiet", () => {
    expect(
      squadSignals({ ...REACHABLE, lastSeenAt: null, lastAnsweredAt: null }, NOW).quiet,
    ).toBe(true);
  });

  it("says nothing about a guest, who has none of these things by design", () => {
    const guest = squadSignals(
      {
        isGuest: true,
        lastSeenAt: null,
        lastAnsweredAt: null,
        lastStandaloneAt: null,
        pushDevices: 0,
        deliveryFailing: true,
      },
      NOW,
    );

    expect(guest).toEqual({
      notInstalled: false,
      noPush: false,
      deliveryTrouble: false,
      quiet: false,
    });
  });
});

describe("shouldStampPresence", () => {
  it("stamps a player we have never stamped", () => {
    expect(shouldStampPresence(null, NOW)).toBe(true);
  });

  it("does not stamp again inside the interval", () => {
    const recent = new Date(NOW.getTime() - (PRESENCE_STAMP_INTERVAL_MS - 1));
    expect(shouldStampPresence(recent, NOW)).toBe(false);
  });

  it("stamps again once the interval has passed", () => {
    const old = new Date(NOW.getTime() - (PRESENCE_STAMP_INTERVAL_MS + 1));
    expect(shouldStampPresence(old, NOW)).toBe(true);
  });

  it("stamps a value from the future rather than trusting it", () => {
    // A clock that went backwards, or a row written by a request whose clock
    // ran ahead: without this the column would be frozen until real time
    // caught up, and the player would read as gone quiet while using the app.
    expect(shouldStampPresence(new Date(NOW.getTime() + 60 * 60 * 1000), NOW)).toBe(true);
  });
});

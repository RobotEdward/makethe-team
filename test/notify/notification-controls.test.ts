import { describe, expect, it } from "vitest";
import { NOTIFICATION_TYPES } from "../../src/notify/dedupe-key.js";
import {
  NOTIFICATION_CONTROLS,
  cellKey,
  cellsWithScope,
  isChannel,
  isNotificationType,
} from "../../src/notify/notification-controls.js";

describe("NOTIFICATION_CONTROLS", () => {
  it("names every notification type exactly once", () => {
    // A Record over the union makes a missing type a typecheck error; this
    // is the runtime half, so a stray extra key cannot hide either.
    expect(Object.keys(NOTIFICATION_CONTROLS).sort()).toEqual([...NOTIFICATION_TYPES].sort());
  });

  it("splits the catalogue as the spec does", () => {
    const byScope = (scope: "owner" | "admin" | "none") =>
      NOTIFICATION_TYPES.filter((t) => NOTIFICATION_CONTROLS[t].scope === scope);
    expect(byScope("owner")).toEqual(["n1", "n4", "n9", "n11", "n12", "n13"]);
    expect(byScope("admin")).toEqual(["n6", "n7", "n10", "n14"]);
    expect(byScope("none")).toEqual(["n2", "n3", "n5", "n8"]);
  });

  it("keeps n14 email-only: a confirmation goes to an address with no player behind it (M39)", () => {
    expect(NOTIFICATION_CONTROLS.n14).toEqual({ scope: "admin", channels: ["email"] });
  });

  it("gives a never-switchable type no channels, so no control can be rendered for it", () => {
    for (const type of ["n2", "n3", "n5", "n8"] as const) {
      expect(NOTIFICATION_CONTROLS[type].channels).toEqual([]);
    }
  });

  it("keeps n11 push-only (src/sweep/group-nudge.ts records why)", () => {
    expect(NOTIFICATION_CONTROLS.n11.channels).toEqual(["push"]);
  });

  it("enumerates owner cells in catalogue order", () => {
    expect(cellsWithScope("owner").map((c) => cellKey(c.type, c.channel))).toEqual([
      "n1.email", "n1.push",
      "n4.email", "n4.push",
      "n9.email", "n9.push",
      "n11.push",
      "n12.email", "n12.push",
      "n13.email", "n13.push",
    ]);
  });

  it("recognises only real types and channels", () => {
    expect(isNotificationType("n9")).toBe(true);
    expect(isNotificationType("n99")).toBe(false);
    expect(isChannel("push")).toBe(true);
    expect(isChannel("sms")).toBe(false);
  });
});

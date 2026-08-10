import { describe, expect, it } from "vitest";
import {
  INITIAL_RESPONSE_STATUS,
  occupiesSlot,
  RESPONSE_SOURCES,
  RESPONSE_STATUSES,
} from "../../src/domain/response-status.js";

describe("response statuses", () => {
  it("is the exact set the spec defines", () => {
    expect([...RESPONSE_STATUSES]).toEqual(["pending", "in", "out", "waitlisted", "withdrawn"]);
  });

  it("defaults to pending", () => {
    expect(INITIAL_RESPONSE_STATUS).toBe("pending");
  });

  it("lists the sources a response can come from", () => {
    expect([...RESPONSE_SOURCES]).toEqual(["token", "web", "owner", "system"]);
  });
});

describe("occupiesSlot", () => {
  it("is true only for in", () => {
    expect(occupiesSlot("in")).toBe(true);
    for (const status of ["pending", "out", "waitlisted", "withdrawn"] as const) {
      expect(occupiesSlot(status)).toBe(false);
    }
  });
});

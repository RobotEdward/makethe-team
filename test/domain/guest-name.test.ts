import { describe, expect, it } from "vitest";
import { parseGuestName } from "../../src/domain/guest-name.js";

describe("parseGuestName", () => {
  it("accepts an ordinary name", () => {
    expect(parseGuestName("Sam Whitlock")).toEqual({ ok: true, name: "Sam Whitlock" });
  });

  it("trims surrounding whitespace", () => {
    expect(parseGuestName("  Sam  ")).toEqual({ ok: true, name: "Sam" });
  });

  it("refuses an empty name", () => {
    expect(parseGuestName("")).toEqual({ ok: false, problem: "Give your guest a name." });
  });

  it("refuses whitespace only", () => {
    expect(parseGuestName("   ")).toEqual({ ok: false, problem: "Give your guest a name." });
  });

  it("refuses a name longer than 80 characters", () => {
    expect(parseGuestName("x".repeat(81))).toEqual({
      ok: false,
      problem: "That name is too long — keep it under 80 characters.",
    });
  });

  it("accepts exactly 80 characters", () => {
    expect(parseGuestName("x".repeat(80))).toEqual({ ok: true, name: "x".repeat(80) });
  });

  it("refuses a non-string, which is what a hand-built request sends", () => {
    expect(parseGuestName(undefined)).toEqual({ ok: false, problem: "Give your guest a name." });
    expect(parseGuestName(42)).toEqual({ ok: false, problem: "Give your guest a name." });
  });
});

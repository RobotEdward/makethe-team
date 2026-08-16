import { describe, expect, it } from "vitest";
import { parsePlayerName } from "../../src/domain/player-name.js";

describe("parsePlayerName", () => {
  it("accepts an ordinary name", () => {
    expect(parsePlayerName("Sam Okafor")).toEqual({ ok: true, name: "Sam Okafor" });
  });

  it("trims surrounding whitespace", () => {
    expect(parsePlayerName("  Sam Okafor \n")).toEqual({ ok: true, name: "Sam Okafor" });
  });

  it("refuses an empty name", () => {
    const result = parsePlayerName("");
    expect(result.ok).toBe(false);
  });

  it("refuses a name that is only whitespace", () => {
    const result = parsePlayerName("   ");
    expect(result.ok).toBe(false);
  });

  it("refuses a name longer than 200 characters", () => {
    const result = parsePlayerName("a".repeat(201));
    expect(result.ok).toBe(false);
  });

  it("accepts a name of exactly 200 characters", () => {
    expect(parsePlayerName("a".repeat(200))).toEqual({ ok: true, name: "a".repeat(200) });
  });

  it("refuses a value that is not a string at all", () => {
    // `parseBody` hands back a File for a multipart field, and undefined for a
    // field the form never sent. Neither is a name.
    expect(parsePlayerName(undefined).ok).toBe(false);
    expect(parsePlayerName(42).ok).toBe(false);
  });
});

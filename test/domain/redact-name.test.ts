import { describe, expect, it } from "vitest";
import { redactName } from "../../src/domain/redact-name.js";

describe("redactName (BR-26)", () => {
  it("renders a first name and a surname initial", () => {
    expect(redactName("Edward Charles")).toBe("Edward C.");
  });

  it("keeps only the last part's initial when there are three", () => {
    expect(redactName("Maria del Toro")).toBe("Maria T.");
  });

  it("returns a single-word name unchanged", () => {
    // Nothing to redact, and inventing an initial would be a lie.
    expect(redactName("Pelé")).toBe("Pelé");
  });

  it("collapses surrounding and repeated whitespace", () => {
    expect(redactName("  Edward   Charles  ")).toBe("Edward C.");
  });

  it("returns an empty string for an empty name", () => {
    expect(redactName("   ")).toBe("");
  });

  it("uppercases a lowercased surname initial", () => {
    expect(redactName("edward charles")).toBe("edward C.");
  });
});

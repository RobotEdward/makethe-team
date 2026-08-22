import { describe, expect, it } from "vitest";
import { effectiveMode, mayPick, mayPublish, type PickerDelegation } from "../../src/domain/picker.js";

const DELEGATE = "p-delegate";
const MEMBER = "p-member";

function delegation(overrides: Partial<PickerDelegation> = {}): PickerDelegation {
  return { pickerMode: "organiser", teamPickerPlayerId: null, ...overrides };
}

describe("effectiveMode", () => {
  it("reads a fixture nobody has handed over as organiser-only", () => {
    expect(effectiveMode(delegation())).toBe("organiser");
  });

  /**
   * `picker_mode` is a bare `text NOT NULL` with no CHECK constraint, so the
   * union type is a claim about the schema rather than a guarantee about the
   * rows — the defect class `test/stored-lookups.test.ts` exists for.
   */
  it("falls back to organiser for a mode this build has never heard of", () => {
    expect(effectiveMode(delegation({ pickerMode: "everyone" as never }))).toBe("organiser");
  });

  /**
   * The setter writes both columns in one statement, so this pair cannot
   * legitimately occur — which is exactly why the reader must not depend on
   * that being true forever.
   */
  it("reads a delegate mode that names nobody as organiser-only", () => {
    expect(effectiveMode(delegation({ pickerMode: "delegate" }))).toBe("organiser");
  });
});

describe("mayPick", () => {
  it("says no to everybody while the organiser keeps the pick", () => {
    expect(mayPick(delegation(), MEMBER)).toBe(false);
  });

  it("says yes to the named delegate and no to anybody else", () => {
    const state = delegation({ pickerMode: "delegate", teamPickerPlayerId: DELEGATE });
    expect(mayPick(state, DELEGATE)).toBe(true);
    expect(mayPick(state, MEMBER)).toBe(false);
  });

  it("says yes to anybody once the pick is open", () => {
    expect(mayPick(delegation({ pickerMode: "open" }), MEMBER)).toBe(true);
  });
});

describe("mayPublish", () => {
  const published = new Date("2026-08-12T09:00:00Z");

  it("lets a delegate announce whether or not the teams have gone out", () => {
    const state = delegation({ pickerMode: "delegate", teamPickerPlayerId: DELEGATE });
    expect(mayPublish(state, DELEGATE, null)).toBe(true);
    expect(mayPublish(state, DELEGATE, published)).toBe(true);
  });

  it("lets any member make the first announcement in open mode", () => {
    expect(mayPublish(delegation({ pickerMode: "open" }), MEMBER, null)).toBe(true);
  });

  /**
   * First publish wins. Without this any member could mail the whole squad a
   * fresh set of teams as often as they liked, and the squad would have no
   * way to tell which message was the real one.
   */
  it("stops a member announcing again in open mode", () => {
    expect(mayPublish(delegation({ pickerMode: "open" }), MEMBER, published)).toBe(false);
  });

  it("never lets somebody publish who could not pick in the first place", () => {
    expect(mayPublish(delegation(), MEMBER, null)).toBe(false);
  });
});

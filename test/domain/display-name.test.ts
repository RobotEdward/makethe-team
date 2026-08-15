import { describe, expect, it } from "vitest";
import { ERASED_DISPLAY_NAME, displayName } from "../../src/domain/display-name.js";
import { ERASED_NAME } from "../../src/domain/erase-player.js";

describe("displayName", () => {
  it("returns the stored name for a player who has not been erased", () => {
    expect(displayName("Edward Cooper", null)).toBe("Edward Cooper");
  });

  it("replaces the name of an erased player with the label", () => {
    expect(displayName(ERASED_NAME, new Date("2026-08-20T09:00:00Z"))).toBe(ERASED_DISPLAY_NAME);
  });

  /**
   * It branches on the column, never on the name (§4). A row whose name has
   * somehow not been anonymised — a partial run, a hand-edited row — is still
   * an erased player, and showing the name because it does not look like the
   * placeholder would be the one mistake this function exists to prevent.
   */
  it("hides a real name whenever erased_at is set, whatever the name says", () => {
    expect(displayName("Edward Cooper", new Date("2026-08-20T09:00:00Z"))).toBe(
      ERASED_DISPLAY_NAME,
    );
  });

  /**
   * The label has to read as a phrase in both positions a squad read puts a
   * name in, which is why it is lower-case and carries its own article.
   */
  it("reads naturally in both of the positions a name appears in", () => {
    const who = displayName(ERASED_NAME, new Date("2026-08-20T09:00:00Z"));
    expect(`marked in by ${who}`).toBe("marked in by a former player");
    expect(who.startsWith("[")).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { squadForViewer } from "../../src/domain/squad-visibility.js";
import type { SquadMember } from "../../src/db/queries.js";

const SQUAD: SquadMember[] = [
  { playerId: "p-1", name: "Priya Raman", erasedAt: null, status: "in", team: null, waitlistRank: null,
    setBy: null, source: "token", isGuest: false },
];

describe("squadForViewer", () => {
  it("gives an owner the squad even when players may not see it", () => {
    expect(squadForViewer({ squadVisibleToPlayers: false }, SQUAD, { isOwner: true })).toEqual(SQUAD);
  });

  it("gives an owner the squad when players may see it", () => {
    expect(squadForViewer({ squadVisibleToPlayers: true }, SQUAD, { isOwner: true })).toEqual(SQUAD);
  });

  it("gives a player the squad when the game allows it", () => {
    expect(squadForViewer({ squadVisibleToPlayers: true }, SQUAD, { isOwner: false })).toEqual(SQUAD);
  });

  it("gives a player nothing when the game does not", () => {
    expect(squadForViewer({ squadVisibleToPlayers: false }, SQUAD, { isOwner: false })).toBeNull();
  });

  it("returns null rather than an empty list, so a caller cannot confuse hidden with empty", () => {
    // An empty array would render as "nobody is playing", which is a lie.
    expect(squadForViewer({ squadVisibleToPlayers: false }, [], { isOwner: false })).toBeNull();
  });

  it("gives an owner an empty squad as an empty list, not null", () => {
    expect(squadForViewer({ squadVisibleToPlayers: true }, [], { isOwner: false })).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { POTM_MIN_VOTES, potmOpen, potmWinners, type PotmVote } from "../../src/domain/potm.js";

const KICKOFF = new Date("2026-08-13T18:00:00Z");
const FIXTURE = { kicksOffAt: KICKOFF, durationMinutes: 90 };
/** 19:30 on the 13th plus 24 hours. */
const DEADLINE = new Date("2026-08-14T19:30:00Z");

function vote(voterId: string, candidateId: string): PotmVote {
  return { voterId, candidateId };
}

describe("potmOpen", () => {
  it("is open on a played fixture before the result deadline", () => {
    expect(potmOpen("played", FIXTURE, 24, new Date(DEADLINE.getTime() - 1))).toBe(true);
  });

  /**
   * Unlike the result, which stays open past its deadline until somebody files
   * — a vote with nobody behind it would otherwise never close, and the
   * winner's notification would never have an instant to fire at.
   */
  it("closes at the deadline whether or not anybody voted", () => {
    expect(potmOpen("played", FIXTURE, 24, DEADLINE)).toBe(false);
  });

  it("is never open on a fixture that has not been played", () => {
    for (const lifecycle of ["open", "scheduled", "cancelled"] as const) {
      expect(potmOpen(lifecycle, FIXTURE, 24, KICKOFF)).toBe(false);
    }
  });
});

describe("potmWinners", () => {
  const candidates = new Set(["ann", "bo", "cy"]);
  const voters = new Set(["ann", "bo", "cy", "org"]);

  it("names the most-voted candidate", () => {
    const outcome = potmWinners([vote("ann", "bo"), vote("cy", "bo"), vote("bo", "ann")], candidates, voters);
    expect(outcome).toEqual({ winnerIds: ["bo"], votes: 2, totalVotes: 3 });
  });

  it("names every candidate tied on the most votes", () => {
    const outcome = potmWinners(
      [vote("ann", "bo"), vote("bo", "ann"), vote("cy", "ann"), vote("org", "bo")],
      candidates,
      voters,
    );
    expect(outcome?.winnerIds.sort()).toEqual(["ann", "bo"]);
    expect(outcome?.votes).toBe(2);
  });

  it(`announces nothing below ${POTM_MIN_VOTES} votes, so one voter cannot crown anybody`, () => {
    expect(potmWinners([vote("ann", "bo")], candidates, voters)).toBeNull();
    expect(potmWinners([], candidates, voters)).toBeNull();
  });

  /**
   * The roster can still move while the vote is open (M64): a vote for a
   * player since taken out of the fixture, or cast by one, counts for nothing
   * rather than naming somebody who did not play.
   */
  it("ignores a vote for a non-candidate, a vote from a non-voter, and a self-vote", () => {
    const outcome = potmWinners(
      [vote("ann", "zed"), vote("stranger", "bo"), vote("cy", "cy"), vote("ann", "bo"), vote("cy", "bo")],
      candidates,
      voters,
    );
    expect(outcome).toEqual({ winnerIds: ["bo"], votes: 2, totalVotes: 2 });
  });
});
